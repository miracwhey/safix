/**
 * Scheduled cron endpoint: customer acceptance reminders (Block 7.2.1e).
 *
 * Runs every 15 minutes. Walks pending acceptances, derives which 24h / 60h
 * customer reminders are due via the pure `deriveDueReminders` selector, and
 * inserts `notification_signals` rows with idempotent ids. Successful sends
 * are recorded in `acceptances.reminders_sent` so the next tick skips them.
 *
 * Authentication:
 *   Validates the `Authorization: Bearer <CRON_SECRET>` header injected by
 *   Vercel Cron — same pattern as `auto-release-acceptance`.
 *
 * Vercel Cron config (vercel.json):
 *   path: /api/cron/acceptance-reminder — every 15 minutes
 *
 * Response (200):
 *   { ok: true, checked, sent24h, sent60h, skippedNoneDue, failed }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSupabaseAdmin } from '../_supabase.js'
import { processAcceptanceReminders } from '../_acceptanceReminder.js'
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
    logError('cron.acceptance_reminder.failed', undefined, {
      reason: 'supabase_admin_unavailable',
    })
    res.status(503).json({
      ok: false,
      error: 'Service unavailable: Supabase admin client not configured.',
    })
    return
  }

  logInfo('cron.acceptance_reminder.started', { path: req.url })

  try {
    const summary = await processAcceptanceReminders(supabase, Date.now())
    logInfo('cron.acceptance_reminder.completed', summary)
    res.status(200).json({ ok: true, ...summary })
  } catch (err) {
    logError('cron.acceptance_reminder.failed', err instanceof Error ? err : undefined, {
      path: req.url,
    })
    res.status(500).json({
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : 'Unexpected error during acceptance-reminder cron.',
    })
  }
}

export default withSentryFlush(handler)
