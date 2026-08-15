import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { SupabaseClient } from '@supabase/supabase-js'
import { applyCors } from './_cors.js'
import { requireAuth } from './_auth.js'
import { getSupabaseAdmin } from './_supabase.js'
import { logInfo, logWarning, logError } from './_observability.js'
import { applyRateLimit } from './_rateLimit.js'

/**
 * POST /api/delete-account
 *
 * Permanently deletes the authenticated user's account. Satisfies Apple App
 * Store Guideline 5.1.1(v) and Google Play policy which require in-app
 * account deletion.
 *
 * Phase 5 Spatial V1.6 · DSGVO Hybrid-Cascade
 * ──────────────────────────────────────────
 * Primary path (this route) clears Storage SYNCHRONOUSLY before calling
 * admin.auth.admin.deleteUser. This guarantees the happy path is orphan-free
 * and that admin.deleteUser is NEVER called when Storage cleanup partially
 * failed — the next attempt re-runs the same cleanup and only deletes the
 * auth user when no errors remain.
 *
 * The trigger `handle_auth_user_delete_cascade` (migration
 * 20260527000001) is the safety-net for alternative deletion paths
 * (admin-console, direct SQL, future RPC).
 *
 * Storage listing routes through the SECURITY DEFINER RPC
 * `account_cascade_list_storage(uuid)` (migration 20260527000002) because
 * PostgREST does not expose the `storage` schema by default. The RPC returns
 * (bucket_id, name) pairs across all 10 user-owned buckets in one round-trip;
 * the caller groups by bucket and removes via `storage.from(bucket).remove(paths)`.
 *
 * Guards:
 *   - Caller must be authenticated (valid Supabase JWT).
 *   - Only the authenticated user's own account is deleted.
 *
 * Bucket selectors live in the RPC (kept in sync with
 * supabase/functions/account-cascade-cleanup/index.ts):
 *   project-scans              foldername[1] = userId
 *   spatial-mesh-snapshots     foldername[1] = userId
 *   spatial-parametric         foldername[1] = userId
 *   spatial-annotation-photos  foldername[1] = userId
 *   worker-doku-photos         storage.objects.owner/owner_id = userId
 *   media                      storage.objects.owner/owner_id = userId
 *   sick-notes                 path LIKE '%/<userId>/%'
 *   chat-customer / chat-internal / chat-dispute
 *                              thread walk ∪ owner/owner_id ∪ orphaned-thread
 *                              sweep (RPC-side, v2 — 20260716120000)
 *   spatial-public-assets      EXCLUDED — shared assets, never user-owned
 */

const REMOVE_BATCH_SIZE = 500

export type StorageCleanupResult = {
  buckets: string[]
  filesRemoved: number
  durationMs: number
  errors: string[]
}

type CascadeRow = { bucket_id: string; name: string }

// ── Helpers ─────────────────────────────────────────────────────────────

async function batchRemove(
  admin: SupabaseClient,
  bucket: string,
  paths: string[],
): Promise<number> {
  // Idempotent: storage.remove([]) errors at the PostgREST layer. Short-circuit.
  if (paths.length === 0) return 0
  let removed = 0
  for (let i = 0; i < paths.length; i += REMOVE_BATCH_SIZE) {
    const chunk = paths.slice(i, i + REMOVE_BATCH_SIZE)
    const { data, error } = await admin.storage.from(bucket).remove(chunk)
    if (error) {
      throw new Error(`storage.remove(${bucket}): ${error.message}`)
    }
    removed += Array.isArray(data) ? data.length : chunk.length
  }
  return removed
}

/**
 * Clears all user-owned objects from every bucket relevant to a given userId.
 *
 * Strategy:
 *   - One SECURITY DEFINER RPC call resolves all 10 user-owned buckets in
 *     a single round-trip. PostgREST does not expose the storage schema,
 *     so direct .schema('storage').from('objects') would 400.
 *   - Rows are grouped by bucket; each bucket's removal is wrapped in its
 *     own try/catch so one bucket failure does NOT abort cleanup for the
 *     remaining buckets — partial progress is the most-common-case outcome
 *     and the caller decides whether to proceed with admin.auth.admin.deleteUser
 *     based on the final errors[] array.
 *   - All errors collected into a flat string[]; durationMs measured around
 *     the entire orchestration so the audit log reflects real wall-clock.
 *   - spatial-public-assets is EXCLUDED at the RPC layer — those are shared
 *     assets, never user-owned, and must never be deleted as part of an
 *     account deletion.
 */
