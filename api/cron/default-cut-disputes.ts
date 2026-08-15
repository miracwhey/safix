/**
 * Scheduled cron endpoint: T+80 dispute-default-cut (Block P · Run 2 + Batch 2).
 *
 * Daily (04:00). Applies the AGB default — a 75/25 PARTIAL refund to the customer
 * (provisional + right-of-recourse) — for any dispute that has reached T+80 days
 * (anchored on escrow_payment_plans.funded_at) with NO consensus and NO operator
 * action. Only the still-HELD remainder (the non-released tranches) is refunded;
 * the already-released tranche stays with the craftsman. The money side reuses the
 * shared executeEscrowRefundForIntent mechanic (reverse_transfer +
 * refund_application_fee on a destination charge, against the held-remainder
 * snapshot amount), so the auto-default refund stays consistent with the public
 * /api/refund-escrow path.
 *
 * FLAG-OFF NO-OP — primary safety: while FUNDING_DESTINATION_CHARGE_ENABLED is
 * unset / !== 'true', the corridor gate below returns a `corridor_disabled` 200
 * BEFORE any Supabase client or Stripe client is constructed, so this cron
 * reads/mutates nothing and is byte-identically dormant. Disputes,
 * escrow_payment_plans, escrow_tranches, ledger_entries and acceptances are all
 * untouched.
 *
 * HELD-ONLY REFUND (no post-release clawback): the held-remainder snapshot
 * (disputes.default_refund_minor) EXCLUDES released/paid-out tranches, so the
 * default refunds ONLY the in-escrow portion. The already-released 25% stays with
 * the provider and the default path NEVER drives a negative Connect balance —
 * Batch 2 inverted the old full-refund OPTION-A clawback. A fully-released escrow
 * has a 0 held snapshot and settles with no Stripe refund at all.
 *
 * Authentication:
 *   Validates the `Authorization: Bearer <CRON_SECRET>` header injected by
 *   Vercel Cron.
 *
 * Vercel Cron config (vercel.json):
 *   { "path": "/api/cron/default-cut-disputes", "schedule": "0 4 * * *" }
 *
 * Response (200):
 *   { ok: true, skipped?: true, reason?: string, checked, defaulted,
 *     skippedNotEligible, skippedNotOurs, alreadySettled, anchorMissing, failed }
 *
 * Response (405): method not allowed
 * Response (401): invalid cron secret
 * Response (503): Supabase admin / STRIPE_SECRET_KEY unavailable
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import { getSupabaseAdmin } from '../_supabase.js'
import { runDisputeDefaultCut } from '../_disputeDefaultCut.js'
import { requireCronAuth } from '../_cronAuth.js'
import { logInfo, logError, withSentryFlush } from '../_observability.js'

// Module-level Stripe singleton (reused across warm invocations).
let stripeClient: Stripe | null = null

function getStripe(secretKey: string): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(secretKey)
  }
  return stripeClient
}

async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed. Use GET or POST.' })
    return
  }

  // Validate Vercel Cron secret (or bypass in dev when CRON_SECRET is unset).
  if (!requireCronAuth(req, res)) return

  // ── CORRIDOR GATE — FLAG-OFF NO-OP (primary flag-OFF safety) ──────────────
  // Read the flag FIRST and bail before constructing the Supabase admin (the
  // SERVICE-ROLE client) or the Stripe client. When the corridor is OFF this
  // cron mutates nothing — byte-identically dormant.
  const PAYOUT_MODE = process.env.FUNDING_DESTINATION_CHARGE_ENABLED === 'true'
  if (!PAYOUT_MODE) {
    logInfo('cron.dispute_default.skipped', { reason: 'corridor_disabled' })
    res.status(200).json({ ok: true, skipped: true, reason: 'corridor_disabled' })
    return
  }

  // SERVICE-ROLE client: required so the apply_dispute_default_refund /
  // settle_dispute_default RPCs run with auth.uid() IS NULL (the normal,
  // guard-passing case for these service_role-only functions).
  const supabase = getSupabaseAdmin()
  if (!supabase) {
    logError('cron.dispute_default.failed', undefined, {
      reason: 'supabase_admin_unavailable',
    })
    res.status(503).json({
      ok: false,
      error: 'Service unavailable: Supabase admin client not configured.',
    })
    return
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY
  if (!stripeSecretKey) {
    logError('cron.dispute_default.failed', undefined, {
      reason: 'stripe_secret_key_missing',
    })
    res.status(503).json({
      ok: false,
      error: 'Service unavailable: STRIPE_SECRET_KEY not configured.',
    })
    return
  }

  logInfo('cron.dispute_default.started', { path: req.url })

  const stripe = getStripe(stripeSecretKey)

  try {
    const summary = await runDisputeDefaultCut(supabase, stripe)

    logInfo('cron.dispute_default.completed', summary)

    // REAL MONEY MOVED — a successful default-fire issued a 75/25 PARTIAL refund
    // of the held remainder to the customer (the released 25% stays with the
    // provider; no negative-Connect-balance clawback). A human MUST see every
    // default. Escalate to Sentry whenever defaulted > 0. logError forwards; the
    // handler is wrapped in withSentryFlush so the event is flushed before the
    // function returns.
    if (summary.defaulted > 0) {
      logError('cron.dispute_default.defaults_fired', undefined, {
        ...summary,
        severity: 'dispute_default_cut_money_moved',
      })
    }

    // A per-dispute failure (missing PI, Stripe ok:false, RPC error) is a
    // money-correctness signal — escalate separately so a failing batch is
    // visible even when nothing defaulted this tick.
    if (summary.failed > 0) {
      logError('cron.dispute_default.attention_required', undefined, {
        ...summary,
        severity: 'dispute_default_cut_attention',
      })
    }

    res.status(200).json({ ok: true, ...summary })
  } catch (err) {
    logError('cron.dispute_default.failed', err, { path: req.url })

    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Unexpected error during dispute-default-cut.',
    })
  }
}

export default withSentryFlush(handler)
