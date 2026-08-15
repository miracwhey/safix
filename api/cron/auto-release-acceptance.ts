/**
 * Scheduled cron endpoint: auto-release expired acceptances.
 *
 * Runs every 15 minutes. Finds acceptances in 'pending' status whose
 * expires_at deadline (72h after work completion) has passed. For each,
 * releases the final_release tranche via the canonical /api/release-tranche
 * endpoint — the same server-authoritative path used by manual customer
 * confirmation.
 *
 * This ensures the craftsman receives their final 75% payout even if the
 * customer does not explicitly confirm within the 72-hour window.
 *
 * Guards:
 *   - Active disputes block auto-release (checked by release-tranche)
 *   - Already-released tranches are idempotent no-ops
 *   - Acceptance status is updated with optimistic concurrency guard
 *
 * Authentication:
 *   Validates the `Authorization: Bearer <CRON_SECRET>` header injected by
 *   Vercel Cron.
 *
 * Vercel Cron config (vercel.json):
 *   path: /api/cron/auto-release-acceptance — every 15 minutes
 *
 * Response (200):
 *   { ok: true, checked, released, disputeBlocked, failed, alreadyProcessed }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSupabaseAdmin } from '../_supabase.js'
import { autoReleaseExpiredAcceptances } from '../_acceptanceAutoRelease.js'
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
    logError('cron.auto_release.failed', undefined, {
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
    logError('cron.auto_release.failed', undefined, {
      reason: 'release_confirm_secret_missing',
    })
    res.status(503).json({
      ok: false,
      error: 'Service unavailable: RELEASE_CONFIRM_SECRET not configured.',
    })
    return
  }

  // Resolve base URL for internal API calls.
  // VERCEL_URL is set automatically by Vercel on every deployment.
  const vercelUrl = process.env.VERCEL_URL
  const baseUrl = vercelUrl ? `https://${vercelUrl}` : 'http://localhost:3000'

  logInfo('cron.auto_release.started', { path: req.url })

  try {
    const summary = await autoReleaseExpiredAcceptances(
      supabase,
      releaseConfirmSecret,
      baseUrl,
    )

    logInfo('cron.auto_release.completed', summary)

    res.status(200).json({ ok: true, ...summary })
  } catch (err) {
    logError('cron.auto_release.failed', err, { path: req.url })

    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Unexpected error during auto-release.',
    })
  }
}

export default withSentryFlush(handler)
