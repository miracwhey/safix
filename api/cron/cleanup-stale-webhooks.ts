/**
 * Scheduled cron endpoint: stale webhook event cleanup.
 *
 * Runs `cleanupStaleWebhookEvents()` to recover webhook processing rows
 * that were abandoned mid-flight (e.g. due to a Vercel function timeout).
 *
 * Authentication:
 *   Validates the `Authorization: Bearer <CRON_SECRET>` header injected by
 *   Vercel Cron.  When CRON_SECRET is not configured the check is bypassed
 *   (useful for local development and manual operator invocations).
 *
 * Vercel Cron config (vercel.json):
 *   { "path": "/api/cron/cleanup-stale-webhooks", "schedule": "every 10 minutes" }
 *
 * Emitted observability events:
 *   cron.cleanup_stale_webhooks.started
 *   cron.cleanup_stale_webhooks.completed
 *   cron.cleanup_stale_webhooks.failed
 *
 * Response (200):
 *   { ok: true, checked: number, recovered: number, failedToUpdate: number }
 *
 * Response (405): method not allowed
 * Response (401): invalid cron secret
 * Response (503): Supabase client unavailable
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSupabaseAdmin } from '../_supabase.js'
import { cleanupStaleWebhookEvents } from '../_webhookProcessingRecovery.js'
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

  // Validate Vercel Cron secret (or bypass in dev when CRON_SECRET is unset).
  if (!requireCronAuth(req, res)) return

  const supabase = getSupabaseAdmin()
  if (!supabase) {
    logError('cron.cleanup_stale_webhooks.failed', undefined, {
      reason: 'supabase_admin_unavailable',
    })
    res.status(503).json({
      ok: false,
      error: 'Service unavailable: Supabase admin client not configured.',
    })
    return
  }

  logInfo('cron.cleanup_stale_webhooks.started', { path: req.url })

  try {
    const result = await cleanupStaleWebhookEvents(supabase)

    logInfo('cron.cleanup_stale_webhooks.completed', {
      checked: result.checked,
      recovered: result.recovered,
      failedToUpdate: result.failedToUpdate,
    })

    res.status(200).json({
      ok: true,
      checked: result.checked,
      recovered: result.recovered,
      failedToUpdate: result.failedToUpdate,
    })
  } catch (err) {
    logError('cron.cleanup_stale_webhooks.failed', err, { path: req.url })

    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Unexpected error during stale webhook cleanup.',
    })
  }
}

export default withSentryFlush(handler)
