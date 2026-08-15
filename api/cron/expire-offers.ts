/**
 * Scheduled cron endpoint: expire stale pending offers.
 *
 * Runs daily at 02:00 UTC. Finds all offers in 'pending' status whose
 * valid_until date has passed and sets their status to 'expired'.
 *
 * This enforces the invariant that a pending offer past its valid_until date
 * cannot be accepted — both by this server-side sweep and by the guard in
 * acceptOfferWorkflow() which catches the window before the cron runs.
 *
 * Authentication:
 *   Validates the Authorization: Bearer <CRON_SECRET> header injected by Vercel Cron.
 *
 * Vercel Cron config (vercel.json):
 *   path: /api/cron/expire-offers — daily at 02:00 UTC
 *
 * Response (200):
 *   { ok: true, checked, expired, failed }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSupabaseAdmin } from '../_supabase.js'
import { expireStaleOffers } from '../_offerExpiry.js'
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

  const supabase = getSupabaseAdmin()
  if (!supabase) {
    logError('cron.expire_offers.failed', undefined, {
      reason: 'supabase_admin_unavailable',
    })
    res.status(503).json({
      ok: false,
      error: 'Service unavailable: Supabase admin client not configured.',
    })
    return
  }

  logInfo('cron.expire_offers.started', { path: req.url })

  try {
    const summary = await expireStaleOffers(supabase)
    logInfo('cron.expire_offers.completed', summary)
    res.status(200).json({ ok: true, ...summary })
  } catch (err) {
    logError('cron.expire_offers.failed', err, { path: req.url })
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Unexpected error during offer expiry sweep.',
    })
  }
}

export default withSentryFlush(handler)
