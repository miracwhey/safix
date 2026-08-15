/**
 * Edge Function `account-cascade-cleanup` — DSGVO Storage cascade safety-net.
 *
 * Invoked by the Postgres trigger `auth_users_after_delete_cascade`
 * (migration `20260527000001_account_delete_cascade_trigger.sql`) via
 * `pg_net.http_post` whenever a row is removed from `auth.users` through any
 * code path that bypasses the primary Vercel-Route (api/delete-account.ts):
 *
 *   • Supabase Admin Console manual delete
 *   • Direct SQL `DELETE FROM auth.users …`
 *   • Future RPC / Apple-Support-Console
 *
 * The Vercel-Route runs the same cleanup synchronously BEFORE calling
 * admin.auth.admin.deleteUser — meaning the trigger normally fires AFTER
 * Storage is already empty for that userId and the function is a no-op
 * (idempotent: account_cascade_list_storage returns 0 rows ⇒ skip).
 *
 * Storage listing routes through the SECURITY DEFINER RPC
 * `account_cascade_list_storage(uuid)` (migration 20260527000002) because
 * PostgREST does not expose the `storage` schema by default.
 *
 * Auth: verify_jwt=false, shared secret in x-fixup-trigger-secret header.
 * Body: { user_id: string }
 *
 * Bucket selectors (kept in sync with api/delete-account.ts):
 *   project-scans              foldername[1] = userId
 *   spatial-mesh-snapshots     foldername[1] = userId
 *   spatial-parametric         foldername[1] = userId
 *   spatial-annotation-photos  foldername[1] = userId
 *   worker-doku-photos         storage.objects.owner = userId
 *   media                      storage.objects.owner = userId
 *   sick-notes                 path LIKE '%/<userId>/%'
 *   chat-customer / chat-internal / chat-dispute
 *                              thread walk ∪ owner/owner_id ∪ orphaned-thread
 *                              sweep (RPC-side, v2 — 20260716120000). The
 *                              owner branch keeps this trigger path correct
 *                              after the auth-delete FK cascade already
 *                              removed the chat_participants rows.
 *   spatial-public-assets      EXCLUDED — shared assets, never user-owned
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { reportError } from '../_shared/errorReport.ts'

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

type CleanupResult = {
  buckets: string[]
  filesRemoved: number
  errors: string[]
  // Objects that survived every retry AND the post-cascade verify pass —
  // i.e. blobs confirmed still present in Storage after cleanup. Non-empty
  // here means DSGVO deletion is INCOMPLETE, not just "logged a warning".
  remainder: CascadeRow[]
}

type CascadeRow = { bucket_id: string; name: string }

const REMOVE_BATCH_SIZE = 500
// Bounded retries for transient storage.remove() failures (network blip,
// rate limit) before a chunk is treated as a real failure for this pass.
const REMOVE_MAX_ATTEMPTS = 3
const REMOVE_RETRY_BASE_MS = 200

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function listUserStorage(
  admin: SupabaseClient,
  userId: string,
): Promise<{ rows: CascadeRow[]; error?: string }> {
  const { data, error } = await admin.rpc('account_cascade_list_storage', {
    p_user_id: userId,
  })
  if (error) {
    return { rows: [], error: `account_cascade_list_storage: ${error.message}` }
  }
  const rows = ((data ?? []) as CascadeRow[]).filter(
    (row) =>
      typeof row?.bucket_id === 'string' &&
      typeof row?.name === 'string' &&
      row.bucket_id.length > 0 &&
      row.name.length > 0,
  )
  return { rows }
}

function groupByBucket(rows: CascadeRow[]): Map<string, string[]> {
  const byBucket = new Map<string, string[]>()
  for (const row of rows) {
    const list = byBucket.get(row.bucket_id)
    if (list) {
      list.push(row.name)
    } else {
      byBucket.set(row.bucket_id, [row.name])
    }
  }
  return byBucket
}

/**
 * Removes `paths` from `bucket`, retrying failed chunks up to
 * REMOVE_MAX_ATTEMPTS with linear backoff. Returns the paths that were
 * still not confirmed removed after all attempts (empty on full success) —
 * the caller does NOT throw on partial failure so remaining buckets still
 * get their own cleanup attempt (one bad bucket must not abort the run).
 */
async function batchRemove(
  admin: SupabaseClient,
  bucket: string,
  paths: string[],
  userId: string,
): Promise<{ removed: number; failedPaths: string[]; lastError?: string }> {
  if (paths.length === 0) return { removed: 0, failedPaths: [] }
  let removed = 0
  const failedPaths: string[] = []
  let lastError: string | undefined

  for (let i = 0; i < paths.length; i += REMOVE_BATCH_SIZE) {
    const chunk = paths.slice(i, i + REMOVE_BATCH_SIZE)
    let chunkRemoved = false
    for (let attempt = 1; attempt <= REMOVE_MAX_ATTEMPTS; attempt++) {
      const { data, error } = await admin.storage.from(bucket).remove(chunk)
      if (!error) {
        removed += Array.isArray(data) ? data.length : chunk.length
        chunkRemoved = true
        break
      }
      lastError = error.message
      log('cleanup.cascade.bucket.retry', {
        bucket,
        userId,
        attempt,
        chunkSize: chunk.length,
        error: error.message,
      })
      if (attempt < REMOVE_MAX_ATTEMPTS) {
        await sleep(REMOVE_RETRY_BASE_MS * attempt)
      }
    }
    if (!chunkRemoved) failedPaths.push(...chunk)
  }

  return { removed, failedPaths, lastError }
}

