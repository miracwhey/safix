import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from './_supabase.js'
import { logInfo, logWarning, logError, withSentryFlush } from './_observability.js'
import {
  isValidWebhookTransition,
  type ReconcileTarget,
} from './_webhookHelpers.js'
import { releaseSupplementaryPayout } from './_releaseSupplementaryPayout.js'
import { executeEscrowRefundForIntent } from './_escrowRefundService.js'
import { deliverNotificationEmailServer } from './_emailDelivery.js'
import {
  deriveJobsFullyPaidOut as deriveJobsFullyPaidOutPure,
  buildPayoutCompletedSignalIds,
} from '../src/lib/payments/payoutEmailGate.js'

// ---------------------------------------------------------------------------
// Stripe client singleton
// ---------------------------------------------------------------------------

let stripeClient: Stripe | null = null

function getStripe(secretKey: string): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(secretKey)
  }
  return stripeClient
}

// ---------------------------------------------------------------------------
// Raw body reader (required for Stripe signature verification)
// ---------------------------------------------------------------------------

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk)
      } else {
        chunks.push(Buffer.from(String(chunk)))
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Local type alias
// ---------------------------------------------------------------------------

type ReconcileOutcome = 'reconciled' | 'skipped' | 'not_found' | 'failed'

// ---------------------------------------------------------------------------
// Webhook event deduplication — claim-first pattern
//
// The stripe_webhook_events table has event_id TEXT PRIMARY KEY.
// We exploit this constraint for atomic deduplication:
//
//   1. claimWebhookEvent  — INSERT with outcome='processing' before any writes.
//                           If the INSERT conflicts (PK), the event was already
//                           claimed by a concurrent delivery → skip immediately.
//   2. finalizeWebhookEvent — UPDATE the row to the terminal outcome after
//                             reconciliation (success, skipped, or failed).
//
// This replaces the previous read-before-write (SELECT → check → UPDATE)
// pattern, which had a small TOCTOU window under concurrent Stripe retries.
// ---------------------------------------------------------------------------

// PostgreSQL error code for unique constraint violation (PK / UNIQUE conflict).
// Supabase passes through the underlying Postgres error codes unchanged.
const PG_UNIQUE_VIOLATION = '23505'

/**
 * Thrown by claimWebhookEvent when the claim INSERT fails with a real
 * (non-PK-conflict) DB error. The top-level handler catches this and returns
 * HTTP 500 so Stripe retries the whole event: a DB error at claim time means
 * we cannot guarantee deduplication, and proceeding to write payment state
 * against a flaky DB is unsafe. A retry re-attempts the claim once the DB
 * recovers — the claim/finalize protocol makes the replay idempotent.
 */
class WebhookClaimError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebhookClaimError'
  }
}

/**
 * Attempts to atomically claim a Stripe event for processing by inserting
 * a 'processing' row into stripe_webhook_events.
 *
 * Returns:
 *   'claimed'   — INSERT succeeded (or a re-claim of a non-finalized row); this
 *                 delivery owns the processing slot.
 *   'duplicate' — PK conflict against a terminally-finalized row; another
 *                 delivery already reconciled this event → skip.
 *
 * Throws WebhookClaimError on any other (non-23505) DB error so the caller can
 * surface a 500 for Stripe to retry — never swallowed as an optimistic proceed.
 */
async function claimWebhookEvent(
  supabase: SupabaseClient,
  eventId: string,
  eventType: string,
  paymentIntentId: string | null,
): Promise<'claimed' | 'duplicate'> {
  const { error } = await supabase.from('stripe_webhook_events').insert({
    event_id: eventId,
    // stripe_event_id is NOT NULL with no default — must be supplied explicitly.
    // It carries the same Stripe event ID value used for deduplication.
    stripe_event_id: eventId,
    event_type: eventType,
    payment_intent_id: paymentIntentId,
    outcome: 'processing',
    processed_at: new Date().toISOString(),
  })

  if (!error) return 'claimed'

  // PK conflict — a row for this event already exists.
  if (error.code === PG_UNIQUE_VIOLATION) {
    // Re-claim the row if the prior attempt never reconciled it — either it
    // finalized as 'failed', or the cleanup job marked it 'processing_expired'
    // (the original handler was interrupted after claiming but before
    // finalizing, so no payment state was ever written). Both are safe to
    // re-process: flip the row back to 'processing' and let this delivery own
    // it. Rows with any other terminal outcome ('reconciled', 'skipped', etc.)
    // remain duplicates.
    const { data: updated } = await supabase
      .from('stripe_webhook_events')
      .update({
        outcome: 'processing',
        processed_at: new Date().toISOString(),
      })
      .eq('event_id', eventId)
      .in('outcome', ['failed', 'processing_expired'])
      .select('event_id')

    if (updated && updated.length > 0) {
      logInfo('webhook.stripe.reclaimed', {
        eventId,
        eventType,
        note: 'non-finalized event (failed / processing_expired) re-claimed for retry',
      })
      return 'claimed'
    }

    return 'duplicate'
  }

  // Any other DB error is a real failure — do NOT proceed optimistically.
  // Throw so the handler returns 500 and Stripe retries the whole event once
  // the DB recovers; the claim/finalize protocol keeps the replay idempotent.
  logError('webhook.stripe.failed', new Error(error.message), {
    eventId,
    eventType,
    reason: 'event claim INSERT failed — 500 for Stripe retry',
    detail: error.message,
  })
  throw new WebhookClaimError(error.message)
}

/**
 * Updates the stripe_webhook_events row (previously claimed as 'processing')
 * to its final outcome once reconciliation has completed.
 *
 * Non-fatal: UPDATE failures are logged but never affect the webhook response.
 */
async function finalizeWebhookEvent(
  supabase: SupabaseClient,
  eventId: string,
  outcome: string,
  paymentId: string | null,
  jobId: string | null,
  previousState: string | null,
  newState: string | null,
  failureReason?: string,
): Promise<void> {
  const payload: Record<string, unknown> = {
    outcome,
    payment_id: paymentId,
    job_id: jobId,
    previous_state: previousState,
    new_state: newState,
  }
  if (failureReason) {
    payload.failure_reason = failureReason
  }
  const { error } = await supabase
    .from('stripe_webhook_events')
    .update(payload)
    .eq('event_id', eventId)

  if (error) {
    logWarning('webhook.stripe.failed', {
      eventId,
      outcome,
      reason: 'audit finalize UPDATE failed',
      detail: error.message,
    })
  }
}

/**
 * Writes a log_only audit record for events that are acknowledged but
 * do not trigger any payment state reconciliation (payment_failed,
 * requires_action, refund.created, refund.failed).
 *
 * Uses upsert with ignoreDuplicates so repeated log-only events are harmless.
 */
async function auditLogOnly(
  supabase: SupabaseClient,
  eventId: string,
  eventType: string,
  paymentIntentId: string | null,
): Promise<void> {
  const { error } = await supabase.from('stripe_webhook_events').upsert(
    {
      event_id: eventId,
      stripe_event_id: eventId,
      event_type: eventType,
      payment_intent_id: paymentIntentId,
      outcome: 'log_only',
      processed_at: new Date().toISOString(),
    },
    { onConflict: 'event_id', ignoreDuplicates: true },
  )
  if (error) {
    logWarning('webhook.stripe.failed', {
      eventId,
      eventType,
      reason: 'audit log_only write failed',
      detail: error.message,
    })
  }
}

// ---------------------------------------------------------------------------
// Payout outcome → timeline fan-out
//
// A Stripe Payout on a Connected Account aggregates one or many prior
// Transfers. To surface payout-arrival truth per job for the provider, we
// walk the payout's balance transactions, resolve the underlying transfer
// metadata back to `escrow_tranches.external_release_ref`, and emit one
// `payout_completed` (or `payout_failed`) timeline signal per distinct
// owning job.
//
// The notification fan-out (in-app notification signal) is derived from
// the timeline signal client-side via `notificationBridge` using the
// config in `notificationConfig.ts` — no additional DB write is needed
// here. Ops alerting for payout.failed remains the existing `logError`
// with 'MANUAL REVIEW REQUIRED:' marker in the log payload.
// ---------------------------------------------------------------------------

type PayoutOutcomeEmitStatus =
  | 'ok'
  | 'skipped_no_connect_account'
  | 'skipped_no_transfers'
  | 'skipped_no_plans'
  | 'skipped_no_jobs'
  | 'failed_stripe_list'
  | 'failed_charge_lookup'
  | 'failed_tranches_lookup'
  | 'failed_plans_lookup'
  | 'failed_signal_insert'

type PayoutOutcomeEmitResult = {
  status: PayoutOutcomeEmitStatus
  /** True when the caller must NOT finalize the webhook event — Stripe will retry. */
  retryable: boolean
  /** Human-readable diagnostic for logs. */
  reason?: string
}

/**
 * Parses a platform escrow plan id from a Stripe `transfer_group`.
 * The SaFix release pipeline tags every Transfer with
 *   transfer_group: `escrow_plan_${planId}`
 * so a destination charge whose `source_transfer` is missing can still
 * be mapped to an owning plan — a strict lookup, no guessing.
 */
function parsePlanIdFromTransferGroup(transferGroup: string | null | undefined): string | null {
  if (!transferGroup) return null
  const match = /^escrow_plan_(.+)$/.exec(transferGroup)
  return match ? match[1] : null
}

/**
 * Resolves either a platform Transfer id (`tr_...`) or — as a defensive
 * fallback — a platform plan id out of a single balance transaction.
 *
 * Primary path: `type='transfer'` carries the Transfer id directly;
 * `type='payment'` (Connect separate-charges-and-transfers destination
 * charges) carries it as `charge.source_transfer`.
 *
 * Fallback path: when a destination charge has no `source_transfer`
 * (rare: Stripe returned a partially populated object, or the Transfer
 * was created without destination metadata), parse the platform plan id
 * from `charge.transfer_group`. The caller can then emit per-tranche
 * signals for every released tranche of that plan. Over-emits instead
 * of silently dropping the payout outcome.
 *
 * Returns `{ lookup_failed }` on a Stripe API error so the caller can
 * mark the whole emit as retryable.
 */
async function resolveTransferIdFromBalanceTx(
  stripeSdk: Stripe,
  bt: Stripe.BalanceTransaction,
  connectAccountId: string,
): Promise<
  | { kind: 'transfer'; transferId: string }
  | { kind: 'plan_fallback'; planId: string; reason: string }
  | { kind: 'unresolved'; reason: string }
  | { kind: 'lookup_failed'; reason: string }
