/**
 * Server-side payment reconciliation helper for scheduled cron jobs.
 *
 * This module queries Supabase directly for payments in risky (non-terminal)
 * states that have a Stripe provider_ref, then fetches the actual PaymentIntent
 * status from Stripe and applies safe, forward-only state corrections.
 *
 * Design choices:
 *   - Only processes payments with a provider_ref (Stripe is involved)
 *   - Only processes non-terminal states (deposit_required → release_pending)
 *   - Advances state only when a clear safe path exists (recoverable)
 *   - Never rolls back state or touches already-terminal rows
 *   - Bounded batch size per run to avoid long DB/Stripe round-trips
 *   - Returns a structured summary (checked / recovered / inconsistent / failed)
 *
 * Reuses the pure `derivePaymentReconciliationStatus` function from the
 * client-side reconciliation module to keep business logic in one place.
 *
 * Emitted observability events (via api/_observability.ts):
 *   cron.payment_reconciliation.started
 *   cron.payment_reconciliation.payment_aligned
 *   cron.payment_reconciliation.payment_recovered
 *   cron.payment_reconciliation.payment_inconsistent
 *   cron.payment_reconciliation.payment_failed
 *   cron.payment_reconciliation.completed
 *   cron.payment_reconciliation.fetch_failed
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { logInfo, logWarning, logError } from './_observability.js'
import { derivePaymentReconciliationStatus } from '../src/lib/payments/reconciliation/deriveReconciliationStatus.js'
import type { Payment } from '../src/lib/payments/types.js'
import type { StripePaymentSnapshot } from '../src/lib/payments/reconciliation/types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of payments reconciled per cron run.
 * Prevents the job from running over the Vercel function timeout.
 */
export const RECONCILIATION_BATCH_LIMIT = 50

/**
 * Non-terminal payment states that warrant reconciliation against Stripe.
 * Terminal states (released, refunded) are never reconsidered automatically.
 *
 * 'disputed' is deliberately excluded: disputed payments belong to the
 * dispute-resolution domain, not Stripe reconciliation.  A disputed payment
 * may only be exited through the dispute workflow (stateMachine.ts) — the
 * cron must never auto-advance it to released/refunded from provider truth.
 */
export const RISKY_PAYMENT_STATES = [
  'deposit_required',
  'deposit_paid',
  'in_escrow',
  'work_in_progress',
  'release_pending',
] as const

// ---------------------------------------------------------------------------
// Row type (DB shape; provider_ref maps to Payment.providerRef)
// ---------------------------------------------------------------------------

