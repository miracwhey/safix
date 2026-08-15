/**
 * Server-side funding request expiry sweep logic.
 *
 * Finds all funding requests in non-terminal status whose expires_at deadline
 * has passed and sets their status to 'expired' in batch.
 *
 * Statuses eligible for automatic expiry:
 *   created, sent, funding_started, funding_failed
 *
 * Excluded from automatic expiry:
 *   funding_initiated — a live Stripe PaymentIntent may exist. If the cron
 *   expired such a row and the Stripe webhook later fires payment_intent.succeeded,
 *   confirm_funding_atomic would return 'invalid_state' and the payment would be
 *   taken from the customer without being reflected in escrow. These rows are
 *   intentionally skipped; Stripe handles PI expiry on its side.
 *
 * Terminal statuses that are never touched:
 *   funded, cancelled, expired
 *
 * Guards:
 *   - Only updates rows whose status is still in the safe set (idempotent)
 *   - Batch-limited to prevent cold-start timeouts
 *
 * Effect: after expiry, api/initiate-funding.ts rejects the request because
 * 'expired' is not in its fundableStatuses set.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logInfo, logWarning, logError } from './_observability.js'

export type FundingRequestExpirySummary = {
  checked: number
  expired: number
  failed: number
}

const BATCH_LIMIT = 100

/**
 * Statuses where automatic expiry is safe.
 * funding_initiated is deliberately excluded — see module-level comment.
 */
export const ACTIVE_STATUSES = ['created', 'sent', 'funding_started', 'funding_failed']

export async function expireStaleFundingRequests(
  supabase: SupabaseClient,
): Promise<FundingRequestExpirySummary> {
  const summary: FundingRequestExpirySummary = { checked: 0, expired: 0, failed: 0 }
  const nowMs = Date.now()

  const { data: staleRequests, error: fetchError } = await supabase
    .from('funding_requests')
    .select('id')
    .in('status', ACTIVE_STATUSES)
    .not('expires_at', 'is', null)
    .lte('expires_at', nowMs)
    .limit(BATCH_LIMIT)

  if (fetchError) {
    logError('funding_request_expiry.fetch_failed', fetchError)
    throw new Error(`Failed to query stale funding requests: ${fetchError.message}`)
  }

  if (!staleRequests || staleRequests.length === 0) {
    logInfo('funding_request_expiry.none_found', { nowMs })
    return summary
  }

  summary.checked = staleRequests.length

  const ids = (staleRequests as Array<{ id: string }>).map((r) => r.id)
  const updateNowMs = Date.now()

  const { data: updated, error: updateError } = await supabase
    .from('funding_requests')
    .update({ status: 'expired', updated_at: new Date(updateNowMs).toISOString() })
    .in('id', ids)
    .in('status', ACTIVE_STATUSES) // Optimistic concurrency guard
    .select('id')

  if (updateError) {
    logError('funding_request_expiry.update_failed', updateError)
    summary.failed = ids.length
    return summary
  }

  const expiredCount = (updated as Array<{ id: string }> | null)?.length ?? 0
  summary.expired = expiredCount

  if (expiredCount < ids.length) {
    logWarning('funding_request_expiry.partial_update', {
      checked: summary.checked,
      expired: expiredCount,
      skipped: ids.length - expiredCount,
    })
  }

  logInfo('funding_request_expiry.completed', {
    checked: summary.checked,
    expired: expiredCount,
  })

  return summary
}
