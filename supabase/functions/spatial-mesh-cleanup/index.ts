/**
 * Edge Function `spatial-mesh-cleanup` — Spatial V1.6.1 #4 · PRIV-D2.
 *
 * DSGVO Storage retention for the `spatial-mesh-snapshots` bucket. Removes:
 *
 *   (a) Orphan blobs — mesh files whose parent `scans` row was deleted
 *       (cascade FK / customer delete) but the storage row remained.
 *   (b) Expired blobs — mesh files older than `retention_days` (default 90)
 *       whose parent scan still exists. Excludes orphans (counted by (a)).
 *
 * Invoked by:
 *   • pg_cron daily via `public.spatial_mesh_cleanup_dispatch()` (source=cron)
 *   • Operator-initiated one-off via supabase CLI / direct HTTP (source=manual)
 *
 * Both paths require `x-fixup-trigger-secret` matching the
 * `FIXUP_TRIGGER_SHARED_SECRET` env (mirrors account-cascade-cleanup pattern).
 *
 * Discovery uses the two SECDEF RPCs from migration 20260527010000 because
 * PostgREST does not expose the `storage` schema (Phase 5 hotfix lesson):
 *   • spatial_mesh_cleanup_list_orphans(p_limit)
 *   • spatial_mesh_cleanup_list_expired(p_retention_days, p_limit)
 *
 * Removal goes through the Storage HTTP API
 * (`admin.storage.from('spatial-mesh-snapshots').remove(paths)`) — this is
 * the only path that deletes BOTH the `storage.objects` row AND the
 * underlying blob in object storage. Direct SQL `DELETE FROM storage.objects`
 * leaks the blob.
 *
 * Hard caps:
 *   • REMOVE_BATCH_SIZE = 500 per remove() call (Supabase limit).
 *   • MAX_FILES_PER_RUN (configurable via body.max_files, default 500) caps
 *     the entire run so cron tick stays under 30 s and rate-limit-safe.
 *
 * Audit:
 *   One row in `public.mesh_cleanup_log` per run with files_deleted,
 *   bytes_freed, orphan_count, expired_count, duration_ms, error_detail.
 *   Audit row written EVEN on partial failure so the DSGVO auditor can
 *   correlate a missing row with a delivery problem.
 *
 * Body schema (all optional):
 *   {
 *     "source": "cron" | "manual",       // default "manual"
 *     "retention_days": number,          // default 90
 *     "max_files": number                // default 500, max 5000
 *   }
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

type DenoLike = {
  env?: { get?: (name: string) => string | undefined }
  serve?: (handler: (req: Request) => Promise<Response>) => unknown
}

function getDeno(): DenoLike | undefined {
  return (globalThis as { Deno?: DenoLike }).Deno
}

function mustGetEnv(name: string): string {
  const value = getDeno()?.env?.get?.(name)
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing env: ${name}`)
  }
  return value
}

function mustGetEnvSafe(name: string): { value: string | null; error?: string } {
  try {
    return { value: mustGetEnv(name) }
  } catch (e) {
    return { value: null, error: (e as Error).message }
  }
}

function jsonResponse(body: unknown, init: number | ResponseInit = 200): Response {
  const status = typeof init === 'number' ? init : init.status ?? 200
  const headers = typeof init === 'number' ? {} : (init.headers ?? {})
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function log(event: string, context?: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, timestamp: Date.now(), ...(context ?? {}) }))
}

// ── Constants ────────────────────────────────────────────────────────────

const BUCKET = 'spatial-mesh-snapshots'
const REMOVE_BATCH_SIZE = 500
const DEFAULT_RETENTION_DAYS = 90
const DEFAULT_MAX_FILES = 500
const MAX_FILES_HARD_CAP = 5000

// ── Types ────────────────────────────────────────────────────────────────

type Source = 'cron' | 'manual'

type RpcRow = { object_name: string; size_bytes: number | string | null }

type CleanupResult = {
  filesDeleted: number
  bytesFreed: number
  orphanCount: number
  expiredCount: number
  errors: string[]
}

// ── RPC helpers ──────────────────────────────────────────────────────────

async function fetchOrphans(
  admin: SupabaseClient,
  limit: number,
): Promise<{ rows: RpcRow[]; error: string | null }> {
  const { data, error } = await admin.rpc('spatial_mesh_cleanup_list_orphans', {
    p_limit: limit,
  })
  if (error) {
    return { rows: [], error: `list_orphans: ${error.message}` }
  }
  return { rows: (data ?? []) as RpcRow[], error: null }
}

async function fetchExpired(
  admin: SupabaseClient,
  retentionDays: number,
  limit: number,
): Promise<{ rows: RpcRow[]; error: string | null }> {
  const { data, error } = await admin.rpc('spatial_mesh_cleanup_list_expired', {
    p_retention_days: retentionDays,
    p_limit: limit,
  })
  if (error) {
    return { rows: [], error: `list_expired: ${error.message}` }
  }
  return { rows: (data ?? []) as RpcRow[], error: null }
}

// ── Batch removal ────────────────────────────────────────────────────────

/**
 * Removes paths in REMOVE_BATCH_SIZE chunks via the Storage HTTP API.
 *
 * `sizes` is a parallel array to `paths` (same length, same order) holding
 * each blob's size_bytes from the SECDEF RPC. We tally `bytesFreed` ONLY for
 * chunks that successfully remove (no error). On the first chunk error we
 * stop and surface the partial counts — matches the audit semantics of
 * `files_deleted` (M2 review fix · PR #949).
 */
