/**
 * Edge Function `spatial-scan-cleanup` — project-scans Storage GC.
 *
 * Replaces two broken raw-SQL storage deleters (the `scans` AFTER-DELETE trigger
 * `spatial_purge_scan_storage` and the `spatial_storage_lifecycle` cron — both
 * ran `DELETE FROM storage.objects`, which `storage.protect_delete` rejects with
 * 42501, and which would only free the metadata row anyway, leaking the S3 blob).
 *
 * DSGVO Storage retention for the PRIVATE `project-scans` bucket (canonical path
 * `<userId>/<scanId>/<kind>/<sha256>.<ext>`). Removes:
 *
 *   (a) Orphan blobs — objects whose scan_id (path segment 2) is no longer in
 *       public.scans (the scan was deleted; scan_assets rows cascaded but the
 *       blob lingered). Pure storage remove.
 *   (b) Expired blobs — assets of scans ARCHIVED more than retention_days ago
 *       (kind<>worldmap) — the former lifecycle policy. Removes the blob AND
 *       deletes the scan_assets row.
 *
 * Mirrors `spatial-mesh-cleanup` 1:1 (orphans-first budget split, batched
 * removes, partial-failure isolation, one audit row per run) — the difference is
 * the expired pass also prunes scan_assets rows.
 *
 * Invoked by pg_cron via `public.spatial_scan_cleanup_dispatch()` (source=cron)
 * or a manual POST (source=manual). Auth: `x-fixup-trigger-secret` ===
 * `FIXUP_TRIGGER_SHARED_SECRET` env. Discovery via the two SECDEF RPCs
 * (`spatial_scan_cleanup_list_orphans`, `spatial_scan_cleanup_list_expired`),
 * because PostgREST does not expose the `storage` schema. Removal through the
 * Storage HTTP API (`admin.storage.from().remove()`) — the ONLY path that frees
 * BOTH the storage.objects row AND the S3 blob.
 *
 * Body (all optional): { source?, retention_days? (default 90), max_files? (default 500) }
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

type DenoLike = {
  env?: { get?: (name: string) => string | undefined }
  serve?: (handler: (req: Request) => Promise<Response>) => unknown
}

function getDeno(): DenoLike | undefined {
  return (globalThis as { Deno?: DenoLike }).Deno
}

function getEnv(name: string): string | null {
  const v = getDeno()?.env?.get?.(name)
  return typeof v === 'string' && v.length > 0 ? v : null
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function log(event: string, context?: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, timestamp: Date.now(), ...(context ?? {}) }))
}

// ── Constants ────────────────────────────────────────────────────────────

const BUCKET = 'project-scans'
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
  rowsPruned: number
  errors: string[]
}

// ── RPC helpers ──────────────────────────────────────────────────────────

async function fetchOrphans(
  admin: SupabaseClient,
  limit: number,
): Promise<{ rows: RpcRow[]; error: string | null }> {
  const { data, error } = await admin.rpc('spatial_scan_cleanup_list_orphans', {
    p_limit: limit,
  })
  if (error) return { rows: [], error: `list_orphans: ${error.message}` }
  return { rows: (data ?? []) as RpcRow[], error: null }
}

async function fetchExpired(
  admin: SupabaseClient,
  retentionDays: number,
  limit: number,
): Promise<{ rows: RpcRow[]; error: string | null }> {
  const { data, error } = await admin.rpc('spatial_scan_cleanup_list_expired', {
    p_retention_days: retentionDays,
    p_limit: limit,
  })
  if (error) return { rows: [], error: `list_expired: ${error.message}` }
  return { rows: (data ?? []) as RpcRow[], error: null }
}

// ── Batch removal ────────────────────────────────────────────────────────

/**
 * Removes paths in REMOVE_BATCH_SIZE chunks via the Storage HTTP API. Tallies
 * `bytesFreed` + collects `removedPaths` ONLY for chunks that succeed; stops and
 * surfaces partial counts on the first chunk error (audit-integrity: counts
 * reflect only successfully removed blobs).
 */
