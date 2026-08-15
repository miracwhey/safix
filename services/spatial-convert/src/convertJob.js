/**
 * Spatial Convert — single job pipeline.
 *
 *   USDZ blob → Blender USD-import → raw glb → gltf-transform optimize
 *               (vertex-quantize + Meshopt + KTX2) → upload + DB row.
 *
 * Uses Supabase service-role credentials so the worker can read the
 * uploader's USDZ regardless of RLS and write the glb back into the same
 * `{user}/{scan}/gltf/<sha>.glb` slot.
 */

import { execFile } from 'node:child_process'
import { createReadStream, promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { createClient } from '@supabase/supabase-js'

const BUCKET = 'project-scans'

const supabaseUrl = mustEnv('SPATIAL_CONVERT_SUPABASE_URL')
const serviceRole = mustEnv('SPATIAL_CONVERT_SERVICE_ROLE_KEY')
const supabase = createClient(supabaseUrl, serviceRole, {
  auth: { persistSession: false, autoRefreshToken: false },
})

function mustEnv(name) {
  const v = process.env[name]
  if (!v) throw new Error(`env ${name} missing`)
  return v
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    // 256 MiB stdio buffer — Blender + gltf-transform stderr for an 80 MB
    // USDZ regularly crosses 32 MB when KTX2 encoding is verbose; the
    // previous limit threw ERR_CHILD_PROCESS_STDIO_MAXBUFFER mid-job.
    const child = execFile(cmd, args, { ...opts, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout
        err.stderr = stderr
        return reject(err)
      }
      resolve({ stdout, stderr })
    })
    child.on('error', reject)
  })
}

const SCRIPTS_DIR = process.env.SPATIAL_CONVERT_SCRIPTS_DIR || '/app/scripts'

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(file)
    s.on('data', d => h.update(d))
    s.on('end', () => resolve(h.digest('hex')))
    s.on('error', reject)
  })
}

export async function convertJob({ scanId, usdzPath }) {
  // usdzPath is the storage object name, e.g. `{user}/{scan}/usdz/<sha>.usdz`.
  // Validate the shape so a malformed call never escapes into the FS layer.
  const parts = usdzPath.split('/')
  if (parts.length < 4 || parts[2] !== 'usdz') {
    throw new Error(`unexpected usdzPath shape: ${usdzPath}`)
  }
  const userId = parts[0]

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'spatial-convert-'))
  const usdzLocal = path.join(work, 'in.usdz')
  const glbRaw = path.join(work, 'raw.glb')
  const glbOut = path.join(work, 'out.glb')

  // Track the uploaded glb so we can remove it on insert-conflict / failure.
  let uploadedDstPath = null

  try {
    // 1. Download USDZ via service role.
    const { data: dl, error: dlError } = await supabase.storage.from(BUCKET).download(usdzPath)
    if (dlError || !dl) throw dlError ?? new Error('download returned null')
    await fs.writeFile(usdzLocal, Buffer.from(await dl.arrayBuffer()))

    // 2. Blender USDZ → glb. The wrapper script handles all import/export config.
    // Path resolves to /app/scripts at deploy time (Cloud Run WORKDIR /app) but
    // the SPATIAL_CONVERT_SCRIPTS_DIR override lets local dev point elsewhere.
    // Previous `path.join(process.cwd(), 'scripts', ...)` collided with the
    // hardcoded `/app/scripts/convert.py` inside postprocess.sh if the runtime
    // changed the working directory.
    await run('bash', [path.join(SCRIPTS_DIR, 'postprocess.sh'),
      usdzLocal, glbRaw, glbOut])

    // V1.5 Hotfix R3-P3: fail fast on degenerate / spec-violating / oversized
    // output. Three cheap gates (gltf-validator spec errors, vertex-count
    // sanity, 25 MB size cap) — see scripts/validate-mesh.sh for rationale.
    // Failure here bubbles up the same audit-event path as any other convert
    // failure (the catch below records `phase: 'failed'`).
    await run('bash', [path.join(SCRIPTS_DIR, 'validate-mesh.sh'), glbOut])

    // 3. Compute sha + upload.
    const sha = await sha256(glbOut)
    const dstPath = `${userId}/${scanId}/gltf/${sha}.glb`
    const glbBytes = await fs.readFile(glbOut)
    const { error: upError } = await supabase.storage.from(BUCKET).upload(dstPath, glbBytes, {
      contentType: 'model/gltf-binary',
      cacheControl: '3600',
      upsert: true,
    })
    if (upError) throw upError
    uploadedDstPath = dstPath

    // 4. Resolve the source USDZ asset id so we can populate converted_from.
    const { data: srcAssets, error: srcError } = await supabase
      .from('scan_assets')
      .select('id')
      .eq('scan_id', scanId)
      .eq('storage_path', usdzPath)
      .limit(1)
    if (srcError) throw srcError
    const convertedFrom = srcAssets?.[0]?.id ?? null

    // 5. Insert the glb asset row (UNIQUE(scan_id, kind)).
    const insertPayload = {
      scan_id: scanId,
      kind: 'gltf',
      storage_path: dstPath,
      bytes: glbBytes.length,
      sha256: sha,
      converted_from: convertedFrom,
    }
    const { data: insertedAsset, error: insErr } = await supabase
      .from('scan_assets')
      .insert(insertPayload)
      .select('id')
      .single()

    if (insErr) {
      if (insErr.code === '23505') {
        // Conflict: another worker (or a retried request) already wrote the
        // gltf row for this scan. Remove our just-uploaded glb so it does
        // not become an orphan that the storage-lifecycle cron never reaps.
        await supabase.storage.from(BUCKET).remove([dstPath]).catch(() => {})
        uploadedDstPath = null
        return { dstPath, sha256: sha, bytes: glbBytes.length, assetId: null, dedup: true }
      }
      throw insErr
    }

    const assetId = insertedAsset?.id

    // 6. Audit + Quality-Engine re-run hook. Quality re-run is best-effort.
    await supabase.rpc('record_scan_event', {
      p_scan_id: scanId,
      p_action: 'asset_converted',
      p_payload: {
        phase: 'done',
        sourceUsdz: usdzPath,
        targetGltf: dstPath,
        sha256: sha,
        bytes: glbBytes.length,
        convertedFrom,
      },
      p_idempotency_key: null,
    })

    return { dstPath, sha256: sha, bytes: glbBytes.length, assetId }
  } catch (err) {
    // Failure audit so the UI's event-stream polling can flip the convert
    // button back to a retry state instead of hanging forever on a silent
    // Cloud-Run crash / Blender OOM / network drop.
    await supabase.rpc('record_scan_event', {
      p_scan_id: scanId,
      p_action: 'asset_converted',
      p_payload: {
        phase: 'failed',
        sourceUsdz: usdzPath,
        message: String(err?.message ?? err),
      },
      p_idempotency_key: null,
    }).catch(() => {})
    // Best-effort orphan cleanup if we already uploaded but later step failed.
    if (uploadedDstPath) {
      await supabase.storage.from(BUCKET).remove([uploadedDstPath]).catch(() => {})
    }
    throw err
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
}
