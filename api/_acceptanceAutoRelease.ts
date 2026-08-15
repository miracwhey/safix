/**
 * Server-side acceptance auto-release logic.
 *
 * Finds all acceptances in 'pending' status whose expires_at deadline has
 * passed. For each, releases the final_release tranche via the canonical
 * release-tranche endpoint (same path as manual customer confirmation).
 *
 * Guards:
 *   - Acceptance must be 'pending' with expires_at <= now
 *   - Active blocking dispute prevents release (checked by release-tranche)
 *   - Already-released tranches are idempotent no-ops
 *   - Acceptance is transitioned to 'accepted' with acceptedAt = now
 *     (auto-release is treated as implicit acceptance)
 *
 * Concurrency safety:
 *   - The status update uses an optimistic guard: only update if still 'pending'
 *   - Stripe Transfer idempotency key prevents duplicate transfers
 *   - If customer confirms while cron runs, one path wins — the other is a no-op
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logInfo, logWarning, logError } from './_observability.js'
import { emitAutoReleasedSignal } from './_acceptanceReminder.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutoReleaseSummary = {
  /** Number of expired pending acceptances found */
  checked: number
  /** Successfully auto-released */
  released: number
  /** Blocked by dispute */
  disputeBlocked: number
  /** Blocked because commercial attribution is not finalized (pending / retrying / dlq / invalid) */
  attributionBlocked: number
  /** Failed (transfer or DB error) */
  failed: number
  /** Already processed (acceptance no longer pending) */
  alreadyProcessed: number
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

const BATCH_LIMIT = 50

