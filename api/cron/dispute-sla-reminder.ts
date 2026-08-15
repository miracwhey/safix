/**
 * Scheduled cron endpoint: dispute SLA reminders (Block N13.SLA-Cron).
 *
 * Walks `*_waiting` disputes whose `updated_at` crossed a 24h / 48h /
 * 72h threshold without a response, and emits a single
 * `dispute_sla_reminder_<window>` notification per (dispute, threshold).
 *
 * Cron cadence: hourly (`0 * * * *`). Sub-hour granularity is not
 * needed — the SLA windows are 24-hour-bucketed.
 *
 * Authentication:
 *   Validates `Authorization: Bearer <CRON_SECRET>` (same pattern as
 *   `acceptance-reminder` / `auto-release-acceptance`).
 *
 * Response (200):
 *   { ok: true, checked, sent24h, sent48h, sent72h, skippedNoneDue, failed }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSupabaseAdmin } from '../_supabase.js'
import { processDisputeSlaReminders } from '../_disputeSlaReminder.js'
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
    logError('cron.dispute_sla_reminder.failed', undefined, {
      reason: 'supabase_admin_unavailable',
    })
    res.status(503).json({
      ok: false,
      error: 'Service unavailable: Supabase admin client not configured.',
    })
    return
  }

  logInfo('cron.dispute_sla_reminder.started', { path: req.url })

  try {
    const summary = await processDisputeSlaReminders(supabase, Date.now())
    logInfo('cron.dispute_sla_reminder.completed', summary)
    res.status(200).json({ ok: true, ...summary })
  } catch (err) {
    logError(
      'cron.dispute_sla_reminder.failed',
      err instanceof Error ? err : undefined,
      { path: req.url },
    )
    res.status(500).json({
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : 'Unexpected error during dispute-sla-reminder cron.',
    })
  }
}

export default withSentryFlush(handler)
