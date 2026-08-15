/**
 * Edge Function `spatial-parametric-cleanup` — Spatial V1.6.1 · Block L4.c.
 *
 * Storage retention for the PRIVATE `spatial-parametric` bucket (scene-blob
 * store, `{sceneId}/parametric.json`). Removes ORPHAN blobs: objects whose bare
 * name is not referenced by any `spatial_scenes.parametric_storage_path` and are
 * older than the grace window (a deleted scene / legacy upload path).
 *
 * Mirrors `spatial-mesh-cleanup` 1:1:
 *   • Invoked by pg_cron via `public.spatial_parametric_cleanup_dispatch()`
 *     (source=cron) or a manual POST (source=manual).
 *   • Auth: `x-fixup-trigger-secret` header === `FIXUP_TRIGGER_SHARED_SECRET`
 *     env (the same secret guarding mesh-cleanup; both are internal triggers).
 *   • Discovery via the SECDEF RPC `spatial_parametric_cleanup_list_orphans`
 *     (PostgREST does not expose the `storage` schema).
 *   • Removal through the Storage HTTP API (`admin.storage.from().remove()`) —
 *     the ONLY path that frees BOTH the storage.objects row AND the S3 blob.
 *     A raw `DELETE FROM storage.objects` leaks the blob.
 *   • One audit row per run in `public.parametric_cleanup_log`.
 *
 * Body (all optional): { source?, grace_days? (default 7), max_files? (default 500) }
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

type DenoLike = { env?: { get?: (name: string) => string | undefined }; serve?: (h: (req: Request) => Promise<Response>) => unknown }
function getDeno(): DenoLike | undefined {
  return (globalThis as { Deno?: DenoLike }).Deno
}
function getEnv(name: string): string | null {
  const v = getDeno()?.env?.get?.(name)
  return typeof v === 'string' && v.length > 0 ? v : null
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
function log(event: string, ctx?: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, timestamp: Date.now(), ...(ctx ?? {}) }))
}

const BUCKET = 'spatial-parametric'
const REMOVE_BATCH_SIZE = 500
const DEFAULT_GRACE_DAYS = 7
const DEFAULT_MAX_FILES = 500
const MAX_FILES_HARD_CAP = 5000

type Source = 'cron' | 'manual'
type OrphanRow = { object_name: string }

function sanitizeInt(raw: unknown, def: number, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def
  const i = Math.trunc(raw)
  return i < min ? min : i > max ? max : i
}

/** Batch-remove paths via the Storage HTTP API (frees the blob). Stops + reports
 *  partial counts on the first chunk error — matches the audit semantics. */
async function batchRemove(
  admin: SupabaseClient,
  paths: string[],
): Promise<{ removed: number; error: string | null }> {
  let removed = 0
  for (let i = 0; i < paths.length; i += REMOVE_BATCH_SIZE) {
    const chunk = paths.slice(i, i + REMOVE_BATCH_SIZE)
    const { data, error } = await admin.storage.from(BUCKET).remove(chunk)
    if (error) return { removed, error: `storage.remove: ${error.message}` }
    removed += Array.isArray(data) ? data.length : chunk.length
  }
  return { removed, error: null }
}

// Constant-time secret comparison so a brute-force probe cannot recover the
// expected secret byte-by-byte from response-timing differences.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const expectedSecret = getEnv('FIXUP_TRIGGER_SHARED_SECRET')
  if (!expectedSecret) return json({ error: 'server_misconfigured', detail: 'FIXUP_TRIGGER_SHARED_SECRET' }, 500)
  const provided = req.headers.get('x-fixup-trigger-secret')
  if (!provided || !timingSafeEqual(provided, expectedSecret)) return json({ error: 'unauthorized' }, 401)

  let body: { source?: string; grace_days?: number; max_files?: number } = {}
  try {
    const text = await req.text()
    if (text.length > 0) body = JSON.parse(text)
  } catch {
    return json({ error: 'invalid_body' }, 400)
  }

  const source: Source = body.source === 'cron' ? 'cron' : 'manual'
  const graceDays = sanitizeInt(body.grace_days, DEFAULT_GRACE_DAYS, 0, 3650)
  const maxFiles = sanitizeInt(body.max_files, DEFAULT_MAX_FILES, 1, MAX_FILES_HARD_CAP)

  const supabaseUrl = getEnv('SUPABASE_URL')
  const serviceKey = getEnv('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return json({ error: 'server_misconfigured', detail: 'SUPABASE_URL/KEY' }, 500)

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const start = Date.now()
  log('cleanup.parametric.start', { source, graceDays, maxFiles })

  const errors: string[] = []
  let orphanCount = 0
  let filesDeleted = 0

  const { data, error: rpcErr } = await admin.rpc('spatial_parametric_cleanup_list_orphans', {
    p_grace_days: graceDays,
    p_limit: maxFiles,
  })
  if (rpcErr) {
    errors.push(`list_orphans: ${rpcErr.message}`)
  } else {
    const paths = ((data ?? []) as OrphanRow[])
      .map((r) => r.object_name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
    orphanCount = paths.length
    if (paths.length > 0) {
      const res = await batchRemove(admin, paths)
      filesDeleted = res.removed
      if (res.error) {
        errors.push(res.error)
        log('cleanup.parametric.partial', { removed: res.removed, error: res.error })
      } else {
        log('cleanup.parametric.removed', { removed: res.removed })
      }
    }
  }

  const durationMs = Date.now() - start
  const { error: auditErr } = await admin.from('parametric_cleanup_log').insert({
    source,
    files_deleted: filesDeleted,
    orphan_count: orphanCount,
    grace_days: graceDays,
    duration_ms: durationMs,
    error_detail: errors.length > 0 ? errors.join('; ').slice(0, 4000) : null,
  })
  if (auditErr) log('cleanup.parametric.audit_failed', { error: auditErr.message })

  log('cleanup.parametric.done', { source, filesDeleted, orphanCount, durationMs, errorCount: errors.length })

  if (errors.length > 0) {
    return json({ ok: false, filesDeleted, orphanCount, durationMs, errors }, 500)
  }
  return json({ ok: true, bucket: BUCKET, graceDays, orphanCount, filesDeleted, durationMs })
}

const denoServe = getDeno()?.serve
if (typeof denoServe === 'function') {
  denoServe(handleRequest)
}
