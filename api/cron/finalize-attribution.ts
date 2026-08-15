/**
 * Attribution Finalizer — scheduled cron endpoint.
 *
 * Sweeps jobs stuck in 'pending' or 'retrying' attribution_status and
 * attempts to resolve their commercial_origin by querying
 * customer_provider_relationships.
 *
 * This is Phase 2 of the two-phase attribution system. Phase 1 (signal
 * capture) runs at job-creation time in the workflow layer. When the
 * customer_provider_relationships lookup fails transiently at creation time,
 * the job is stamped with commercial_origin = 'unknown_pending_resolution'
 * and attribution_status = 'pending'. This worker picks up those jobs and
 * resolves them asynchronously.
 *
 * ── Resolution logic ─────────────────────────────────────────────────────────
 *
 *   1. Missing customer_user_id or craftsman_user_id → transition to DLQ
 *      immediately with reason 'MISSING_USER_IDS'.  The worker cannot
 *      self-resolve a job whose identity anchors are absent.  Only operator
 *      action (Stage 4 RPC) can move it forward.
 *   2. Query customer_provider_relationships for the job's customer↔craftsman pair.
 *   3. Record found            → finalize with record.commercial_origin.
 *   4. No record, no DB error  → relationship definitively absent →
 *                                finalize as 'platform_acquired'.
 *   5. DB error                → increment retry_count.
 *                                  retry_count < MAX_RETRY_COUNT → mark 'retrying'
 *                                  retry_count ≥ MAX_RETRY_COUNT → transition to DLQ
 *                                                                  with reason 'MAX_RETRY_EXCEEDED'
 *
 * ── Concurrency: compare-and-swap ────────────────────────────────────────────
 *
 *   Every state-mutating UPDATE predicates on the snapshot this invocation
 *   read at sweep time (attribution_status + attribution_retry_count).  If a
 *   concurrent finalizer instance has already advanced the row, our UPDATE
 *   matches zero rows and we skip without writing.  Prevents the class of bug
 *   where overlapping cron invocations could regress a finalized job back to
 *   'retrying' or 'dlq'.
 *
 * ── Backoff schedule ──────────────────────────────────────────────────────────
 *
 *   retry_count 0  → eligible immediately (first attempt after creation)
 *   retry_count 1  → 1 minute
 *   retry_count 2  → 5 minutes
 *   retry_count 3  → 15 minutes
 *   retry_count 4  → 1 hour
 *   retry_count 5+ → 6 hours
 *
 *   At the 6h cadence, MAX_RETRY_COUNT=8 gives roughly 24h+ of autonomous
 *   retries (60s + 5m + 15m + 1h + 6h × 4 ≈ 25 h) before operator escalation.
 *
 * ── Invariants ────────────────────────────────────────────────────────────────
 *
 *   - DO NOT default to any origin on DB error.  Retry, then DLQ.
 *   - DO NOT permanently loop — unbounded retries are forbidden.  Every job
 *     either finalizes or ends in DLQ.
 *   - A job is eligible for payment ONLY after attribution_status = 'finalized'.
 *   - commercial_origin is immutable once finalized.
 *   - Every transition writes an attribution_audit_log row (non-fatal).
 *   - Every state UPDATE uses CAS on (status, retry_count) snapshot — no
 *     blind overwrites.
 *
 * ── Observability contract ───────────────────────────────────────────────────
 *
 *   cron.attribution_finalizer.started
 *   cron.attribution_finalizer.completed
 *   cron.attribution_finalizer.failed                    (fetch / auth failures)
 *   cron.attribution_finalizer.job_finalized             (info)
 *   cron.attribution_finalizer.job_retry_scheduled       (warning — still retryable)
 *   cron.attribution_finalizer.job_skipped_backoff       (info)
 *   cron.attribution_finalizer.job_dlq_entered           (ERROR — operator escalation)
 *   cron.attribution_finalizer.job_missing_ids           (ERROR — operator escalation)
 *   cron.attribution_finalizer.stale_snapshot_skip       (info — CAS no-op)
 *
 * ── Authentication ────────────────────────────────────────────────────────────
 *
 *   Validates `Authorization: Bearer <CRON_SECRET>` (Vercel Cron standard).
 *
 * ── Vercel Cron config (vercel.json) ─────────────────────────────────────────
 *
 *   { "path": "/api/cron/finalize-attribution", "schedule": "* /5 * * * *" }
 *   (remove the space between * and /5 — shown here to avoid ending this JSDoc block)
 *
 * ── Response (200) ────────────────────────────────────────────────────────────
 *
 *   { ok: true, swept: number, finalized: number, retried: number,
 *     skipped: number, missingIds: number, dlq: number, staleSkipped: number }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdminWithStatus } from '../_supabase.js'
import { requireCronAuth } from '../_cronAuth.js'
import { logInfo, logWarning, logError, withSentryFlush } from '../_observability.js'
import { writeAttributionAudit } from '../_attributionAudit.js'

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Maximum retry_count before a transient-DB-error job is escalated to DLQ.
 * At retry_count = 5 the backoff plateaus at 6 h, so MAX_RETRY_COUNT = 8 gives
 * roughly 24 h + of autonomous retrying before operator escalation.
 */
