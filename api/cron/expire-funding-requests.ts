/**
 * Scheduled cron endpoint: expire stale funding requests.
 *
 * Runs daily at 02:00 UTC. Finds all funding requests in non-terminal status
 * whose expires_at deadline has passed and sets their status to 'expired'.
 *
 * After expiry, api/initiate-funding.ts rejects any attempt to fund the
 * request because 'expired' is not in its fundableStatuses set.
 *
 * Authentication:
 *   Validates the Authorization: Bearer <CRON_SECRET> header injected by Vercel Cron.
 *
 * Vercel Cron config (vercel.json):
 *   path: /api/cron/expire-funding-requests — daily at 02:00 UTC
 *
 * Response (200):
 *   { ok: true, checked, expired, failed }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSupabaseAdmin } from '../_supabase.js'
import { expireStaleFundingRequests } from '../_fundingRequestExpiry.js'
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
    logError('cron.expire_funding_requests.failed', undefined, {
      reason: 'supabase_admin_unavailable',
    })
    res.status(503).json({
      ok: false,
      error: 'Service unavailable: Supabase admin client not configured.',
    })
    return
  }

  logInfo('cron.expire_funding_requests.started', { path: req.url })

  try {
    const summary = await expireStaleFundingRequests(supabase)
    logInfo('cron.expire_funding_requests.completed', summary)
    res.status(200).json({ ok: true, ...summary })
  } catch (err) {
    logError('cron.expire_funding_requests.failed', err, { path: req.url })
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Unexpected error during funding request expiry sweep.',
    })
  }
}

export default withSentryFlush(handler)
