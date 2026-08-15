/**
 * Operator Attribution-DLQ Listing Endpoint.
 *
 * GET /api/operator/list-dlq-attribution
 *
 * Returns every `public.jobs` row currently at `attribution_status='dlq'`.
 *
 * Why an API endpoint instead of a direct browser query:
 *   The existing RLS policy on `public.jobs` (`jobs_select_own`) scopes reads to
 *   rows the caller owns as customer or craftsman.  Operators are typically not
 *   participants on the jobs they need to review — the old browser query hid
 *   most DLQ rows from them, which defeated the entire manual-recovery flow.
 *   We fix this here, not by widening RLS on the jobs table, but by routing the
 *   request through a service-role endpoint with an explicit operator gate.
 *   The jobs-RLS surface stays untouched.
 *
 * Authorization:
 *   1. Valid Supabase session (requireAuth).
 *   2. profiles.is_operator = TRUE (fetchIsOperator).
 *
 * The service-role admin client performs the select so the caller's RLS scope
 * is bypassed, but only after both auth gates pass.  Rate-limited under the
 * 'standard' bucket — this is a read, not a mutation.
 *
 * HTTP contract:
 *   200 { jobs: DlqJob[] }
 *   401 unauthenticated
 *   403 not an operator
 *   500 DB error / admin unavailable
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { applyCors } from '../_cors.js'
import { requireAuth } from '../_auth.js'
import { applyRateLimit } from '../_rateLimit.js'
import { fetchIsOperator } from '../_paymentAuth.js'
import { getSupabaseAdminWithStatus, formatAdminUnavailable } from '../_supabase.js'
import { logError, logInfo, logWarning } from '../_observability.js'

const LIST_LIMIT = 100

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (applyCors(req, res)) return

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed. Use GET or POST.' })
    return
  }

  const auth = await requireAuth(req, res)
  if (!auth) return
  if (await applyRateLimit(res, 'standard', auth.userId)) return

  const adminResult = getSupabaseAdminWithStatus()
  if (adminResult.ok === false) {
    logError('api.operator.list_dlq.admin_unavailable', undefined, {
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
    logWarning('api.operator.list_dlq.forbidden', { userId: auth.userId })
    res.status(403).json({
      error: 'forbidden',
      message: 'Operator access required.',
    })
    return
  }

  const { data, error } = await supabase
    .from('jobs')
    .select(
      'id, customer_user_id, craftsman_user_id, attribution_status, attribution_dlq_reason, attribution_retry_count, attribution_last_retry_at, commercial_origin, created_at',
    )
    .eq('attribution_status', 'dlq')
    .order('attribution_last_retry_at', { ascending: true, nullsFirst: true })
    .limit(LIST_LIMIT)

  if (error) {
    logError(
      'api.operator.list_dlq.query_failed',
      new Error(error.message),
      { userId: auth.userId },
    )
    res.status(500).json({
      error: 'query_failed',
      message: error.message,
    })
    return
  }

  logInfo('api.operator.list_dlq.success', {
    userId: auth.userId,
    count: data?.length ?? 0,
  })

  res.status(200).json({ jobs: data ?? [] })
}