export async function cleanupUserStorage(
  userId: string,
  admin: SupabaseClient,
): Promise<StorageCleanupResult> {
  const start = Date.now()
  const errors: string[] = []
  let filesRemoved = 0

  const { data: rpcData, error: rpcError } = await admin.rpc(
    'account_cascade_list_storage',
    { p_user_id: userId },
  )

  if (rpcError) {
    return {
      buckets: [],
      filesRemoved: 0,
      durationMs: Date.now() - start,
      errors: [`account_cascade_list_storage: ${rpcError.message}`],
    }
  }

  const rows = (rpcData ?? []) as CascadeRow[]
  const byBucket = new Map<string, string[]>()
  for (const row of rows) {
    if (typeof row?.bucket_id !== 'string' || typeof row?.name !== 'string') continue
    if (row.bucket_id.length === 0 || row.name.length === 0) continue
    const list = byBucket.get(row.bucket_id)
    if (list) {
      list.push(row.name)
    } else {
      byBucket.set(row.bucket_id, [row.name])
    }
  }

  const buckets = Array.from(byBucket.keys()).sort()
  for (const bucket of buckets) {
    const paths = byBucket.get(bucket) ?? []
    try {
      filesRemoved += await batchRemove(admin, bucket, paths)
    } catch (e) {
      errors.push(`${bucket}: ${(e as Error).message}`)
    }
  }

  return {
    buckets,
    filesRemoved,
    durationMs: Date.now() - start,
    errors,
  }
}