async function batchRemove(
  admin: SupabaseClient,
  paths: string[],
  sizes: number[],
): Promise<{ removed: number; bytesFreed: number; error: string | null }> {
  if (paths.length === 0) return { removed: 0, bytesFreed: 0, error: null }
  let removed = 0
  let bytesFreed = 0
  for (let i = 0; i < paths.length; i += REMOVE_BATCH_SIZE) {
    const chunk = paths.slice(i, i + REMOVE_BATCH_SIZE)
    const chunkSizes = sizes.slice(i, i + REMOVE_BATCH_SIZE)
    const { data, error } = await admin.storage.from(BUCKET).remove(chunk)
    if (error) {
      return { removed, bytesFreed, error: `storage.remove: ${error.message}` }
    }
    const chunkRemoved = Array.isArray(data) ? data.length : chunk.length
    if (chunkRemoved > 0) {
      removed += chunkRemoved
      bytesFreed += chunkSizes.reduce((sum, b) => sum + b, 0)
    }
  }
  return { removed, bytesFreed, error: null }
}

// ── Core cleanup pipeline ────────────────────────────────────────────────

export async function runCleanup(
  admin: SupabaseClient,
  retentionDays: number,
  maxFiles: number,
): Promise<CleanupResult> {
  const errors: string[] = []
  let filesDeleted = 0
  let bytesFreed = 0

  // 1. Orphans first — they have the most aggressive cleanup justification
  //    (parent scan already deleted, DSGVO Art. 5(1)(c) data minimisation).
  //    Cap the remaining budget for expired after orphans are processed.
  const orphanLimit = Math.min(maxFiles, MAX_FILES_HARD_CAP)
  const orphansResult = await fetchOrphans(admin, orphanLimit)
  if (orphansResult.error) {
    errors.push(orphansResult.error)
  }

  const orphanRows = orphansResult.rows
  const orphanCount = orphanRows.length

  if (orphanRows.length > 0) {
    const { paths, sizes } = extractPathsAndSizes(orphanRows)
    const removeResult = await batchRemove(admin, paths, sizes)
    filesDeleted += removeResult.removed
    bytesFreed += removeResult.bytesFreed
    if (removeResult.error) {
      errors.push(`orphans ${removeResult.error}`)
      log('cleanup.mesh.orphans.partial', { removed: removeResult.removed, error: removeResult.error })
    } else {
      log('cleanup.mesh.orphans.done', { removed: removeResult.removed })
    }
  }

  // 2. Expired — only if budget remains.
  const remaining = Math.max(0, maxFiles - orphanCount)
  let expiredCount = 0
  if (remaining > 0) {
    const expiredResult = await fetchExpired(admin, retentionDays, remaining)
    if (expiredResult.error) {
      errors.push(expiredResult.error)
    }
    expiredCount = expiredResult.rows.length
    if (expiredResult.rows.length > 0) {
      const { paths, sizes } = extractPathsAndSizes(expiredResult.rows)
      const removeResult = await batchRemove(admin, paths, sizes)
      filesDeleted += removeResult.removed
      bytesFreed += removeResult.bytesFreed
      if (removeResult.error) {
        errors.push(`expired ${removeResult.error}`)
        log('cleanup.mesh.expired.partial', { removed: removeResult.removed, error: removeResult.error })
      } else {
        log('cleanup.mesh.expired.done', { removed: removeResult.removed })
      }
    }
  }

  return { filesDeleted, bytesFreed, orphanCount, expiredCount, errors }
}

