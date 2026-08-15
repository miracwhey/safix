/**
 * Vercel API Route: POST /api/revenuecat-webhook
 *
 * Handles RevenueCat subscription lifecycle events and syncs state to
 * craftsman_subscriptions in Supabase.
 *
 * Auth: Bearer token in Authorization header (set in RC dashboard →
 *   Integrations → Webhooks → Authorization header = Bearer <secret>).
 *   Secret stored in Vercel env as REVENUECAT_WEBHOOK_SECRET.
 *
 * RC app_user_id = Supabase profile_id (set during SDK initialization).
 *
 * Idempotency: event_id claim/reclaim plus an atomic, per-user ordering guard.
 *   Subscription writes and event finalization commit in the same transaction,
 *   so out-of-order delivery can't overwrite newer state or strand a 200 event.
 *
 * Env required:
 *   REVENUECAT_WEBHOOK_SECRET   shared Bearer secret configured in RC dashboard
 *   SUPABASE_URL                Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY   service-role key (bypasses RLS)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSupabaseAdminWithStatus } from './_supabase.js'
import { logError, logInfo } from './_observability.js'
import { secureCompare } from './_secureCompare.js'

// ── RevenueCat event types ────────────────────────────────────────────────

// RevenueCat v1 webhook event types. NOTE: RC has NO TRIAL_STARTED /
// TRIAL_CONVERTED / TRIAL_CANCELLED events — trial state is conveyed via the
// `period_type` field on INITIAL_PURCHASE / RENEWAL / CANCELLATION.
type RCEventType =
  | 'INITIAL_PURCHASE'
  | 'RENEWAL'
  | 'CANCELLATION'
  | 'UNCANCELLATION'
  | 'BILLING_ISSUE'
  | 'PRODUCT_CHANGE'
  | 'EXPIRATION'
  | 'SUBSCRIBER_ALIAS'
  | 'TRANSFER'

interface RCWebhookEvent {
  id: string
  type: RCEventType
  app_user_id: string
  expiration_at_ms: number | null
  purchased_at_ms: number | null
  product_id: string
  store: string
  /** RC billing period of this event. TRIAL = free trial; INTRO/PROMOTIONAL/NORMAL are paid. */
  period_type?: 'TRIAL' | 'INTRO' | 'NORMAL' | 'PROMOTIONAL' | null
  original_transaction_id: string | null
  event_timestamp_ms: number
}

interface RCWebhookPayload {
  event: RCWebhookEvent
}

type SubscriptionStatus = 'trial_active' | 'active' | 'grace' | 'canceled' | 'expired'

/** A crashed invocation may be reclaimed only after this lease has expired. */
const EVENT_PROCESSING_LEASE_MS = 10 * 60 * 1000

function mapEventToStatus(event: RCWebhookEvent): SubscriptionStatus | null {
  switch (event.type) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
      // No dedicated trial event in RC — a free trial is signalled by
      // period_type=TRIAL on the purchase/renewal. INTRO/PROMOTIONAL/NORMAL are
      // paid periods → active.
      return event.period_type === 'TRIAL' ? 'trial_active' : 'active'
    case 'UNCANCELLATION':
    case 'PRODUCT_CHANGE':
      // PRODUCT_CHANGE: plan change (e.g. monthly → 6-month). Status stays active.
      return 'active'
    case 'CANCELLATION':
      return 'canceled'
    case 'BILLING_ISSUE':
      return 'grace'
    case 'EXPIRATION':
      return 'expired'
    default:
      // SUBSCRIBER_ALIAS, TRANSFER — no status change
      return null
  }
}

