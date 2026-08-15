/**
 * Spatial Convert — HTTP front for the Cloud Run worker.
 *
 * Accepts POST /convert with an HMAC-signed body:
 *   { scanId: string, usdzPath: string, idempotencyKey: string }
 *
 * Auth: X-Spatial-Convert-Signature header carries an HMAC-SHA256 of the
 * request body using SPATIAL_CONVERT_TOKEN. Requests without a valid
 * signature are rejected — the edge function `spatial-enqueue-convert`
 * is the only legitimate caller in prod.
 *
 * Flow per request:
 *   1. Verify signature + dedupe by idempotencyKey (in-memory recent set).
 *   2. Download the USDZ from Supabase Storage (service-role credential).
 *   3. Run scripts/convert.py via Blender headless to produce a raw glb.
 *   4. Run scripts/postprocess.sh to compress with Meshopt + KTX2.
 *   5. Upload glb back to `{user}/{scan}/gltf/<sha>.glb`.
 *   6. Insert a `scan_assets` row with kind='gltf', converted_from=<usdzAssetId>.
 *   7. Emit a `record_scan_event` audit row.
 *
 * On failure the worker returns 5xx with a structured error; the edge
 * function re-enqueues with an exponential backoff (Block X.3 handles
 * the retry semantics).
 */

import express from 'express'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { convertJob } from './convertJob.js'

const app = express()

// Capture the raw body so HMAC verification sees the exact bytes the sender signed.
app.use(express.raw({ type: 'application/json', limit: '32kb' }))

const TOKEN = process.env.SPATIAL_CONVERT_TOKEN
if (!TOKEN) {
  console.error('SPATIAL_CONVERT_TOKEN env var missing — refusing to start')
  process.exit(1)
}

// In-memory idempotency cache: keeps a 5-min sliding window of recently
// processed keys. Cloud Run scales horizontally so the cache is per-instance;
// the DB-side UNIQUE on scan_assets(scan_id, kind) is the durable guard.
const seenKeys = new Map()
const SEEN_WINDOW_MS = 5 * 60 * 1000

function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false
  const expected = createHmac('sha256', TOKEN).update(rawBody).digest('hex')
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(signatureHeader, 'utf8')
  if (expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}

function rememberIdempotency(key) {
  const now = Date.now()
  for (const [k, ts] of seenKeys) {
    if (now - ts > SEEN_WINDOW_MS) seenKeys.delete(k)
  }
  if (seenKeys.has(key)) return false
  seenKeys.set(key, now)
  return true
}

// `/ping` instead of `/healthz` — Google Cloud Run's frontend reserves
// `/healthz`, intercepts the request before it reaches the container, and
// returns its own 404. App-level health endpoints must use a different
// path so the container actually sees the request.
app.get('/ping', (_req, res) => res.json({ ok: true, ts: Date.now() }))

app.post('/convert', async (req, res) => {
  const signature = req.get('X-Spatial-Convert-Signature')
  if (!verifySignature(req.body, signature)) {
    return res.status(401).json({ error: 'invalid_signature' })
  }
  let payload
  try {
    payload = JSON.parse(req.body.toString('utf8'))
  } catch {
    return res.status(400).json({ error: 'invalid_json' })
  }
  const { scanId, usdzPath, idempotencyKey } = payload
  if (!scanId || !usdzPath || !idempotencyKey) {
    return res.status(400).json({ error: 'missing_field' })
  }
  if (!rememberIdempotency(idempotencyKey)) {
    return res.status(200).json({ ok: true, dedup: true })
  }
  try {
    const result = await convertJob({ scanId, usdzPath })
    return res.status(200).json({ ok: true, ...result })
  } catch (err) {
    console.error('convertJob failed', { scanId, usdzPath, err: String(err?.stack ?? err) })
    return res.status(500).json({ error: 'convert_failed', message: String(err?.message ?? err) })
  }
})

const port = Number(process.env.PORT ?? 8080)
app.listen(port, () => {
  console.log(`spatial-convert listening on :${port}`)
})