/**
 * Builds parallel `paths` + `sizes` arrays from RPC rows, filtering blanks.
 * Sizes track each path 1:1 so batchRemove can tally `bytes_freed` per
 * successful chunk only (M2 review fix · PR #949).
 */
function extractPathsAndSizes(rows: RpcRow[]): { paths: string[]; sizes: number[] } {
  const paths: string[] = []
  const sizes: number[] = []
  for (const row of rows) {
    if (typeof row.object_name !== 'string' || row.object_name.length === 0) continue
    paths.push(row.object_name)
    sizes.push(toBytes(row.size_bytes))
  }
  return { paths, sizes }
}

function toBytes(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

// ── HTTP handler ─────────────────────────────────────────────────────────

// Constant-time secret comparison so a brute-force probe cannot recover the
// expected secret byte-by-byte from response-timing differences.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405)
  }

  const expectedSecret = mustGetEnvSafe('FIXUP_TRIGGER_SHARED_SECRET')
  if (!expectedSecret.value) {
    return jsonResponse({ error: 'server_misconfigured', detail: expectedSecret.error }, 500)
  }
  const provided = req.headers.get('x-fixup-trigger-secret')
  if (!provided || !timingSafeEqual(provided, expectedSecret.value)) {
    return jsonResponse({ error: 'unauthorized' }, 401)
  }

  let body: { source?: string; retention_days?: number; max_files?: number } = {}
  try {
    // Empty body is valid — defaults apply.
    const text = await req.text()
    if (text.length > 0) {
      body = JSON.parse(text)
    }
  } catch {
    return jsonResponse({ error: 'invalid_body' }, 400)
  }

  const source: Source = body.source === 'cron' ? 'cron' : 'manual'
  const retentionDays = sanitizeInt(
    body.retention_days,
    DEFAULT_RETENTION_DAYS,
    1,
    3650,
  )
  const maxFiles = sanitizeInt(body.max_files, DEFAULT_MAX_FILES, 1, MAX_FILES_HARD_CAP)

  const supabaseUrl = mustGetEnvSafe('SUPABASE_URL')
  const serviceKey = mustGetEnvSafe('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl.value || !serviceKey.value) {
    return jsonResponse(
      { error: 'server_misconfigured', detail: supabaseUrl.error ?? serviceKey.error },
      500,
    )
  }

  const admin = createClient(supabaseUrl.value, serviceKey.value, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const start = Date.now()
  log('cleanup.mesh.start', { source, retentionDays, maxFiles })

  const result = await runCleanup(admin, retentionDays, maxFiles)
  const durationMs = Date.now() - start

  // Audit log INSERT — written even on partial failure so the auditor can
  // correlate via ran_at + source. error_detail = null on full success.
  const { error: auditErr } = await admin.from('mesh_cleanup_log').insert({
    source,
    files_deleted: result.filesDeleted,
    bytes_freed: result.bytesFreed,
    orphan_count: result.orphanCount,
    expired_count: result.expiredCount,
    duration_ms: durationMs,
    error_detail: result.errors.length > 0 ? result.errors.join('; ').slice(0, 4000) : null,
  })
  if (auditErr) {
    log('cleanup.mesh.audit_failed', { error: auditErr.message })
  }

  log('cleanup.mesh.done', {
    source,
    filesDeleted: result.filesDeleted,
    bytesFreed: result.bytesFreed,
    orphanCount: result.orphanCount,
    expiredCount: result.expiredCount,
    durationMs,
    errorCount: result.errors.length,
  })

  if (result.errors.length > 0) {
    return jsonResponse(
      {
        ok: false,
        filesDeleted: result.filesDeleted,
        bytesFreed: result.bytesFreed,
        orphanCount: result.orphanCount,
        expiredCount: result.expiredCount,
        durationMs,
        errors: result.errors,
      },
      500,
    )
  }

  return jsonResponse({
    ok: true,
    filesDeleted: result.filesDeleted,
    bytesFreed: result.bytesFreed,
    orphanCount: result.orphanCount,
    expiredCount: result.expiredCount,
    durationMs,
  })
}

function sanitizeInt(
  raw: unknown,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return defaultValue
  const i = Math.trunc(raw)
  if (i < min) return min
  if (i > max) return max
  return i
}

const denoServe = getDeno()?.serve
if (typeof denoServe === 'function') {
  denoServe(handleRequest)
}
