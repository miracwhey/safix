/**
 * Operator Attribution Resolve / Reclassify endpoint.
 *
 * POST /api/operator/resolve-attribution
 *
 * Body:
 *   { jobId: string,
 *     mode: 'resolve' | 'reclassify' | 'reject',
 *     toOrigin?: 'merchant_brought' | 'platform_acquired',
 *     reason: string   // required, trimmed server-side }
 *
 * Authorization:
 *   - Valid Supabase session (requireAuth).
 *   - Operator flag: profiles.is_operator = TRUE (fetchIsOperator).
 *
 * Invokes the SECURITY DEFINER RPC `operator_resolve_attribution` via the
 * admin (service-role) client.  The RPC re-verifies the operator flag as
 * belt-and-suspenders and writes the audit-log row atomically with the state
 * transition.  No state mutation happens in this handler — all writes route
 * through the RPC so the invariant "every operator action is auditable" is
 * enforced at the DB layer.
 *
 * HTTP contract:
 *   200 { outcome: 'resolved', mode, jobId, fromStatus, toStatus, fromOrigin, toOrigin }
 *   400 validation errors (body shape, enum, reason missing)
 *   401 unauthenticated
 *   403 not an operator
 *   404 job not found (RPC SQLSTATE P0002)
 *   409 invalid transition or invalid mode/origin (RPC SQLSTATE P0001)
 *   500 DB error / admin unavailable
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { applyCors } from '../_cors.js'
import { requireAuth } from '../_auth.js'
import { applyRateLimit } from '../_rateLimit.js'
import { fetchIsOperator } from '../_paymentAuth.js'
import { getSupabaseAdminWithStatus, formatAdminUnavailable } from '../_supabase.js'
import { logError, logInfo, logWarning } from '../_observability.js'

type Mode = 'resolve' | 'reclassify' | 'reject'
type Origin = 'merchant_brought' | 'platform_acquired'

const VALID_MODES: readonly Mode[] = ['resolve', 'reclassify', 'reject']
const VALID_ORIGINS: readonly Origin[] = ['merchant_brought', 'platform_acquired']

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (applyCors(req, res)) return

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed. Use POST.' })
    return
  }

  const auth = await requireAuth(req, res)
  if (!auth) return
  if (await applyRateLimit(res, 'critical', auth.userId)) return

  const { jobId, mode, toOrigin, reason } = req.body as {
    jobId: unknown
    mode: unknown
    toOrigin: unknown
    reason: unknown
  }

  // ── Validation ────────────────────────────────────────────────────────────
  if (typeof jobId !== 'string' || jobId.trim() === '') {
    res.status(400).json({ error: 'validation_error', message: 'jobId is required.' })
    return
  }
  if (typeof mode !== 'string' || !(VALID_MODES as readonly string[]).includes(mode)) {
    res.status(400).json({
      error: 'validation_error',
      message: `mode must be one of ${VALID_MODES.join(', ')}.`,
    })
    return
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    res.status(400).json({
      error: 'validation_error',
      message: 'reason is required and must be a non-empty string.',
    })
    return
  }
  if (mode === 'resolve' || mode === 'reclassify') {
    if (typeof toOrigin !== 'string' || !(VALID_ORIGINS as readonly string[]).includes(toOrigin)) {
      res.status(400).json({
        error: 'validation_error',
        message: `toOrigin must be one of ${VALID_ORIGINS.join(', ')} for mode='${mode}'.`,
      })
      return
    }
  } else if (mode === 'reject') {
    if (toOrigin !== undefined && toOrigin !== null) {
      res.status(400).json({
        error: 'validation_error',
        message: "toOrigin must be omitted when mode='reject'.",
      })
      return
    }
  }

  // ── Admin client + operator check ─────────────────────────────────────────
  const adminResult = getSupabaseAdminWithStatus()
  if (adminResult.ok === false) {
    logError('api.operator.resolve_attribution.admin_unavailable', undefined, {
      missing: adminResult.missing,
    })
    res.status(500).json({
      error: 'server_misconfiguration',
      message: formatAdminUnavailable(adminResult.missing),
    })
    return
  }
  const supabase = adminResult.client

  const isOperator = await fetchIsOperator(auth.userId, supabase)
  if (!isOperator) {
    logWarning('api.operator.resolve_attribution.forbidden', {
      userId: auth.userId,
      jobId: jobId.trim(),
      mode,
    })
    res.status(403).json({
      error: 'forbidden',
      message: 'Operator access required.',
    })
    return
  }

  // ── Invoke the RPC ────────────────────────────────────────────────────────
  const { data, error } = await supabase.rpc('operator_resolve_attribution', {
    p_job_id: jobId.trim(),
    p_mode: mode,
    p_to_origin: mode === 'reject' ? null : (toOrigin as string),
    p_reason: reason,
    p_operator_id: auth.userId,
  })

  if (error) {
    const code = (error as { code?: string }).code
    const message = error.message ?? 'Unknown RPC error.'

    // Map SQLSTATE to fachliche HTTP responses.
    if (code === '42501') {
      // Unauthorized — should not reach here because the handler already checks;
      // RPC-layer catch ensures DB-side mismatch is surfaced clearly.
      logWarning('api.operator.resolve_attribution.rpc_forbidden', {
        userId: auth.userId,
        jobId: jobId.trim(),
        message,
      })
      res.status(403).json({ error: 'forbidden', message })
      return
    }
    if (code === 'P0002') {
      logWarning('api.operator.resolve_attribution.job_not_found', {
        userId: auth.userId,
        jobId: jobId.trim(),
      })
      res.status(404).json({ error: 'job_not_found', message })
      return
    }
    if (code === 'P0001') {
      logWarning('api.operator.resolve_attribution.invalid_transition', {
        userId: auth.userId,
        jobId: jobId.trim(),
        mode,
        toOrigin,
        message,
      })
      res.status(409).json({ error: 'invalid_transition', message })
      return
    }

    logError(
      'api.operator.resolve_attribution.rpc_failed',
      new Error(message),
      {
        userId: auth.userId,
        jobId: jobId.trim(),
        mode,
        code,
      },
    )
    res.status(500).json({ error: 'rpc_failed', message })
    return
  }

  logInfo('api.operator.resolve_attribution.success', {
    userId: auth.userId,
    jobId: jobId.trim(),
    mode,
    result: data,
  })

  res.status(200).json(data)
}
