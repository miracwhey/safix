/**
 * Server-side offer expiry sweep logic.
 *
 * Finds all offers in 'pending' status whose valid_until date has passed
 * (strictly before today UTC) and sets their status to 'expired' in batch.
 *
 * Guards:
 *   - Only updates rows still in 'pending' (optimistic concurrency guard)
 *   - Batch-limited to prevent cold-start timeouts
 *   - UTC date comparison matches the workflow-layer guard in acceptOfferWorkflow
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logInfo, logWarning, logError } from './_observability.js'

export type OfferExpirySummary = {
  checked: number
  expired: number
  failed: number
}

const BATCH_LIMIT = 100

export async function expireStaleOffers(
  supabase: SupabaseClient,
): Promise<OfferExpirySummary> {
  const summary: OfferExpirySummary = { checked: 0, expired: 0, failed: 0 }
  const todayUTC = new Date().toISOString().slice(0, 10) // YYYY-MM-DD UTC

  const { data: staleOffers, error: fetchError } = await supabase
    .from('offers')
    .select('id, valid_until')
    .eq('status', 'pending')
    .not('valid_until', 'is', null)
    .lt('valid_until', todayUTC)
    .limit(BATCH_LIMIT)

  if (fetchError) {
    logError('offer_expiry.fetch_failed', fetchError)
    throw new Error(`Failed to query stale offers: ${fetchError.message}`)
  }

  if (!staleOffers || staleOffers.length === 0) {
    logInfo('offer_expiry.none_found', { todayUTC })
    return summary
  }

  summary.checked = staleOffers.length

  const ids = (staleOffers as Array<{ id: string }>).map((o) => o.id)
  const nowMs = Date.now()

  const { data: updated, error: updateError } = await supabase
    .from('offers')
    .update({ status: 'expired', updated_at: nowMs })
    .in('id', ids)
    .eq('status', 'pending') // Optimistic concurrency guard
    .select('id')

  if (updateError) {
    logError('offer_expiry.update_failed', updateError)
    summary.failed = ids.length
    return summary
  }

  const expiredCount = (updated as Array<{ id: string }> | null)?.length ?? 0
  summary.expired = expiredCount

  if (expiredCount < ids.length) {
    logWarning('offer_expiry.partial_update', {
      checked: summary.checked,
      expired: expiredCount,
      skipped: ids.length - expiredCount,
    })
  }

  logInfo('offer_expiry.completed', {
    todayUTC,
    checked: summary.checked,
    expired: expiredCount,
  })

  return summary
}