> {
  const source = bt.source
  if (!source) return { kind: 'unresolved', reason: 'balance_tx.source missing' }

  if (bt.type === 'transfer') {
    const transferId = typeof source === 'string' ? source : source.id
    if (!transferId) return { kind: 'unresolved', reason: 'transfer source id missing' }
    return { kind: 'transfer', transferId }
  }

  if (bt.type === 'payment') {
    let charge: Stripe.Charge
    try {
      charge = typeof source === 'string'
        ? await stripeSdk.charges.retrieve(source, { stripeAccount: connectAccountId })
        : (source as Stripe.Charge)
    } catch (err: unknown) {
      return {
        kind: 'lookup_failed',
        reason: `charges.retrieve failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    const st = charge.source_transfer
    const transferId = typeof st === 'string' ? st : st?.id
    if (transferId) return { kind: 'transfer', transferId }

    const planId = parsePlanIdFromTransferGroup(charge.transfer_group)
    if (planId) {
      return {
        kind: 'plan_fallback',
        planId,
        reason: 'charge.source_transfer missing — using transfer_group plan fallback',
      }
    }
    return { kind: 'unresolved', reason: 'charge has neither source_transfer nor escrow_plan transfer_group' }
  }

  return { kind: 'unresolved', reason: `balance_tx.type ${bt.type} not mappable` }
}

async function emitPayoutOutcomeSignals(
  supabase: SupabaseClient,
  stripeSdk: Stripe,
  payout: Stripe.Payout,
  connectAccountId: string | null,
  outcomeType: 'payout_completed' | 'payout_failed',
  eventId: string,
): Promise<PayoutOutcomeEmitResult> {
  if (!connectAccountId) {
    logWarning('webhook.stripe.payout.outcome_skipped', {
      eventId,
      payoutId: payout.id,
      outcomeType,
      reason: 'no connect account id on event — cannot resolve payout transfers',
    })
    // Missing connect account id is a data issue on the Stripe event, not a
    // transient failure — retrying won't help.
    return { status: 'skipped_no_connect_account', retryable: false }
  }

  const transferIds = new Set<string>()
  const fallbackPlanIds = new Set<string>()
  let pagesProcessed = 0
  let btsProcessed = 0
  let mappingMisses = 0
  let fallbackHits = 0
  let chargeLookupFailure: string | null = null

  try {
    // Auto-paginate over every balance transaction in the payout so a
    // Connected Account with >100 entries is fully covered.
    const iterator = stripeSdk.balanceTransactions.list(
      { payout: payout.id, limit: 100, expand: ['data.source'] },
      { stripeAccount: connectAccountId },
    )
    for await (const bt of iterator) {
      btsProcessed += 1
      // `payout` balance transactions describe the aggregate payout itself
      // and never own a tranche transfer — skip them explicitly so they
      // don't run through the charge lookup path.
      if (bt.type === 'payout' || bt.type === 'payout_failure') continue

      const resolved = await resolveTransferIdFromBalanceTx(stripeSdk, bt, connectAccountId)
      if (resolved.kind === 'transfer') {
        transferIds.add(resolved.transferId)
      } else if (resolved.kind === 'plan_fallback') {
        fallbackPlanIds.add(resolved.planId)
        fallbackHits += 1
        logWarning('webhook.stripe.payout.mapping_fallback', {
          eventId,
          payoutId: payout.id,
          outcomeType,
          btId: bt.id,
          planId: resolved.planId,
          reason: resolved.reason,
        })
      } else if (resolved.kind === 'lookup_failed') {
        chargeLookupFailure = resolved.reason
        break
      } else {
        mappingMisses += 1
        logWarning('webhook.stripe.payout.mapping_miss', {
          eventId,
          payoutId: payout.id,
          outcomeType,
          btId: bt.id,
          btType: bt.type,
          reason: resolved.reason,
        })
      }
    }
    pagesProcessed += 1
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    logError('webhook.stripe.payout.outcome_stripe_list_failed', err, {
      eventId,
      payoutId: payout.id,
      outcomeType,
      connectAccountId,
      btsProcessed,
      reason,
    })
    return { status: 'failed_stripe_list', retryable: true, reason }
  }

  if (chargeLookupFailure) {
    logError('webhook.stripe.payout.outcome_charge_lookup_failed', undefined, {
      eventId,
      payoutId: payout.id,
      outcomeType,
      connectAccountId,
      btsProcessed,
      reason: chargeLookupFailure,
    })
    return { status: 'failed_charge_lookup', retryable: true, reason: chargeLookupFailure }
  }

  if (transferIds.size === 0 && fallbackPlanIds.size === 0) {
    logInfo('webhook.stripe.payout.outcome_no_transfers', {
      eventId,
      payoutId: payout.id,
      outcomeType,
      connectAccountId,
      btsProcessed,
      pagesProcessed,
      mappingMisses,
    })
    return { status: 'skipped_no_transfers', retryable: false }
  }

  type TrancheRow = { plan_id: string; external_release_ref: string | null }
  const allTranches: TrancheRow[] = []

  if (transferIds.size > 0) {
    const { data, error } = await supabase
      .from('escrow_tranches')
      .select('plan_id, external_release_ref')
      .in('external_release_ref', Array.from(transferIds))
    if (error) {
      logError('webhook.stripe.payout.outcome_tranches_lookup_failed', undefined, {
        eventId,
        payoutId: payout.id,
        outcomeType,
        reason: 'escrow_tranches lookup by transfer ref failed',
        detail: error.message,
      })
      return { status: 'failed_tranches_lookup', retryable: true, reason: error.message }
    }
    for (const row of (data ?? []) as TrancheRow[]) allTranches.push(row)
  }

  if (fallbackPlanIds.size > 0) {
    // Fallback: when `charge.source_transfer` was missing but we recovered
    // a plan id from `transfer_group`, grab every released tranche of the
    // plan. Signals for already-matched transfer refs dedup via the upsert
    // conflict key below, so this is safe to union.
    const { data, error } = await supabase
      .from('escrow_tranches')
      .select('plan_id, external_release_ref')
      .in('plan_id', Array.from(fallbackPlanIds))
      .not('external_release_ref', 'is', null)
    if (error) {
      logError('webhook.stripe.payout.outcome_tranches_lookup_failed', undefined, {
        eventId,
        payoutId: payout.id,
        outcomeType,
        reason: 'escrow_tranches lookup by plan_id fallback failed',
        detail: error.message,
      })
      return { status: 'failed_tranches_lookup', retryable: true, reason: error.message }
    }
    for (const row of (data ?? []) as TrancheRow[]) allTranches.push(row)
  }

  const tranches = allTranches

  const matchedRefs = new Set(
    (tranches ?? [])
      .map((t) => t.external_release_ref as string | null)
      .filter((ref): ref is string => typeof ref === 'string' && ref.length > 0),
  )
  const planIds = Array.from(new Set((tranches ?? []).map((t) => t.plan_id as string)))
  const unmatchedTransferIds = Array.from(transferIds).filter((id) => !matchedRefs.has(id))
  if (unmatchedTransferIds.length > 0) {
    logWarning('webhook.stripe.payout.outcome_unmatched_transfers', {
      eventId,
      payoutId: payout.id,
      outcomeType,
      unmatchedCount: unmatchedTransferIds.length,
      sample: unmatchedTransferIds.slice(0, 5),
    })
  }

  if (planIds.length === 0 || matchedRefs.size === 0) {
    logInfo('webhook.stripe.payout.outcome_no_plans', {
      eventId,
      payoutId: payout.id,
      outcomeType,
      transferCount: transferIds.size,
    })
    return { status: 'skipped_no_plans', retryable: false }
  }

  const { data: plans, error: plansErr } = await supabase
    .from('escrow_payment_plans')
    .select('id, job_id')
    .in('id', planIds)

  if (plansErr) {
    logError('webhook.stripe.payout.outcome_plans_lookup_failed', undefined, {
      eventId,
      payoutId: payout.id,
      outcomeType,
      reason: 'escrow_payment_plans lookup failed',
      detail: plansErr.message,
    })
    return { status: 'failed_plans_lookup', retryable: true, reason: plansErr.message }
  }

  const planIdToJobId = new Map<string, string>()
  for (const plan of plans ?? []) {
    const id = plan.id as string | null
    const jobId = plan.job_id as string | null
    if (id && jobId) planIdToJobId.set(id, jobId)
  }

  // Tranche-scoped signal rows: one per (transferId, jobId) pair. The
  // deterministic id suffix matches `buildPayoutOutcomeSignalId` on the
  // client so `derivePayoutOutcomesByTransfer` can map each outcome back
  // to its specific tranche.
  const occurredAt = Date.now()
  const rows: Array<{
    id: string
    job_id: string
    type: 'payout_completed' | 'payout_failed'
    occurred_at: number
  }> = []
  const seen = new Set<string>()
  for (const row of tranches ?? []) {
    const ref = row.external_release_ref as string | null
    const planId = row.plan_id as string | null
    if (!ref || !planId) continue
    const jobId = planIdToJobId.get(planId)
    if (!jobId) continue
    const id = `timeline_${outcomeType}__${ref}`
    if (seen.has(id)) continue
    seen.add(id)
    rows.push({ id, job_id: jobId, type: outcomeType, occurred_at: occurredAt })
  }

  if (rows.length === 0) {
    logInfo('webhook.stripe.payout.outcome_no_jobs', {
      eventId,
      payoutId: payout.id,
      outcomeType,
      planIds,
    })
    return { status: 'skipped_no_jobs', retryable: false }
  }

  const { error: insertErr } = await supabase
    .from('timeline_signals')
    .upsert(rows, { onConflict: 'id' })

  if (insertErr) {
    logError('webhook.stripe.payout.outcome_insert_failed', undefined, {
      eventId,
      payoutId: payout.id,
      outcomeType,
      rowCount: rows.length,
      detail: insertErr.message,
    })
    return { status: 'failed_signal_insert', retryable: true, reason: insertErr.message }
  }

  logInfo('webhook.stripe.payout.outcome_signals_emitted', {
    eventId,
    payoutId: payout.id,
    outcomeType,
    rowCount: rows.length,
    transferCount: transferIds.size,
    fallbackPlanCount: fallbackPlanIds.size,
    fallbackHits,
    mappingMisses,
    btsProcessed,
  })

  // ── Email fan-out ──────────────────────────────────────────────────────────
  // Best-effort: the timeline signal is the canonical trust source; emails
  // are a redundant awareness channel. A delivery failure must not unwind
  // the webhook — the craftsman still sees the in-app notification and
  // finance surfaces via the signal written above.
  await emitPayoutOutcomeEmails(supabase, rows, outcomeType, eventId)

  return { status: 'ok', retryable: false }
}

async function emitPayoutOutcomeEmails(
  supabase: SupabaseClient,
  rows: Array<{ id: string; job_id: string; type: 'payout_completed' | 'payout_failed'; occurred_at: number }>,
  outcomeType: 'payout_completed' | 'payout_failed',
  eventId: string,
): Promise<void> {
  const jobIds = Array.from(new Set(rows.map((r) => r.job_id)))
  if (jobIds.length === 0) return

  // Resolve the canonical auth id for the craftsman via `craftsman_user_id`.
  // `jobs.provider_id` is the provider-table FK (NOT an auth user id) and
  // would cause `admin.auth.admin.getUserById` in the email helper to miss
  // every recipient.
  const { data: jobRows, error } = await supabase
    .from('jobs')
    .select('id, craftsman_user_id, title')
    .in('id', jobIds)

  if (error) {
    logWarning('webhook.stripe.payout.email_lookup_failed', {
      eventId,
      outcomeType,
      reason: error.message,
    })
    return
  }

  // For `payout_completed` we must NOT email per tranche — that template
  // announces the job as fully paid out. Gate on:
  //   (a) plan.status === 'fully_released'
  //   (b) every released tranche has a `payout_completed` timeline signal
  // Only then does the craftsman actually see "Geld eingegangen" for the
  // whole job. A failing payout (`payout_failed`) is always surfaced
  // immediately — partial failures still require craftsman awareness.
  let eligibleJobIdsForCompletedEmail: Set<string> | null = null
  if (outcomeType === 'payout_completed') {
    eligibleJobIdsForCompletedEmail = await deriveJobsFullyPaidOut(
      supabase, jobIds, eventId,
    )
  }

  for (const jobRow of jobRows ?? []) {
    const craftsmanUserId = (jobRow.craftsman_user_id as string | null) ?? null
    const jobId = jobRow.id as string
    const jobTitle = (jobRow.title as string | null) ?? undefined
    if (!craftsmanUserId) {
      logInfo('webhook.stripe.payout.email_skipped', {
        eventId,
        outcomeType,
        jobId,
        reason: 'no_craftsman_user_id',
      })
      continue
    }

    if (outcomeType === 'payout_completed' && eligibleJobIdsForCompletedEmail
        && !eligibleJobIdsForCompletedEmail.has(jobId)) {
      logInfo('webhook.stripe.payout.email_skipped_partial', {
        eventId,
        outcomeType,
        jobId,
        reason: 'plan not fully paid out — skipping job-level completed email',
      })
      continue
    }

    try {
      await deliverNotificationEmailServer(supabase, {
        type: outcomeType,
        jobId,
        recipientUserId: craftsmanUserId,
        recipientRole: 'craftsman',
        context: jobTitle ? { jobTitle } : {},
      })
    } catch (err: unknown) {
      logWarning('webhook.stripe.payout.email_dispatch_failed', {
        eventId,
        outcomeType,
        jobId,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/**
 * Fetches the inputs needed to gate the job-level `payout_completed`
 * email and delegates the pure decision to
 * `deriveJobsFullyPaidOutPure`. Returns the subset of jobIds whose
 * escrow plan is `fully_released` and for which every released tranche
 * already carries a `payout_completed` timeline signal.
 */
async function deriveJobsFullyPaidOut(
  supabase: SupabaseClient,
  jobIds: string[],
  eventId: string,
): Promise<Set<string>> {
  if (jobIds.length === 0) return new Set<string>()

  const { data: planRows, error: plansErr } = await supabase
    .from('escrow_payment_plans')
    .select('id, job_id, status')
    .in('job_id', jobIds)

  if (plansErr) {
    logWarning('webhook.stripe.payout.email_gate_plan_lookup_failed', {
      eventId, reason: plansErr.message,
    })
    return new Set<string>()
  }

  const plans = (planRows ?? []).map((p) => ({
    id: p.id as string,
    jobId: p.job_id as string,
    status: (p.status as string | null) ?? '',
  }))
  const fullyReleasedPlanIds = plans
    .filter((p) => p.status === 'fully_released')
    .map((p) => p.id)
  if (fullyReleasedPlanIds.length === 0) return new Set<string>()

  const { data: trancheRows, error: tranchesErr } = await supabase
    .from('escrow_tranches')
    .select('plan_id, external_release_ref, external_payout_ref, status')
    .in('plan_id', fullyReleasedPlanIds)

  if (tranchesErr) {
    logWarning('webhook.stripe.payout.email_gate_tranches_lookup_failed', {
      eventId, reason: tranchesErr.message,
    })
    return new Set<string>()
  }

  const tranches = (trancheRows ?? []).map((t) => ({
    planId: t.plan_id as string,
    externalReleaseRef: (t.external_release_ref as string | null) ?? null,
    externalPayoutRef: (t.external_payout_ref as string | null) ?? null,
    status: (t.status as string | null) ?? '',
  }))

  // A released tranche proves payout via EITHER ref: external_release_ref (tr_*,
  // transfer corridor) OR external_payout_ref (po_*, destination-charge payout
  // corridor). Flag-OFF, external_payout_ref is always NULL so this is identical
  // to the prior transfer-only filter/map.
  const releasedRefs = tranches
    .filter((t) => t.status === 'released' && (t.externalReleaseRef || t.externalPayoutRef))
    .map((t) => (t.externalReleaseRef ?? t.externalPayoutRef) as string)
  if (releasedRefs.length === 0) return new Set<string>()

  const signalIds = buildPayoutCompletedSignalIds(releasedRefs)
  const { data: completedSignals, error: signalsErr } = await supabase
    .from('timeline_signals')
    .select('id')
    .in('id', signalIds)

  if (signalsErr) {
    logWarning('webhook.stripe.payout.email_gate_signal_lookup_failed', {
      eventId, reason: signalsErr.message,
    })
    return new Set<string>()
  }

  const completedSignalIds = (completedSignals ?? [])
    .map((s) => (s.id as string | null) ?? '')
    .filter((sid) => sid.length > 0)

  return deriveJobsFullyPaidOutPure({
    plans,
    tranches,
    completedSignalIds,
  })
}

// ---------------------------------------------------------------------------
// Destination-charge corridor: direct payout → tranche resolution (P3)
//
// Under the corridor flag (FUNDING_DESTINATION_CHARGE_ENABLED on the release
// endpoint), a tranche release is a Stripe *payout* on the provider's
// connected account — the money already landed there from the P2 destination
// charge. release-tranche.ts stamps that payout with metadata.tranche_id and
// persists escrow_tranches.external_payout_ref = po_*; the tranche then sits
// at status='release_pending' awaiting this payout.paid / payout.failed.
//
// A flag-OFF Stripe *auto*-payout carries NEITHER metadata.tranche_id NOR a
// matching external_payout_ref, so the data shape alone disambiguates the two
// corridors. No env flag is read here — `not_corridor` falls through to the
// transfer-model emitPayoutOutcomeSignals path, which stays byte-identical.
// ---------------------------------------------------------------------------

type PayoutCorridorTranche = { id: string; status: string; planId: string; payoutAttemptCount: number }

type PayoutCorridorResolution =
  | { kind: 'resolved'; tranche: PayoutCorridorTranche }
  | { kind: 'not_corridor' }
  | { kind: 'error'; reason: string }

/**
 * Resolves a destination-charge corridor tranche for a Stripe payout, or
 * reports the payout as a flag-OFF auto-payout (`not_corridor`).
 *
 * Primary key: `payout.metadata.tranche_id` (set by release-tranche.ts on the
 * corridor payouts.create). Fallback: `escrow_tranches.external_payout_ref =
 * payout.id`. Both are 1:1 with the tranche (stable idempotency key
 * `tranche_payout_<trancheId>`), so maybeSingle is safe.
 *
 * Returns `error` (retryable) instead of silently falling through when a
 * corridor payout (metadata.tranche_id present) resolves to no tranche or the
 * lookup itself fails — otherwise the transfer-model path would mark the event
 * reconciled WITHOUT releasing the tranche.
 */
async function resolvePayoutCorridorTranche(
  supabase: SupabaseClient,
  payout: Stripe.Payout,
  eventId: string,
): Promise<PayoutCorridorResolution> {
  const metaTrancheId = (payout.metadata?.tranche_id ?? '').trim()

  const base = supabase.from('escrow_tranches').select('id, status, plan_id, payout_attempt_count')
  const { data, error } = metaTrancheId
    ? await base.eq('id', metaTrancheId).maybeSingle()
    : await base.eq('external_payout_ref', payout.id).maybeSingle()

  if (error) {
    // Transient lookup failure → retryable. Safe for the flag-OFF path too: a
    // Stripe auto-payout simply re-resolves to `not_corridor` on the retry.
    logWarning('webhook.stripe.payout.corridor_resolve_failed', {
      eventId,
      payoutId: payout.id,
      via: metaTrancheId ? 'metadata.tranche_id' : 'external_payout_ref',
      reason: error.message,
    })
    return { kind: 'error', reason: 'tranche_lookup_failed' }
  }

  if (!data) {
    if (metaTrancheId) {
      // A corridor payout MUST map to a tranche. A miss is a data-integrity
      // anomaly — do NOT fall through to the transfer-model signal path.
      logError('webhook.stripe.payout.corridor_tranche_missing', undefined, {
        eventId,
        payoutId: payout.id,
        trancheId: metaTrancheId,
        note: 'MANUAL REVIEW REQUIRED: payout.metadata.tranche_id resolved to no escrow_tranche',
      })
      return { kind: 'error', reason: 'tranche_missing' }
    }
    // No metadata + no external_payout_ref match = flag-OFF auto-payout.
    return { kind: 'not_corridor' }
  }

  return {
    kind: 'resolved',
    tranche: {
      id: data.id as string,
      status: (data.status as string | null) ?? '',
      planId: data.plan_id as string,
      // P3b item A retry-enabler: the payout.failed revert bumps this so the
      // reconcile-payout-corridor cron's next re-attempt uses a fresh key.
      payoutAttemptCount: Number(data.payout_attempt_count ?? 0),
    },
  }
}

/**
 * G7 double-count guard: returns true when the corridor split-settle has already
 * booked a customer refund for this payment (a `refund_partial` ledger row keyed
 * by dispute_id). The two ''-movement-ref 'refund' writers (reconcilePaymentState
 * + reconcileChargeRefunded) must skip when this is true, IN ADDITION to their
 * existing payment.status !== 'disputed' guard: the unique index
 * (payment_id, entry_type, movement_ref) does NOT dedup across entry_type
 * 'refund' vs 'refund_partial', so a late/redelivered Stripe refund landing after
 * the payment leaves 'disputed' would otherwise write a SECOND refund row =
 * double count in getRefunds().
 *
 * Fail-OPEN on a transient read error (log + return false → the status-guarded
 * upsert proceeds). This keeps flag-OFF behavior byte-identical: while the
 * corridor is dormant no refund_partial rows exist, so this always returns false
 * and the refund writers behave exactly as before.
 */
async function corridorRefundPartialExists(
  supabase: SupabaseClient,
  paymentId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('ledger_entries')
    .select('id')
    .eq('payment_id', paymentId)
    .eq('entry_type', 'refund_partial')
    .limit(1)
  if (error) {
    logWarning('webhook.stripe.refund_partial_lookup_failed', {
      paymentId,
      reason: error.message,
    })
    return false
  }
  return (data?.length ?? 0) > 0
}

/**
 * Completes a destination-charge corridor tranche on payout.paid: marks it
 * 'released' (+ released_at + plan rollup) via the idempotent SECDEF RPC
 * `complete_tranche_payout`, then emits the one targeted timeline signal and
 * the best-effort email. Returns false when the caller must retry (HTTP 500):
 * RPC failure, plan-lookup failure, or signal-write failure — all idempotent
 * on the Stripe retry (0-row guard in the RPC, upsert conflict on the signal).
 */
async function completePayoutCorridorTranche(
  supabase: SupabaseClient,
  tranche: PayoutCorridorTranche,
  payout: Stripe.Payout,
  eventId: string,
): Promise<boolean> {
  const { data: rpcResult, error: rpcError } = await supabase.rpc(
    'complete_tranche_payout',
    {
      p_tranche_id: tranche.id,
      p_payout_id: payout.id,
    },
  )

  if (rpcError) {
    // The Stripe payout is paid but the DB write to mark the tranche
    // 'released' failed. Retry (RPC is idempotent: 0-row guard re-delivery).
    logError('webhook.stripe.payout.corridor_complete_failed', new Error(rpcError.message), {
      eventId,
      payoutId: payout.id,
      trancheId: tranche.id,
      reason: 'complete_tranche_payout RPC failed',
    })
    return false
  }

  logInfo('webhook.stripe.payout.corridor_completed', {
    eventId,
    payoutId: payout.id,
    trancheId: tranche.id,
    planId: tranche.planId,
    outcome: rpcResult?.outcome ?? 'unknown',
  })

  // Resolve the owning job + plan rollup for the targeted timeline signal,
  // email AND the full-release settlement below.
  const { data: plan, error: planErr } = await supabase
    .from('escrow_payment_plans')
    .select('job_id, status')
    .eq('id', tranche.planId)
    .maybeSingle()

  if (planErr) {
    logError('webhook.stripe.payout.corridor_plan_lookup_failed', undefined, {
      eventId,
      payoutId: payout.id,
      trancheId: tranche.id,
      planId: tranche.planId,
      reason: planErr.message,
    })
    return false
  }

  const jobId = (plan?.job_id as string | null) ?? null
  if (!jobId) {
    // Release is committed (RPC). Without a job we cannot emit the
    // provider-facing signal, but the money truth is intact — do not retry.
    logInfo('webhook.stripe.payout.corridor_no_job', {
      eventId,
      payoutId: payout.id,
      trancheId: tranche.id,
      planId: tranche.planId,
    })
    return true
  }

  // ── A1: settle the payment/job FSM on the FINAL payout ──────────────────────
  // complete_tranche_payout only flips the tranche + rolls up the plan; it does
  // NOT advance payments → released, job → completed, or stamp
  // jobs.payment_released_at. In the legacy (transfer) model the releasing CLIENT
  // (paymentWorkflow.runPaymentReleasedSideEffects) did this synchronously — but
  // under the corridor the payout pays ~7d async and the client is long gone, so
  // the authoritative settlement must happen HERE, when the last tranche's payout
  // lands and the plan reaches 'fully_released'. Gated on the freshly-read plan
  // rollup so a redelivery re-checks idempotently.
  //
  // Safety (per adversarial review): the payment is moved to 'released' ONLY when
  // isValidWebhookTransition allows it — this EXCLUDES 'disputed' (a chargeback /
  // in-app dispute opened during the ~7d async window), so a payout.paid never
  // force-releases over a running dispute. The job/project FSM is advanced ONLY
  // when the canonical payment actually transitioned (matched row), never on a
  // 0-row no-op or a missing payment. A transient settle error returns false to
  // force an idempotent Stripe retry.
  //
  // STATUS:
  //  · DONE: the deposit+final write-skew is closed — complete_tranche_payout now
  //    takes `SELECT 1 FROM escrow_payment_plans WHERE id=v_plan_id FOR UPDATE`
  //    before the rollup, so concurrent payout.paid deliveries serialize and the
  //    SECOND one always reads 'fully_released' and runs this block.
  //  · DONE: invoice→paid projection — the R3 AFTER-UPDATE trigger on `payments`
  //    (advance_invoice_to_paid) flips the §14 invoice when this block moves the
  //    payment to 'released'. No invoice write is needed here.
  //  · DONE (B5): a missed/undelivered final payout.paid that skips this block is
  //    healed by reconcile_fully_released_corridor_payments() in the payout-corridor
  //    cron (plan fully_released + payment in a pre-settle state → released + sync).
  //  · DONE (P4 Batch 4): a resolved-but-pending operator/consensus DISPUTE is now
  //    settled below via settle_dispute_resolution (the ONE shared corridor
  //    settler), flipping disputes.settlement_status pending→settled regardless of
  //    plan.status — so a corridor SPLIT (partially_released, never fully_released)
  //    also settles. The corridor dispute-settlement relocation is closed.
  //  · KNOWN-DEFERRED: completed-jobs counter, in-app notification + calendar
  //    projection side-effects that runPaymentReleasedSideEffects ran client-side
  //    are not replicated here yet. The trust-critical payout_completed timeline
  //    signal + email are emitted below.
  if ((plan?.status as string | undefined) === 'fully_released') {
    const settleNow = Date.now()
    const { data: pay } = await supabase
      .from('payments')
      .select('id, status, total_amount')
      .eq('job_id', jobId)
      .maybeSingle()
    const payRow = pay as { id: string; status: string; total_amount: number | null } | null

    if (!payRow) {
      // Plan fully paid out but no canonical payments row — NEVER force the job to
      // 'released' without a released payment. Surface for operator review.
      logWarning('webhook.stripe.payout.corridor_settle_no_payment', {
        eventId, payoutId: payout.id, jobId, planId: tranche.planId,
      })
    } else if (payRow.status === 'released') {
      // Idempotent: already settled by a prior delivery — nothing to do.
    } else if (!isValidWebhookTransition(payRow.status, 'released')) {
      // 'disputed' (or any non-releasable state) — the dispute settlement path
      // owns the outcome. Do NOT force-release; surface as an inconsistency for
      // operator review. Job/project FSM is NOT advanced.
      logWarning('webhook.stripe.payout.corridor_settle_blocked_invalid_transition', {
        eventId, payoutId: payout.id, jobId, planId: tranche.planId,
        currentPaymentStatus: payRow.status,
        note: 'payout.paid landed on a non-releasable payment (e.g. disputed) — dispute path owns this; job NOT auto-completed',
      })
    } else {
      const { data: moved, error: payErr } = await supabase
        .from('payments')
        .update({ status: 'released', amount_released: payRow.total_amount ?? 0, updated_at: settleNow })
        .eq('id', payRow.id)
        .eq('status', payRow.status)
        .select('id')
      if (payErr) {
        // Transient DB error → force an idempotent Stripe retry (HTTP 500).
        logError('webhook.stripe.payout.corridor_payment_settle_failed', undefined, {
          eventId, payoutId: payout.id, jobId, planId: tranche.planId, reason: payErr.message,
        })
        return false
      }
      if ((moved?.length ?? 0) === 0) {
        // Optimistic guard matched 0 rows: a concurrent path moved the payment
        // between read and write. Do NOT advance the job.
        logWarning('webhook.stripe.payout.corridor_settle_raced', {
          eventId, payoutId: payout.id, jobId, planId: tranche.planId,
          note: 'payment status changed concurrently — job NOT advanced',
        })
      } else {
        // payment_state → released, job → completed (from waiting_payment only),
        // jobs.payment_released_at stamped, project synced.
        await reconcileJobFromPayment(supabase, jobId, 'released', settleNow, eventId)
        logInfo('webhook.stripe.payout.corridor_fully_released_settled', {
          eventId, payoutId: payout.id, jobId, planId: tranche.planId,
        })
      }
    }
  }

  // ── A1-b: settle a resolved-but-pending corridor DISPUTE ────────────────────
  // Under the corridor, an operator/consensus RELEASE/REJECT/SPLIT resolution
  // drives an ASYNC payout, so the releasing client never settles the dispute
  // (bridgeFullySucceeded=false) and the T+80 cron ignores it (default_applied_at
  // IS NULL). This payout.paid handler is the only place corridor money lands as
  // service_role, so it is the natural, idempotent trigger to flip
  // disputes.settlement_status pending→settled via the ONE shared settler
  // (settle_dispute_resolution). A corridor SPLIT is TERMINAL at partially_released
  // (the held customer share never pays out), so it settles on ANY payout.paid. A
  // RELEASE/REJECT only completes once EVERY craftsman tranche has paid out
  // (plan.status='fully_released'); settling it on an earlier PARTIAL payout would
  // seal the dispute while an un-bridged craftsman tranche is still owed (orphaned
  // tranche + a false 'settled' signal), so those defer to the fully_released
  // payout.paid. The RPC refunds ONLY still-HELD tranches (the just-released tranche
  // is EXCLUDED by the shared held predicate → no double-pay / N2 not reopened) and
  // never touches payments/jobs/project (G6=B). Dormant flag-OFF (no corridor payout
  // can exist) and a no-op when no resolved-but-pending dispute is on the job.
  //
  // Use .limit(1) + [0] (NOT .maybeSingle()): a 'resolved' dispute is NOT covered
  // by the active-unique index, so a job could in theory carry more than one
  // non-active dispute and maybeSingle() would throw on >1.
  const { data: pendingDisputes, error: disputeLookupErr } = await supabase
    .from('disputes')
    .select('id, decision')
    .eq('job_id', jobId)
    .eq('status', 'resolved')
    .eq('settlement_status', 'pending')
    // ONLY async-payout-driven resolutions are owned by this webhook. A
    // decision='refund' dispute (T+80 auto-default OR operator full-refund) is
    // settled by whoever actually issued the Stripe refund — the cron via the
    // settle_dispute_default delegate, or the synchronous client refund path —
    // NEVER here. Including 'refund' would let a redelivered deposit payout.paid
    // force-settle a default whose Stripe refund FAILED (cron `failed++ → continue`,
    // still-retrying), writing a false refund_partial row + abandoning the retry.
    .in('decision', ['split', 'release', 'reject'])
    // Deterministic oldest-first (a 'resolved' dispute is not covered by the
    // active-unique index, so a job could carry >1 settle-eligible row); mirrors
    // the cron 1b query ordering.
    .order('opened_at', { ascending: true })
    .limit(1)

  if (disputeLookupErr) {
    // Transient lookup error → force an idempotent Stripe retry (the tranche
    // release is already committed; the settle RPC is idempotent on re-delivery).
    logError('webhook.stripe.payout.corridor_dispute_lookup_failed', undefined, {
      eventId,
      payoutId: payout.id,
      trancheId: tranche.id,
      jobId,
      planId: tranche.planId,
      reason: disputeLookupErr.message,
    })
    return false
  }

  const pendingDispute = (pendingDisputes ?? [])[0] as
    | { id: string; decision: string }
    | undefined
  // SPLIT settles on any payout.paid (terminal at partially_released); RELEASE/
  // REJECT only once fully_released so a partial-bridge payout never seals the
  // dispute over an un-released craftsman tranche (a later fully_released
  // payout.paid settles it idempotently).
  const settleEligible =
    pendingDispute !== undefined &&
    (pendingDispute.decision === 'split' ||
      (plan?.status as string | undefined) === 'fully_released')
  if (pendingDispute && !settleEligible) {
    logInfo('webhook.stripe.payout.corridor_dispute_settle_deferred', {
      eventId,
      payoutId: payout.id,
      trancheId: tranche.id,
      jobId,
      planId: tranche.planId,
      disputeId: pendingDispute.id,
      decision: pendingDispute.decision,
      planStatus: (plan?.status as string | undefined) ?? null,
      note: 'release/reject dispute awaits plan.status=fully_released before settle',
    })
  }
  if (pendingDispute && settleEligible) {
    const { error: settleErr } = await supabase.rpc('settle_dispute_resolution', {
      p_dispute_id: pendingDispute.id,
    })
    if (settleErr) {
      // Force an idempotent Stripe retry — settle_dispute_resolution is idempotent
      // (already-settled returns unchanged; ledger ON CONFLICT DO NOTHING).
      logError('webhook.stripe.payout.corridor_dispute_settle_failed', undefined, {
        eventId,
        payoutId: payout.id,
        trancheId: tranche.id,
        jobId,
        planId: tranche.planId,
        disputeId: pendingDispute.id,
        reason: settleErr.message,
      })
      return false
    }
    logInfo('webhook.stripe.payout.corridor_dispute_settled', {
      eventId,
      payoutId: payout.id,
      trancheId: tranche.id,
      jobId,
      planId: tranche.planId,
      disputeId: pendingDispute.id,
    })
  }

  // ONE targeted timeline signal for this tranche's job. Keyed by payout id so
  // re-delivery dedups via the upsert conflict on `id`.
  const row = {
    id: `timeline_payout_completed__${payout.id}`,
    job_id: jobId,
    type: 'payout_completed' as const,
    occurred_at: Date.now(),
  }
  const { error: signalErr } = await supabase
    .from('timeline_signals')
    .upsert(row, { onConflict: 'id' })

  if (signalErr) {
    // Mirror emitPayoutOutcomeSignals: a signal-write failure is retryable so
    // the provider is never left blind to an arrived payout. RPC + upsert are
    // both idempotent on the Stripe retry.
    logError('webhook.stripe.payout.corridor_signal_failed', undefined, {
      eventId,
      payoutId: payout.id,
      trancheId: tranche.id,
      jobId,
      reason: signalErr.message,
    })
    return false
  }

  // Best-effort email (never throws). The payout_completed email gate
  // (deriveJobsFullyPaidOut) is now corridor-adapted: it counts a released
  // tranche via its external_payout_ref (po_*) proving ref, so the job-level
  // payout_completed email fires correctly once the plan is fully_released AND
  // every released tranche carries its `timeline_payout_completed__{po}` signal
  // (written above). The timeline signal remains the canonical trust source.
  await emitPayoutOutcomeEmails(supabase, [row], 'payout_completed', eventId)

  return true
}

/**
 * Records the audit trail for a FAILED destination-charge corridor payout,
 * called AFTER the release_pending → eligible_for_release revert has committed.
 *
 * The revert alone restores the tranche to a re-attemptable state but leaves NO
 * journal of the bounced money event. This helper closes the audit invariant —
 * "every money state change is journaled" — by writing two idempotent records:
 *
 *   1. A compensating ledger entry (entry_type 'payout_adjustment' — the
 *      established reversal/adjustment type, mirroring the transfer-reversal
 *      ledger write). Amount is POSITIVE (payout.amount / 100); the direction
 *      "a payout was attempted and returned" is conveyed by entry_type +
 *      metadata.note, NEVER by sign (CHECK amount>=0). movement_ref = payout.id
 *      (NOT tranche_id), so each distinct failed payout over the retry-cron
 *      lifecycle gets its own journal row AND Stripe re-delivery dedups via the
 *      ON CONFLICT(payment_id,entry_type,movement_ref).
 *   2. A `payout_failed` timeline signal (routes to craftsman + admin via the
 *      notification config), keyed by payout.id so re-delivery dedups on `id`.
 *
 * Returns false when the caller must retry (HTTP 500): a job/payment lookup
 * failure, a ledger-write failure, or a signal-write failure — all idempotent
 * on the Stripe retry (the revert is status-guarded 0-row; both upserts dedup).
 * A genuine data gap (no payment row for the job) is logged for MANUAL REVIEW
 * but does NOT block the retry loop forever: the timeline signal still emits and
 * the helper returns true so the surfaced anomaly can be handled out-of-band.
 *
 * Scoped strictly to the corridor (called only from the payout.failed
 * `failedCorridor.kind === 'resolved'` branch); a flag-OFF auto-payout resolves
 * to `not_corridor` and never reaches here, so flag-OFF stays byte-identical.
 */
async function recordPayoutFailureAudit(
  supabase: SupabaseClient,
  tranche: PayoutCorridorTranche,
  payout: Stripe.Payout,
  eventId: string,
): Promise<boolean> {
  // 1. Resolve the owning job.
  const { data: plan, error: planErr } = await supabase
    .from('escrow_payment_plans')
    .select('job_id')
    .eq('id', tranche.planId)
    .maybeSingle()

  if (planErr) {
    logError('webhook.stripe.payout.failure_audit_plan_lookup_failed', undefined, {
      eventId,
      payoutId: payout.id,
      trancheId: tranche.id,
      planId: tranche.planId,
      reason: planErr.message,
    })
    return false
  }

  const jobId = (plan?.job_id as string | null) ?? null
  if (!jobId) {
    // The revert is already committed (money truth intact). Without a job we
    // cannot journal the audit, but a data gap must not retry forever.
    logInfo('webhook.stripe.payout.failure_audit_no_job', {
      eventId,
      payoutId: payout.id,
      trancheId: tranche.id,
      planId: tranche.planId,
    })
    return true
  }

  // 2. Resolve the payment row (mirror the transfer-reversal pattern, but
  //    maybeSingle so a >1 / 0 payment anomaly never throws).
  const { data: paymentRow, error: paymentErr } = await supabase
    .from('payments')
    .select('id')
    .eq('job_id', jobId)
    .maybeSingle()

  if (paymentErr) {
    logError('webhook.stripe.payout.failure_audit_payment_lookup_failed', undefined, {
      eventId,
      payoutId: payout.id,
      trancheId: tranche.id,
      jobId,
      reason: paymentErr.message,
    })
    return false
  }

  // 3. Compensating ledger entry — only when a payment row exists.
  const paymentId = (paymentRow?.id as string | null) ?? null
  if (paymentId) {
    const { error: ledgerError } = await supabase
      .from('ledger_entries')
      .upsert(
        {
          payment_id: paymentId,
          job_id: jobId,
          entry_type: 'payout_adjustment',
          amount: payout.amount / 100,
          currency: 'EUR',
          movement_ref: payout.id,
          metadata: {
            note: `Payout ${payout.id} fehlgeschlagen — Tranche zurück auf eligible_for_release`,
            payout_id: payout.id,
            tranche_id: tranche.id,
            failure_code: payout.failure_code ?? null,
          },
        },
        { onConflict: 'payment_id,entry_type,movement_ref', ignoreDuplicates: true },
      )
    if (ledgerError) {
      logError('webhook.stripe.payout.failure_audit_ledger_failed', undefined, {
        eventId,
        payoutId: payout.id,
        trancheId: tranche.id,
        paymentId,
        reason: ledgerError.message,
      })
      return false
    }
  } else {
    // No payment row for a corridor tranche is a genuine data anomaly. Surface
    // it for manual review but still emit the timeline signal below so the
    // failure is not silent — do not block the retry loop forever on a gap.
    logError('webhook.stripe.payout.failure_audit_payment_missing', undefined, {
      eventId,
      payoutId: payout.id,
      trancheId: tranche.id,
      jobId,
      note: 'MANUAL REVIEW: corridor payout failed but no payment row — ledger compensation skipped',
    })
  }

  // 4. Timeline signal (routes to craftsman + admin via notificationConfig).
  //    Keyed by payout.id so re-delivery dedups via the upsert conflict on `id`.
  const { error: signalError } = await supabase
    .from('timeline_signals')
    .upsert(
      {
        id: `timeline_payout_failed__${payout.id}`,
        job_id: jobId,
        type: 'payout_failed',
        occurred_at: Date.now(),
      },
      { onConflict: 'id' },
    )
  if (signalError) {
    logError('webhook.stripe.payout.failure_audit_signal_failed', undefined, {
      eventId,
      payoutId: payout.id,
      trancheId: tranche.id,
      jobId,
      reason: signalError.message,
    })
    return false
  }

  return true
}

// ---------------------------------------------------------------------------
// Escrow funding confirmation
//
// When a PaymentIntent created by initiate-funding succeeds, the webhook
// updates funding_requests, escrow_payment_plans, and escrow_tranches to
// reflect the funded state.  These PaymentIntents are identified by
// metadata.type === 'escrow_funding'.
// ---------------------------------------------------------------------------

/**
 * Reconciles a successful escrow-funding PaymentIntent.
 *
 * 1. Claims the webhook event (deduplication).
 * 2. Resolves the funding_request — from metadata or by external_funding_ref.
 * 3. Updates funding_requests → 'funded'.
 * 4. Updates escrow_payment_plans → 'funded_in_escrow'.
 * 5. Updates pending_funding escrow_tranches → 'funded'.
 * 6. Finalizes the audit row.
 */
async function reconcileFundingConfirmation(
  supabase: SupabaseClient,
  stripe: Stripe,
  intent: Stripe.PaymentIntent,
  eventId: string,
  eventType: string,
  destinationChargeEnabled: boolean,
): Promise<boolean> {
  // 0. Claim the event atomically (deduplication).
  const claim = await claimWebhookEvent(supabase, eventId, eventType, intent.id)
  if (claim === 'duplicate') {
    logInfo('webhook.stripe.duplicate', {
      eventId,
      eventType,
      paymentIntentId: intent.id,
      note: 'funding event already claimed by prior delivery — skipping',
    })
    return true
  }

  const metadata = intent.metadata ?? {}
  const metadataFundingRequestId = (metadata.fundingRequestId ?? '').trim()
  const fundingRequestLookup = supabase
    .from('funding_requests')
    .select('id, escrow_plan_id, job_id, external_funding_ref')
  const { data: fundingRequest, error: fundingRequestError } = metadataFundingRequestId
    ? await fundingRequestLookup.eq('id', metadataFundingRequestId).maybeSingle()
    : await fundingRequestLookup.eq('external_funding_ref', intent.id).maybeSingle()

  if (fundingRequestError) {
    logError('webhook.stripe.failed', new Error(fundingRequestError.message), {
      eventId,
      eventType,
      paymentIntentId: intent.id,
      fundingRequestId: metadataFundingRequestId || null,
      reason: 'funding_request_lookup_failed',
    })
    await finalizeWebhookEvent(supabase, eventId, 'failed', null, null, null, null, 'funding_request_lookup_failed')
    return false
  }

  if (!fundingRequest) {
    logWarning('webhook.stripe.failed', {
      eventId,
      eventType,
      paymentIntentId: intent.id,
      reason: 'escrow_funding PI succeeded but no funding_request found — cannot reconcile',
    })
    await finalizeWebhookEvent(supabase, eventId, 'not_found', null, null, null, null)
    return true
  }

  // Metadata identifies the Stripe object, but the funding request is the
  // canonical relationship for plan and job. Never pass optional metadata IDs
  // through to the atomic RPC or a successful payment can strand plan/tranche
  // state as only the request is marked funded.
  const fundingRequestId = fundingRequest.id
  const escrowPlanId = fundingRequest.escrow_plan_id
  const jobId = fundingRequest.job_id
  const metadataEscrowPlanId = (metadata.escrowPlanId ?? '').trim()
  const metadataJobId = (metadata.jobId ?? '').trim()
  const storedFundingRef = (fundingRequest.external_funding_ref ?? '').trim()
  const canonicalRelationshipInvalid =
    !escrowPlanId ||
    !jobId ||
    (metadataEscrowPlanId !== '' && metadataEscrowPlanId !== escrowPlanId) ||
    (metadataJobId !== '' && metadataJobId !== jobId) ||
    (storedFundingRef !== '' && storedFundingRef !== intent.id)

  if (canonicalRelationshipInvalid) {
    logError('webhook.stripe.failed', undefined, {
      eventId,
      eventType,
      paymentIntentId: intent.id,
      fundingRequestId,
      escrowPlanId: escrowPlanId ?? null,
      jobId: jobId ?? null,
      reason: 'funding_request_relationship_mismatch',
    })
    await finalizeWebhookEvent(
      supabase,
      eventId,
      'failed',
      null,
      jobId || null,
      null,
      null,
      'funding_request_relationship_mismatch',
    )
    return false
  }

  // Atomic funding confirmation — single DB transaction via RPC.
  // Prevents split-state where funding_request=funded but plan/tranches lag.
  const { data: rpcResult, error: rpcError } = await supabase.rpc(
    'confirm_funding_atomic',
    {
      p_funding_request_id: fundingRequestId,
      p_escrow_plan_id: escrowPlanId,
      p_payment_intent_id: intent.id,
    },
  )

  if (rpcError) {
    logError('webhook.stripe.failed', new Error(rpcError.message), {
      eventId,
      eventType,
      fundingRequestId,
      reason: 'confirm_funding_atomic RPC failed',
    })
    await finalizeWebhookEvent(
      supabase, eventId, 'failed',
      null, jobId || null, null, null, 'db_funding_rpc_failed',
    )
    return false
  }

  const outcome = rpcResult?.outcome ?? 'unknown'

  if (outcome === 'not_found') {
    logWarning('webhook.stripe.failed', {
      eventId,
      eventType,
      fundingRequestId,
      reason: 'confirm_funding_atomic: funding_request not found',
    })
    await finalizeWebhookEvent(
      supabase, eventId, 'not_found',
      null, jobId || null, null, null,
    )
    return true
  }

  if (outcome === 'invalid_state') {
    logWarning('webhook.stripe.skipped', {
      eventId,
      eventType,
      fundingRequestId,
      reason: `confirm_funding_atomic: ${rpcResult?.detail}`,
    })
    await finalizeWebhookEvent(
      supabase, eventId, 'skipped',
      null, jobId || null, rpcResult?.funding_request_status ?? null, null,
    )
    return true
  }

  if (outcome === 'job_terminal') {
    // The job was cancelled/completed while a live PaymentIntent was in flight
    // (the cancel cascade leaves funding_initiated PIs to this RPC). The RPC
    // refused to RECORD funding — but the card was already charged
    // (payment_intent.succeeded), so the captured money must be returned, not
    // left stranded on a dead order. Refund (idempotent key), then audit
    // truthfully as 'skipped' — never as a 'reconciled' funding that did not
    // happen. Refund failure → 'failed' so Stripe retries (re-claimable); the
    // refund idempotency key prevents a double refund on re-delivery.
    try {
      const refund = await executeEscrowRefundForIntent(stripe, intent, { destinationChargeEnabled })
      if (refund.ok === false) {
        logError('webhook.stripe.failed', new Error(JSON.stringify(refund.body)), {
          eventId, eventType, fundingRequestId, jobId,
          reason: 'job_terminal refund refused (MAX guard / structured)',
        })
        await finalizeWebhookEvent(
          supabase, eventId, 'failed',
          null, jobId || null, 'funding_initiated', null, 'job_terminal_refund_refused',
        )
        return false
      }
      logWarning('webhook.stripe.job_terminal_refunded', {
        eventId, eventType, paymentIntentId: intent.id, fundingRequestId, jobId,
        jobStatus: rpcResult?.job_status ?? null,
        refundMode: refund.mode,
        note: 'funding refused for terminal job — captured PaymentIntent reversed',
      })

      // Journal the refund as a first-class ledger entry — Supabase is the source
      // of truth, and the RPC's C1 funding-ledger block was skipped (no escrow was
      // recorded), so this is the only Supabase trace of the captured-then-reversed
      // money. Idempotent via UNIQUE(payment_id, entry_type, movement_ref) keyed on
      // the PaymentIntent id. Non-fatal: the refund already settled the money, so a
      // ledger-write failure must not loop the event — it is logged for reconcile.
      if (jobId) {
        const { data: payRow } = await supabase
          .from('payments')
          .select('id')
          .eq('job_id', jobId)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle()
        const payId = (payRow?.id as string | null) ?? null
        if (payId) {
          const { error: ledgerErr } = await supabase
            .from('ledger_entries')
            .upsert(
              {
                payment_id: payId,
                job_id: jobId,
                entry_type: 'escrow_refund',
                amount: intent.amount / 100,
                currency: intent.currency.toUpperCase(),
                movement_ref: intent.id,
                metadata: {
                  note: 'Einzahlung auf storniertem/abgeschlossenem Auftrag erstattet',
                  payment_intent_id: intent.id,
                  job_status: rpcResult?.job_status ?? null,
                  refund_mode: refund.mode,
                },
              },
              { onConflict: 'payment_id,entry_type,movement_ref', ignoreDuplicates: true },
            )
          if (ledgerErr) {
            logWarning('webhook.stripe.job_terminal_ledger_failed', {
              eventId, jobId, paymentIntentId: intent.id, reason: ledgerErr.message,
            })
          }
        } else {
          logWarning('webhook.stripe.job_terminal_ledger_skipped', {
            eventId, jobId, paymentIntentId: intent.id,
            note: 'no payments row for job — refund journaled in Stripe + audit row only',
          })
        }
      }

      await finalizeWebhookEvent(
        supabase, eventId, 'skipped',
        null, jobId || null, 'funding_initiated', null,
        `job_terminal_refunded:${rpcResult?.job_status ?? 'unknown'}`,
      )
      return true
    } catch (refundErr: unknown) {
      logError(
        'webhook.stripe.failed',
        refundErr instanceof Error ? refundErr : new Error(String(refundErr)),
        { eventId, eventType, fundingRequestId, jobId, reason: 'job_terminal refund threw' },
      )
      await finalizeWebhookEvent(
        supabase, eventId, 'failed',
        null, jobId || null, 'funding_initiated', null, 'job_terminal_refund_error',
      )
      return false
    }
  }

  // 'confirmed' or 'already_funded'
  logInfo('webhook.stripe.processed', {
    eventId,
    eventType,
    paymentIntentId: intent.id,
    fundingRequestId,
    escrowPlanId,
    jobId,
    outcome: `funding_${outcome}`,
    tranchesUpdated: rpcResult?.tranches_updated,
  })

  await finalizeWebhookEvent(
    supabase, eventId, 'reconciled',
    null, jobId || null, 'funding_initiated', 'funded_in_escrow',
  )
  return true
}

// ---------------------------------------------------------------------------
// Supplementary funding confirmation
//
// When a PaymentIntent created by initiate-supplementary-funding succeeds,
// the webhook transitions the supplementary_payment_request to 'funded'.
// These PIs are identified by metadata.type === 'supplementary_funding'.
// ---------------------------------------------------------------------------

/**
 * Reconciles a successful supplementary-funding PaymentIntent.
 *
 * 1. Claims the webhook event (deduplication).
 * 2. Resolves the supplementary_payment_request by metadata or external_ref.
 * 3. Updates supplementary_payment_requests → 'funded' (row-count guarded).
 * 4. On 0 affected rows, decides idempotent-OK vs terminal-refund from the
 *    CURRENT row state — mirrors api/confirm-supplementary-funding.ts so the
 *    webhook path cannot strand captured money on a waived/paid/dup-funded
 *    request. There is NO downstream heal for supplementary PIs.
 * 5. Finalizes the audit row.
 */
async function reconcileSupplementaryFundingConfirmation(
  supabase: SupabaseClient,
  stripe: Stripe,
  intent: Stripe.PaymentIntent,
  eventId: string,
  eventType: string,
  destinationChargeEnabled: boolean,
): Promise<boolean> {
  const claim = await claimWebhookEvent(supabase, eventId, eventType, intent.id)
  if (claim === 'duplicate') {
    logInfo('webhook.stripe.duplicate', {
      eventId,
      eventType,
      paymentIntentId: intent.id,
      note: 'supplementary funding event already claimed — skipping',
    })
    return true
  }

  const metadata = intent.metadata ?? {}
  let supplementaryPaymentId = (metadata.supplementaryPaymentId ?? '').trim()
  const jobId = (metadata.jobId ?? '').trim()

  // Fallback: look up by external_ref
  if (!supplementaryPaymentId) {
    const { data: row } = await supabase
      .from('supplementary_payment_requests')
      .select('id')
      .eq('external_ref', intent.id)
      .maybeSingle()

    if (row) {
      supplementaryPaymentId = row.id
    }
  }

  if (!supplementaryPaymentId) {
    logWarning('webhook.stripe.failed', {
      eventId,
      eventType,
      paymentIntentId: intent.id,
      reason: 'supplementary_funding PI succeeded but no request found — cannot reconcile',
    })
    await finalizeWebhookEvent(supabase, eventId, 'not_found', null, jobId || null, null, null)
    return true
  }

  const nowMs = Date.now()

  // Update supplementary_payment_requests → 'funded'
  // Status guard: only advance from non-terminal states.
  // .select() so we can inspect the affected-row count — a 0-row result must
  // NOT be reconciled blindly (H1): the request already left the fundable
  // states while this captured PI is in flight.
  const { data: updatedRows, error: updateError } = await supabase
    .from('supplementary_payment_requests')
    .update({
      status: 'funded',
      external_ref: intent.id,
      funded_at: nowMs,
      updated_at: nowMs,
    })
    .eq('id', supplementaryPaymentId)
    .in('status', ['pending', 'acknowledged', 'funding_initiated'])
    .select('id')

  if (updateError) {
    logError('webhook.stripe.failed', new Error(updateError.message), {
      eventId,
      eventType,
      supplementaryPaymentId,
      reason: 'failed to update supplementary_payment_request to funded',
    })
    await finalizeWebhookEvent(
      supabase, eventId, 'failed',
      null, jobId || null, null, null, 'db_supplementary_update_failed',
    )
    return false
  }

  if (!updatedRows || updatedRows.length === 0) {
    // H1 — the guarded UPDATE matched no row: the request already left the
    // fundable states. Never audit as 'reconciled' blindly. Decide idempotent-OK
    // vs terminal-refund from the CURRENT row state (mirrors
    // api/confirm-supplementary-funding.ts).
    const { data: currentRow, error: currentError } = await supabase
      .from('supplementary_payment_requests')
      .select('status, external_ref, original_payment_id, job_id')
      .eq('id', supplementaryPaymentId)
      .maybeSingle()

    if (currentError) {
      logError('webhook.stripe.failed', new Error(currentError.message), {
        eventId,
        eventType,
        supplementaryPaymentId,
        reason: 'failed to fetch current supplementary request state after 0-row update',
      })
      await finalizeWebhookEvent(
        supabase, eventId, 'failed',
        null, jobId || null, null, null, 'db_supplementary_state_fetch_failed',
      )
      return false
    }

    if (!currentRow) {
      // The request row vanished (hard-deleted, e.g. account cascade) between the
      // resolve and this read, yet the PI is captured. No row means the money can
      // never be released against a request — refund so captured funds are not
      // stranded (money-guard). No ledger linkage is possible (row gone); the
      // per-PI refund idempotency key still blocks a double refund. A refund
      // failure finalizes 'failed' + returns false so Stripe re-delivers rather
      // than the event silently closing over stranded money.
      try {
        const refund = await executeEscrowRefundForIntent(stripe, intent, { destinationChargeEnabled })
        if (refund.ok === false) {
          logError('webhook.stripe.failed', new Error(JSON.stringify(refund.body)), {
            eventId, eventType, paymentIntentId: intent.id, supplementaryPaymentId,
            reason: 'vanished-request captured-PI refund refused (MAX guard / structured)',
          })
          await finalizeWebhookEvent(
            supabase, eventId, 'failed', null, jobId || null, null, null,
            'supplementary_vanished_refund_refused',
          )
          return false
        }
        logWarning('webhook.stripe.supplementary_vanished_refunded', {
          eventId,
          eventType,
          paymentIntentId: intent.id,
          supplementaryPaymentId,
          refundMode: refund.mode,
          reason: 'supplementary request vanished between resolve and update — captured PaymentIntent reversed',
        })
      } catch (refundErr: unknown) {
        logError('webhook.stripe.failed', refundErr instanceof Error ? refundErr : new Error(String(refundErr)), {
          eventId, eventType, paymentIntentId: intent.id, supplementaryPaymentId,
          reason: 'vanished-request captured-PI refund threw',
        })
        await finalizeWebhookEvent(
          supabase, eventId, 'failed', null, jobId || null, null, null,
          'supplementary_vanished_refund_threw',
        )
        return false
      }
      await finalizeWebhookEvent(supabase, eventId, 'not_found', null, jobId || null, null, null)
      return true
    }

    // Idempotent retry: the SAME PaymentIntent already funded this request (a
    // prior delivery or the client confirm endpoint won the race). 'released' is
    // downstream of 'funded' (transfer already executed). Nothing to move.
    const alreadyFundedByThisIntent =
      (currentRow.status === 'funded' || currentRow.status === 'released') &&
      currentRow.external_ref === intent.id

    if (alreadyFundedByThisIntent) {
      logInfo('webhook.stripe.duplicate', {
        eventId,
        eventType,
        paymentIntentId: intent.id,
        supplementaryPaymentId,
        currentStatus: currentRow.status,
        note: 'supplementary request already funded by this PI — idempotent skip',
      })
      await finalizeWebhookEvent(
        supabase, eventId, 'skipped',
        null, (currentRow.job_id as string | null) ?? jobId ?? null,
        currentRow.status, null, 'already_funded_by_this_pi',
      )
      return true
    }

    // Terminal without this PI's money (waived / paid off-platform / funded by a
    // DIFFERENT PI). The PI is captured (payment_intent.succeeded), but this
    // request will never release against it — refund so the money is not
    // stranded. Covers the race with waiveSupplementaryPayment, which flips the
    // row terminal but never cancels the PaymentIntent. Idempotent refund key
    // (per PI) prevents a double refund on Stripe re-delivery.
    try {
      const refund = await executeEscrowRefundForIntent(stripe, intent, { destinationChargeEnabled })
      if (refund.ok === false) {
        logError('webhook.stripe.failed', new Error(JSON.stringify(refund.body)), {
          eventId, eventType, paymentIntentId: intent.id, supplementaryPaymentId,
          currentStatus: currentRow.status,
          reason: 'supplementary terminal-state refund refused (MAX guard / structured)',
        })
        await finalizeWebhookEvent(
          supabase, eventId, 'failed',
          null, (currentRow.job_id as string | null) ?? jobId ?? null,
          currentRow.status, null, 'supplementary_terminal_refund_refused',
        )
        return false
      }

      logWarning('webhook.stripe.supplementary_terminal_refunded', {
        eventId,
        eventType,
        paymentIntentId: intent.id,
        supplementaryPaymentId,
        currentStatus: currentRow.status,
        refundMode: refund.mode,
        note: 'supplementary request no longer fundable — captured PaymentIntent reversed',
      })

      // Journal the refund as a first-class ledger entry — Supabase is the source
      // of truth, and no escrow was recorded for this dead request, so this is the
      // only Supabase trace of the captured-then-reversed money. Idempotent via
      // UNIQUE(payment_id, entry_type, movement_ref) keyed on the PI id. Non-fatal:
      // the refund already settled the money, so a ledger-write failure must not
      // loop the event — it is logged for reconcile.
      if (refund.mode === 'refunded' && currentRow.original_payment_id) {
        const refundedMinor = intent.amount_received ?? intent.amount ?? 0
        const { error: ledgerError } = await supabase.from('ledger_entries').upsert(
          {
            payment_id: currentRow.original_payment_id,
            job_id: (currentRow.job_id as string | null) ?? null,
            entry_type: 'refund',
            amount: Number((refundedMinor / 100).toFixed(2)),
            currency: (intent.currency ?? 'eur').toUpperCase(),
            movement_ref: intent.id,
            metadata: {
              note: `Nachtrag-Zahlung zurückerstattet (nicht mehr förderbar) [${supplementaryPaymentId}]`,
              spr_id: supplementaryPaymentId,
              terminal_status: currentRow.status,
            },
          },
          { onConflict: 'payment_id,entry_type,movement_ref', ignoreDuplicates: true },
        )
        if (ledgerError) {
          logWarning('webhook.stripe.supplementary_terminal_ledger_failed', {
            eventId,
            paymentIntentId: intent.id,
            supplementaryPaymentId,
            reason: ledgerError.message,
          })
        }
      }
    } catch (refundErr: unknown) {
      // Unlike escrow-funding's job_terminal branch there is NO webhook path that
      // later refunds supplementary PIs — a failed refund would strand the
      // captured money. Finalize 'failed' → HTTP 500 → Stripe retries (the row is
      // re-claimable). The refund idempotency key is stable per PI, so a retry
      // cannot double-refund.
      logError(
        'webhook.stripe.failed',
        refundErr instanceof Error ? refundErr : new Error(String(refundErr)),
        {
          eventId, eventType, paymentIntentId: intent.id, supplementaryPaymentId,
          currentStatus: currentRow.status,
          reason: 'supplementary terminal-state refund threw',
        },
      )
      await finalizeWebhookEvent(
        supabase, eventId, 'failed',
        null, (currentRow.job_id as string | null) ?? jobId ?? null,
        currentRow.status, null, 'supplementary_terminal_refund_error',
      )
      return false
    }

    // Refund settled: the captured money is returned and the event is fully
    // handled. Audit truthfully as 'skipped' (never a funding that did not
    // happen) and return true so Stripe does not retry.
    await finalizeWebhookEvent(
      supabase, eventId, 'skipped',
      null, (currentRow.job_id as string | null) ?? jobId ?? null,
      currentRow.status, null, `supplementary_terminal_refunded:${currentRow.status}`,
    )
    return true
  }

  logInfo('webhook.stripe.processed', {
    eventId,
    eventType,
    paymentIntentId: intent.id,
    supplementaryPaymentId,
    jobId,
    outcome: 'supplementary_funding_confirmed',
  })

  await finalizeWebhookEvent(
    supabase, eventId, 'reconciled',
    null, jobId || null, 'funding_initiated', 'funded',
  )
  return true
}

// ---------------------------------------------------------------------------
// Diagnosis payment confirmation
//
// When a PaymentIntent created by initiate-diagnosis-payment succeeds, the
// webhook transitions the diagnosis Payment to 'diagnosis_payment_completed'.
// These PIs are identified by metadata.type === 'diagnosis_payment'.
// ---------------------------------------------------------------------------

/**
 * Reconciles a successful diagnosis instant-payment PaymentIntent.
 *
 * 1. Claims the webhook event (deduplication).
 * 2. Resolves the Payment record — by provider_ref, then metadata.paymentId fallback.
 * 3. Updates payment.status → 'diagnosis_payment_completed'.
 * 4. Syncs job.payment_state and project.payment_state.
 * 5. Finalizes the audit row.
 */
async function reconcileDiagnosisPaymentConfirmation(
  supabase: SupabaseClient,
  intent: Stripe.PaymentIntent,
  eventId: string,
  eventType: string,
): Promise<boolean> {
  // 0. Claim atomically — duplicate deliveries exit here.
  const claim = await claimWebhookEvent(supabase, eventId, eventType, intent.id)
  if (claim === 'duplicate') {
    logInfo('webhook.stripe.duplicate', {
      eventId,
      eventType,
      paymentIntentId: intent.id,
      note: 'diagnosis_payment event already claimed — skipping',
    })
    return true
  }

  const metadata = intent.metadata ?? {}
  const metaPaymentId = (metadata.paymentId ?? '').trim()
  const metaJobId = (metadata.jobId ?? '').trim()

  // 1. Look up payment — primary by provider_ref, fallback by metadata.paymentId.
  let payment: { id: string; job_id: string | null; status: string } | null = null

  const { data: byRef, error: refError } = await supabase
    .from('payments')
    .select('id, job_id, status')
    .eq('provider_ref', intent.id)
    .maybeSingle()

  if (refError) {
    logError('webhook.stripe.failed', new Error(refError.message), {
      eventId, eventType, paymentIntentId: intent.id, reason: 'provider_ref lookup failed',
    })
  } else {
    payment = byRef
  }

  if (!payment && metaPaymentId) {
    const { data: byMeta, error: metaError } = await supabase
      .from('payments')
      .select('id, job_id, status')
      .eq('id', metaPaymentId)
      .maybeSingle()

    if (metaError) {
      logError('webhook.stripe.failed', new Error(metaError.message), {
        eventId, eventType, paymentIntentId: intent.id, reason: 'metadata.paymentId lookup failed',
      })
    } else {
      payment = byMeta
    }
  }

  if (!payment) {
    logWarning('webhook.stripe.failed', {
      eventId, eventType, paymentIntentId: intent.id,
      reason: 'diagnosis_payment PI succeeded but no payment record found',
    })
    await finalizeWebhookEvent(supabase, eventId, 'not_found', null, metaJobId || null, null, null)
    return true
  }

  // 2. Idempotency — already completed.
  if (payment.status === 'diagnosis_payment_completed') {
    await finalizeWebhookEvent(
      supabase, eventId, 'skipped',
      payment.id, payment.job_id, payment.status, 'diagnosis_payment_completed',
    )
    return true
  }

  // 3. Update payment → 'diagnosis_payment_completed'.
  const now = Date.now()
  const { error: paymentUpdateError } = await supabase
    .from('payments')
    .update({
      status: 'diagnosis_payment_completed',
      provider_ref: intent.id,
      updated_at: now,
    })
    .eq('id', payment.id)
    .eq('status', 'diagnosis_payment_pending')

  if (paymentUpdateError) {
    logError('webhook.stripe.failed', new Error(paymentUpdateError.message), {
      eventId, eventType, paymentId: payment.id,
      reason: 'failed to update diagnosis payment to completed',
    })
    await finalizeWebhookEvent(
      supabase, eventId, 'failed',
      payment.id, payment.job_id, payment.status, null, 'db_payment_update_failed',
    )
    return false
  }

  logInfo('webhook.stripe.processed', {
    eventId, eventType,
    paymentId: payment.id,
    paymentIntentId: intent.id,
    previousState: 'diagnosis_payment_pending',
    newState: 'diagnosis_payment_completed',
  })

  await finalizeWebhookEvent(
    supabase, eventId, 'reconciled',
    payment.id, payment.job_id, 'diagnosis_payment_pending', 'diagnosis_payment_completed',
  )

  // 4. Best-effort: sync job and project payment_state.
  const jobId = payment.job_id ?? metaJobId
  if (jobId) {
    const { data: jobRow, error: jobFetchError } = await supabase
      .from('jobs')
      .select('status, project_id')
      .eq('id', jobId)
      .maybeSingle()

    if (jobFetchError || !jobRow) {
      logWarning('webhook.stripe.failed', {
        eventId, jobId, reason: 'diagnosis job not found for payment_state sync',
      })
      return true
    }

    const { error: jobUpdateError } = await supabase
      .from('jobs')
      .update({ payment_state: 'diagnosis_payment_completed', updated_at: now })
      .eq('id', jobId)

    if (jobUpdateError) {
      logError('webhook.stripe.failed', new Error(jobUpdateError.message), {
        eventId, jobId, reason: 'diagnosis job payment_state sync failed',
      })
    }

    const projectId = (jobRow as { status: string; project_id: string | null }).project_id
    if (projectId) {
      const { error: projUpdateError } = await supabase
        .from('projects')
        .update({ payment_state: 'diagnosis_payment_completed', updated_at: now })
        .eq('id', projectId)

      if (projUpdateError) {
        logError('webhook.stripe.failed', new Error(projUpdateError.message), {
          eventId, jobId, projectId, reason: 'diagnosis project payment_state sync failed',
        })
      }
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Connect account reconciliation
// ---------------------------------------------------------------------------

type OnboardingStatus = 'not_started' | 'onboarding_in_progress' | 'onboarding_complete' | 'payout_blocked'

function deriveOnboardingStatus(account: Stripe.Account): OnboardingStatus {
  if (account.charges_enabled && account.payouts_enabled) {
    return 'onboarding_complete'
  }
  if (account.requirements?.disabled_reason) {
    return 'payout_blocked'
  }
  return 'onboarding_in_progress'
}

/**
 * Syncs provider payout account status from a Stripe Connect account webhook.
 *
 * Finds the provider_payout_accounts row by stripe_connect_account_id, fetches
 * the latest account state from Stripe, and updates the onboarding status,
 * charges/payouts enabled flags, requirements, and completion timestamp.
 *
 * Returns:
 *   'reconciled' — status updated successfully
 *   'not_found'  — no provider_payout_accounts row with this Connect account ID
 */
async function reconcileConnectAccount(
  supabase: SupabaseClient,
  stripeAccountId: string,
  eventId: string,
  eventType: string,
): Promise<'reconciled' | 'not_found'> {
  // 1. Find the provider_payout_accounts row by stripe_connect_account_id
  const { data: payoutAccount, error: lookupError } = await supabase
    .from('provider_payout_accounts')
    .select('provider_user_id, onboarding_completed_at')
    .eq('stripe_connect_account_id', stripeAccountId)
    .maybeSingle()

  if (lookupError) {
    logError('webhook.stripe.connect.failed', new Error(lookupError.message), {
      eventId,
      eventType,
      stripeAccountId,
      reason: 'db_lookup_failed',
    })
    return 'not_found'
  }

  if (!payoutAccount) {
    logWarning('webhook.stripe.connect.not_found', {
      eventId,
      eventType,
      stripeAccountId,
      reason: 'no provider_payout_accounts row with this stripe_connect_account_id',
    })
    return 'not_found'
  }

  // 2. Fetch the latest account state from Stripe
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    logError('webhook.stripe.connect.failed', undefined, {
      eventId,
      eventType,
      stripeAccountId,
      reason: 'STRIPE_SECRET_KEY not set',
    })
    return 'not_found'
  }

  const stripe = getStripe(secretKey)
  let account: Stripe.Account
  try {
    account = await stripe.accounts.retrieve(stripeAccountId)
  } catch (err: unknown) {
    logError('webhook.stripe.connect.failed', err instanceof Error ? err : undefined, {
      eventId,
      eventType,
      stripeAccountId,
      reason: 'stripe_account_lookup_failed',
    })
    return 'not_found'
  }

  // 3. Derive status and update provider_payout_accounts
  const newStatus = deriveOnboardingStatus(account)
  const chargesEnabled = account.charges_enabled ?? false
  const payoutsEnabled = account.payouts_enabled ?? false
  const requirementsDue = account.requirements?.currently_due?.join(',') ?? null
  const now = new Date().toISOString()
  const existingCompletion = payoutAccount.onboarding_completed_at ?? null
  const nextCompletion = newStatus === 'onboarding_complete' && !existingCompletion ? now : existingCompletion

  const updatePayload: Record<string, unknown> = {
    onboarding_status: newStatus,
    charges_enabled: chargesEnabled,
    payouts_enabled: payoutsEnabled,
    requirements_due: requirementsDue,
    updated_at: now,
  }
  if (nextCompletion) {
    updatePayload.onboarding_completed_at = nextCompletion
  }

  const { error: updateError } = await supabase
    .from('provider_payout_accounts')
    .update(updatePayload)
    .eq('stripe_connect_account_id', stripeAccountId)

  if (updateError) {
    logError('webhook.stripe.connect.failed', new Error(updateError.message), {
      eventId,
      eventType,
      stripeAccountId,
      reason: 'db_update_failed',
    })
    return 'not_found'
  }

  logInfo('webhook.stripe.connect.reconciled', {
    eventId,
    eventType,
    stripeAccountId,
    providerUserId: payoutAccount.provider_user_id,
    status: newStatus,
    chargesEnabled,
    payoutsEnabled,
  })

  return 'reconciled'
}

/**
 * Applies a payment state reconciliation driven by a Stripe webhook event.
 *
 * Lookup key: payments.provider_ref = paymentIntentId
 *
 * Deduplication model (claim-first):
 * - Step 0: Atomically INSERT a 'processing' row into stripe_webhook_events.
 *   The event_id PRIMARY KEY constraint prevents duplicate rows.  If the
 *   INSERT fails with a PK conflict, another delivery already claimed this
 *   event and we skip immediately — no payment reads/writes occur.
 * - Steps 1-4: Normal reconciliation path.
 * - Step 5: UPDATE the audit row from 'processing' to the final outcome.
 *
 * Other guarantees:
 * - Idempotent: if the payment is already in the target state, we skip.
 *   Terminal states (released, refunded) have no outgoing transitions.
 * - State-machine validated: only valid transitions are applied.
 * - Best-effort job handoff: job.payment_state is synced after payment update.
 * - Fault-tolerant: Supabase errors are logged but never cause a non-2xx
 *   response (which would trigger Stripe retries with the same event).
 */
async function reconcilePaymentState(
  supabase: SupabaseClient,
  paymentIntentId: string,
  targetState: ReconcileTarget,
  eventId: string,
  eventType: string,
  refundedAmount?: number,
): Promise<ReconcileOutcome> {
  // 0. Claim the event atomically.  A 'duplicate' result means another
  //    delivery already owns this event — skip all further processing.
  const claim = await claimWebhookEvent(supabase, eventId, eventType, paymentIntentId)
  if (claim === 'duplicate') {
    logInfo('webhook.stripe.duplicate', {
      eventId,
      eventType,
      paymentIntentId,
      note: 'event already claimed by prior delivery — skipping',
    })
    return 'skipped'
  }

  // 1. Look up payment by Stripe PaymentIntent ID (provider_ref).
  const { data, error } = await supabase
    .from('payments')
    .select('id, job_id, status, total_amount')
    .eq('provider_ref', paymentIntentId)
    .maybeSingle()

  if (error) {
    logError('webhook.stripe.failed', new Error(error.message), {
      eventId,
      eventType,
      paymentIntentId,
      reason: 'DB lookup error for payment by provider_ref',
    })
    await finalizeWebhookEvent(supabase, eventId, 'failed', null, null, null, null, 'db_lookup_error')
    return 'failed'
  }

  if (!data) {
    // No payment found — test event, payment outside this system, or
    // createEscrow mid-flight failure.  Acknowledge and continue.
    logInfo('webhook.stripe.received', {
      eventId,
      eventType,
      paymentIntentId,
      outcome: 'not_found',
      note: 'no payment found for provider_ref — skipping reconciliation',
    })
    await finalizeWebhookEvent(supabase, eventId, 'not_found', null, null, null, null)
    return 'not_found'
  }

  const payment = data as { id: string; job_id: string | null; status: string; total_amount: number }

  // 2. Idempotency: already in the target state → skip.
  if (payment.status === targetState) {
    logInfo('webhook.stripe.duplicate', {
      eventId,
      eventType,
      paymentId: payment.id,
      currentState: payment.status,
      targetState,
      note: 'payment already in target state — no-op',
    })
    await finalizeWebhookEvent(
      supabase, eventId, 'skipped',
      payment.id, payment.job_id, payment.status, targetState,
    )
    return 'skipped'
  }

  // 3. State-machine validation: skip invalid transitions.
  if (!isValidWebhookTransition(payment.status, targetState)) {
    logWarning('webhook.stripe.failed', {
      eventId,
      eventType,
      paymentId: payment.id,
      currentState: payment.status,
      targetState,
      reason: `invalid state-machine transition '${payment.status}' → '${targetState}'`,
    })
    await finalizeWebhookEvent(
      supabase, eventId, 'invalid_transition',
      payment.id, payment.job_id, payment.status, null,
      `invalid_transition:${payment.status}_to_${targetState}`,
    )
    return 'skipped'
  }

  const now = Date.now()

  // 4. Update payment state.
  //    Optimistic concurrency guard: only update if payment is still in the
  //    state we read in step 1.  Prevents overwriting a more-advanced state
  //    set by a concurrent webhook delivery or client-side workflow.
  //
  //    If the guard fails (0 rows updated because another actor already
  //    advanced the state), the UPDATE succeeds silently with no affected
  //    rows — Supabase does not return an error.  The finalizeWebhookEvent
  //    call below records 'reconciled' regardless, which is acceptable
  //    because the payment is already at a correct-or-more-advanced state.
  //    The concurrency loser's webhook delivery becomes a safe no-op.
  const paymentUpdate: Record<string, unknown> = { status: targetState, updated_at: now }
  if (targetState === 'refunded' && refundedAmount !== undefined) {
    paymentUpdate.refunded_amount = refundedAmount
  }
  const { error: paymentUpdateError } = await supabase
    .from('payments')
    .update(paymentUpdate)
    .eq('id', payment.id)
    .eq('status', payment.status)

  if (paymentUpdateError) {
    logError('webhook.stripe.failed', new Error(paymentUpdateError.message), {
      eventId,
      eventType,
      paymentId: payment.id,
      reason: 'failed to update payment state in DB',
    })
    await finalizeWebhookEvent(
      supabase, eventId, 'failed',
      payment.id, payment.job_id, payment.status, null,
      'db_payment_update_failed',
    )
    return 'failed'
  }

  logInfo('webhook.stripe.processed', {
    eventId,
    eventType,
    paymentId: payment.id,
    previousState: payment.status,
    newState: targetState,
  })

  // 5. Finalize audit row to 'reconciled'.
  await finalizeWebhookEvent(
    supabase, eventId, 'reconciled',
    payment.id, payment.job_id, payment.status, targetState,
  )

  // 6. Best-effort job handoff: sync job.payment_state and, for terminal
  //    states, advance job.status to 'completed' when it is in waiting_payment.
  if (payment.job_id) {
    await reconcileJobFromPayment(
      supabase,
      payment.job_id,
      targetState,
      now,
      eventId,
    )
  }

  // 7. Best-effort ledger 'refund' movement for refunded state.
  //    Dedupes on (payment_id, 'refund', '') via upsert ignoreDuplicates so the
  //    sibling reconcileChargeRefunded refund writer is a no-op if it runs second.
  //    Skip for disputed payments AND when the corridor split-settle already booked
  //    a refund_partial row (G7): the dispute settlement path owns refund
  //    accounting, and the unique index does NOT dedup across 'refund'/'' vs
  //    'refund_partial'/<disputeId>, so writing 'refund' here once the payment has
  //    left 'disputed' would double-count. corridorRefundPartialExists fails OPEN
  //    (returns false on a transient read error) so flag-OFF writes stay byte-identical.
  if (
    targetState === 'refunded' &&
    payment.job_id &&
    payment.status !== 'disputed' &&
    !(await corridorRefundPartialExists(supabase, payment.id))
  ) {
    const ledgerAmount = refundedAmount ?? payment.total_amount
    const { error: ledgerError } = await supabase
      .from('ledger_entries')
      .upsert(
        {
          payment_id: payment.id,
          job_id: payment.job_id,
          entry_type: 'refund',
          amount: ledgerAmount,
          currency: 'EUR',
          movement_ref: '',
          metadata: { note: 'Zahlung zurückerstattet' },
        },
        { onConflict: 'payment_id,entry_type,movement_ref', ignoreDuplicates: true },
      )
    if (ledgerError) {
      logWarning('webhook.stripe.failed', {
        eventId,
        paymentId: payment.id,
        reason: 'refund ledger entry write failed — payment state is correctly updated',
        error: ledgerError.message,
      })
    }
  }

  return 'reconciled'
}

/**
 * Dedicated reconciliation path for charge.refunded events.
 *
 * Separated from reconcilePaymentState to handle two concerns unique to
 * charge.refunded that do not apply to other webhook transitions:
 *
 * 1. Cumulative amount sync: charge.amount_refunded is Stripe's running total,
 *    not a per-event delta. If the payment is already in 'refunded' state (e.g.
 *    a subsequent partial refund fires after the first), we must update
 *    refunded_amount and the ledger entry unconditionally even though the state
 *    machine transition is already complete.
 *
 * 2. Dispute classification: if the payment was in 'disputed' state at the time
 *    of the refund, the client dispute path (resolveDisputeRefundWorkflow) has
 *    already written a 'dispute_resolved_refund' ledger entry. Writing a second
 *    'refund' entry here would cause getRefunds() to double-count.  Skip the
 *    ledger write for disputed source states.
 */
async function reconcileChargeRefunded(
  supabase: SupabaseClient,
  paymentIntentId: string,
  refundedAmount: number,
  eventId: string,
  eventType: string,
): Promise<ReconcileOutcome> {
  // 0. Claim the event atomically.
  const claim = await claimWebhookEvent(supabase, eventId, eventType, paymentIntentId)
  if (claim === 'duplicate') {
    logInfo('webhook.stripe.duplicate', {
      eventId,
      eventType,
      paymentIntentId,
      note: 'event already claimed by prior delivery — skipping',
    })
    return 'skipped'
  }

  // 1. Look up payment by Stripe PaymentIntent ID.
  const { data, error } = await supabase
    .from('payments')
    .select('id, job_id, status, total_amount')
    .eq('provider_ref', paymentIntentId)
    .maybeSingle()

  if (error) {
    logError('webhook.stripe.failed', new Error(error.message), {
      eventId,
      eventType,
      paymentIntentId,
      reason: 'DB lookup error for payment by provider_ref',
    })
    await finalizeWebhookEvent(supabase, eventId, 'failed', null, null, null, null, 'db_lookup_error')
    return 'failed'
  }

  if (!data) {
    logInfo('webhook.stripe.received', {
      eventId,
      eventType,
      paymentIntentId,
      outcome: 'not_found',
      note: 'no payment found for provider_ref — skipping reconciliation',
    })
    await finalizeWebhookEvent(supabase, eventId, 'not_found', null, null, null, null)
    return 'not_found'
  }

  const payment = data as { id: string; job_id: string | null; status: string; total_amount: number }
  const now = Date.now()

  // 2. Already refunded: sync cumulative amount + ledger, skip state transition.
  //    charge.amount_refunded is authoritative from Stripe — always persist it.
  if (payment.status === 'refunded') {
    const { error: amountSyncError } = await supabase
      .from('payments')
      .update({ refunded_amount: refundedAmount, updated_at: now })
      .eq('id', payment.id)

    if (amountSyncError) {
      logWarning('webhook.stripe.failed', {
        eventId,
        paymentId: payment.id,
        reason: 'failed to sync cumulative refunded_amount on already-refunded payment',
        error: amountSyncError.message,
        refundedAmount,
      })
    }

    // Sync the cumulative refunded amount onto the 'refund' movement row.
    // .update() is intentionally a no-op when no matching row exists yet — a
    // later refund webhook upserts the entry with the same correct amount.
    // Filters on entry_type (prod) — the legacy nullable `type` column is NULL
    // under the movement model, so filtering it would match 0 rows and silently
    // never sync.
    const { error: ledgerSyncError } = await supabase
      .from('ledger_entries')
      .update({ amount: refundedAmount })
      .eq('payment_id', payment.id)
      .eq('entry_type', 'refund')

    if (ledgerSyncError) {
      logWarning('webhook.stripe.failed', {
        eventId,
        paymentId: payment.id,
        reason: 'failed to sync cumulative refund amount on ledger entry',
        error: ledgerSyncError.message,
        refundedAmount,
      })
    }

    logInfo('webhook.stripe.processed', {
      eventId,
      eventType,
      paymentId: payment.id,
      note: 'charge.refunded on already-refunded payment — synced refunded_amount and ledger',
      refundedAmount,
    })
    await finalizeWebhookEvent(
      supabase, eventId, 'reconciled',
      payment.id, payment.job_id, payment.status, payment.status,
    )
    return 'reconciled'
  }

  // 3. State-machine validation.
  if (!isValidWebhookTransition(payment.status, 'refunded')) {
    logWarning('webhook.stripe.failed', {
      eventId,
      eventType,
      paymentId: payment.id,
      currentState: payment.status,
      targetState: 'refunded',
      reason: `invalid state-machine transition '${payment.status}' → 'refunded'`,
    })
    await finalizeWebhookEvent(
      supabase, eventId, 'invalid_transition',
      payment.id, payment.job_id, payment.status, null,
      `invalid_transition:${payment.status}_to_refunded`,
    )
    return 'skipped'
  }

  // 4. Update payment state and persist Stripe-confirmed refunded amount.
  const { error: paymentUpdateError } = await supabase
    .from('payments')
    .update({ status: 'refunded', refunded_amount: refundedAmount, updated_at: now })
    .eq('id', payment.id)
    .eq('status', payment.status)

  if (paymentUpdateError) {
    logError('webhook.stripe.failed', new Error(paymentUpdateError.message), {
      eventId,
      eventType,
      paymentId: payment.id,
      reason: 'failed to update payment state in DB',
    })
    await finalizeWebhookEvent(
      supabase, eventId, 'failed',
      payment.id, payment.job_id, payment.status, null,
      'db_payment_update_failed',
    )
    return 'failed'
  }

  logInfo('webhook.stripe.processed', {
    eventId,
    eventType,
    paymentId: payment.id,
    previousState: payment.status,
    newState: 'refunded',
    refundedAmount,
  })

  // 5. Finalize audit row.
  await finalizeWebhookEvent(
    supabase, eventId, 'reconciled',
    payment.id, payment.job_id, payment.status, 'refunded',
  )

  // 6. Best-effort job handoff.
  if (payment.job_id) {
    await reconcileJobFromPayment(supabase, payment.job_id, 'refunded', now, eventId)
  }

  // 7. Best-effort ledger 'refund' movement.
  //    Shares the (payment_id, 'refund', '') key with the reconcilePaymentState
  //    refund writer, so whichever runs second is a no-op via upsert ignoreDuplicates.
  //    Skipped for 'disputed' source state AND when the corridor split-settle
  //    already booked a refund_partial row (G7): the dispute settlement path owns
  //    refund accounting, and the unique index does NOT dedup across 'refund'/''
  //    vs 'refund_partial'/<disputeId>, so writing 'refund' here once the payment
  //    has left 'disputed' would double-count. corridorRefundPartialExists fails
  //    OPEN so flag-OFF writes stay byte-identical.
  if (
    payment.status !== 'disputed' &&
    payment.job_id &&
    !(await corridorRefundPartialExists(supabase, payment.id))
  ) {
    const { error: ledgerError } = await supabase
      .from('ledger_entries')
      .upsert(
        {
          payment_id: payment.id,
          job_id: payment.job_id,
          entry_type: 'refund',
          amount: refundedAmount,
          currency: 'EUR',
          movement_ref: '',
          metadata: { note: 'Zahlung zurückerstattet' },
        },
        { onConflict: 'payment_id,entry_type,movement_ref', ignoreDuplicates: true },
      )
    if (ledgerError) {
      logWarning('webhook.stripe.failed', {
        eventId,
        paymentId: payment.id,
        reason: 'refund ledger entry write failed — payment state is correctly updated',
        error: ledgerError.message,
      })
    }
  }

  return 'reconciled'
}

/**
 * Syncs the job and project records when a payment has been reconciled.
 *
 * - Always updates jobs.payment_state to match the new payment state.
 * - For terminal payment states (released, refunded), advances jobs.status
 *   to 'completed' only when the job is currently in 'waiting_payment'.
 *   This mirrors the guard applied by the client-side releaseEscrowWorkflow.
 * - Sets jobs.payment_released_at when reconciling to 'released'.
 * - Syncs the project's payment_state to match the new payment state,
 *   ensuring downstream truth alignment (mirrors syncPaymentStateToJobAndProject
 *   from the client-side paymentWorkflow).
 */
async function reconcileJobFromPayment(
  supabase: SupabaseClient,
  jobId: string,
  targetPaymentState: ReconcileTarget,
  now: number,
  eventId: string,
): Promise<void> {
  // Fetch the current job status and project_id so we can sync both.
  const { data: jobData, error: jobFetchError } = await supabase
    .from('jobs')
    .select('status, project_id')
    .eq('id', jobId)
    .maybeSingle()

  if (jobFetchError) {
    logError('webhook.stripe.failed', new Error(jobFetchError.message), {
      eventId,
      jobId,
      reason: 'failed to fetch job for payment_state sync',
    })
    return
  }

  if (!jobData) {
    logWarning('webhook.stripe.failed', {
      eventId,
      jobId,
      reason: 'job not found — payment_state sync skipped',
    })
    return
  }

  const jobUpdate: Record<string, unknown> = {
    payment_state: targetPaymentState,
  }

  // Advance job to 'completed' only from 'waiting_payment', to mirror the
  // client-side guard in releaseEscrowWorkflow / refundEscrowWorkflow.
  const jobRow = jobData as { status: string; project_id: string | null }
  const currentJobStatus = jobRow.status
  if (
    (targetPaymentState === 'released' || targetPaymentState === 'refunded') &&
    currentJobStatus === 'waiting_payment'
  ) {
    jobUpdate.status = 'completed'
    if (targetPaymentState === 'released') {
      jobUpdate.payment_released_at = now
    }
  }

  const { error: jobUpdateError } = await supabase
    .from('jobs')
    .update(jobUpdate)
    .eq('id', jobId)

  if (jobUpdateError) {
    // Payment state was already updated successfully.  Log job sync failure
    // but do not surface it as a webhook error — Stripe must not retry.
    logError('webhook.stripe.failed', new Error(jobUpdateError.message), {
      eventId,
      jobId,
      targetPaymentState,
      reason: 'job payment_state sync failed',
    })
  } else {
    logInfo('webhook.stripe.processed', {
      eventId,
      jobId,
      paymentState: targetPaymentState,
      jobStatus: jobUpdate.status ?? 'unchanged',
    })
  }

  // Project downstream sync: update project.payment_state to match the
  // reconciled payment state, mirroring the client-side
  // syncPaymentStateToJobAndProject contract.  Best-effort — failure
  // is logged but does not affect the webhook response.
  const projectId = jobRow.project_id
  if (projectId) {
    const { error: projectUpdateError } = await supabase
      .from('projects')
      .update({ payment_state: targetPaymentState })
      .eq('id', projectId)

    if (projectUpdateError) {
      logError('webhook.stripe.failed', new Error(projectUpdateError.message), {
        eventId,
        jobId,
        projectId,
        targetPaymentState,
        reason: 'project payment_state sync failed',
      })
    } else {
      logInfo('webhook.stripe.project_synced', {
        eventId,
        jobId,
        projectId,
        paymentState: targetPaymentState,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Stripe Transfer reconciliation
//
// transfer.created fires when a Stripe Transfer to a Connected Account was
// created successfully. In the happy path the release-tranche.ts API already
// persisted external_release_ref atomically via the release_tranche_atomic RPC.
// This handler acts as a self-healing fallback: if the API call to the RPC
// failed after the Transfer was created on Stripe, this webhook detects the
// stuck state and re-runs the same atomic DB write — using the same transfer.id
// as external_release_ref so the result is identical.
//
// transfer.reversed fires when a Stripe Transfer was reversed. This is an
// unusual event that requires manual operator review. We log it as a critical
// alert and take no automatic action — reverting the tranche state automatically
// would cause more user-facing confusion than the reversal itself.
//
// transfer.failed is NOT a reliably deliverable webhook event for Stripe Connect
// Separate Charges and Transfers. Synchronous transfer creation errors are
// handled inline by release-tranche.ts and _releaseSupplementaryPayout.ts.
// ---------------------------------------------------------------------------

/**
 * Heals a stuck tranche state after a successful Stripe Transfer.
 *
 * Triggered by transfer.created. Uses the release_tranche_atomic RPC
 * (same as release-tranche.ts) to set external_release_ref and update
 * the plan status — idempotent, safe to call even when the ref is already set.
 */
async function reconcileTransferCreated(
  supabase: SupabaseClient,
  transfer: Stripe.Transfer,
  eventId: string,
  eventType: string,
): Promise<boolean> {
  const trancheId = (transfer.metadata?.tranche_id ?? '').trim()
  if (!trancheId) {
    logInfo('webhook.stripe.transfer.skipped', {
      eventId,
      transferId: transfer.id,
      reason: 'no tranche_id in transfer metadata — not a SaFix tranche transfer',
    })
    await auditLogOnly(supabase, eventId, eventType, null)
    return true
  }

  const claim = await claimWebhookEvent(supabase, eventId, eventType, null)
  if (claim === 'duplicate') {
    logInfo('webhook.stripe.duplicate', {
      eventId,
      eventType,
      transferId: transfer.id,
      note: 'transfer.created already claimed — skipping',
    })
    return true
  }

  // Resolve plan_id from transfer_group: "escrow_plan_{planId}"
  const transferGroup = transfer.transfer_group ?? ''
  const planIdMatch = /^escrow_plan_(.+)$/.exec(transferGroup)
  const planId = planIdMatch ? planIdMatch[1] : null

  if (!planId) {
    logWarning('webhook.stripe.transfer.skipped', {
      eventId,
      transferId: transfer.id,
      trancheId,
      transferGroup,
      reason: 'transfer_group does not match escrow_plan_{id} pattern',
    })
    await finalizeWebhookEvent(supabase, eventId, 'skipped', null, null, null, null)
    return true
  }

  const { data: rpcResult, error: rpcError } = await supabase.rpc(
    'release_tranche_atomic',
    {
      p_tranche_id: trancheId,
      p_plan_id: planId,
      p_transfer_id: transfer.id,
      p_actor: 'system',
      p_released_at: new Date(transfer.created * 1000).toISOString(),
    },
  )

  if (rpcError) {
    logError('webhook.stripe.transfer.heal_failed', new Error(rpcError.message), {
      eventId,
      transferId: transfer.id,
      trancheId,
      planId,
    })
    await finalizeWebhookEvent(supabase, eventId, 'failed', null, null, null, null, 'rpc_failed')
    return false
  }

  const rpcData = rpcResult as Record<string, unknown> | null
  const outcome = rpcData?.outcome ?? 'unknown'
  logInfo('webhook.stripe.transfer.healed', {
    eventId,
    transferId: transfer.id,
    trancheId,
    planId,
    outcome,
    planStatus: rpcData?.plan_status,
  })

  await finalizeWebhookEvent(
    supabase, eventId,
    outcome === 'not_found' ? 'not_found' : 'reconciled',
    null, null, null, 'released',
  )
  return true
}

/**
 * Records a Stripe Transfer reversal in the DB and recomputes plan status.
 *
 * A reversal means funds returned from the Connected Account to the platform.
 * We mark the tranche with transfer_reversal_ref (the reversal ID) so that
 * the projection can no longer count it as released. The plan-status rollup
 * is recomputed atomically by reconcile_transfer_reversal_atomic.
 *
 * Manual operator follow-up is still required; this write only ensures the
 * app no longer presents a false "In Auszahlung" state to the craftsman.
 */
async function reconcileTransferReversed(
  supabase: SupabaseClient,
  transfer: Stripe.Transfer,
  eventId: string,
  eventType: string,
): Promise<boolean> {
  const trancheId = (transfer.metadata?.tranche_id ?? '').trim()
  const destination =
    typeof transfer.destination === 'string'
      ? transfer.destination
      : (transfer.destination as { id?: string } | null)?.id ?? 'unknown'

  // Use the first reversal ID if available; fall back to the transfer ID
  // (with a suffix) to keep it distinct from external_release_ref.
  const reversalId =
    (transfer.reversals?.data[0] as { id?: string } | undefined)?.id
    ?? `rev:${transfer.id}`

  logError('webhook.stripe.transfer.reversed', undefined, {
    eventId,
    transferId: transfer.id,
    reversalId,
    trancheId: trancheId || 'unknown',
    amount: transfer.amount,
    currency: transfer.currency,
    destination,
    note: 'MANUAL REVIEW REQUIRED: Stripe transfer reversed — recording reversal and recomputing plan status',
  })

  if (!trancheId) {
    // No metadata → can't identify tranche; audit only.
    await auditLogOnly(supabase, eventId, eventType, null)
    return true
  }

  const transferGroup = transfer.transfer_group ?? ''
  const planIdMatch = /^escrow_plan_(.+)$/.exec(transferGroup)
  const planId = planIdMatch ? planIdMatch[1] : null

  if (!planId) {
    logWarning('webhook.stripe.transfer.reversed.skipped', {
      eventId,
      transferId: transfer.id,
      trancheId,
      transferGroup,
      reason: 'transfer_group does not match escrow_plan_{id} pattern',
    })
    await finalizeWebhookEvent(supabase, eventId, 'skipped', null, null, null, null)
    return true
  }

  const claim = await claimWebhookEvent(supabase, eventId, eventType, null)
  if (claim === 'duplicate') {
    logInfo('webhook.stripe.duplicate', {
      eventId,
      eventType,
      transferId: transfer.id,
      note: 'transfer.reversed already claimed — skipping',
    })
    return true
  }

  const { data: rpcResult, error: rpcError } = await supabase.rpc(
    'reconcile_transfer_reversal_atomic',
    {
      p_tranche_id:   trancheId,
      p_plan_id:      planId,
      p_reversal_ref: reversalId,
      p_reversed_at:  new Date().toISOString(),
    },
  )

  if (rpcError) {
    logError('webhook.stripe.transfer.reversal_persist_failed', new Error(rpcError.message), {
      eventId,
      transferId: transfer.id,
      trancheId,
      planId,
      reversalId,
    })
    await finalizeWebhookEvent(supabase, eventId, 'failed', null, null, null, null, 'rpc_failed')
    return false
  }

  const rpcData = rpcResult as Record<string, unknown> | null
  const outcome = rpcData?.outcome ?? 'unknown'
  logInfo('webhook.stripe.transfer.reversal_recorded', {
    eventId,
    transferId: transfer.id,
    trancheId,
    planId,
    reversalId,
    outcome,
    planStatus: rpcData?.plan_status,
  })

  // Ledger audit trail: create a 'payout_adjustment' counter-entry so the ledger
  // reflects that a prior payout returned to the platform. Amount is POSITIVE
  // (CHECK amount>=0) — direction is conveyed by entry_type + metadata.note, not
  // by sign. Only on fresh reversals — 'already_recorded' means the tranche was
  // already marked, so a ledger entry for this reversal was presumably written.
  if (outcome === 'reversed') {
    const { data: planRow } = await supabase
      .from('escrow_payment_plans')
      .select('job_id')
      .eq('id', planId)
      .single()

    if (planRow?.job_id) {
      const { data: paymentRow } = await supabase
        .from('payments')
        .select('id')
        .eq('job_id', planRow.job_id)
        .single()

      if (paymentRow?.id) {
        const amountEur = transfer.amount / 100
        const { error: ledgerError } = await supabase
          .from('ledger_entries')
          .upsert(
            {
              payment_id: paymentRow.id,
              job_id: planRow.job_id,
              entry_type: 'payout_adjustment',
              amount: amountEur,
              currency: 'EUR',
              movement_ref: reversalId,
              metadata: {
                note: `Transfer ${transfer.id} storniert (${reversalId})`,
                reversal_id: reversalId,
                transfer_id: transfer.id,
              },
            },
            { onConflict: 'payment_id,entry_type,movement_ref', ignoreDuplicates: true },
          )
        if (ledgerError) {
          logWarning('webhook.stripe.transfer.reversal_ledger_failed', {
            eventId,
            transferId: transfer.id,
            reversalId,
            paymentId: paymentRow.id,
            reason: ledgerError.message,
          })
        }
      }

      // Emit timeline signal so notificationBridge routes alerts to craftsman + admin.
      // Non-blocking: a write failure does not roll back the already-committed reversal.
      const { error: signalError } = await supabase
        .from('timeline_signals')
        .upsert(
          {
            id: `timeline_transfer_reversed__${reversalId}`,
            job_id: planRow.job_id,
            type: 'transfer_reversed',
            occurred_at: Date.now(),
          },
          { onConflict: 'id' },
        )
      if (signalError) {
        logWarning('webhook.stripe.transfer.reversal_signal_failed', {
          eventId,
          transferId: transfer.id,
          reversalId,
          jobId: planRow.job_id,
          reason: signalError.message,
        })
      }
    }
  }

  await finalizeWebhookEvent(supabase, eventId, 'reconciled', null, null, null, null)
  return true
}

// ---------------------------------------------------------------------------
// External chargeback reconciliation (charge.dispute.created)
// ---------------------------------------------------------------------------

/**
 * Handles charge.dispute.created — an external Stripe chargeback.
 *
 * A Stripe chargeback is initiated by the customer's bank, bypassing the
 * SaFix in-app dispute workflow entirely. It may arrive when the payment is
 * still active (in_escrow / work_in_progress / release_pending) or after the
 * payment has already been released.
 *
 * V1 behaviour
 * ------------
 * - Non-terminal active states (in_escrow, work_in_progress, release_pending):
 *   transition payment to 'disputed' so release is blocked.
 * - 'released': terminal — no rollback. Chargeback on a released payment
 *   affects the platform Stripe balance directly; the SaFix payment record
 *   stays as-is. A dispute visibility record is still created.
 * - 'disputed': already correct — idempotent, dispute record ensured.
 * - Any other terminal state (refunded): dispute record created, no state change.
 * - In all found-payment cases: create a minimal SaFix dispute record with a
 *   deterministic ID (idempotent on Stripe retries) and emit a critical alert.
 */
async function reconcileExternalChargeback(
  supabase: SupabaseClient,
  dispute: Stripe.Dispute,
  eventId: string,
  eventType: string,
): Promise<ReconcileOutcome> {
  const paymentIntentId =
    typeof dispute.payment_intent === 'string'
      ? dispute.payment_intent
      : (dispute.payment_intent as { id?: string } | null)?.id ?? null

  const claim = await claimWebhookEvent(supabase, eventId, eventType, paymentIntentId)
  if (claim === 'duplicate') {
    logInfo('webhook.stripe.duplicate', {
      eventId,
      eventType,
      stripeDisputeId: dispute.id,
      note: 'charge.dispute.created already claimed — skipping',
    })
    return 'skipped'
  }

  if (!paymentIntentId) {
    logError('webhook.stripe.chargeback.failed', undefined, {
      eventId,
      eventType,
      stripeDisputeId: dispute.id,
      reason: 'no payment_intent on Stripe dispute — cannot look up payment',
    })
    await finalizeWebhookEvent(supabase, eventId, 'not_found', null, null, null, null, 'no_payment_intent')
    return 'not_found'
  }

  // 1. Look up payment by Stripe PaymentIntent ID.
  const { data, error } = await supabase
    .from('payments')
    .select('id, job_id, status, total_amount')
    .eq('provider_ref', paymentIntentId)
    .maybeSingle()

  if (error) {
    logError('webhook.stripe.chargeback.failed', new Error(error.message), {
      eventId,
      eventType,
      paymentIntentId,
      stripeDisputeId: dispute.id,
      reason: 'DB lookup error for payment by provider_ref',
    })
    await finalizeWebhookEvent(supabase, eventId, 'failed', null, null, null, null, 'db_lookup_error')
    return 'failed'
  }

  if (!data) {
    logError('webhook.stripe.chargeback.orphaned', undefined, {
      eventId,
      eventType,
      paymentIntentId,
      stripeDisputeId: dispute.id,
      amount: dispute.amount,
      currency: dispute.currency,
      reason: dispute.reason,
      note: 'MANUAL REVIEW REQUIRED: Stripe chargeback for unknown payment — no SaFix payment record found',
    })
    await finalizeWebhookEvent(supabase, eventId, 'not_found', null, null, null, null, 'payment_not_found')
    return 'not_found'
  }

  const payment = data as { id: string; job_id: string | null; status: string; total_amount: number }
  const now = Date.now()

  // 2. Determine whether the payment state allows a transition to 'disputed'.
  //    'released' is intentionally terminal — no rollback for external chargebacks.
  const DISPUTED_ENTRY_STATES = new Set(['in_escrow', 'work_in_progress', 'release_pending'])
  const canTransitionToDisputed = DISPUTED_ENTRY_STATES.has(payment.status)
  const alreadyDisputed = payment.status === 'disputed'
  const alreadyReleased = payment.status === 'released'

  // 3. Critical alert — always emitted regardless of current payment state.
  logError('webhook.stripe.chargeback.created', undefined, {
    eventId,
    eventType,
    paymentId: payment.id,
    jobId: payment.job_id,
    paymentStatus: payment.status,
    stripeDisputeId: dispute.id,
    amount: dispute.amount,
    currency: dispute.currency,
    reason: dispute.reason,
    note: alreadyReleased
      ? 'MANUAL REVIEW REQUIRED: external Stripe chargeback on already-released payment — no state rollback; dispute record created for operator visibility'
      : alreadyDisputed
        ? 'external Stripe chargeback received — payment already in disputed state; dispute record ensured'
        : 'MANUAL REVIEW REQUIRED: external Stripe chargeback received — transitioning payment to disputed',
  })

  // 4. Transition to 'disputed' if the current state permits it.
  if (canTransitionToDisputed) {
    const { error: updateError } = await supabase
      .from('payments')
      .update({ status: 'disputed', updated_at: now })
      .eq('id', payment.id)
      .eq('status', payment.status) // optimistic concurrency guard

    if (updateError) {
      logError('webhook.stripe.chargeback.state_update_failed', new Error(updateError.message), {
        eventId,
        paymentId: payment.id,
        fromStatus: payment.status,
        toStatus: 'disputed',
      })
      await finalizeWebhookEvent(
        supabase, eventId, 'failed',
        payment.id, payment.job_id, payment.status, null,
        'db_payment_update_failed',
      )
      return 'failed'
    }
  }

  // 5. Create minimal SaFix dispute record for operator visibility.
  //    Deterministic ID keyed on Stripe dispute ID — idempotent on Stripe retries.
  //    Requires a job_id (NOT NULL column); skip record creation if missing.
  const jobId = payment.job_id
  if (jobId) {
    const disputeId = `dispute_ext_${dispute.id}`
    const { error: disputeUpsertError } = await supabase
      .from('disputes')
      .upsert(
        {
          id: disputeId,
          job_id: jobId,
          payment_id: payment.id,
          raised_by: 'stripe_chargeback',
          status: 'open',
          reason: 'other',
          title: `Stripe Chargeback — ${dispute.id}`,
          description: `Externer Stripe-Chargeback (${dispute.reason}). Stripe Dispute ID: ${dispute.id}. Betrag: ${dispute.amount / 100} ${dispute.currency.toUpperCase()}.`,
          created_at: now,
          updated_at: now,
        },
        { onConflict: 'id', ignoreDuplicates: true },
      )

    if (disputeUpsertError) {
      // Non-fatal: payment state correctly updated (or intentionally unchanged).
      logWarning('webhook.stripe.chargeback.dispute_record_failed', {
        eventId,
        paymentId: payment.id,
        disputeId,
        reason: disputeUpsertError.message,
        note: 'payment state correctly handled; dispute visibility record could not be written — manual review needed',
      })
    }
  } else {
    logWarning('webhook.stripe.chargeback.dispute_record_skipped', {
      eventId,
      paymentId: payment.id,
      stripeDisputeId: dispute.id,
      reason: 'payment has no job_id — dispute visibility record not created',
    })
  }

  const newState = canTransitionToDisputed ? 'disputed' : payment.status
  await finalizeWebhookEvent(
    supabase, eventId, 'reconciled',
    payment.id, payment.job_id, payment.status, newState,
  )
  return 'reconciled'
}

// ---------------------------------------------------------------------------
// Chargeback closed reconciliation (charge.dispute.closed)
// ---------------------------------------------------------------------------

/**
 * Handles charge.dispute.closed — Stripe has finalized the chargeback decision.
 *
 * dispute.status at close can be:
 *   'won'            — chargeback reversed; funds reinstated to platform.
 *   'lost'           — chargeback upheld; platform balance permanently debited.
 *   'warning_closed' — inquiry closed without formal dispute.
 *
 * V1: log-only with severity proportional to outcome. No automatic SaFix
 * state change — the SaFix operator manages the SaFix dispute record manually.
 *
 * Rationale for no auto-resolution: automatic state reversal from 'disputed'
 * to 'released' would require determining whether the prior state transition
 * was driven by this same chargeback, and whether the craftsman transfer must
 * be re-triggered — ambiguity that is out of scope for V1.
 */
async function reconcileChargeDisputeClosed(
  supabase: SupabaseClient,
  dispute: Stripe.Dispute,
  eventId: string,
  eventType: string,
): Promise<void> {
  const paymentIntentId =
    typeof dispute.payment_intent === 'string'
      ? dispute.payment_intent
      : (dispute.payment_intent as { id?: string } | null)?.id ?? null

  const claim = await claimWebhookEvent(supabase, eventId, eventType, paymentIntentId)
  if (claim === 'duplicate') {
    logInfo('webhook.stripe.duplicate', {
      eventId,
      eventType,
      stripeDisputeId: dispute.id,
      note: 'charge.dispute.closed already claimed — skipping',
    })
    return
  }

  // Best-effort payment lookup for enriched audit context.
  let paymentId: string | null = null
  let jobId: string | null = null
  if (paymentIntentId) {
    const { data } = await supabase
      .from('payments')
      .select('id, job_id')
      .eq('provider_ref', paymentIntentId)
      .maybeSingle()
    if (data) {
      const p = data as { id: string; job_id: string | null }
      paymentId = p.id
      jobId = p.job_id
    }
  }

  const isLost = dispute.status === 'lost'

  if (isLost) {
    logError('webhook.stripe.chargeback.closed', undefined, {
      eventId,
      eventType,
      stripeDisputeId: dispute.id,
      stripeDisputeStatus: dispute.status,
      paymentId,
      jobId,
      amount: dispute.amount,
      currency: dispute.currency,
      note: 'MANUAL REVIEW REQUIRED: Stripe chargeback LOST — platform balance has been debited; SaFix dispute requires operator resolution',
    })
  } else {
    logWarning('webhook.stripe.chargeback.closed', {
      eventId,
      eventType,
      stripeDisputeId: dispute.id,
      stripeDisputeStatus: dispute.status,
      paymentId,
      jobId,
      amount: dispute.amount,
      currency: dispute.currency,
      note: dispute.status === 'won'
        ? 'Stripe chargeback WON — funds reinstated; SaFix dispute requires operator resolution'
        : `Stripe chargeback closed with status '${dispute.status}' — operator review recommended`,
    })
  }

  await finalizeWebhookEvent(
    supabase, eventId, 'log_only',
    paymentId, jobId, null, null,
    `chargeback_${dispute.status}`,
  )
}

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

/**
 * POST /api/stripe-webhook
 *
 * Receives and verifies Stripe webhook events, then reconciles SaFix payment
 * and job state against Stripe's authoritative source of truth.
 *
 * Reconciliation model
 * --------------------
 * The primary payment state path is driven by the frontend workflow layer
 * (createEscrowWorkflow → confirmDepositWorkflow → lockEscrowWorkflow →
 * releaseEscrowWorkflow / refundEscrowWorkflow).  In the happy path, the app
 * and Stripe are already in sync before the webhook fires.
 *
 * The webhook acts as a safety net for partial failures (e.g. Stripe call
 * succeeded but the subsequent DB write failed) and as an audit trail.
 *
 * Events and their reconciliation targets
 * ----------------------------------------
 * payment_intent.succeeded             → 'released'   (capture confirmed)
 * payment_intent.canceled              → 'refunded'   (escrow hold released)
 * charge.refunded                      → 'refunded'   (post-capture refund)
 * payment_intent.payment_failed        → log only     (no state change; intent can be retried)
 * payment_intent.requires_action       → log only     (customer 3DS pending; frontend handles it)
 * refund.created                       → log only     (charge.refunded is the authoritative signal)
 * refund.failed                        → outcome=failed, critical alert (customer has not received funds)
 * transfer.created                     → heal stuck release_pending / missing external_release_ref
 * transfer.reversed                    → critical alert, manual review required
 * charge.dispute.created               → payment → 'disputed' (if valid); SaFix dispute record; critical alert
 * charge.dispute.updated               → log only     (V1: operator-managed; explicitly audited, not swallowed)
 * charge.dispute.closed                → log only, critical alert on 'lost' (V1: no auto state change)
 * charge.dispute.funds_withdrawn       → log only     (funds held by Stripe pending resolution)
 * charge.dispute.funds_reinstated      → log only     (funds reinstated after won chargeback)
 * payout.paid                          → transfer corridor (flag-OFF): log only (bank delivery confirmed); destination-charge corridor (flag-ON): mark the matching tranche 'released' (resolve via metadata.tranche_id / external_payout_ref)
 * payout.failed                        → outcome=failed, critical alert; destination-charge corridor (flag-ON): revert the matching tranche release_pending → eligible_for_release for the P3b retry cron
 * account.updated                      → sync Connect account status to provider_payout_accounts
 * capability.updated                   → sync Connect account status to provider_payout_accounts
 *
 * Reconciliation is state-machine validated and idempotent.  Repeated
 * deliveries of the same event never produce duplicate or contradictory
 * state transitions.
 *
 * Supabase integration
 * --------------------
 * Reconciliation writes use a service-role Supabase client (getSupabaseAdmin)
 * that bypasses Row Level Security.  If SUPABASE_URL or
 * SUPABASE_SERVICE_ROLE_KEY are not configured, the webhook degrades to
 * log-only mode and returns 200 (missing env vars are a config issue, not
 * a transient failure — Stripe retries would not help).
 *
 * Transient DB-write failures during reconciliation return 500 so Stripe
 * retries.  The re-claim mechanism allows previously failed events to be
 * re-processed on retry.
 *
 * Required environment variables (server-side only, never VITE_*):
 *   STRIPE_SECRET_KEY         — sk_test_* / sk_live_*
 *   STRIPE_WEBHOOK_SECRET     — whsec_*
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service-role JWT (bypasses RLS)
 *
 * Stripe Dashboard subscription
 * ------------------------------
 * Register endpoint:  https://<app>.vercel.app/api/stripe-webhook
 * Subscribe to events:
 *   payment_intent.succeeded
 *   payment_intent.requires_action
 *   payment_intent.payment_failed
 *   payment_intent.canceled
 *   charge.refunded
 *   refund.created
 *   refund.failed
 *   transfer.created
 *   transfer.reversed
 *   charge.dispute.created
 *   charge.dispute.updated
 *   charge.dispute.closed
 *   charge.dispute.funds_withdrawn
 *   charge.dispute.funds_reinstated
 *   payout.paid
 *   payout.failed
 *   account.updated
 *   capability.updated
 */
async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed. Use POST.' })
    return
  }

  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    logError('webhook.stripe.failed', undefined, { reason: 'STRIPE_SECRET_KEY not set' })
    res.status(500).json({ error: 'Server misconfiguration: Stripe secret key not configured.' })
    return
  }

  // Two Stripe webhook endpoints deliver to this same URL, each with its own
  // signing secret, because SaFix uses DESTINATION CHARGES (the PaymentIntent
  // lives on the PLATFORM account, not the connected account):
  //   STRIPE_WEBHOOK_SECRET          — Connect endpoint (connect=true): payout.*,
  //                                    account.updated, capability.updated (Connected-Account events).
  //   STRIPE_WEBHOOK_SECRET_ACCOUNT  — Account endpoint (connect=false): payment_intent.*,
  //                                    charge.*, charge.dispute.*, refund.*, transfer.* (PLATFORM
  //                                    events — a Connect-only endpoint would never receive them,
  //                                    so disputes/chargebacks/refunds would be silently missed).
  // Verify the signature against each configured secret until one matches. ACCOUNT
  // is optional so this stays backward-compatible until its endpoint + env exist.
  const webhookSecrets = [
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_WEBHOOK_SECRET_ACCOUNT,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0)
  if (webhookSecrets.length === 0) {
    logError('webhook.stripe.failed', undefined, { reason: 'no STRIPE_WEBHOOK_SECRET* configured' })
    res.status(500).json({ error: 'Server misconfiguration: Stripe webhook secret not configured.' })
    return
  }

  const sigHeader = req.headers['stripe-signature']
  const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader
  if (!signature) {
    logWarning('webhook.stripe.failed', { reason: 'missing Stripe-Signature header' })
    res.status(400).json({ error: 'Missing Stripe-Signature header.' })
    return
  }

  let rawBody: Buffer
  try {
    rawBody = await readRawBody(req)
  } catch (err: unknown) {
    logError('webhook.stripe.failed', err, { reason: 'failed to read request body' })
    res.status(500).json({ error: 'Failed to read request body.' })
    return
  }

  const stripe = getStripe(secretKey)

  // Try each configured signing secret; a given event is signed by exactly one
  // endpoint's secret, so the first that verifies is authoritative. An attacker
  // without a valid secret matches none — no security weakening from trying both.
  let event: Stripe.Event | undefined
  let lastVerifyError: unknown
  for (const secret of webhookSecrets) {
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, secret)
      break
    } catch (err: unknown) {
      lastVerifyError = err
    }
  }
  if (!event) {
    const detail = lastVerifyError instanceof Error ? lastVerifyError.message : String(lastVerifyError)
    logError('webhook.stripe.failed', lastVerifyError, { reason: 'signature verification failed', detail })
    res.status(400).json({ error: `Webhook signature verification failed: ${detail}` })
    return
  }

  // Structured observability: event received and signature verified.
  const obj = event.data.object as unknown as Record<string, unknown>
  const resourceId = typeof obj['id'] === 'string' ? obj['id'] : 'unknown'
  logInfo('webhook.stripe.received', { eventId: event.id, eventType: event.type, resourceId })
  logInfo('webhook.stripe.verified', { eventId: event.id, eventType: event.type })

  // Obtain the Supabase admin client.  May be null when SUPABASE_URL /
  // SUPABASE_SERVICE_ROLE_KEY are not configured.
  //
  // Log-only mode: return 200 so Stripe does not retry.  Missing env vars
  // are a deployment/config issue — retries won't fix it.  Ops must deploy
  // the correct configuration.  (Distinct from transient DB-write failures
  // during reconciliation, which DO trigger 500 for Stripe retry.)
  const supabase = getSupabaseAdmin()

  if (!supabase) {
    logWarning('webhook.stripe.failed', {
      eventId: event.id,
      eventType: event.type,
      reason: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured — log-only mode, no reconciliation',
    })
    res.status(200).json({ received: true })
    return
  }

  // Track whether a critical reconciliation write failed.
  // When true, return 500 so Stripe retries the event.
  let criticalFailure = false

  // Any claim-time DB error (WebhookClaimError, thrown by claimWebhookEvent on a
  // non-PK-conflict INSERT failure) must surface as a 500 so Stripe retries the
  // whole event — never a swallowed optimistic proceed. Routed through the same
  // graceful `criticalFailure → 500` path below. Non-claim throws re-propagate
  // unchanged (existing behavior). The switch body is intentionally not
  // re-indented to keep this a minimal, reviewable diff.
  try {
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const intent = event.data.object as Stripe.PaymentIntent

      if (intent.metadata?.type === 'escrow_funding') {
        // Escrow-funding PIs (initiate-funding): reconcile funding_requests + escrow_payment_plans.
        const ok = await reconcileFundingConfirmation(
          supabase, stripe, intent, event.id, event.type,
          process.env.FUNDING_DESTINATION_CHARGE_ENABLED === 'true',
        )
        if (!ok) criticalFailure = true
      } else if (intent.metadata?.type === 'supplementary_funding') {
        // Supplementary funding PIs (initiate-supplementary-funding): reconcile supplementary_payment_requests.
        const ok = await reconcileSupplementaryFundingConfirmation(
          supabase, stripe, intent, event.id, event.type,
          process.env.FUNDING_DESTINATION_CHARGE_ENABLED === 'true',
        )
        if (!ok) criticalFailure = true

        // Auto-release: immediately attempt to transfer net amount to craftsman.
        // Only attempt if funding reconciliation succeeded.
        // If provider is not payout-ready, SPR stays 'funded' and can be released
        // later via /api/release-supplementary-payout or when the account becomes ready.
        if (ok) {
          const sprId = (intent.metadata?.supplementaryPaymentId ?? '').trim()
          if (sprId) {
            const releaseResult = await releaseSupplementaryPayout(supabase, stripe, sprId)
            logInfo('webhook.stripe.supplementary_auto_release', {
              eventId: event.id,
              supplementaryPaymentId: sprId,
              outcome: releaseResult.outcome,
              ok: releaseResult.ok,
            })
          }
        }
      } else if (intent.metadata?.type === 'diagnosis_payment') {
        // Diagnosis instant-payment PIs (initiate-diagnosis-payment): transition to completed.
        const ok = await reconcileDiagnosisPaymentConfirmation(supabase, intent, event.id, event.type)
        if (!ok) criticalFailure = true
      } else {
        // Standard capture-confirmed flow: reconcile payment to 'released'.
        const outcome = await reconcilePaymentState(supabase, intent.id, 'released', event.id, event.type)
        if (outcome === 'failed') criticalFailure = true
      }
      break
    }

    case 'payment_intent.canceled': {
      // PaymentIntent was cancelled — either our refund-escrow endpoint
      // cancelled a requires_capture intent, or it was cancelled out-of-band.
      // Reconcile to 'refunded' (the escrow hold was released).
      const intent = event.data.object as Stripe.PaymentIntent
      const outcome = await reconcilePaymentState(supabase, intent.id, 'refunded', event.id, event.type)
      if (outcome === 'failed') criticalFailure = true
      break
    }

    case 'charge.refunded': {
      // A charge was refunded (full or partial).  In our flow this fires when
      // refund-escrow creates a Refund against a captured (succeeded) charge.
      // Reconcile to 'refunded' and persist the Stripe-confirmed refund amount.
      //
      // charge.amount_refunded is in the smallest currency unit (e.g. EUR cents).
      // SaFix only uses EUR (2 decimal places), so dividing by 100 gives EUR.
      const charge = event.data.object as Stripe.Charge
      const piId =
        typeof charge.payment_intent === 'string'
          ? charge.payment_intent
          : charge.payment_intent?.id
      const refundedAmountEur = charge.amount_refunded / 100

      if (piId) {
        const outcome = await reconcileChargeRefunded(supabase, piId, refundedAmountEur, event.id, event.type)
        if (outcome === 'failed') criticalFailure = true
      } else {
        logWarning('webhook.stripe.failed', {
          eventId: event.id,
          eventType: event.type,
          reason: 'charge.refunded has no payment_intent — cannot reconcile',
        })
      }
      break
    }

    case 'payment_intent.payment_failed': {
      // Card was declined or authorization failed.  The PaymentIntent can be
      // retried by the customer.  No SaFix state change is needed — the
      // payment stays in 'deposit_required' until the customer succeeds.
      const intent = event.data.object as Stripe.PaymentIntent
      const lastError = intent.last_payment_error
      logWarning('webhook.stripe.received', {
        eventId: event.id,
        eventType: event.type,
        paymentIntentId: intent.id,
        failureCode: lastError?.code ?? 'unknown',
        failureMessage: lastError?.message ?? '',
      })
      await auditLogOnly(supabase, event.id, event.type, intent.id)
      break
    }

    case 'payment_intent.requires_action': {
      // Customer action required (e.g. 3-D Secure).  The frontend Stripe.js
      // flow handles this; no server-side state change is needed.
      const intent = event.data.object as Stripe.PaymentIntent
      logInfo('webhook.stripe.received', {
        eventId: event.id,
        eventType: event.type,
        paymentIntentId: intent.id,
        nextAction: intent.next_action?.type ?? 'none',
      })
      await auditLogOnly(supabase, event.id, event.type, intent.id)
      break
    }

    case 'refund.created': {
      // Refund object created.  charge.refunded is the authoritative event
      // for reconciliation; this is logged for audit purposes only.
      const refund = event.data.object as Stripe.Refund
      const refundPaymentIntentId =
        typeof refund.payment_intent === 'string'
          ? refund.payment_intent
          : refund.payment_intent?.id ?? null
      logInfo('webhook.stripe.received', {
        eventId: event.id,
        eventType: event.type,
        refundId: refund.id,
        amount: refund.amount,
        status: refund.status,
      })
      await auditLogOnly(supabase, event.id, event.type, refundPaymentIntentId)
      break
    }

    case 'refund.failed': {
      // Refund could not be applied — customer has not received funds.
      // Claim-first so this is queryable as 'failed' (not 'log_only') and
      // re-claimable on retry.  No automated payment state change.
      const refund = event.data.object as Stripe.Refund
      const refundPaymentIntentId =
        typeof refund.payment_intent === 'string'
          ? refund.payment_intent
          : refund.payment_intent?.id ?? null

      const refundClaim = await claimWebhookEvent(supabase, event.id, event.type, refundPaymentIntentId)
      if (refundClaim === 'duplicate') {
        logInfo('webhook.stripe.duplicate', {
          eventId: event.id,
          eventType: event.type,
          refundId: refund.id,
          note: 'refund.failed already claimed — skipping',
        })
        break
      }

      // Best-effort payment lookup for enriched audit context.
      let refundPaymentId: string | null = null
      let refundJobId: string | null = null
      if (refundPaymentIntentId) {
        const { data: refundPaymentData } = await supabase
          .from('payments')
          .select('id, job_id')
          .eq('provider_ref', refundPaymentIntentId)
          .maybeSingle()
        if (refundPaymentData) {
          const rp = refundPaymentData as { id: string; job_id: string | null }
          refundPaymentId = rp.id
          refundJobId = rp.job_id
        }
      }

      logError('webhook.stripe.refund.failed', undefined, {
        eventId: event.id,
        eventType: event.type,
        refundId: refund.id,
        amount: refund.amount,
        failureReason: refund.failure_reason ?? 'unknown',
        paymentId: refundPaymentId,
        jobId: refundJobId,
        note: 'MANUAL REVIEW REQUIRED: Stripe refund failed — customer has not received funds',
      })

      await finalizeWebhookEvent(
        supabase, event.id, 'failed',
        refundPaymentId, refundJobId, null, null,
        refund.failure_reason ?? 'refund_failed',
      )
      break
    }

    case 'transfer.created': {
      // TODO(P5): the transfer.created / transfer.reversed handlers (and
      // emitPayoutOutcomeSignals / resolveTransferIdFromBalanceTx) serve the
      // flag-OFF transfer corridor. Remove them with the transfer model in P5
      // cleanup — they are NOT dead while FUNDING_DESTINATION_CHARGE_ENABLED
      // is unset.
      // Heals stuck tranche states after a successful Stripe Transfer.
      // In the happy path this is a no-op (external_release_ref already set).
      // On DB-write failure in release-tranche.ts, this fires and runs the
      // same release_tranche_atomic RPC to backfill the missing ref.
      const transfer = event.data.object as Stripe.Transfer
      const ok = await reconcileTransferCreated(supabase, transfer, event.id, event.type)
      if (!ok) criticalFailure = true
      break
    }

    case 'transfer.reversed': {
      // Records reversal against the tranche (transfer_reversal_ref) and
      // recomputes plan-status so projection no longer shows transfer_triggered.
      const transfer = event.data.object as Stripe.Transfer
      const ok = await reconcileTransferReversed(supabase, transfer, event.id, event.type)
      if (!ok) criticalFailure = true
      break
    }

    case 'charge.dispute.created': {
      // External Stripe chargeback initiated by the customer's bank.
      // Reconcile payment state and create a SaFix dispute record for operator visibility.
      const createdDispute = event.data.object as Stripe.Dispute
      const chargebackOutcome = await reconcileExternalChargeback(supabase, createdDispute, event.id, event.type)
      if (chargebackOutcome === 'failed') criticalFailure = true
      break
    }

    case 'charge.dispute.updated': {
      // Stripe updates the dispute as evidence deadlines approach or status changes.
      // No SaFix state change in V1 — the SaFix dispute lifecycle is operator-managed.
      // Explicitly audited as log_only so the event is queryable; not silently swallowed.
      const updatedDispute = event.data.object as Stripe.Dispute
      const updatedDisputePiId =
        typeof updatedDispute.payment_intent === 'string'
          ? updatedDispute.payment_intent
          : (updatedDispute.payment_intent as { id?: string } | null)?.id ?? null
      logInfo('webhook.stripe.chargeback.updated', {
        eventId: event.id,
        eventType: event.type,
        stripeDisputeId: updatedDispute.id,
        stripeDisputeStatus: updatedDispute.status,
        paymentIntentId: updatedDisputePiId,
      })
      await auditLogOnly(supabase, event.id, event.type, updatedDisputePiId)
      break
    }

    case 'charge.dispute.closed': {
      // Stripe has finalized the chargeback decision (won / lost / warning_closed).
      // Log with severity proportional to outcome; no automatic SaFix state change.
      const closedDispute = event.data.object as Stripe.Dispute
      await reconcileChargeDisputeClosed(supabase, closedDispute, event.id, event.type)
      break
    }

    case 'charge.dispute.funds_withdrawn': {
      // Stripe has placed funds in a temporary hold pending chargeback resolution.
      // No SaFix state change in V1 — logged and audited for operator awareness.
      const fwDispute = event.data.object as Stripe.Dispute
      const fwPiId =
        typeof fwDispute.payment_intent === 'string'
          ? fwDispute.payment_intent
          : (fwDispute.payment_intent as { id?: string } | null)?.id ?? null
      logWarning('webhook.stripe.chargeback.funds_withdrawn', {
        eventId: event.id,
        eventType: event.type,
        stripeDisputeId: fwDispute.id,
        amount: fwDispute.amount,
        currency: fwDispute.currency,
        paymentIntentId: fwPiId,
        note: 'Stripe chargeback funds placed in temporary hold — awaiting resolution',
      })
      await auditLogOnly(supabase, event.id, event.type, fwPiId)
      break
    }

    case 'charge.dispute.funds_reinstated': {
      // Stripe has reinstated held funds after a won chargeback.
      // No SaFix state change in V1 — logged and audited for operator awareness.
      const frDispute = event.data.object as Stripe.Dispute
      const frPiId =
        typeof frDispute.payment_intent === 'string'
          ? frDispute.payment_intent
          : (frDispute.payment_intent as { id?: string } | null)?.id ?? null
      logWarning('webhook.stripe.chargeback.funds_reinstated', {
        eventId: event.id,
        eventType: event.type,
        stripeDisputeId: frDispute.id,
        amount: frDispute.amount,
        currency: frDispute.currency,
        paymentIntentId: frPiId,
        note: 'Stripe chargeback funds reinstated — chargeback was won',
      })
      await auditLogOnly(supabase, event.id, event.type, frPiId)
      break
    }

    case 'payout.paid': {
      // Bank delivery confirmed for a Connected Account payout.
      // Fires in the Connect account context (event.account = Connected Account ID).
      // Emits a `payout_completed` timeline signal per owning job so the
      // provider sees "Auf deinem Konto" truth across finance, timeline
      // and notification surfaces. No payment-state transition — the
      // payment corridor is already 'released'; this is the downstream
      // bank-arrival confirmation.
      const paidPayout = event.data.object as Stripe.Payout
      const paidClaim = await claimWebhookEvent(supabase, event.id, event.type, null)
      if (paidClaim === 'duplicate') {
        logInfo('webhook.stripe.duplicate', {
          eventId: event.id,
          eventType: event.type,
          payoutId: paidPayout.id,
          note: 'payout.paid already claimed — skipping',
        })
        break
      }
      const paidAccount = event.account ?? null
      logInfo('webhook.stripe.payout.paid', {
        eventId: event.id,
        eventType: event.type,
        payoutId: paidPayout.id,
        connectAccountId: paidAccount ?? 'unknown',
        amount: paidPayout.amount,
        currency: paidPayout.currency,
        arrivalDate: paidPayout.arrival_date,
      })
      // Destination-charge corridor (flag-ON): a payout carrying
      // metadata.tranche_id (or a tranche row with external_payout_ref = po_*)
      // is a tranche release — mark it 'released' directly. A flag-OFF auto-
      // payout resolves to `not_corridor` and falls through UNCHANGED below.
      const paidCorridor = await resolvePayoutCorridorTranche(supabase, paidPayout, event.id)
      if (paidCorridor.kind === 'error') {
        await finalizeWebhookEvent(
          supabase, event.id, 'failed', null, null, null, null,
          `payout_corridor_${paidCorridor.reason}`,
        )
        criticalFailure = true
        break
      }
      if (paidCorridor.kind === 'resolved') {
        const completed = await completePayoutCorridorTranche(
          supabase, paidCorridor.tranche, paidPayout, event.id,
        )
        if (!completed) {
          await finalizeWebhookEvent(
            supabase, event.id, 'failed', null, null, null, null,
            'payout_corridor_complete_retry',
          )
          criticalFailure = true
          break
        }
        await finalizeWebhookEvent(supabase, event.id, 'reconciled', null, null, null, null)
        break
      }
      // not_corridor → existing transfer-model signal fan-out (byte-identical).
      const paidEmit = await emitPayoutOutcomeSignals(
        supabase, stripe, paidPayout, paidAccount, 'payout_completed', event.id,
      )
      if (paidEmit.retryable) {
        // Signal fan-out failed mid-flight. Finalize as 'failed' so the
        // reclaim path can pick this event up on the Stripe retry driven
        // by the HTTP 500 below — otherwise the claim stays 'processing'
        // and the retry degrades to a silent duplicate.
        await finalizeWebhookEvent(
          supabase, event.id, 'failed', null, null, null, null,
          paidEmit.reason ?? `payout_outcome_${paidEmit.status}`,
        )
        criticalFailure = true
        break
      }
      await finalizeWebhookEvent(supabase, event.id, 'reconciled', null, null, null, null)
      break
    }

    case 'payout.failed': {
      // Bank delivery failed for a Connected Account payout.
      // Fires in the Connect account context (event.account = Connected Account ID).
      // Critical: the craftsman has NOT received their funds.
      const failedPayout = event.data.object as Stripe.Payout
      const payoutFailedClaim = await claimWebhookEvent(supabase, event.id, event.type, null)
      if (payoutFailedClaim === 'duplicate') {
        logInfo('webhook.stripe.duplicate', {
          eventId: event.id,
          eventType: event.type,
          payoutId: failedPayout.id,
          note: 'payout.failed already claimed — skipping',
        })
        break
      }

      const failedAccount = event.account ?? null
      logError('webhook.stripe.payout.failed', undefined, {
        eventId: event.id,
        eventType: event.type,
        payoutId: failedPayout.id,
        connectAccountId: failedAccount ?? 'unknown',
        amount: failedPayout.amount,
        currency: failedPayout.currency,
        failureCode: failedPayout.failure_code ?? 'unknown',
        failureMessage: failedPayout.failure_message ?? 'unknown',
        note: 'MANUAL REVIEW REQUIRED: bank payout failed — craftsman has not received funds',
      })

      // Destination-charge corridor (flag-ON): revert release_pending →
      // eligible_for_release so the P3b retry cron re-issues a fresh payout.
      // The critical logError alert above already fired (kept for both
      // corridors). A flag-OFF auto-payout resolves to `not_corridor` and
      // falls through to the UNCHANGED signal fan-out below.
      const failedCorridor = await resolvePayoutCorridorTranche(supabase, failedPayout, event.id)
      if (failedCorridor.kind === 'error') {
        await finalizeWebhookEvent(
          supabase, event.id, 'failed', null, null, null, null,
          `payout_corridor_${failedCorridor.reason}`,
        )
        criticalFailure = true
        break
      }
      if (failedCorridor.kind === 'resolved') {
        const { error: revertErr } = await supabase
          .from('escrow_tranches')
          .update({
            status: 'eligible_for_release',
            // RETRY-ENABLER (P3b item A): bump the attempt counter alongside the
            // revert so the reconcile-payout-corridor cron's next re-attempt uses
            // a FRESH idempotency key (`tranche_payout_<id>_<count>`). The created
            // payout bank-FAILED and will never pay on its existing po id;
            // replaying the same key would just return the dead failed payout and
            // re-stick the tranche. Lives strictly inside the resolved-corridor
            // branch → flag-OFF auto-payouts resolve to not_corridor and never
            // reach it (byte-identical).
            payout_attempt_count: failedCorridor.tranche.payoutAttemptCount + 1,
            updated_at: new Date().toISOString(),
          })
          .eq('id', failedCorridor.tranche.id)
          .eq('status', 'release_pending')
          // DOUBLE-PAY GUARD (P3b): scope the revert to the SPECIFIC payout that
          // failed. external_payout_ref holds the tranche's CURRENT po id (the
          // release RPC overwrites it on each payouts.create). A stale, redelivered
          // payout.failed(po_A) must not revert a tranche whose live payout is now
          // po_B (the cron re-issued after the first failure) — otherwise po_A's
          // redelivery kicks the tranche back to eligible while po_B is in flight,
          // the cron issues po_C, and po_B + po_C can BOTH pay. Matching on the
          // failed po id means a stale failure hits 0 rows and no-ops.
          .eq('external_payout_ref', failedPayout.id)
        if (revertErr) {
          // Transient write failure leaves the tranche stuck at
          // release_pending → retry (the UPDATE is idempotent via the
          // status guard).
          logError('webhook.stripe.payout.corridor_revert_failed', new Error(revertErr.message), {
            eventId: event.id,
            payoutId: failedPayout.id,
            trancheId: failedCorridor.tranche.id,
            reason: 'failed to revert release_pending → eligible_for_release',
          })
          await finalizeWebhookEvent(
            supabase, event.id, 'failed', null, null, null, null,
            'payout_corridor_revert_retry',
          )
          criticalFailure = true
          break
        }
        // Audit completeness (item C): the revert above restored a
        // re-attemptable state but journaled nothing. Write the compensating
        // ledger entry + a payout_failed timeline signal so the audit invariant
        // ("every money state change is journaled") holds. Retryable on failure
        // (HTTP 500 → Stripe redelivers; the revert is status-guarded 0-row and
        // both audit writes dedup ON CONFLICT, so the retry is safe).
        const audited = await recordPayoutFailureAudit(
          supabase, failedCorridor.tranche, failedPayout, event.id,
        )
        if (!audited) {
          await finalizeWebhookEvent(
            supabase, event.id, 'failed', null, null, null, null,
            'payout_corridor_audit_retry',
          )
          criticalFailure = true
          break
        }
        // The hourly reconcile-payout-corridor cron re-issues a fresh payout
        // (new po_id, fresh idempotency key) for tranches left at
        // eligible_for_release here.
        await finalizeWebhookEvent(
          supabase, event.id, 'failed', null, null, null, null, 'payout_failed',
        )
        break
      }
      // not_corridor → existing transfer-model signal fan-out (byte-identical).
      const failedEmit = await emitPayoutOutcomeSignals(
        supabase, stripe, failedPayout, failedAccount, 'payout_failed', event.id,
      )
      if (failedEmit.retryable) {
        // Same retry contract as payout.paid — a failed signal emission
        // must not leave the provider blind to a bank rejection.
        await finalizeWebhookEvent(
          supabase, event.id, 'failed', null, null, null, null,
          failedEmit.reason ?? `payout_outcome_${failedEmit.status}`,
        )
        criticalFailure = true
        break
      }

      await finalizeWebhookEvent(
        supabase, event.id, 'failed',
        null, null, null, null,
        'payout_failed',
      )
      break
    }

    case 'account.updated': {
      // Stripe Connect account was updated (e.g., onboarding progress, capabilities changed).
      // Sync the provider payout account status back to provider_payout_accounts.
      // Claim/finalize wrapped like every other event type so a redelivery of the
      // same event_id is skipped instead of re-running the sync (idempotency).
      const account = event.data.object as Stripe.Account
      const accountClaim = await claimWebhookEvent(supabase, event.id, event.type, null)
      if (accountClaim === 'duplicate') {
        logInfo('webhook.stripe.duplicate', {
          eventId: event.id,
          eventType: event.type,
          note: 'account.updated already claimed — skipping',
        })
        break
      }
      const accountOutcome = await reconcileConnectAccount(supabase, account.id, event.id, event.type)
      await finalizeWebhookEvent(supabase, event.id, accountOutcome, null, null, null, null)
      break
    }

    case 'capability.updated': {
      // Stripe Connect account capability updated (e.g., transfers capability enabled/disabled).
      // Fetch the full account and sync status. Claim/finalize wrapped for the
      // same idempotency guarantee as account.updated.
      const capability = event.data.object as Stripe.Capability
      const capabilityClaim = await claimWebhookEvent(supabase, event.id, event.type, null)
      if (capabilityClaim === 'duplicate') {
        logInfo('webhook.stripe.duplicate', {
          eventId: event.id,
          eventType: event.type,
          note: 'capability.updated already claimed — skipping',
        })
        break
      }
      const accountId = capability.account
      if (typeof accountId === 'string') {
        const capabilityOutcome = await reconcileConnectAccount(supabase, accountId, event.id, event.type)
        await finalizeWebhookEvent(supabase, event.id, capabilityOutcome, null, null, null, null)
      } else {
        logWarning('webhook.stripe.failed', {
          eventId: event.id,
          eventType: event.type,
          reason: 'capability.updated has no account ID — cannot reconcile',
        })
        await finalizeWebhookEvent(
          supabase, event.id, 'not_found', null, null, null, null, 'capability_no_account_id',
        )
      }
      break
    }

    default:
      // Silently acknowledge unhandled event types to prevent Stripe retries.
      break
  }
  } catch (err: unknown) {
    if (err instanceof WebhookClaimError) {
      // claimWebhookEvent already logged the DB error at ERROR level.
      criticalFailure = true
    } else {
      // Not a claim error — preserve existing behavior (propagates to the
      // Sentry-flush wrapper / platform default 500).
      throw err
    }
  }

  if (criticalFailure) {
    logError('webhook.stripe.failed', undefined, {
      eventId: event.id,
      eventType: event.type,
      reason: 'critical reconciliation write failed — returning 500 for Stripe retry',
    })
    res.status(500).json({ error: 'Reconciliation failed — retry expected.' })
    return
  }

  res.status(200).json({ received: true })
}

export default withSentryFlush(handler)

// Disable Vercel's automatic body parsing so that Stripe webhook signature
// verification can access the exact raw bytes sent by Stripe.
export const config = {
  api: {
    bodyParser: false,
  },
}