export const MAX_RETRY_COUNT = 8

export const DLQ_REASONS = {
  MISSING_USER_IDS: 'MISSING_USER_IDS',
  MAX_RETRY_EXCEEDED: 'MAX_RETRY_EXCEEDED',
} as const

// ── Backoff ───────────────────────────────────────────────────────────────────

function backoffSeconds(retryCount: number): number {
  if (retryCount <= 0) return 0
  if (retryCount === 1) return 60        //  1 minute
  if (retryCount === 2) return 300       //  5 minutes
  if (retryCount === 3) return 900       // 15 minutes
  if (retryCount === 4) return 3_600     //  1 hour
  return 21_600                          //  6 hours
}

function isEligible(retryCount: number, lastRetryAt: string | null): boolean {
  const backoff = backoffSeconds(retryCount)
  if (backoff === 0) return true
  if (!lastRetryAt) return true
  const elapsed = (Date.now() - new Date(lastRetryAt).getTime()) / 1000
  return elapsed >= backoff
}

// ── DLQ transition helper ────────────────────────────────────────────────────

type StateTransitionOutcome = 'transitioned' | 'db_error' | 'stale_snapshot'

/**
 * Transitions a job to attribution_status='dlq' with an explicit reason.
 *
 * Compare-and-swap: the UPDATE predicates on the expected
 * (attribution_status, attribution_retry_count) snapshot.  If a concurrent
 * finalizer already advanced the row past that snapshot — including an
 * already-successful finalize — the UPDATE matches zero rows and the call
 * returns `'stale_snapshot'` without writing audit or Sentry.  Prevents the
 * overlap bug where a later finalizer could roll back an earlier finalize.
 *
 * Writes the corresponding audit-log row and emits a Sentry-routed error
 * event only on `'transitioned'`.  Non-blocking — audit-write failures are
 * logged, not fatal.
 *
 * Returns:
 *   'transitioned'   — DLQ write landed, audit + Sentry emitted
 *   'stale_snapshot' — another finalizer already advanced the row, no-op
 *   'db_error'       — Supabase error, leaves row untouched for next sweep
 */
async function transitionJobToDlq(
  supabase: SupabaseClient,
  params: {
    jobId: string
    fromStatus: string
    retryCount: number
    reason: keyof typeof DLQ_REASONS
    metadata?: Record<string, unknown>
  },
): Promise<StateTransitionOutcome> {
  const nowIso = new Date().toISOString()

  const { data: updatedRows, error } = await supabase
    .from('jobs')
    .update({
      attribution_status: 'dlq',
      attribution_dlq_reason: params.reason,
      attribution_last_retry_at: nowIso,
    })
    .eq('id', params.jobId)
    .eq('attribution_status', params.fromStatus)
    .eq('attribution_retry_count', params.retryCount)
    .select('id')

  if (error) {
    logWarning('cron.attribution_finalizer.dlq_update_failed', {
      jobId: params.jobId,
      reason: params.reason,
      dbError: error.message,
    })
    return 'db_error'
  }

  if (!updatedRows || updatedRows.length === 0) {
    // CAS miss: another invocation beat us to this row.  Never re-insert a
    // possibly-finalized job into DLQ.
    logInfo('cron.attribution_finalizer.stale_snapshot_skip', {
      jobId: params.jobId,
      intendedTransition: 'dlq',
      expectedFromStatus: params.fromStatus,
      expectedRetryCount: params.retryCount,
      reason: params.reason,
    })
    return 'stale_snapshot'
  }

  await writeAttributionAudit(supabase, {
    jobId: params.jobId,
    eventType: 'dlq_entered',
    fromStatus: params.fromStatus,
    toStatus: 'dlq',
    retryCount: params.retryCount,
    reason: params.reason,
    metadata: params.metadata ?? null,
  })

  // ERROR-level so Sentry captures it as a distinct, operator-actionable event.
  logError(
    'cron.attribution_finalizer.job_dlq_entered',
    new Error(`Attribution DLQ: ${params.reason}`),
    {
      jobId: params.jobId,
      fromStatus: params.fromStatus,
      retryCount: params.retryCount,
      reason: params.reason,
      action: 'OPERATOR_ACTION_REQUIRED — resolve via /api/operator/resolve-attribution',
      ...(params.metadata ?? {}),
    },
  )

  return 'transitioned'
}