interface PaymentRow {
  id: string
  job_id: string
  status: string
  provider_ref: string | null
  total_amount: number
  deposit_amount: number
  final_amount: number
  created_at: number
  updated_at: number
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface PaymentReconciliationSummary {
  /** Total non-terminal payments with provider_ref queried. */
  checked: number
  /** Payments already consistent with Stripe — no action taken. */
  aligned: number
  /** Payments advanced to the correct state from Stripe data. */
  recovered: number
  /** Payments with detected mismatch that cannot be auto-resolved. */
  inconsistent: number
  /** Payments that failed to process (Stripe/DB error). */
  failed: number
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Queries Supabase for payments in risky non-terminal states that have a
 * Stripe provider_ref, then reconciles each against Stripe's live status.
 *
 * @param supabase   - Service-role Supabase client (bypasses RLS)
 * @param stripe     - Stripe client (initialised with secret key)
 * @param options    - Optional overrides for batch limit
 */
export async function reconcileRiskyPayments(
  supabase: SupabaseClient,
  stripe: Stripe,
  options?: { batchLimit?: number },
): Promise<PaymentReconciliationSummary> {
  const batchLimit = options?.batchLimit ?? RECONCILIATION_BATCH_LIMIT

  const summary: PaymentReconciliationSummary = {
    checked: 0,
    aligned: 0,
    recovered: 0,
    inconsistent: 0,
    failed: 0,
  }

  logInfo('cron.payment_reconciliation.started', { batchLimit })

  // 1. Fetch non-terminal payments with a Stripe provider_ref.
  const { data, error: fetchError } = await supabase
    .from('payments')
    .select('id, job_id, status, provider_ref, total_amount, deposit_amount, final_amount, created_at, updated_at')
    .in('status', [...RISKY_PAYMENT_STATES])
    .not('provider_ref', 'is', null)
    .order('created_at', { ascending: true })
    .limit(batchLimit)

  if (fetchError) {
    logError('cron.payment_reconciliation.fetch_failed', new Error(fetchError.message), {
      reason: 'failed to query risky payments',
    })
    return summary
  }

  if (!data || data.length === 0) {
    logInfo('cron.payment_reconciliation.completed', {
      ...summary,
      note: 'no risky payments with provider_ref found',
    })
    return summary
  }

  summary.checked = data.length

  // 2. Reconcile each payment individually so a single failure does not block others.
  for (const row of data as PaymentRow[]) {
    try {
      await reconcileSinglePayment(supabase, stripe, row, summary)
    } catch (err) {
      summary.failed++
      logError('cron.payment_reconciliation.payment_failed', err, {
        paymentId: row.id,
        jobId: row.job_id,
        state: row.status,
        providerRef: row.provider_ref,
        reason: 'unexpected error during reconciliation',
      })
    }
  }

  logInfo('cron.payment_reconciliation.completed', { ...summary })
  return summary
}

// ---------------------------------------------------------------------------
// Per-payment helper
// ---------------------------------------------------------------------------

async function reconcileSinglePayment(
  supabase: SupabaseClient,
  stripe: Stripe,
  row: PaymentRow,
  summary: PaymentReconciliationSummary,
): Promise<void> {
  // Build a Payment object from the DB row (adapts snake_case → camelCase).
  const payment: Payment = {
    id: row.id,
    jobId: row.job_id,
    state: row.status as Payment['state'],
    providerRef: row.provider_ref ?? undefined,
    amounts: {
      totalAmount: row.total_amount,
      depositAmount: row.deposit_amount,
      finalAmount: row.final_amount,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }

  // Fetch live Stripe status.
  let stripeSnapshot: StripePaymentSnapshot
  try {
    const intent = await stripe.paymentIntents.retrieve(row.provider_ref!)
    stripeSnapshot = {
      paymentIntentId: intent.id,
      stripeStatus: intent.status,
      amountCapturable: intent.amount_capturable,
      amountReceived: intent.amount_received,
      currency: intent.currency,
    }
  } catch (stripeErr) {
    summary.failed++
    logError('cron.payment_reconciliation.payment_failed', stripeErr, {
      paymentId: row.id,
      jobId: row.job_id,
      providerRef: row.provider_ref,
      reason: 'stripe_retrieve_failed',
    })
    return
  }

  // Derive reconciliation result (pure, no I/O).
  const result = derivePaymentReconciliationStatus(payment, stripeSnapshot)

  switch (result.status) {
    case 'aligned':
    case 'no_provider_ref':
    case 'not_found':
      summary.aligned++
      logInfo('cron.payment_reconciliation.payment_aligned', {
        paymentId: row.id,
        jobId: row.job_id,
        dbState: result.dbState,
        stripeStatus: stripeSnapshot.stripeStatus,
        note: result.note,
      })
      break

    case 'recoverable': {
      if (!result.recommendedState) {
        // Should not happen: recoverable always has a recommendedState.
        summary.inconsistent++
        logWarning('cron.payment_reconciliation.payment_inconsistent', {
          paymentId: row.id,
          note: 'recoverable result missing recommendedState',
        })
        break
      }

      const { error: updateError } = await supabase
        .from('payments')
        .update({ status: result.recommendedState, updated_at: Date.now() })
        .eq('id', row.id)
        .eq('status', row.status) // optimistic concurrency: only update if state unchanged

      if (updateError) {
        summary.failed++
        logError('cron.payment_reconciliation.payment_failed', new Error(updateError.message), {
          paymentId: row.id,
          jobId: row.job_id,
          dbState: result.dbState,
          recommendedState: result.recommendedState,
          reason: 'db_update_failed',
        })
      } else {
        summary.recovered++
        logInfo('cron.payment_reconciliation.payment_recovered', {
          paymentId: row.id,
          jobId: row.job_id,
          previousState: result.dbState,
          newState: result.recommendedState,
          stripeStatus: stripeSnapshot.stripeStatus,
          note: result.note,
        })

        // Downstream sync: mirror the recovered payment state to the linked
        // job and project, just like the webhook's reconcileJobFromPayment.
        // Without this, cron recovery would leave downstream truth stale.
        if (row.job_id && (result.recommendedState === 'released' || result.recommendedState === 'refunded')) {
          await syncJobAndProjectFromCronRecovery(
            supabase, row.job_id, result.recommendedState, row.id,
          )
        }
      }
      break
    }

    case 'inconsistent':
    default:
      summary.inconsistent++
      logWarning('cron.payment_reconciliation.payment_inconsistent', {
        paymentId: row.id,
        jobId: row.job_id,
        dbState: result.dbState,
        stripeStatus: stripeSnapshot.stripeStatus,
        note: result.note,
      })
      break
  }
}

// ---------------------------------------------------------------------------
// Downstream sync helper for cron recovery
// ---------------------------------------------------------------------------

/**
 * Mirrors the webhook's reconcileJobFromPayment logic for cron-recovered
 * payments.  Updates jobs.payment_state and projects.payment_state to match
 * the recovered terminal state.
 *
 * Best-effort: failures are logged but do not affect the reconciliation
 * summary.  The same pattern is used by the webhook handler.
 */
async function syncJobAndProjectFromCronRecovery(
  supabase: SupabaseClient,
  jobId: string,
  targetPaymentState: 'released' | 'refunded',
  paymentId: string,
): Promise<void> {
  // Fetch job to check status and get project_id
  const { data: jobData, error: jobFetchError } = await supabase
    .from('jobs')
    .select('status, project_id')
    .eq('id', jobId)
    .maybeSingle()

  if (jobFetchError || !jobData) {
    logWarning('cron.payment_reconciliation.downstream_sync_failed', {
      paymentId,
      jobId,
      reason: jobFetchError ? 'failed to fetch job' : 'job not found',
    })
    return
  }

  const jobRow = jobData as { status: string; project_id: string | null }

  // Update job.payment_state; advance to 'completed' from 'waiting_payment'
  const jobUpdate: Record<string, unknown> = {
    payment_state: targetPaymentState,
  }
  if (jobRow.status === 'waiting_payment') {
    jobUpdate.status = 'completed'
    if (targetPaymentState === 'released') {
      jobUpdate.payment_released_at = Date.now()
    }
  }

  const { error: jobUpdateError } = await supabase
    .from('jobs')
    .update(jobUpdate)
    .eq('id', jobId)

  if (jobUpdateError) {
    logError('cron.payment_reconciliation.downstream_sync_failed', new Error(jobUpdateError.message), {
      paymentId,
      jobId,
      targetPaymentState,
      reason: 'job payment_state sync failed',
    })
  } else {
    logInfo('cron.payment_reconciliation.downstream_synced', {
      paymentId,
      jobId,
      paymentState: targetPaymentState,
      jobStatus: jobUpdate.status ?? 'unchanged',
    })
  }

  // Sync project.payment_state
  const projectId = jobRow.project_id
  if (projectId) {
    const { error: projectUpdateError } = await supabase
      .from('projects')
      .update({ payment_state: targetPaymentState })
      .eq('id', projectId)

    if (projectUpdateError) {
      logError('cron.payment_reconciliation.downstream_sync_failed', new Error(projectUpdateError.message), {
        paymentId,
        jobId,
        projectId,
        targetPaymentState,
        reason: 'project payment_state sync failed',
      })
    } else {
      logInfo('cron.payment_reconciliation.project_synced', {
        paymentId,
        jobId,
        projectId,
        paymentState: targetPaymentState,
      })
    }
  }
}