export async function cleanupUserStorage(
  admin: SupabaseClient,
  userId: string,
): Promise<CleanupResult> {
  const errors: string[] = []
  let filesRemoved = 0

  const initial = await listUserStorage(admin, userId)
  if (initial.error) {
    return { buckets: [], filesRemoved: 0, errors: [initial.error], remainder: [] }
  }

  const byBucket = groupByBucket(initial.rows)
  const buckets = Array.from(byBucket.keys()).sort()
  for (const bucket of buckets) {
    const paths = byBucket.get(bucket) ?? []
    try {
      const { removed, failedPaths, lastError } = await batchRemove(
        admin,
        bucket,
        paths,
        userId,
      )
      filesRemoved += removed
      if (failedPaths.length > 0) {
        const msg = `${bucket}: ${failedPaths.length}/${paths.length} objects failed after ${REMOVE_MAX_ATTEMPTS} attempts (${lastError ?? 'unknown error'})`
        errors.push(msg)
        await reportError('cleanup.cascade.bucket.error', new Error(msg), {
          userId,
          bucket,
          failedCount: failedPaths.length,
        })
      } else {
        log('cleanup.cascade.bucket.done', { bucket, removed, userId })
      }
    } catch (e) {
      const msg = `${bucket}: ${(e as Error).message}`
      errors.push(msg)
      await reportError('cleanup.cascade.bucket.error', e, { userId, bucket })
    }
  }

  // Post-cascade verify: re-list Storage for this user rather than trusting
  // storage.remove()'s reported success — this is the actual DSGVO
  // guarantee (H4). Any row still present here is a confirmed leftover
  // blob, independent of whether the remove() call above reported an
  // error (e.g. a stale/cached listing, a partial provider-side failure).
  const verify = await listUserStorage(admin, userId)
  if (verify.error) {
    errors.push(`post-cleanup verify failed: ${verify.error}`)
    await reportError(
      'cleanup.cascade.verify_failed',
      new Error(verify.error),
      { userId },
    )
    // Cannot confirm empty state — do not claim remainder is empty either.
    return { buckets, filesRemoved, errors, remainder: [] }
  }

  const remainder = verify.rows
  if (remainder.length > 0) {
    const msg = `${remainder.length} object(s) still present after cascade + retries — DSGVO cleanup incomplete`
    errors.push(msg)
    await reportError('cleanup.cascade.remainder', new Error(msg), {
      userId,
      remainder: remainder.map((r) => `${r.bucket_id}/${r.name}`),
    })
    log('cleanup.cascade.remainder', {
      userId,
      remainderCount: remainder.length,
      remainderPaths: remainder.map((r) => `${r.bucket_id}/${r.name}`),
    })
  }

  return { buckets, filesRemoved, errors, remainder }
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

  let body: { user_id?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'invalid_body' }, 400)
  }
  const userId = typeof body?.user_id === 'string' ? body.user_id.trim() : ''
  if (userId.length === 0) {
    return jsonResponse({ error: 'missing_user_id' }, 400)
  }

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
  log('cleanup.cascade.start', { userId, source: 'trigger' })

  const result = await cleanupUserStorage(admin, userId)
  const durationMs = Date.now() - start

  // error_detail carries both transient errors AND the post-verify
  // remainder (dead-letter marker) as one auditor-readable string — the
  // existing column has no dedicated "remainder" field (out of scope: no
  // migration in this fix), so the remainder paths are always appended
  // when non-empty instead of only showing a generic error message.
  const remainderNote =
    result.remainder.length > 0
      ? `REMAINDER(${result.remainder.length}): ${result.remainder
          .map((r) => `${r.bucket_id}/${r.name}`)
          .join(', ')}`
      : null
  const errorDetailParts = [...result.errors]
  if (remainderNote) errorDetailParts.push(remainderNote)

  // Audit log — write irrespective of partial-failure so DSGVO auditor
  // can correlate via source='trigger'.
  const { error: auditErr } = await admin.from('account_deletion_log').insert({
    user_id: userId,
    source: 'trigger',
    buckets_cleared: result.buckets,
    files_removed: result.filesRemoved,
    duration_ms: durationMs,
    error_detail: errorDetailParts.length > 0 ? errorDetailParts.join('; ') : null,
  })
  if (auditErr) {
    await reportError('cleanup.cascade.audit_failed', auditErr, { userId })
  }

  log('cleanup.cascade.done', {
    userId,
    filesRemoved: result.filesRemoved,
    bucketsCleared: result.buckets,
    durationMs,
    errorCount: result.errors.length,
    remainderCount: result.remainder.length,
  })

  if (result.errors.length > 0 || result.remainder.length > 0) {
    return jsonResponse(
      {
        ok: false,
        filesRemoved: result.filesRemoved,
        bucketsCleared: result.buckets,
        durationMs,
        errors: result.errors,
        remainderCount: result.remainder.length,
      },
      500,
    )
  }

  return jsonResponse({
    ok: true,
    filesRemoved: result.filesRemoved,
    bucketsCleared: result.buckets,
    durationMs,
  })
}

const denoServe = getDeno()?.serve
if (typeof denoServe === 'function') {
  denoServe(handleRequest)
}
