/**
 * Scheduled cron endpoint: expire DB-only trials that Apple never sends EXPIRATION for.
 *
 * Runs daily at 03:00 UTC. Finds all craftsman_subscriptions with
 * status='trial_active' AND trial_ends_at < now() AND no Apple billing provider
 * subscription ID (= pure DB trial, no IAP transaction) → sets status='expired'.
 *
 * Closes the trial-reconciliation bug: start_trial() RPC writes trial_active but
 * if the user never purchased, the RevenueCat EXPIRATION event never fires. The
 * DB-only trial stays trial_active forever at the DB level, breaking RLS/BI.
 *
 * Authentication: Bearer <CRON_SECRET> header injected by Vercel Cron.
 *
 * Response (200): { ok: true, expired }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSupabaseAdmin } from '../_supabase.js'
import { requireCronAuth } from '../_cronAuth.js'
import { logInfo, logError, withSentryFlush } from '../_observability.js'

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireCronAuth(req, res)) return

  const supabase = getSupabaseAdmin()
  if (!supabase) {
    logError('cron.expire_trials.failed', undefined, { reason: 'supabase_admin_unavailable' })
    res.status(503).json({ ok: false, error: 'Service unavailable: Supabase admin client not configured.' })
    return
  }

  const now = new Date()
  const nowIso = now.toISOString()
  const graceDeadline = new Date(now.getTime() - 16 * 24 * 60 * 60 * 1000).toISOString()

  try {
    // 1. DB-only trials (never purchased via IAP) where trial_ends_at has passed
    const { data: expiredTrials, error: trialError } = await supabase
      .from('craftsman_subscriptions')
      .update({ status: 'expired', updated_at: nowIso })
      .eq('status', 'trial_active')
      .lt('trial_ends_at', nowIso)
      .is('billing_provider_subscription_id', null)
      .select('id, profile_id')

    if (trialError) {
      logError('cron.expire_trials.db_failed', trialError, { step: 'trials' })
      res.status(500).json({ ok: false, error: trialError.message })
      return
    }

    // 2. Grace rows older than 16 days (Apple grace window exhausted, EXPIRATION webhook never arrived)
    const { data: expiredGrace, error: graceError } = await supabase
      .from('craftsman_subscriptions')
      .update({ status: 'expired', updated_at: nowIso })
      .eq('status', 'grace')
      .lt('grace_started_at', graceDeadline)
      .select('id, profile_id')

    if (graceError) {
      logError('cron.expire_trials.db_failed', graceError, { step: 'grace' })
      res.status(500).json({ ok: false, error: graceError.message })
      return
    }

    // 3. Canceled rows with null current_period_end (webhook received null expiration_at_ms)
    //    These have no paid period to honor — expire immediately.
    const { data: expiredNullCanceled, error: canceledError } = await supabase
      .from('craftsman_subscriptions')
      .update({ status: 'expired', updated_at: nowIso })
      .eq('status', 'canceled')
      .is('current_period_end', null)
      .select('id, profile_id')

    if (canceledError) {
      logError('cron.expire_trials.db_failed', canceledError, { step: 'null_canceled' })
      res.status(500).json({ ok: false, error: canceledError.message })
      return
    }

    const total = (expiredTrials?.length ?? 0) + (expiredGrace?.length ?? 0) + (expiredNullCanceled?.length ?? 0)
    logInfo('cron.expire_trials.done', {
      expired_trials: expiredTrials?.length ?? 0,
      expired_grace: expiredGrace?.length ?? 0,
      expired_null_canceled: expiredNullCanceled?.length ?? 0,
      total,
    })
    res.status(200).json({ ok: true, expired: total })
  } catch (e) {
    logError('cron.expire_trials.unexpected', e instanceof Error ? e : undefined, {})
    res.status(500).json({ ok: false, error: 'unexpected_error' })
  }
}

export default withSentryFlush(handler)
