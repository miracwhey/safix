/**
 * Scheduled cron endpoint: destination-charge payout-corridor reconciliation
 * (Block P · P3b items A + B).
 *
 * Hourly. Drives the two open lifecycle gaps of the payout corridor:
 *   A. Re-attempts tranches stuck at `eligible_for_release` (released-tranche
 *      `balance_insufficient` soft-fail) via the canonical /api/release-tranche
 *      endpoint, whose payout idempotency key VARIES by payout_attempt_count so
 *      Stripe's cached `balance_insufficient` 4xx is bypassed; raises a Sentry
 *      aging alert at >24h.
 *   B. Warns (T+60d) / operator-force-flags (T+75d) on the DE 90-day manual-
 *      payout deadline, anchored on escrow_payment_plans.funded_at.
 *
 * This cron needs NO Stripe client — it re-pokes release-tranche over HTTP
 * (same pattern as auto-release-acceptance), which owns the Stripe call.
 *
 * FLAG-OFF NO-OP — primary safety: while FUNDING_DESTINATION_CHARGE_ENABLED is
 * unset / !== 'true', the corridor gate below returns a `corridor_disabled`
 * 200 BEFORE any Supabase client or query, so this cron reads/mutates nothing
 * and the transfer-corridor crons (reconcile-escrow-tranches, reconcile-
 * payments) and all transfer-corridor tranches are untouched.
 *
 * Authentication:
 *   Validates the `Authorization: Bearer <CRON_SECRET>` header injected by
 *   Vercel Cron.
 *
 * Vercel Cron config (vercel.json):
 *   { "path": "/api/cron/reconcile-payout-corridor", "schedule": "0 * * * *" }
 *
 * Response (200):
 *   { ok: true, skipped?: true, reason?: string, checked, reattempted,
 *     deferred, blocked, failed, agingAlerts, deadlineWarnings, deadlineForced }
 *
 * Response (405): method not allowed
 * Response (401): invalid cron secret
 * Response (503): Supabase admin / RELEASE_CONFIRM_SECRET unavailable
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSupabaseAdmin } from '../_supabase.js'
import { reconcilePayoutCorridor } from '../_payoutCorridorReconciliation.js'
import { requireCronAuth } from '../_cronAuth.js'
import { logInfo, logError, withSentryFlush } from '../_observability.js'

async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed. Use GET or POST.' })
    return
  }

  if (!requireCronAuth(req, res)) return

  // ── CORRIDOR GATE — FLAG-OFF NO-OP (primary flag-OFF safety) ──────────────
  // Read the flag FIRST and bail before touching Supabase or running any query.
  // When the corridor is OFF this cron mutates nothing, leaving the transfer
  // corridor entirely untouched.
  const PAYOUT_MODE = process.env.FUNDING_DESTINATION_CHARGE_ENABLED === 'true'
  if (!PAYOUT_MODE) {
    logInfo('cron.payout_corridor.skipped', { reason: 'corridor_disabled' })
    res.status(200).json({ ok: true, skipped: true, reason: 'corridor_disabled' })
    return
  }

  const supabase = getSupabaseAdmin()
  if (!supabase) {
    logError('cron.payout_corridor.failed', undefined, {
      reason: 'supabase_admin_unavailable',
    })
    res.status(503).json({
      ok: false,
      error: 'Service unavailable: Supabase admin client not configured.',
    })
    return
  }

  const releaseConfirmSecret = process.env.RELEASE_CONFIRM_SECRET
  if (!releaseConfirmSecret) {
    logError('cron.payout_corridor.failed', undefined, {
      reason: 'release_confirm_secret_missing',
    })
    res.status(503).json({
      ok: false,
      error: 'Service unavailable: RELEASE_CONFIRM_SECRET not configured.',
    })
    return
  }

  // Resolve base URL for the internal release-tranche call.
  // VERCEL_URL is set automatically by Vercel on every deployment.
  const vercelUrl = process.env.VERCEL_URL
  const baseUrl = vercelUrl ? `https://${vercelUrl}` : 'http://localhost:3000'

  logInfo('cron.payout_corridor.started', { path: req.url })

  try {
    const summary = await reconcilePayoutCorridor(
      supabase,
      releaseConfirmSecret,
      baseUrl,
    )

    logInfo('cron.payout_corridor.completed', summary)

    // Aggregate escalation: a failed re-attempt, a stuck-over-24h aging alert,
    // or a T+75d operator-force is a payout-correctness signal. logError
    // forwards to Sentry; the handler is wrapped in withSentryFlush so the
    // event is flushed before the function returns.
    if (summary.failed > 0 || summary.agingAlerts > 0 || summary.deadlineForced > 0) {
      logError('cron.payout_corridor.attention_required', undefined, {
        ...summary,
        severity: summary.deadlineForced > 0
          ? 'manual_payout_deadline_operator_action_required'
          : 'reconciliation_attention',
      })
    }

    res.status(200).json({ ok: true, ...summary })
  } catch (err) {
    logError('cron.payout_corridor.failed', err, { path: req.url })

    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Unexpected error during payout-corridor reconciliation.',
    })
  }
}

export default withSentryFlush(handler)