export async function autoReleaseExpiredAcceptances(
  supabase: SupabaseClient,
  releaseConfirmSecret: string,
  baseUrl: string,
): Promise<AutoReleaseSummary> {
  const summary: AutoReleaseSummary = {
    checked: 0,
    released: 0,
    disputeBlocked: 0,
    attributionBlocked: 0,
    failed: 0,
    alreadyProcessed: 0,
  }

  // ── 1. Query expired pending acceptances ──────────────────────────────────
  const nowMs = Date.now()
  const { data: expiredAcceptances, error: fetchError } = await supabase
    .from('acceptances')
    .select('id, job_id, customer_user_id, status, expires_at')
    .eq('status', 'pending')
    .not('expires_at', 'is', null)
    .lte('expires_at', nowMs)
    .order('expires_at', { ascending: true })
    .limit(BATCH_LIMIT)

  if (fetchError) {
    logError('auto_release.fetch_failed', fetchError)
    throw new Error(`Failed to query expired acceptances: ${fetchError.message}`)
  }

  if (!expiredAcceptances || expiredAcceptances.length === 0) {
    logInfo('auto_release.none_expired', { checked: 0 })
    return summary
  }

  summary.checked = expiredAcceptances.length

  // ── 2. For each expired acceptance, release the final tranche ─────────────
  for (const acceptance of expiredAcceptances) {
    const jobId = acceptance.job_id

    // ── 2a. Find the escrow plan + final tranche for this job ───────────────
    const { data: plan, error: planError } = await supabase
      .from('escrow_payment_plans')
      .select('id')
      .eq('job_id', jobId)
      .maybeSingle()

    if (planError || !plan) {
      logWarning('auto_release.no_escrow_plan', {
        acceptanceId: acceptance.id,
        jobId,
        error: planError?.message,
      })
      summary.failed++
      continue
    }

    const { data: finalTranche, error: trancheError } = await supabase
      .from('escrow_tranches')
      .select('id, status')
      .eq('plan_id', plan.id)
      .eq('kind', 'final_release')
      .maybeSingle()

    if (trancheError || !finalTranche) {
      logWarning('auto_release.no_final_tranche', {
        acceptanceId: acceptance.id,
        jobId,
        planId: plan.id,
        error: trancheError?.message,
      })
      summary.failed++
      continue
    }

    // ── 2b. Idempotent guard: tranche already released ──────────────────────
    if (finalTranche.status === 'released') {
      logInfo('auto_release.tranche_already_released', {
        acceptanceId: acceptance.id,
        jobId,
        trancheId: finalTranche.id,
      })
      // Still mark the acceptance as accepted if it's pending
      await markAcceptanceAutoAccepted(supabase, acceptance.id)
      summary.alreadyProcessed++
      continue
    }

    // ── 2c. Guard: tranche must be eligible ─────────────────────────────────
    if (finalTranche.status !== 'eligible_for_release' && finalTranche.status !== 'release_pending') {
      logWarning('auto_release.tranche_not_eligible', {
        acceptanceId: acceptance.id,
        jobId,
        trancheId: finalTranche.id,
        trancheStatus: finalTranche.status,
      })
      summary.failed++
      continue
    }

    // ── 2d. Call release-tranche endpoint (same path as manual release) ─────
    try {
      const response = await fetch(`${baseUrl}/api/release-tranche`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-release-confirm-secret': releaseConfirmSecret,
        },
        body: JSON.stringify({
          trancheId: finalTranche.id,
          planId: plan.id,
          actor: 'system',
        }),
      })

      const body = await response.json().catch(() => ({ error: 'Unparseable response' })) as Record<string, unknown>

      if (!response.ok) {
        // Attribution-blocked is a distinct outcome — payment is held back
        // because the Attribution Finalizer has not finalised the job yet or
        // the row is in DLQ.  Cron is not allowed to auto-release without
        // finalized attribution; this is expected behaviour, not a failure.
        // Acceptance stays 'pending' so the next cron tick retries after the
        // finalizer resolves the row (or operator resolves DLQ).
        //
        // The guard emits attribution blocks with MIXED HTTP status codes:
        //   402 — PAYMENT_BLOCKED_ATTRIBUTION_{UNRESOLVED|DLQ|INVALID|JOB_NOT_FOUND}
        //   500 — ATTRIBUTION_LOOKUP_FAILED  (guard-layer DB error — still a
        //         retryable attribution-block semantic, not a generic failure)
        // Match on the error code rather than the status so both flavours are
        // counted correctly.
        const attributionBlockCodes = new Set([
          'PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED',
          'PAYMENT_BLOCKED_ATTRIBUTION_DLQ',
          'PAYMENT_BLOCKED_ATTRIBUTION_INVALID',
          'PAYMENT_BLOCKED_JOB_NOT_FOUND',
          'ATTRIBUTION_LOOKUP_FAILED',
        ])
        if (typeof body.error === 'string' && attributionBlockCodes.has(body.error)) {
          logInfo('auto_release.attribution_blocked', {
            acceptanceId: acceptance.id,
            jobId,
            trancheId: finalTranche.id,
            attributionCode: body.error,
            httpStatus: response.status,
            attributionStatus: (body as { attributionStatus?: string }).attributionStatus,
            dlqReason: (body as { dlqReason?: string | null }).dlqReason,
          })
          summary.attributionBlocked++
          continue
        }

        // Check if blocked by dispute
        if (body.error === 'DISPUTE_BLOCKING' || response.status === 409) {
          logInfo('auto_release.dispute_blocked', {
            acceptanceId: acceptance.id,
            jobId,
            trancheId: finalTranche.id,
            disputeId: body.disputeId,
          })
          summary.disputeBlocked++
          continue
        }

        logWarning('auto_release.release_failed', {
          acceptanceId: acceptance.id,
          jobId,
          trancheId: finalTranche.id,
          status: response.status,
          error: body.error,
        })
        summary.failed++
        continue
      }

      // ── 2e. Mark acceptance as accepted (implicit acceptance via deadline) ──
      await markAcceptanceAutoAccepted(supabase, acceptance.id)

      // ── 2f. Craftsman-targeted notification (Block 7.2.1e). Distinct from
      // the generic `payment_released` event so the recipient sees that the
      // release was deadline-driven, not a customer action.
      await emitAutoReleasedSignal(supabase, {
        acceptanceId: acceptance.id,
        jobId,
        occurredAt: Date.now(),
      })

      logInfo('auto_release.success', {
        acceptanceId: acceptance.id,
        jobId,
        trancheId: finalTranche.id,
        transferId: body.externalReleaseRef,
      })
      summary.released++
    } catch (err) {
      logError('auto_release.unexpected_error', err instanceof Error ? err : undefined, {
        acceptanceId: acceptance.id,
        jobId,
        trancheId: finalTranche.id,
      })
      summary.failed++
    }
  }

  return summary
}

// ---------------------------------------------------------------------------
// Helper: mark acceptance as auto-accepted
// ---------------------------------------------------------------------------

async function markAcceptanceAutoAccepted(
  supabase: SupabaseClient,
  acceptanceId: string,
): Promise<void> {
  const nowMs = Date.now()
  const { error } = await supabase
    .from('acceptances')
    .update({
      status: 'accepted',
      accepted_at: nowMs,
      notes: 'Automatisch akzeptiert nach Ablauf der 72-Stunden-Frist.',
      updated_at: nowMs,
    })
    .eq('id', acceptanceId)
    .eq('status', 'pending') // Optimistic concurrency guard

  if (error) {
    logWarning('auto_release.acceptance_update_failed', {
      acceptanceId,
      error: error.message,
    })
  }
}