// ── Handler ───────────────────────────────────────────────────────────────────

async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  if (!requireCronAuth(req, res)) return

  const adminResult = getSupabaseAdminWithStatus()
  if (adminResult.ok === false) {
    logError(
      'cron.attribution_finalizer.failed',
      new Error('Supabase admin client unavailable'),
      { missing: adminResult.missing },
    )
    res.status(503).json({ error: 'Supabase admin client unavailable', missing: adminResult.missing })
    return
  }

  const supabase = adminResult.client

  logInfo('cron.attribution_finalizer.started', {})

  // ── Fetch pending/retrying jobs ──────────────────────────────────────────
  // DLQ rows are excluded by design: only operator action can move them.
  const { data: jobs, error: fetchError } = await supabase
    .from('jobs')
    .select('id, customer_user_id, craftsman_user_id, attribution_status, attribution_retry_count, attribution_last_retry_at, commercial_origin')
    .in('attribution_status', ['pending', 'retrying'])
    .order('attribution_last_retry_at', { ascending: true, nullsFirst: true })
    .limit(100)

  if (fetchError) {
    logError('cron.attribution_finalizer.failed', fetchError, {
      reason: 'could not fetch pending jobs',
    })
    res.status(503).json({ error: 'Failed to fetch pending attribution jobs', detail: fetchError.message })
    return
  }

  const swept = jobs?.length ?? 0
  let finalized = 0
  let retried = 0
  let skipped = 0
  let missingIds = 0
  let dlq = 0
  let staleSkipped = 0

  for (const job of jobs ?? []) {
    const jobId: string = job.id
    const currentStatus: string = job.attribution_status ?? 'pending'
    const currentOrigin: string | null = (job.commercial_origin as string | null) ?? null
    const customerUserId: string | null = job.customer_user_id ?? null
    const craftsmanUserId: string | null = job.craftsman_user_id ?? null
    const retryCount: number = job.attribution_retry_count ?? 0
    const lastRetryAt: string | null = job.attribution_last_retry_at ?? null

    // ── Guard: missing IDs → DLQ immediately ─────────────────────────────
    if (!customerUserId || !craftsmanUserId) {
      missingIds++
      const outcome = await transitionJobToDlq(supabase, {
        jobId,
        fromStatus: currentStatus,
        retryCount,
        reason: 'MISSING_USER_IDS',
        metadata: {
          customerUserId,
          craftsmanUserId,
          note: 'job cannot be resolved without both user IDs',
        },
      })
      if (outcome === 'transitioned') dlq++
      if (outcome === 'stale_snapshot') staleSkipped++
      continue
    }

    // ── Backoff check ─────────────────────────────────────────────────────
    if (!isEligible(retryCount, lastRetryAt)) {
      logInfo('cron.attribution_finalizer.job_skipped_backoff', {
        jobId,
        retryCount,
        lastRetryAt,
        nextEligibleInSeconds: backoffSeconds(retryCount),
      })
      skipped++
      continue
    }

    // ── Relationship lookup ───────────────────────────────────────────────
    const { data: relRow, error: relError } = await supabase
      .from('customer_provider_relationships')
      .select('commercial_origin')
      .eq('customer_user_id', customerUserId)
      .eq('craftsman_user_id', craftsmanUserId)
      .maybeSingle()

    if (relError) {
      const nextRetry = retryCount + 1

      // ── Max-retry escalation → DLQ ─────────────────────────────────────
      if (nextRetry > MAX_RETRY_COUNT) {
        const outcome = await transitionJobToDlq(supabase, {
          jobId,
          fromStatus: currentStatus,
          retryCount,
          reason: 'MAX_RETRY_EXCEEDED',
          metadata: {
            lastError: relError.message,
            maxRetryCount: MAX_RETRY_COUNT,
          },
        })
        if (outcome === 'transitioned') dlq++
        if (outcome === 'stale_snapshot') staleSkipped++
        continue
      }

      // ── Normal retry increment (CAS) ───────────────────────────────────
      const nowIso = new Date().toISOString()
      const { data: retryRows, error: updateError } = await supabase
        .from('jobs')
        .update({
          attribution_status: 'retrying',
          attribution_retry_count: nextRetry,
          attribution_last_retry_at: nowIso,
        })
        .eq('id', jobId)
        .eq('attribution_status', currentStatus)
        .eq('attribution_retry_count', retryCount)
        .select('id')

      if (updateError) {
        logWarning('cron.attribution_finalizer.job_retry_update_failed', {
          jobId,
          reason: updateError.message,
        })
        // Still count as retried — next sweep picks it up.
        retried++
        continue
      }

      if (!retryRows || retryRows.length === 0) {
        // CAS miss: another finalizer already advanced this row.  Skip
        // without audit/log-as-retry so counters reflect reality.
        logInfo('cron.attribution_finalizer.stale_snapshot_skip', {
          jobId,
          intendedTransition: 'retrying',
          expectedFromStatus: currentStatus,
          expectedRetryCount: retryCount,
          reason: relError.message,
        })
        staleSkipped++
        continue
      }

      await writeAttributionAudit(supabase, {
        jobId,
        eventType: 'retry_incremented',
        fromStatus: currentStatus,
        toStatus: 'retrying',
        retryCount: nextRetry,
        reason: relError.message,
      })

      logWarning('cron.attribution_finalizer.job_retry_scheduled', {
        jobId,
        retryCount: nextRetry,
        reason: relError.message,
      })

      retried++
      continue
    }

    // ── Finalize (CAS) ────────────────────────────────────────────────────
    // No DB error:
    //   relRow != null → use the stored commercial_origin (merchant_brought or platform_acquired)
    //   relRow == null → relationship definitively absent → platform_acquired
    const resolvedOrigin: string = relRow?.commercial_origin ?? 'platform_acquired'
    const finalizeSource: 'relationship_record' | 'definitively_absent' = relRow
      ? 'relationship_record'
      : 'definitively_absent'

    const { data: finalizeRows, error: finalizeError } = await supabase
      .from('jobs')
      .update({
        commercial_origin: resolvedOrigin,
        attribution_status: 'finalized',
        attribution_last_retry_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .eq('attribution_status', currentStatus)
      .eq('attribution_retry_count', retryCount)
      .select('id')

    if (finalizeError) {
      logWarning('cron.attribution_finalizer.job_finalize_write_failed', {
        jobId,
        resolvedOrigin,
        reason: finalizeError.message,
        action: 'will retry on next sweep',
      })
      retried++
      continue
    }

    if (!finalizeRows || finalizeRows.length === 0) {
      // CAS miss: another finalizer already finalized / DLQ-escalated this row.
      // Skipping is correct — do NOT overwrite whatever authoritative state the
      // other invocation persisted.
      logInfo('cron.attribution_finalizer.stale_snapshot_skip', {
        jobId,
        intendedTransition: 'finalized',
        expectedFromStatus: currentStatus,
        expectedRetryCount: retryCount,
        resolvedOrigin,
      })
      staleSkipped++
      continue
    }

    await writeAttributionAudit(supabase, {
      jobId,
      eventType: relRow ? 'finalize_auto' : 'finalize_absent',
      fromStatus: currentStatus,
      toStatus: 'finalized',
      fromOrigin: currentOrigin,
      toOrigin: resolvedOrigin,
      retryCount,
      metadata: { source: finalizeSource },
    })

    logInfo('cron.attribution_finalizer.job_finalized', {
      jobId,
      resolvedOrigin,
      retryCount,
      source: finalizeSource,
    })
    finalized++
  }

  logInfo('cron.attribution_finalizer.completed', {
    swept,
    finalized,
    retried,
    skipped,
    missingIds,
    dlq,
    staleSkipped,
  })

  res.status(200).json({ ok: true, swept, finalized, retried, skipped, missingIds, dlq, staleSkipped })
}

export default withSentryFlush(handler)