// ── Vercel handler ──────────────────────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (applyCors(req, res)) return

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed. Use POST.' })
    return
  }

  const auth = await requireAuth(req, res)
  if (!auth) return
  if (await applyRateLimit(res, 'critical', auth.userId)) return

  const admin = getSupabaseAdmin()
  if (!admin) {
    logWarning('api.account.delete_failed', {
      route: 'delete-account',
      reason: 'supabase_admin_unavailable',
    })
    res.status(500).json({ error: 'Server misconfiguration: authorization service unavailable.' })
    return
  }

  const userId = auth.userId

  // 0. Money / dispute precheck — block deletion while funds are held in escrow,
  //    a payout is in flight, funding is capturing, or a dispute is unsettled.
  //    The BEFORE DELETE trigger `auth_users_before_delete_guard` (migration
  //    20260622000000) is the hard, all-paths enforcement; this is the in-app
  //    path's clean 409 before any storage/auth work runs. Fail closed: if the
  //    check itself errors, do NOT delete.
  const { data: blockers, error: blockersErr } = await admin.rpc('account_delete_blockers', {
    p_user_id: userId,
  })
  if (blockersErr) {
    logError('api.account.delete_precheck_failed', blockersErr, {
      route: 'delete-account',
      userId,
    })
    res.status(500).json({ error: 'Konto konnte nicht gelöscht werden. Bitte versuche es erneut.' })
    return
  }
  if (blockers && typeof blockers === 'object' && Object.keys(blockers).length > 0) {
    logWarning('api.account.delete_blocked', { route: 'delete-account', userId, blockers })
    res.status(409).json({
      error:
        'Dein Konto kann nicht gelöscht werden, solange noch Zahlungen in Treuhand, offene Auszahlungen oder ungeklärte Streitfälle bestehen. Bitte schließe diese zuerst ab.',
      detail: 'active_money_or_dispute',
    })
    return
  }

  // 1. Storage cleanup — SYNCHRONOUS, before admin.deleteUser.
  const cleanup = await cleanupUserStorage(userId, admin)

  // 2. Audit log — write before deciding whether to proceed. The DSGVO
  //    auditor needs the row even when cleanup partially failed.
  const { error: auditErr } = await admin.from('account_deletion_log').insert({
    user_id: userId,
    source: 'vercel',
    buckets_cleared: cleanup.buckets,
    files_removed: cleanup.filesRemoved,
    duration_ms: cleanup.durationMs,
    error_detail: cleanup.errors.length > 0 ? cleanup.errors.join('; ') : null,
  })
  if (auditErr) {
    // Audit failure is not fatal — the cleanup ran. But we DO log so it
    // surfaces in Sentry and we don't bury a write-side problem.
    logError('api.account.audit_log_failed', auditErr, {
      route: 'delete-account',
      userId,
    })
  }

  // 3. Partial-failure guard — do NOT call admin.deleteUser if any bucket
  //    errored. The user retries; the next attempt re-runs cleanup and
  //    only proceeds when errors[] is empty. The trigger safety-net
  //    handles alternative deletion paths.
  if (cleanup.errors.length > 0) {
    logWarning('api.account.delete_storage_failed', {
      route: 'delete-account',
      userId,
      filesRemoved: cleanup.filesRemoved,
      errors: cleanup.errors,
      durationMs: cleanup.durationMs,
    })
    res.status(500).json({
      error: 'Konto konnte nicht vollständig gelöscht werden. Bitte versuche es erneut.',
      detail: 'storage_cleanup_partial_failure',
    })
    return
  }

  // 3.5 Erase the rows the user owns/authored BEFORE deleteUser. Six FKs to
  //     profiles/auth.users (scans.captured_by, provider_presales_projects,
  //     spatial_share_audit, spatial_change_orders, spatial_pin_reviews,
  //     spatial_rescan_requests) are NOT NULL + RESTRICT/NO-ACTION, so
  //     admin.deleteUser aborts for any user who captured a scan or acted as a
  //     provider — the in-app DSGVO deletion (Apple 5.1.1(v)) would always fail.
  //     The SECDEF RPC deletes them in dependency order in one transaction (the
  //     blobs were already freed in step 1; the storage-purge trigger that used
  //     to block scan deletes is gone — migration 20260602120000). A live
  //     dispute lock on a change order RAISEs here (retention hold) → we stop
  //     short of deleteUser and the user retries once the dispute resolves.
  const { error: eraseErr } = await admin.rpc('account_cascade_delete_owned_rows', {
    p_user_id: userId,
  })
  if (eraseErr) {
    logWarning('api.account.delete_owned_rows_failed', {
      route: 'delete-account',
      userId,
      error: eraseErr.message,
      filesRemoved: cleanup.filesRemoved,
    })
    res.status(500).json({
      error: 'Konto konnte nicht vollständig gelöscht werden. Bitte versuche es erneut.',
      detail: 'owned_rows_cleanup_failure',
    })
    return
  }

  // 4. Auth user delete — Supabase cascade removes profiles, jobs, etc.
  //    via existing FK ON DELETE CASCADE on user_id columns.
  const { error: deleteErr } = await admin.auth.admin.deleteUser(userId)

  if (deleteErr) {
    // Storage is already clean, audit row exists. Trigger safety-net will
    // pick up the cleanup if the user is later removed via another path.
    // Backstop for the money guard: if funds went in-flight between the
    // precheck and here (race), the BEFORE DELETE trigger RAISEs
    // ACCOUNT_DELETE_BLOCKED — surface that as a 409, not a generic 500.
    const blocked = /ACCOUNT_DELETE_BLOCKED/.test(deleteErr.message ?? '')
    logWarning('api.account.delete_failed', {
      route: 'delete-account',
      userId,
      error: deleteErr.message,
      filesRemoved: cleanup.filesRemoved,
      blocked,
    })
    res.status(blocked ? 409 : 500).json({
      error: blocked
        ? 'Dein Konto kann nicht gelöscht werden, solange noch Zahlungen in Treuhand, offene Auszahlungen oder ungeklärte Streitfälle bestehen. Bitte schließe diese zuerst ab.'
        : 'Konto konnte nicht gelöscht werden. Bitte versuche es erneut.',
    })
    return
  }

  logInfo('api.account.deleted', {
    route: 'delete-account',
    userId,
    filesRemoved: cleanup.filesRemoved,
    bucketsCleared: cleanup.buckets.length,
    durationMs: cleanup.durationMs,
  })

  res.status(200).json({
    ok: true,
    filesRemoved: cleanup.filesRemoved,
    durationMs: cleanup.durationMs,
  })
}
