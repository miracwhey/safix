/**
 * Scheduled cron endpoint: Stripe Transfer ↔ DB escrow tranche reconciliation.
 *
 * Detects escrow tranches stuck in 'eligible_for_release' where a Stripe
 * Transfer has already been executed (the DB write after the Transfer failed).
 * Recovers by marking the tranche as 'released' with the real Transfer ID
 * and recomputing the plan rollup status.
 *
 * Authentication:
 *   Validates the `Authorization: Bearer <CRON_SECRET>` header injected by
 *   Vercel Cron.  When CRON_SECRET is not configured the check is bypassed
 *   (useful for local development and manual operator invocations).
 *
 * Vercel Cron config (vercel.json):
 *   { "path": "/api/cron/reconcile-escrow-tranches", "schedule": "0 * * * *" }
 *
 * Emitted observability events:
 *   cron.escrow_reconciliation.started
 *   cron.escrow_reconciliation.completed
 *   cron.escrow_reconciliation.failed
 *   (plus per-tranche events from _escrowReconciliation.ts)
 *
 * Response (200):
 *   { ok: true, checked: number, aligned: number, recovered: number,
 *     failed: number, planRollupsFixed: number }
 *
 * Response (405): method not allowed
 * Response (401): invalid cron secret
 * Response (503): Supabase or Stripe client unavailable
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import { getSupabaseAdmin } from '../_supabase.js'
import { reconcileEscrowTranches } from '../_escrowReconciliation.js'
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

  if (!requireCronAuth(req, res)) return

  const supabase = getSupabaseAdmin()
  if (!supabase) {
    logError('cron.escrow_reconciliation.failed', undefined, {
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
    logError('cron.escrow_reconciliation.failed', undefined, {
      reason: 'stripe_secret_key_missing',
    })
    res.status(503).json({
      ok: false,
      error: 'Service unavailable: STRIPE_SECRET_KEY not configured.',
    })
    return
  }

  logInfo('cron.escrow_reconciliation.started', { path: req.url })

  const stripe = getStripe(stripeSecretKey)

  try {
    const summary = await reconcileEscrowTranches(supabase, stripe)

    logInfo('cron.escrow_reconciliation.completed', summary)

    // Aggregate escalation: any recovered split-brain (Stripe transfer existed, DB
    // not released) or any failed heal is a money-correctness signal. logError
    // forwards to Sentry; the handler is wrapped in withSentryFlush so the event is
    // flushed before the function returns.
    if (summary.recovered > 0 || summary.failed > 0) {
      logError('cron.escrow_reconciliation.split_brain_detected', undefined, {
        recovered: summary.recovered,
        failed: summary.failed,
        checked: summary.checked,
        planRollupsFixed: summary.planRollupsFixed,
        severity: summary.failed > 0 ? 'heal_failed_operator_action_required' : 'healed_automatically',
      })
    }

    res.status(200).json({ ok: true, ...summary })
  } catch (err) {
    logError('cron.escrow_reconciliation.failed', err, { path: req.url })

    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Unexpected error during escrow reconciliation.',
    })
  }
}

export default withSentryFlush(handler)
