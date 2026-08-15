/**
 * One-shot loader for `stripe_webhook_events` rows associated with a job
 * (N13.2). The webhook log is append-only and written exclusively by the
 * webhook handler — never by the client. This loader exposes the rows for
 * read-only display in the user's reconciliation timeline.
 *
 * The selector layer applies an event-type allow-list (see
 * `reconciliationSelectors.ts → VISIBLE_STRIPE_EVENT_TYPES`) so internal
 * stripe events never reach the UI.
 */

import { supabase } from '../../supabase'
import { logError } from '../../observability'
import type { ReconciliationStripeRow } from '../types'

interface StripeWebhookRowDTO {
  event_id: string
  event_type: string
  payment_intent_id: string | null
  payment_id: string | null
  job_id: string | null
  outcome: string | null
  amount_eur: number | null
  processed_at: string
}

export async function loadStripeEventsForJob(
  jobId: string,
): Promise<ReconciliationStripeRow[]> {
  if (!jobId) return []
  const { data, error } = await supabase
    .from('stripe_webhook_events')
    .select(
      'event_id, event_type, payment_intent_id, payment_id, job_id, outcome, amount_eur, processed_at',
    )
    .eq('job_id', jobId)
    .order('processed_at', { ascending: true })

  if (error) {
    logError('reconciliation.stripe.load_failed', error, { jobId })
    return []
  }
  if (!Array.isArray(data)) return []

  return (data as StripeWebhookRowDTO[]).map((dto) => ({
    eventId: dto.event_id,
    eventType: dto.event_type,
    paymentIntentId: dto.payment_intent_id,
    outcome: dto.outcome,
    amountEur: dto.amount_eur,
    processedAt: dto.processed_at,
  }))
}
