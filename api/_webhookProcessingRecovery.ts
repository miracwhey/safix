/**
 * Stripe webhook processing recovery.
 *
 * Handles the operational gap where a webhook handler is interrupted
 * (e.g. Vercel function timeout, OOM kill, network failure) after calling
 * claimWebhookEvent but before finalizeWebhookEvent.
 *
 * Such an interrupted invocation leaves a `stripe_webhook_events` row with
 * outcome='processing' permanently, preventing future Stripe re-deliveries
 * from being claimed (the PK conflict skips them as duplicates).
 *
 * This module provides:
 *   - classifyProcessingRow  — pure function; testable without I/O
 *   - cleanupStaleWebhookEvents — queries and recovers stale processing rows
 *
 * Intended usage:
 *   - Manual operator invocation via a Vercel function or admin script
 *   - Periodic cron job (Supabase pg_cron or Vercel cron)
 *   - Called inline from the webhook handler itself before claiming (optional)
 *
 * Outcome lifecycle:
 *   processing         — in-flight; set by claimWebhookEvent
 *   reconciled         — terminal; payment state transitioned successfully
 *   skipped            — terminal; already in target state
 *   not_found          — terminal; no matching payment found
 *   invalid_transition — terminal; state-machine guard rejected
 *   failed             — terminal; DB write error
 *   log_only           — terminal; non-reconciliation event (audit only)
 *   processing_expired — re-claimable; set by cleanup when handler was
 *                        interrupted (claimed but never finalized). The next
 *                        Stripe re-delivery re-claims and re-processes it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logInfo, logWarning, logError } from './_observability.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * A processing row older than this threshold is considered stale.
 *
 * Rationale: Vercel serverless functions have a default max execution time
 * of 10 seconds (Hobby) / 60 seconds (Pro).  A `processing` row older than
 * 10 minutes is safely beyond any plausible in-flight window.
 */
export const STALE_PROCESSING_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes

/**
 * Maximum rows processed per cleanup invocation.  Prevents a runaway cleanup
 * from holding a DB connection for a long time if many rows accumulate.
 */
export const CLEANUP_BATCH_LIMIT = 100

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

export interface WebhookEventRow {
  event_id: string
  event_type: string
  outcome: string
  processed_at: string
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export type ProcessingRowClassification = 'active' | 'stale' | 'finalized'

/**
 * Classifies a stripe_webhook_events row for recovery purposes.
 *
 * Returns:
 *   'finalized' — row has reached a terminal outcome (not 'processing')
 *   'active'    — outcome is 'processing' and within the staleness threshold
 *   'stale'     — outcome is 'processing' and past the staleness threshold
 *
 * @param row     - The row to classify
 * @param nowMs   - Current time in Unix milliseconds (defaults to Date.now())
 * @param thresholdMs - Staleness threshold in ms (defaults to STALE_PROCESSING_THRESHOLD_MS)
 */
export function classifyProcessingRow(
  row: Pick<WebhookEventRow, 'outcome' | 'processed_at'>,
  nowMs: number = Date.now(),
  thresholdMs: number = STALE_PROCESSING_THRESHOLD_MS,
): ProcessingRowClassification {
  if (row.outcome !== 'processing') return 'finalized'
  const processedAtMs = new Date(row.processed_at).getTime()
  const ageMs = nowMs - processedAtMs
  return ageMs >= thresholdMs ? 'stale' : 'active'
}

// ---------------------------------------------------------------------------
// Cleanup result
// ---------------------------------------------------------------------------

export interface CleanupResult {
  /** Number of stale processing rows found. */
  checked: number
  /** Number successfully updated to processing_expired. */
  recovered: number
  /** Number that failed to update (DB error). */
  failedToUpdate: number
}

// ---------------------------------------------------------------------------
// Cleanup function
// ---------------------------------------------------------------------------

/**
 * Detects and recovers stale `processing` rows in stripe_webhook_events.
 *
 * For each row with outcome='processing' older than `thresholdMs`:
 *   1. Logs `webhook.stripe.processing_stale_detected`
 *   2. Updates outcome to 'processing_expired'
 *   3. Logs `webhook.stripe.processing_recovered` on success
 *      or `webhook.stripe.processing_cleanup_failed` on DB error
 *
 * Calling this function unblocks future Stripe re-deliveries for the same
 * event.  The interrupted handler claimed the row but never finalized it, so
 * no payment state was ever written — the event still needs processing.
 *
 * `processing_expired` is a RE-CLAIMABLE outcome: claimWebhookEvent (in
 * api/stripe-webhook.ts) treats it like `failed` — on the next Stripe
 * re-delivery the claim INSERT hits the PK conflict, flips the row back to
 * `processing`, and re-processes the event from scratch.  This is safe
 * precisely because the interrupted handler wrote no payment state.  No manual
 * row deletion is required.
 *
 * @param supabase   - Service-role Supabase client (bypasses RLS)
 * @param options    - Optional overrides for threshold / batch size
 */
export async function cleanupStaleWebhookEvents(
  supabase: SupabaseClient,
  options?: {
    thresholdMs?: number
    batchLimit?: number
  },
): Promise<CleanupResult> {
  const thresholdMs = options?.thresholdMs ?? STALE_PROCESSING_THRESHOLD_MS
  const batchLimit = options?.batchLimit ?? CLEANUP_BATCH_LIMIT
  const staleCutoff = new Date(Date.now() - thresholdMs).toISOString()

  const result: CleanupResult = { checked: 0, recovered: 0, failedToUpdate: 0 }

  // 1. Fetch stale processing rows.
  const { data, error: fetchError } = await supabase
    .from('stripe_webhook_events')
    .select('event_id, event_type, outcome, processed_at')
    .eq('outcome', 'processing')
    .lt('processed_at', staleCutoff)
    .limit(batchLimit)

  if (fetchError) {
    logError('webhook.stripe.processing_cleanup_failed', new Error(fetchError.message), {
      reason: 'failed to query stale processing rows',
    })
    return result
  }

  if (!data || data.length === 0) {
    logInfo('webhook.stripe.processing_cleanup_completed', {
      reason: 'no stale processing rows found',
      staleCutoffMs: staleCutoff,
    })
    return result
  }

  result.checked = data.length

  // 2. Recover each stale row individually so that a single update failure
  //    does not block recovery of the remaining rows.
  for (const row of data as WebhookEventRow[]) {
    logWarning('webhook.stripe.processing_stale_detected', {
      eventId: row.event_id,
      eventType: row.event_type,
      processedAt: row.processed_at,
      ageMs: Date.now() - new Date(row.processed_at).getTime(),
      thresholdMs,
    })

    const { error: updateError } = await supabase
      .from('stripe_webhook_events')
      .update({ outcome: 'processing_expired' })
      .eq('event_id', row.event_id)
      .eq('outcome', 'processing') // guard: only update if still 'processing'

    if (updateError) {
      result.failedToUpdate++
      logError('webhook.stripe.processing_cleanup_failed', new Error(updateError.message), {
        eventId: row.event_id,
        eventType: row.event_type,
        reason: 'failed to update stale processing row',
      })
    } else {
      result.recovered++
      logInfo('webhook.stripe.processing_recovered', {
        eventId: row.event_id,
        eventType: row.event_type,
        processedAt: row.processed_at,
      })
    }
  }

  logInfo('webhook.stripe.processing_recovered', {
    checked: result.checked,
    recovered: result.recovered,
    failedToUpdate: result.failedToUpdate,
  })

  return result
}
