/**
 * Scheduled cron endpoint: Stripe ↔ DB payment reconciliation.
 *
 * Queries non-terminal payments with a Stripe provider_ref, retrieves their
 * live status from Stripe, and safely advances DB state where it has fallen
 * behind Stripe's authoritative state.
 *
 * Authentication:
 *   Validates the `Authorization: Bearer <CRON_SECRET>` header injected by
 *   Vercel Cron.  When CRON_SECRET is not configured the check is bypassed
 *   (useful for local development and manual operator invocations).
 *
 * Vercel Cron config (vercel.json):
 *   { "path": "/api/cron/reconcile-payments", "schedule": "0 * * * *" }
 *
 * Emitted observability events:
 *   cron.payment_reconciliation.started
 *   cron.payment_reconciliation.completed
 *   cron.payment_reconciliation.failed
 *   (plus per-payment events from _serverReconciliation.ts)
 *
 * Response (200):
 *   { ok: true, checked: number, aligned: number, recovered: number,
 *     inconsistent: number, failed: number }
 *
 * Response (405): method not allowed
 * Response (401): invalid cron secret
 * Response (503): Supabase or Stripe client unavailable
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import { getSupabaseAdmin } from '../_supabase.js'
import { reconcileRiskyPayments } from '../_serverReconciliation.js'
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

  const supabase = getSupabaseAdmin()
  if (!supabase) {
    logError('cron.payment_reconciliation.failed', undefined, {
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
    logError('cron.payment_reconciliation.failed', undefined, {
      reason: 'stripe_secret_key_missing',
    })
    res.status(503).json({
      ok: false,
      error: 'Service unavailable: STRIPE_SECRET_KEY not configured.',
    })
    return
  }

  logInfo('cron.payment_reconciliation.started', { path: req.url })

  const stripe = getStripe(stripeSecretKey)

  try {
    const summary = await reconcileRiskyPayments(supabase, stripe)

    res.status(200).json({ ok: true, ...summary })
  } catch (err) {
    logError('cron.payment_reconciliation.failed', err, { path: req.url })

    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Unexpected error during payment reconciliation.',
    })
  }
}

export default withSentryFlush(handler)
