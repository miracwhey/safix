/**
 * Server-authoritative Funding Entry Read Endpoint
 *
 * GET /api/funding-entry?fundingRequestId=<id>
 *
 * Returns the full canonical payment context for a funding request so that
 * the client can render the payment UI immediately, without depending on
 * warm client-side stores.
 *
 * Authentication: Supabase JWT in Authorization header.
 *
 * Access: The authenticated caller must have role `customer` (HTTP gate)
 * AND must be the customer linked to the funding request (resource match).
 * The matching `/funding/:fundingRequestId` route is also customer-only
 * (`AuthGate requiredRole="customer"`); this endpoint mirrors that contract
 * server-side instead of relying on the route gate.
 *
 * Response payload:
 *   { fundingRequest, escrowPlan, job, project?, errorCode? }
 *
 * Error codes (structured, never a generic catch-all):
 *   FUNDING_REQUEST_NOT_FOUND     — no row with that ID
 *   FUNDING_REQUEST_NOT_ACCESSIBLE — row exists but caller has no access
 *   ESCROW_PLAN_NOT_FOUND         — funding request exists but escrow plan row missing
 *   JOB_CONTEXT_NOT_FOUND         — linked job row missing
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { applyCors } from './_cors.js'
import { requireCustomer } from './_authRole.js'
import { getSupabaseAdminWithStatus, formatAdminUnavailable } from './_supabase.js'
import { logInfo, logWarning, logError } from './_observability.js'
import { applyRateLimit } from './_rateLimit.js'

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (applyCors(req, res)) return

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed. Use GET.' })
    return
  }

  // ── Authenticate + Authorize ────────────────────────────────────────────
  // Customer-only HTTP gate. Resource-level customer match against
  // funding_request.customer_user_id is enforced below (Step 2).

  const auth = await requireCustomer(req, res)
  if (!auth) return
  if (await applyRateLimit(res, 'standard', auth.userId)) return

  // ── Parse fundingRequestId ──────────────────────────────────────────────

  const rawId =
    typeof req.query.fundingRequestId === 'string'
      ? req.query.fundingRequestId.trim()
      : ''

  if (!rawId) {
    res.status(400).json({
      error: 'Validation error: fundingRequestId query parameter is required.',
    })
    return
  }

  logInfo('api.funding_entry.read_started', {
    fundingRequestId: rawId,
    userId: auth.userId,
  })

  // ── Supabase admin client ───────────────────────────────────────────────

  const adminResult = getSupabaseAdminWithStatus()
  if (adminResult.ok === false) {
    logError('api.funding_entry.admin_unavailable', undefined, {
      missing: adminResult.missing,
    })
    res.status(500).json({
      error: `Server misconfiguration: ${formatAdminUnavailable(adminResult.missing)}`,
    })
    return
  }

  const supabase = adminResult.client

  // ── 1. Load funding request ─────────────────────────────────────────────

  const { data: fr, error: frError } = await supabase
    .from('funding_requests')
    .select(
      'id, source_offer_id, job_id, escrow_plan_id, customer_user_id, provider_id, provider_user_id, type, status, amount, currency, created_by, conversation_id, message_id, created_at, updated_at, sent_at, funded_at, external_funding_ref, funding_idempotency_key, failure_reason',
    )
    .eq('id', rawId)
    .maybeSingle()

  if (frError) {
    logError('api.funding_entry.request_lookup_failed', frError, {
      fundingRequestId: rawId,
    })
    res.status(500).json({ error: 'Failed to lookup funding request.' })
    return
  }

  if (!fr) {
    logWarning('api.funding_entry.not_found', { fundingRequestId: rawId })
    res.status(404).json({
      errorCode: 'FUNDING_REQUEST_NOT_FOUND',
      error: 'Funding request not found.',
    })
    return
  }

  logInfo('api.funding_entry.request_found', {
    fundingRequestId: fr.id,
    status: fr.status,
  })

  // ── 2. Customer-resource match ──────────────────────────────────────────
  // The HTTP role gate already ensured the caller is a customer. Verify
  // they are the customer linked to THIS funding request.

  if (fr.customer_user_id !== auth.userId) {
    logWarning('api.funding_entry.access_denied', {
      fundingRequestId: fr.id,
      userId: auth.userId,
      customerUserId: fr.customer_user_id,
      providerUserId: fr.provider_user_id,
    })
    res.status(403).json({
      errorCode: 'FUNDING_REQUEST_NOT_ACCESSIBLE',
      error: 'You do not have access to this funding request.',
    })
    return
  }

  logInfo('api.funding_entry.access_allowed', {
    fundingRequestId: fr.id,
    role: 'customer',
  })

  // ── 3. Load escrow plan ─────────────────────────────────────────────────

  const { data: ep, error: epError } = await supabase
    .from('escrow_payment_plans')
    .select(
      'id, source_offer_id, job_id, customer_user_id, provider_id, currency, total_amount, funding_mode, release_model, status, created_at, updated_at, funding_initiated_at, funded_at, external_funding_ref, funding_idempotency_key',
    )
    .eq('id', fr.escrow_plan_id)
    .maybeSingle()

  if (epError) {
    logError('api.funding_entry.escrow_plan_lookup_failed', epError, {
      escrowPlanId: fr.escrow_plan_id,
    })
    res.status(500).json({ error: 'Failed to lookup escrow plan.' })
    return
  }

  if (!ep) {
    logWarning('api.funding_entry.escrow_plan_not_found', {
      escrowPlanId: fr.escrow_plan_id,
      fundingRequestId: fr.id,
    })
    res.status(404).json({
      errorCode: 'ESCROW_PLAN_NOT_FOUND',
      error: 'Escrow plan not found.',
    })
    return
  }

  logInfo('api.funding_entry.escrow_plan_found', {
    escrowPlanId: ep.id,
    status: ep.status,
  })

  // ── 4. Load canonical job ───────────────────────────────────────────────

  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .select('id, status, source_offer_id, customer_user_id, provider_id')
    .eq('id', fr.job_id)
    .maybeSingle()

  if (jobError) {
    logError('api.funding_entry.job_lookup_failed', jobError, {
      jobId: fr.job_id,
    })
    res.status(500).json({ error: 'Failed to lookup job context.' })
    return
  }

  if (!job) {
    logWarning('api.funding_entry.job_not_found', {
      jobId: fr.job_id,
      fundingRequestId: fr.id,
    })
    res.status(404).json({
      errorCode: 'JOB_CONTEXT_NOT_FOUND',
      error: 'Job context not found.',
    })
    return
  }

  logInfo('api.funding_entry.job_found', { jobId: job.id })

  // ── 5. Load linked project (optional — best effort) ─────────────────────

  let project: { id: string; title?: string } | null = null

  const { data: proj } = await supabase
    .from('projects')
    .select('id, title')
    .eq('source_job_id', job.id)
    .maybeSingle()

  if (proj) {
    project = { id: proj.id, title: proj.title ?? undefined }
    logInfo('api.funding_entry.project_found', { projectId: proj.id })
  }

  // ── 6. Build canonical response ─────────────────────────────────────────

  const payload = {
    fundingRequest: {
      id: fr.id,
      sourceOfferId: fr.source_offer_id,
      jobId: fr.job_id,
      escrowPlanId: fr.escrow_plan_id,
      customerUserId: fr.customer_user_id,
      providerId: fr.provider_id,
      providerUserId: fr.provider_user_id,
      type: fr.type,
      status: fr.status,
      amount: Number(fr.amount) || 0,
      currency: fr.currency,
      createdBy: fr.created_by,
      conversationId: fr.conversation_id ?? undefined,
      messageId: fr.message_id ?? undefined,
      createdAt: fr.created_at,
      updatedAt: fr.updated_at,
      sentAt: fr.sent_at ?? undefined,
      fundedAt: fr.funded_at ?? undefined,
      externalFundingRef: fr.external_funding_ref ?? undefined,
      fundingIdempotencyKey: fr.funding_idempotency_key ?? undefined,
      failureReason: fr.failure_reason ?? undefined,
    },
    escrowPlan: {
      id: ep.id,
      sourceOfferId: ep.source_offer_id,
      jobId: ep.job_id,
      customerUserId: ep.customer_user_id,
      providerId: ep.provider_id,
      currency: ep.currency,
      totalAmount: Number(ep.total_amount) || 0,
      fundingMode: ep.funding_mode,
      releaseModel: ep.release_model,
      status: ep.status,
      createdAt: ep.created_at,
      updatedAt: ep.updated_at,
      fundingInitiatedAt: ep.funding_initiated_at ?? undefined,
      fundedAt: ep.funded_at ?? undefined,
      externalFundingRef: ep.external_funding_ref ?? undefined,
      fundingIdempotencyKey: ep.funding_idempotency_key ?? undefined,
    },
    job: {
      id: job.id,
      status: job.status,
    },
    project: project ?? undefined,
  }

  logInfo('api.funding_entry.read_complete', {
    fundingRequestId: fr.id,
    fundingStatus: fr.status,
    escrowStatus: ep.status,
    jobId: job.id,
    projectId: project?.id,
  })

  res.status(200).json(payload)
}