// ── Handler ───────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET
  if (!secret) {
    logError('api.revenuecat_webhook.misconfigured', undefined, { reason: 'REVENUECAT_WEBHOOK_SECRET_missing' })
    return res.status(500).json({ error: 'webhook_misconfigured' })
  }
  const authHeader = req.headers['authorization'] ?? ''
  const token = Array.isArray(authHeader) ? (authHeader[0] ?? '') : authHeader
  if (!secureCompare(token, `Bearer ${secret}`)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  const payload = req.body as RCWebhookPayload | undefined
  if (!payload?.event) {
    return res.status(400).json({ error: 'Missing event payload' })
  }

  const { event } = payload
  const profileId = event.app_user_id

  if (!profileId) {
    return res.status(400).json({ error: 'Missing app_user_id' })
  }

  // ── Supabase admin client ─────────────────────────────────────────────────
  const adminResult = getSupabaseAdminWithStatus()
  if (adminResult.ok === false) {
    logError('api.revenuecat_webhook.admin_unavailable', undefined, { missing: adminResult.missing })
    return res.status(500).json({ error: 'Server configuration error' })
  }
  const supabase = adminResult.client

  // ── Dedup: claim event_id before processing ───────────────────────────────
  // Plain INSERT — if event_id PK conflicts, Supabase returns error code 23505.
  // Failed claims (or an abandoned processing lease) may be atomically
  // reclaimed, but successful/skipped events remain immutable duplicates.
  const eventId = event.id ?? `${event.type}:${event.app_user_id}:${event.event_timestamp_ms}`
  const newStatus = mapEventToStatus(event)
  const claimedAt = new Date().toISOString()
  const initialOutcome: 'processing' | 'skipped' = newStatus ? 'processing' : 'skipped'

  const { error: claimError } = await supabase
    .from('revenuecat_webhook_events')
    .insert({
      event_id: eventId,
      event_type: event.type,
      event_timestamp_ms: event.event_timestamp_ms,
      app_user_id: profileId,
      payload: payload as unknown as Record<string, unknown>,
      outcome: initialOutcome,
      ...(newStatus ? { processed_at: claimedAt } : {}),
    })

  if (claimError) {
    if (claimError.code === '23505') {
      // Events that map to no status are terminally skipped and must never be
      // replayed. For status-bearing events, reclaim only a known failed row
      // or a lease left behind by a crashed invocation.
      if (!newStatus) {
        logInfo('api.revenuecat_webhook.duplicate', { eventId, profileId })
        return res.status(200).json({ ok: true, action: 'duplicate' })
      }

      const reclaimPatch = {
        outcome: 'processing',
        outcome_reason: null,
        processed_at: claimedAt,
      }
      const { data: failedReclaim, error: failedReclaimError } = await supabase
        .from('revenuecat_webhook_events')
        .update(reclaimPatch)
        .eq('event_id', eventId)
        .eq('outcome', 'failed')
        .select('event_id')

      if (failedReclaimError) {
        logError('api.revenuecat_webhook.reclaim_failed', failedReclaimError, { eventId, profileId })
        return res.status(500).json({ error: 'event_reclaim_failed' })
      }
      if (failedReclaim && failedReclaim.length > 0) {
        logInfo('api.revenuecat_webhook.reclaimed', { eventId, profileId, reason: 'previous_attempt_failed' })
      } else {
        const leaseExpiredBefore = new Date(Date.now() - EVENT_PROCESSING_LEASE_MS).toISOString()
        const { data: expiredReclaim, error: expiredReclaimError } = await supabase
          .from('revenuecat_webhook_events')
          .update(reclaimPatch)
          .eq('event_id', eventId)
          .eq('outcome', 'processing')
          .lt('processed_at', leaseExpiredBefore)
          .select('event_id')

        if (expiredReclaimError) {
          logError('api.revenuecat_webhook.reclaim_failed', expiredReclaimError, { eventId, profileId })
          return res.status(500).json({ error: 'event_reclaim_failed' })
        }
        if (!expiredReclaim || expiredReclaim.length === 0) {
          const { data: existingEvent, error: existingEventError } = await supabase
            .from('revenuecat_webhook_events')
            .select('outcome')
            .eq('event_id', eventId)
            .maybeSingle()

          if (existingEventError) {
            logError('api.revenuecat_webhook.duplicate_check_failed', existingEventError, { eventId, profileId })
            return res.status(500).json({ error: 'event_duplicate_check_failed' })
          }
          if (existingEvent?.outcome === 'processing') {
            // The original invocation may still commit or fail. A success here
            // would acknowledge an event whose audit row remains `processing`.
            logInfo('api.revenuecat_webhook.processing', { eventId, profileId })
            return res.status(500).json({ error: 'event_processing' })
          }
          logInfo('api.revenuecat_webhook.duplicate', { eventId, profileId })
          return res.status(200).json({ ok: true, action: 'duplicate' })
        }
        logInfo('api.revenuecat_webhook.reclaimed', { eventId, profileId, reason: 'processing_lease_expired' })
      }
    } else {
      logError('api.revenuecat_webhook.claim_failed', claimError, { eventId })
      return res.status(500).json({ error: 'event_claim_failed' })
    }
  }

  if (!newStatus) {
    logInfo('api.revenuecat_webhook.skipped', { eventId, type: event.type })
    return res.status(200).json({ ok: true, action: 'skipped', type: event.type })
  }

  // ── Build subscription transition ─────────────────────────────────────────
  const updates: Record<string, unknown> = {
    status: newStatus,
    billing_provider: 'apple',
    billing_provider_subscription_id: event.original_transaction_id,
    updated_at: new Date().toISOString(),
  }

  // current_period_end: set when RC provides expiry. For cancellations without
  // expiry, preserve the existing DB value by omitting the field.
  if (event.expiration_at_ms !== null && event.expiration_at_ms !== undefined) {
    updates.current_period_end = new Date(event.expiration_at_ms).toISOString()
  }

  if (newStatus === 'grace') {
    updates.grace_started_at = new Date(event.event_timestamp_ms).toISOString()
  }

  if (newStatus === 'canceled') {
    updates.canceled_at = new Date(event.event_timestamp_ms).toISOString()
  }

  if ((event.type === 'INITIAL_PURCHASE' || event.type === 'RENEWAL') && event.purchased_at_ms) {
    updates.current_period_start = new Date(event.purchased_at_ms).toISOString()
  }

  // Free trial: RC signals it via period_type=TRIAL on the INITIAL_PURCHASE /
  // RENEWAL event (there is no TRIAL_* event type). Record the trial window and
  // clear the paid-period fields — the trial hasn't converted yet. Runs after
  // the period-start block so it overrides current_period_* for the trial case.
  if (newStatus === 'trial_active') {
    updates.trial_started_at = event.purchased_at_ms
      ? new Date(event.purchased_at_ms).toISOString()
      : new Date(event.event_timestamp_ms).toISOString()
    updates.trial_ends_at = event.expiration_at_ms
      ? new Date(event.expiration_at_ms).toISOString()
      : null
    updates.current_period_start = null
    updates.current_period_end = null
  }

  // This RPC takes a transaction-scoped advisory lock per profile, performs
  // the ordering check, updates the subscription, and finalizes this event in
  // one transaction. Different event IDs for one profile cannot interleave.
  const { data: action, error } = await supabase.rpc('finalize_revenuecat_subscription_event', {
    p_event_id: eventId,
    p_profile_id: profileId,
    p_event_timestamp_ms: event.event_timestamp_ms,
    p_subscription_updates: updates,
  })

  if (error) {
    // The RPC transaction rolled back, including any subscription write. Mark
    // the outer claim failed so the same event ID can be reclaimed immediately.
    await supabase
      .from('revenuecat_webhook_events')
      .update({ outcome: 'failed', outcome_reason: error.message, processed_at: new Date().toISOString() })
      .eq('event_id', eventId)
      .eq('outcome', 'processing')
    logError('api.revenuecat_webhook.db_update_failed', error, { profileId, eventId })
    return res.status(500).json({ error: error.message })
  }

  if (action === 'no_subscription') {
    logError('api.revenuecat_webhook.no_row_updated', undefined, { profileId, eventId, eventType: event.type })
    // A missing row is commonly an onboarding/webhook delivery race. Return a
    // retriable response; the RPC atomically finalized this attempt as failed.
    return res.status(500).json({ error: 'no_subscription_row', profileId })
  }

  if (action === 'stale') {
    logInfo('api.revenuecat_webhook.stale_event', {
      eventId,
      profileId,
      eventTimestampMs: event.event_timestamp_ms,
    })
    return res.status(200).json({ ok: true, action: 'stale' })
  }

  if (action !== 'updated') {
    logError('api.revenuecat_webhook.invalid_finalize_result', undefined, { eventId, profileId, action })
    return res.status(500).json({ error: 'invalid_finalize_result' })
  }

  logInfo('api.revenuecat_webhook.processed', { eventId, profileId, newStatus })
  return res.status(200).json({ ok: true, action: 'updated', status: newStatus })
}