async function batchRemove(
  admin: SupabaseClient,
  paths: string[],
  sizes: number[],
): Promise<{ removed: number; bytesFreed: number; removedPaths: string[]; error: string | null }> {
  if (paths.length === 0) return { removed: 0, bytesFreed: 0, removedPaths: [], error: null }
  let removed = 0
  let bytesFreed = 0
  const removedPaths: string[] = []
  for (let i = 0; i < paths.length; i += REMOVE_BATCH_SIZE) {
    const chunk = paths.slice(i, i + REMOVE_BATCH_SIZE)
    const chunkSizes = sizes.slice(i, i + REMOVE_BATCH_SIZE)
    const { data, error } = await admin.storage.from(BUCKET).remove(chunk)
    if (error) {
      return { removed, bytesFreed, removedPaths, error: `storage.remove: ${error.message}` }
    }
    const chunkRemoved = Array.isArray(data) ? data.length : chunk.length
    if (chunkRemoved > 0) {
      removed += chunkRemoved
      bytesFreed += chunkSizes.reduce((sum, b) => sum + b, 0)
      removedPaths.push(...chunk)
    }
  }
  return { removed, bytesFreed, removedPaths, error: null }
}

/**
 * Prunes scan_assets rows whose storage_path was just removed from the bucket
 * (expired pass only — orphans have no scan_assets row, it cascaded with the
 * scan). Chained .select('id') so the deleted-row count is returned.
 */
async function pruneAssetRows(
  admin: SupabaseClient,
  storagePaths: string[],
): Promise<{ pruned: number; error: string | null }> {
  if (storagePaths.length === 0) return { pruned: 0, error: null }
  const { data, error } = await admin
    .from('scan_assets')
    .delete()
    .in('storage_path', storagePaths)
    .select('id')
  if (error) return { pruned: 0, error: `scan_assets prune: ${error.message}` }
  return { pruned: Array.isArray(data) ? data.length : 0, error: null }
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
  let rowsPruned = 0

  // 1. Orphans first (parent scan already deleted — strongest deletion
  //    justification, DSGVO Art. 5(1)(c)). Cap the remaining budget afterwards.
  const orphanLimit = Math.min(maxFiles, MAX_FILES_HARD_CAP)
  const orphansResult = await fetchOrphans(admin, orphanLimit)
  if (orphansResult.error) errors.push(orphansResult.error)

  const orphanCount = orphansResult.rows.length
  if (orphanCount > 0) {
    const { paths, sizes } = extractPathsAndSizes(orphansResult.rows)
    const removeResult = await batchRemove(admin, paths, sizes)
    filesDeleted += removeResult.removed
    bytesFreed += removeResult.bytesFreed
    if (removeResult.error) {
      errors.push(`orphans ${removeResult.error}`)
      log('cleanup.scan.orphans.partial', { removed: removeResult.removed, error: removeResult.error })
    } else {
      log('cleanup.scan.orphans.done', { removed: removeResult.removed })
    }
  }

  // 2. Expired — only if budget remains. Removes blob AND prunes the
  //    scan_assets row (the former spatial_storage_lifecycle responsibility).
  const remaining = Math.max(0, maxFiles - orphanCount)
  let expiredCount = 0
  if (remaining > 0) {
    const expiredResult = await fetchExpired(admin, retentionDays, remaining)
    if (expiredResult.error) errors.push(expiredResult.error)

    expiredCount = expiredResult.rows.length
    if (expiredCount > 0) {
      const { paths, sizes } = extractPathsAndSizes(expiredResult.rows)
      const removeResult = await batchRemove(admin, paths, sizes)
      filesDeleted += removeResult.removed
      bytesFreed += removeResult.bytesFreed
      if (removeResult.error) {
        errors.push(`expired ${removeResult.error}`)
        log('cleanup.scan.expired.partial', { removed: removeResult.removed, error: removeResult.error })
      } else {
        log('cleanup.scan.expired.done', { removed: removeResult.removed })
      }
      // Prune the scan_assets rows for blobs that were actually removed.
      const prune = await pruneAssetRows(admin, removeResult.removedPaths)
      rowsPruned += prune.pruned
      if (prune.error) {
        errors.push(prune.error)
        log('cleanup.scan.expired.prune_failed', { error: prune.error })
      }
    }
  }

  return { filesDeleted, bytesFreed, orphanCount, expiredCount, rowsPruned, errors }
}

