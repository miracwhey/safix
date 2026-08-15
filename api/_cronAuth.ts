/**
 * Cron job authentication guard for Vercel scheduled functions.
 *
 * Vercel Cron automatically injects an `Authorization: Bearer <CRON_SECRET>`
 * header on every scheduled invocation when `CRON_SECRET` is set in the
 * project environment.  This module validates that header so cron endpoints
 * cannot be triggered by arbitrary HTTP callers.
 *
 * Preferred usage — `requireCronAuth` sends the error response automatically:
 *
 *   if (!requireCronAuth(req, res)) return
 *
 * Lower-level alternative — `authenticateCronRequest` returns a union:
 *
 *   const cronAuth = authenticateCronRequest(req)
 *   if (cronAuth.ok === false) {
 *     res.status(cronAuth.statusCode).json({ error: cronAuth.error })
 *     return
 *   }
 *
 * When CRON_SECRET is absent the guard is bypassed ONLY outside Vercel
 * (true local development, `VERCEL` unset).  On any Vercel deployment —
 * production, preview, or development — a missing secret rejects the request:
 * preview deploys share the production Supabase service-role key, so an
 * unauthenticated cron endpoint there is an unauthenticated prod mutation.
 *
 * Emitted observability events:
 *   cron.auth.bypassed           — CRON_SECRET not configured (local dev only)
 *   cron.auth.rejected           — CRON_SECRET not configured on a Vercel deploy
 *   cron.auth.missing_token      — Authorization header absent
 *   cron.auth.invalid_token      — Secret present but token does not match
 *   cron.auth.verified           — Token matches CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { logInfo, logWarning } from './_observability.js'
import { secureCompare } from './_secureCompare.js'

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type CronAuthResult =
  | { ok: true }
  | { ok: false; statusCode: 401; error: string }

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

/**
 * Validates the Vercel Cron secret carried in the Authorization header.
 *
 * - When CRON_SECRET is not set: reject on any Vercel deployment (fail-closed —
 *   preview/dev deploys carry the production service-role key); bypass only
 *   outside Vercel (true local development).
 * - When CRON_SECRET is set, the Authorization header must be
 *   `Bearer <CRON_SECRET>`.
 */
export function authenticateCronRequest(req: VercelRequest): CronAuthResult {
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret) {
    if (process.env.VERCEL) {
      logWarning('cron.auth.rejected', {
        path: req.url,
        reason: 'CRON_SECRET not configured on a Vercel deployment — rejecting request',
        vercelEnv: process.env.VERCEL_ENV ?? 'unknown',
      })
      return {
        ok: false,
        statusCode: 401,
        error: 'Server misconfiguration: CRON_SECRET is required on Vercel deployments.',
      }
    }

    logInfo('cron.auth.bypassed', {
      path: req.url,
      reason: 'CRON_SECRET not configured — skipping auth (local dev, non-Vercel)',
    })
    return { ok: true }
  }

  const header = req.headers['authorization']
  if (!header || typeof header !== 'string') {
    logWarning('cron.auth.missing_token', { path: req.url })
    return {
      ok: false,
      statusCode: 401,
      error: 'Unauthorized: missing Authorization header.',
    }
  }

  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) {
    logWarning('cron.auth.missing_token', { path: req.url, reason: 'not_bearer' })
    return {
      ok: false,
      statusCode: 401,
      error: 'Unauthorized: Authorization header must use Bearer scheme.',
    }
  }

  const token = header.slice(prefix.length).trim()

  if (!secureCompare(token, cronSecret)) {
    logWarning('cron.auth.invalid_token', { path: req.url })
    return {
      ok: false,
      statusCode: 401,
      error: 'Unauthorized: invalid cron secret.',
    }
  }

  logInfo('cron.auth.verified', { path: req.url })
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Convenience — authenticate-or-reject
// ---------------------------------------------------------------------------

/**
 * Authenticates the cron request and sends an error response when
 * authentication fails.  Returns `true` on success, or `false` when the
 * error response has already been sent (caller should `return` immediately).
 */
export function requireCronAuth(
  req: VercelRequest,
  res: VercelResponse,
): boolean {
  const result = authenticateCronRequest(req)
  if (result.ok === false) {
    res.status(result.statusCode).json({ error: result.error })
    return false
  }
  return true
}