/** Builds parallel paths + sizes arrays from RPC rows, filtering blanks. */
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

function sanitizeInt(raw: unknown, defaultValue: number, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return defaultValue
  const i = Math.trunc(raw)
  return i < min ? min : i > max ? max : i
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
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405)

  const expectedSecret = getEnv('FIXUP_TRIGGER_SHARED_SECRET')
  if (!expectedSecret) {
    return jsonResponse({ error: 'server_misconfigured', detail: 'FIXUP_TRIGGER_SHARED_SECRET' }, 500)
  }
  const provided = req.headers.get('x-fixup-trigger-secret')
  if (!provided || !timingSafeEqual(provided, expectedSecret)) return jsonResponse({ error: 'unauthorized' }, 401)

  let body: { source?: string; retention_days?: number; max_files?: number } = {}
  try {
    const text = await req.text()
    if (text.length > 0) body = JSON.parse(text)
  } catch {
    return jsonResponse({ error: 'invalid_body' }, 400)
  }

  const source: Source = body.source === 'cron' ? 'cron' : 'manual'
  const retentionDays = sanitizeInt(body.retention_days, DEFAULT_RETENTION_DAYS, 1, 3650)
  const maxFiles = sanitizeInt(body.max_files, DEFAULT_MAX_FILES, 1, MAX_FILES_HARD_CAP)

  const supabaseUrl = getEnv('SUPABASE_URL')
  const serviceKey = getEnv('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: 'server_misconfigured', detail: 'SUPABASE_URL/KEY' }, 500)
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const start = Date.now()
  log('cleanup.scan.start', { source, retentionDays, maxFiles })

  const result = await runCleanup(admin, retentionDays, maxFiles)
  const durationMs = Date.now() - start

  const { error: auditErr } = await admin.from('scan_cleanup_log').insert({
    source,
    files_deleted: result.filesDeleted,
    bytes_freed: result.bytesFreed,
    orphan_count: result.orphanCount,
    expired_count: result.expiredCount,
    rows_pruned: result.rowsPruned,
    duration_ms: durationMs,
    error_detail: result.errors.length > 0 ? result.errors.join('; ').slice(0, 4000) : null,
  })
  if (auditErr) log('cleanup.scan.audit_failed', { error: auditErr.message })

  log('cleanup.scan.done', {
    source,
    filesDeleted: result.filesDeleted,
    bytesFreed: result.bytesFreed,
    orphanCount: result.orphanCount,
    expiredCount: result.expiredCount,
    rowsPruned: result.rowsPruned,
    durationMs,
    errorCount: result.errors.length,
  })

  const payload = {
    ok: result.errors.length === 0,
    bucket: BUCKET,
    filesDeleted: result.filesDeleted,
    bytesFreed: result.bytesFreed,
    orphanCount: result.orphanCount,
    expiredCount: result.expiredCount,
    rowsPruned: result.rowsPruned,
    durationMs,
    ...(result.errors.length > 0 ? { errors: result.errors } : {}),
  }
  return jsonResponse(payload, result.errors.length > 0 ? 500 : 200)
}

const denoServe = getDeno()?.serve
if (typeof denoServe === 'function') {
  denoServe(handleRequest)
}
