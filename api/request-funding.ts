import type { VercelRequest, VercelResponse } from '@vercel/node'
import { applyCors } from './_cors.js'
import { requireOwner } from './_authRole.js'
import { getSupabaseAdminWithStatus, formatAdminUnavailable } from './_supabase.js'
import { logError, logInfo, logWarning } from './_observability.js'
import { applyRateLimit } from './_rateLimit.js'
import { requireProEntitlement } from './_subscriptionAuth.js'
import { randomUUID } from 'node:crypto'

/**
 * Server-authoritative provider funding request creation endpoint.
 *
 * This is the ONLY path for provider-triggered funding request creation.
 * The provider UI calls this endpoint; the server validates canonical data,
 * ensures/reuses escrow plan + funding request + thread artifact, and
 * returns the canonical state.  The client then refreshes local state.
 *
 * Authorization: Supabase JWT — the caller must be the provider (craftsman)
 * who owns the job.
 *
 * Idempotent: if the escrow plan, funding request, or thread artifact
 * already exist, they are reused.  Repeated calls return the same result
 * without creating duplicates.
 *
 * Structured error codes are returned so the client can surface precise
 * operational messages instead of a generic failure.
 */

// ── Error codes ──────────────────────────────────────────────────────────

type FundingCreationErrorCode =
  | 'JOB_QUERY_FAILED'
  | 'JOB_LOOKUP_FAILED'
  | 'CANONICAL_JOB_NOT_FOUND'
  | 'STALE_JOB_REDIRECT_FAILED'
  | 'SOURCE_OFFER_MISSING'
  | 'ACCEPTED_OFFER_NOT_FOUND'
  | 'CUSTOMER_LINKAGE_MISSING'
  | 'PROVIDER_PROFILE_NOT_FOUND'
  | 'PROVIDER_LINKAGE_MISSING'
  | 'PROVIDER_NOT_AUTHORIZED'
  | 'INVALID_AMOUNT_BASIS'
  | 'JOB_IN_TERMINAL_STATE'
  | 'NO_ACCEPTED_QUOTE'
  | 'ESCROW_PLAN_CREATE_FAILED'
  | 'FUNDING_REQUEST_CREATE_FAILED'
  | 'FUNDING_ARTIFACT_CREATE_FAILED'

// ── Tranche split (25/75) ────────────────────────────────────────────────

const DEPOSIT_RELEASE_PERCENT = 25
const FINAL_RELEASE_PERCENT = 75

// ── Confirmed-live jobs columns ──────────────────────────────────────────
// Only these columns are confirmed to exist in the live public.jobs table.
// Do NOT add columns here unless they are verified in the production schema.
const LIVE_JOB_COLUMNS = 'id, status, source_offer_id, customer_user_id, provider_id'

function calculateTrancheAmounts(totalAmount: number): {
  depositAmount: number
  finalAmount: number
} {
  const depositAmount = Number(((totalAmount * DEPOSIT_RELEASE_PERCENT) / 100).toFixed(2))
  const finalAmount = Number((totalAmount - depositAmount).toFixed(2))
  return { depositAmount, finalAmount }
}

// ── Amount parsing (mirrors client-side parseJobAmount) ──────────────────

function parseAmount(raw: string | number | null | undefined): number | null {
  if (raw == null) return null
  if (typeof raw === 'number') return isFinite(raw) && raw > 0 ? raw : null
  if (!raw.trim()) return null
  const firstPart = raw.split(/[–-]/)[0]
  const cleaned = firstPart
    .replace(/€/g, '')
    .replace(/\./g, '')
    .replace(',', '.')
    .replace(/\s/g, '')
    .trim()
  const n = parseFloat(cleaned)
  return isNaN(n) || n <= 0 ? null : n
}

// ── Euro formatting (mirrors client-side formatEuro) ─────────────────────

function formatEuro(amount: number): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
  }).format(amount)
}

// ── UUID generation ──────────────────────────────────────────────────────

function generateUUID(): string {
  return randomUUID()
}

// ── Handler ──────────────────────────────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (applyCors(req, res)) return

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed. Use POST.' })
    return
  }

  // Authenticate + Authorize — must have a valid Supabase session AND
  // be a craftsman owner. The downstream provider-linkage check (Step 7)
  // additionally verifies that this owner is the provider for THIS job.
  const auth = await requireOwner(req, res)
  if (!auth) return
  if (await applyRateLimit(res, 'critical', auth.userId)) return

  const { jobId } = req.body as { jobId: unknown }

  if (!jobId || typeof jobId !== 'string' || jobId.trim() === '') {
    res.status(400).json({ error: 'jobId is required.' })
    return
  }

  const adminResult = getSupabaseAdminWithStatus()
  if (adminResult.ok === false) {
    logError('api.request_funding.admin_unavailable', undefined, {
      reason: 'supabase_admin_unavailable',
      missing: adminResult.missing,
    })
    res.status(500).json({ error: `Server misconfiguration: ${formatAdminUnavailable(adminResult.missing)}` })
    return
  }

  const supabase = adminResult.client

  // ── Pro entitlement gate ──────────────────────────────────────────────
  // request_funding is not in the AWE allow-list — expired owners cannot
  // initiate new funding requests even for active-escrow jobs.
  const proResult = await requireProEntitlement(supabase, auth.userId, 'request_funding')
  if (proResult.ok === false) {
    res.status(proResult.status).json({ error: proResult.reason })
    return
  }

  try {
    // ── 1. Resolve canonical accepted job ──────────────────────────────
    // Only select confirmed-live job columns — do NOT depend on
    // craftsman_user_id, source_conversation_id, proposal_accepted_at,
    // or amount which may not exist in the live public.jobs schema.

    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .select(LIVE_JOB_COLUMNS)
      .eq('id', jobId.trim())
      .maybeSingle()

    if (jobError) {
      logError('api.request_funding.job_query_failed', jobError, { jobId })
      res.status(500).json({
        error: 'Failed to query job.',
        code: 'JOB_QUERY_FAILED' satisfies FundingCreationErrorCode,
      })
      return
    }

    if (!job) {
      res.status(404).json({
        error: 'Job not found.',
        code: 'CANONICAL_JOB_NOT_FOUND' satisfies FundingCreationErrorCode,
      })
      return
    }

    // ── Canonical identity: never infer a replacement job from the parties.
    // A customer/provider pair can have many historical jobs, so even one query
    // result is not proof that it is the counterpart of this request. The only
    // accepted recovery below is an exact accepted offer whose created_job_id
    // points at this job. Otherwise funding fails closed.
    const canonicalJob = job
    if (!job.source_offer_id) {
      logWarning('api.request_funding.source_offer_link_missing', {
        jobId: jobId.trim(),
        recovery: 'accepted_offer_created_job_id_only',
      })
    }

    // ── 2. Validate terminal state ─────────────────────────────────────
    if (canonicalJob.status === 'completed' || canonicalJob.status === 'cancelled') {
      res.status(409).json({
        error: 'Job is in a terminal state.',
        code: 'JOB_IN_TERMINAL_STATE' satisfies FundingCreationErrorCode,
      })
      return
    }

    // ── 3. Validate accepted quote ─────────────────────────────────────
    // Use live-schema-safe signals: source_offer_id implies accepted offer,
    // and post-acceptance statuses (booked, in_progress, waiting_payment)
    // confirm prior acceptance — without depending on proposal_accepted_at.
    const ACCEPTED_STATUSES = ['booked', 'in_progress', 'waiting_payment']
    const hasAcceptanceSignal =
      !!canonicalJob.source_offer_id || ACCEPTED_STATUSES.includes(canonicalJob.status)
    if (!hasAcceptanceSignal) {
      res.status(409).json({
        error: 'No accepted quote for this job.',
        code: 'NO_ACCEPTED_QUOTE' satisfies FundingCreationErrorCode,
      })
      return
    }

    // ── 4. Validate source_offer_id ────────────────────────────────────
    let sourceOfferId = canonicalJob.source_offer_id as string | null

    // Recovery: try to find the accepted offer by created_job_id
    if (!sourceOfferId) {
      const { data: acceptedOffer } = await supabase
        .from('offers')
        .select('id')
        .eq('created_job_id', canonicalJob.id)
        .eq('status', 'accepted')
        .maybeSingle()

      if (acceptedOffer) {
        sourceOfferId = acceptedOffer.id

        // Persist the linkage for future calls
        await supabase
          .from('jobs')
          .update({ source_offer_id: sourceOfferId })
          .eq('id', canonicalJob.id)

        logInfo('api.request_funding.source_offer_recovered', {
          jobId: canonicalJob.id,
          offerId: sourceOfferId,
        })
      }
    }

    if (!sourceOfferId) {
      res.status(422).json({
        error: 'Source offer linkage is missing.',
        code: 'SOURCE_OFFER_MISSING' satisfies FundingCreationErrorCode,
      })
      return
    }

    // ── 5. Validate accepted offer exists and matches ──────────────────
    // Only select confirmed-live offer columns (no gross_total).
    // Include conversation_id for downstream funding request + artifact creation.
    const { data: offer, error: offerError } = await supabase
      .from('offers')
      .select('id, status, price, customer_user_id, craftsman_user_id, created_job_id, conversation_id')
      .eq('id', sourceOfferId)
      .maybeSingle()

    if (offerError) {
      logError('api.request_funding.offer_lookup_failed', offerError, { sourceOfferId })
      res.status(500).json({ error: 'Failed to lookup offer.' })
      return
    }

    if (!offer || offer.status !== 'accepted') {
      res.status(422).json({
        error: 'Accepted offer not found or not in accepted state.',
        code: 'ACCEPTED_OFFER_NOT_FOUND' satisfies FundingCreationErrorCode,
      })
      return
    }

    // ── 6. Validate customer linkage ───────────────────────────────────
    const customerUserId = canonicalJob.customer_user_id
    if (!customerUserId) {
      res.status(422).json({
        error: 'Customer linkage is missing on the job.',
        code: 'CUSTOMER_LINKAGE_MISSING' satisfies FundingCreationErrorCode,
      })
      return
    }

    if (offer.customer_user_id !== customerUserId) {
      logWarning('api.request_funding.offer_customer_mismatch', {
        jobId: canonicalJob.id,
        sourceOfferId,
        jobCustomerUserId: customerUserId,
        offerCustomerUserId: offer.customer_user_id ?? null,
      })
      res.status(409).json({
        error: 'The accepted offer belongs to a different customer than the job.',
        code: 'CUSTOMER_LINKAGE_MISSING' satisfies FundingCreationErrorCode,
      })
      return
    }

    if (offer.created_job_id && offer.created_job_id !== canonicalJob.id) {
      logWarning('api.request_funding.offer_job_mismatch', {
        jobId: canonicalJob.id,
        sourceOfferId,
        offerCreatedJobId: offer.created_job_id,
      })
      res.status(409).json({
        error: 'The accepted offer is linked to a different canonical job.',
        code: 'STALE_JOB_REDIRECT_FAILED' satisfies FundingCreationErrorCode,
      })
      return
    }

    // ── 7. Validate provider linkage + authorization ───────────────────
    // jobs.provider_id stores providers.id (DB UUID), NOT auth.uid().
    // offers.craftsman_user_id stores auth.uid() — this is the live source
    // for the provider's auth identity (NOT jobs.craftsman_user_id which
    // may not exist in the live schema).
    const providerId = canonicalJob.provider_id
    const providerUserId = offer.craftsman_user_id
    if (!providerId && !providerUserId) {
      res.status(422).json({
        error: 'Provider linkage is missing on the job.',
        code: 'PROVIDER_LINKAGE_MISSING' satisfies FundingCreationErrorCode,
      })
      return
    }

    // Authorization: the caller must be the provider/craftsman.
    // First try direct match on offer.craftsman_user_id (auth UID → auth UID).
    let providerAuthorized = providerUserId != null && auth.userId === providerUserId

    // If direct match failed but provider_id exists, resolve via providers table:
    // providers.id (= job.provider_id) → providers.profile_id (= auth.uid()).
    if (!providerAuthorized && providerId) {
      const { data: providerRow, error: providerLookupError } = await supabase
        .from('providers')
        .select('id, profile_id')
        .eq('id', providerId)
        .maybeSingle()

      if (providerLookupError) {
        logError('api.request_funding.provider_lookup_failed', providerLookupError, {
          providerId,
          userId: auth.userId,
        })
        // Fall through — will fail authorization below
      } else if (!providerRow) {
        logWarning('api.request_funding.provider_profile_not_found', {
          providerId,
          userId: auth.userId,
        })
        res.status(422).json({
          error: 'Provider profile not found for the linked provider_id.',
          code: 'PROVIDER_PROFILE_NOT_FOUND' satisfies FundingCreationErrorCode,
        })
        return
      } else if (providerRow.profile_id === auth.userId) {
        providerAuthorized = true
        logInfo('api.request_funding.provider_resolved_via_profile', {
          userId: auth.userId,
          providerId,
          profileId: providerRow.profile_id,
        })
      }
    }

    // Also try the reverse direction: resolve the authenticated user's
    // provider profile and check whether its providers.id matches the job.
    if (!providerAuthorized && providerId) {
      const { data: authProviderRow } = await supabase
        .from('providers')
        .select('id')
        .eq('profile_id', auth.userId)
        .maybeSingle()

      if (authProviderRow && authProviderRow.id === providerId) {
        providerAuthorized = true
        logInfo('api.request_funding.provider_resolved_via_auth_profile', {
          userId: auth.userId,
          resolvedProviderId: authProviderRow.id,
          jobProviderId: providerId,
        })
      }
    }

    if (!providerAuthorized) {
      logWarning('api.request_funding.authorization_failed', {
        userId: auth.userId,
        expectedProviderUserId: providerUserId,
        expectedProviderId: providerId,
      })
      res.status(403).json({
        error: 'Forbidden: you are not the provider for this job.',
        code: 'PROVIDER_NOT_AUTHORIZED' satisfies FundingCreationErrorCode,
      })
      return
    }

    // ── 8. Validate amount basis ───────────────────────────────────────
    // Use only the offer price (confirmed-live on offers table).
    // Non-live fields (job amount, offer gross total) are NOT used.
    const amount = parseAmount(offer.price)
    if (amount === null || amount <= 0) {
      res.status(422).json({
        error: 'Cannot determine valid amount from offer or job.',
        code: 'INVALID_AMOUNT_BASIS' satisfies FundingCreationErrorCode,
      })
      return
    }

    // ── 9. Ensure / reuse escrow plan ──────────────────────────────────
    // Check for existing plan by source_offer_id first, then by job_id
    const { data: existingPlan } = await supabase
      .from('escrow_payment_plans')
      .select('id, status, total_amount, source_offer_id, job_id')
      .or(`source_offer_id.eq.${sourceOfferId},job_id.eq.${canonicalJob.id}`)
      .limit(1)
      .maybeSingle()

    let escrowPlanId: string
    let escrowPlanStatus: string
    let escrowTotalAmount: number

    if (existingPlan) {
      // Reuse existing plan
      escrowPlanId = existingPlan.id
      escrowPlanStatus = existingPlan.status
      escrowTotalAmount = existingPlan.total_amount
      logInfo('api.request_funding.escrow_plan_reused', {
        planId: escrowPlanId,
        jobId: canonicalJob.id,
      })
    } else {
      // Create new plan
      escrowPlanId = generateUUID()
      escrowTotalAmount = amount
      escrowPlanStatus = 'awaiting_customer_funding'
      const now = new Date().toISOString()

      const { error: planInsertError } = await supabase
        .from('escrow_payment_plans')
        .insert({
          id: escrowPlanId,
          source_offer_id: sourceOfferId,
          job_id: canonicalJob.id,
          customer_user_id: customerUserId,
          provider_id: providerId ?? providerUserId,
          currency: 'EUR',
          total_amount: amount,
          funding_mode: 'full_upfront_escrow',
          release_model: 'start_25_completion_75',
          status: escrowPlanStatus,
          created_at: now,
          updated_at: now,
        })

      if (planInsertError) {
        logError('api.request_funding.escrow_plan_create_failed', planInsertError, {
          jobId: canonicalJob.id,
          sourceOfferId,
        })
        res.status(500).json({
          error: 'Failed to create escrow payment plan.',
          code: 'ESCROW_PLAN_CREATE_FAILED' satisfies FundingCreationErrorCode,
        })
        return
      }

      logInfo('api.request_funding.escrow_plan_created', {
        planId: escrowPlanId,
        jobId: canonicalJob.id,
        amount,
      })
    }

    // Ensure tranches exist for this plan — create missing ones.
    // Handles both new plans and retries where a prior tranche INSERT failed.
    {
      const { data: existingTranches } = await supabase
        .from('escrow_tranches')
        .select('kind')
        .eq('plan_id', escrowPlanId)

      const existingKinds = new Set((existingTranches ?? []).map((t: { kind: string }) => t.kind))
      const now = new Date().toISOString()
      const { depositAmount, finalAmount } = calculateTrancheAmounts(escrowTotalAmount)
      const tranchesToInsert: object[] = []

      if (!existingKinds.has('deposit_release')) {
        tranchesToInsert.push({
          id: generateUUID(),
          plan_id: escrowPlanId,
          kind: 'deposit_release',
          percentage: DEPOSIT_RELEASE_PERCENT,
          amount: depositAmount,
          release_trigger: 'work_started',
          status: 'pending_funding',
          created_at: now,
          updated_at: now,
        })
      }
      if (!existingKinds.has('final_release')) {
        tranchesToInsert.push({
          id: generateUUID(),
          plan_id: escrowPlanId,
          kind: 'final_release',
          percentage: FINAL_RELEASE_PERCENT,
          amount: finalAmount,
          release_trigger: 'work_completed',
          status: 'pending_funding',
          created_at: now,
          updated_at: now,
        })
      }

      if (tranchesToInsert.length > 0) {
        const { error: trancheError } = await supabase
          .from('escrow_tranches')
          .insert(tranchesToInsert)

        if (trancheError) {
          logError('api.request_funding.tranche_create_failed', trancheError, {
            planId: escrowPlanId,
            missing: tranchesToInsert.map((t) => (t as { kind: string }).kind),
          })
          res.status(500).json({
            error: 'Failed to create escrow tranches.',
            code: 'ESCROW_PLAN_CREATE_FAILED' satisfies FundingCreationErrorCode,
          })
          return
        }

        logInfo('api.request_funding.tranches_created', {
          planId: escrowPlanId,
          count: tranchesToInsert.length,
        })
      }
    }

    // ── 10. Ensure / reuse funding request ─────────────────────────────
    const { data: existingFundingReq } = await supabase
      .from('funding_requests')
      .select('id, status, amount')
      .eq('escrow_plan_id', escrowPlanId)
      .limit(1)
      .maybeSingle()

    let fundingRequestId: string
    let fundingRequestStatus: string
    let fundingRequestAmount: number

    if (existingFundingReq) {
      // Reuse existing funding request
      fundingRequestId = existingFundingReq.id
      fundingRequestStatus = existingFundingReq.status
      fundingRequestAmount = existingFundingReq.amount
      logInfo('api.request_funding.funding_request_reused', {
        fundingRequestId,
        jobId: canonicalJob.id,
      })
    } else {
      // Create new funding request — directly with 'sent' status since
      // the provider action itself IS the send event.
      fundingRequestId = generateUUID()
      fundingRequestStatus = 'sent'
      fundingRequestAmount = escrowTotalAmount
      const now = new Date().toISOString()

      const { error: frInsertError } = await supabase
        .from('funding_requests')
        .insert({
          id: fundingRequestId,
          source_offer_id: sourceOfferId,
          job_id: canonicalJob.id,
          escrow_plan_id: escrowPlanId,
          customer_user_id: customerUserId,
          provider_id: providerId ?? providerUserId,
          provider_user_id: providerUserId ?? auth.userId,
          type: 'full_escrow',
          status: fundingRequestStatus,
          amount: escrowTotalAmount,
          currency: 'EUR',
          created_by: 'provider',
          conversation_id: offer.conversation_id ?? null,
          sent_at: now,
          created_at: now,
          updated_at: now,
          expires_at: Date.now() + 14 * 24 * 60 * 60 * 1000,
        })

      if (frInsertError) {
        logError('api.request_funding.funding_request_create_failed', frInsertError, {
          jobId: canonicalJob.id,
          escrowPlanId,
        })
        res.status(500).json({
          error: 'Failed to create funding request.',
          code: 'FUNDING_REQUEST_CREATE_FAILED' satisfies FundingCreationErrorCode,
        })
        return
      }

      logInfo('api.request_funding.funding_request_created', {
        fundingRequestId,
        jobId: canonicalJob.id,
        amount: escrowTotalAmount,
      })
    }

    // ── 11. Mark existing funding request as 'sent' if still 'created' ──
    // This handles the case where an existing request was found but is still
    // in 'created' state (e.g. from a previous partial run).
    if (existingFundingReq && fundingRequestStatus === 'created') {
      const now = new Date().toISOString()
      const { error: markSentError } = await supabase
        .from('funding_requests')
        .update({
          status: 'sent',
          sent_at: now,
          updated_at: now,
        })
        .eq('id', fundingRequestId)
        .eq('status', 'created')

      if (!markSentError) {
        fundingRequestStatus = 'sent'
      }
    }

    // ── 12. Ensure / reuse thread artifact ─────────────────────────────
    // Use offer.conversation_id (confirmed-live) instead of job.source_conversation_id.
    // Use 'funding_step' artifact_type — distinct from the 'payment_phase'
    // artifact created during offer acceptance.  The CHECK constraint now
    // allows 'funding_step' (migration 20260326000002).
    const conversationId = offer.conversation_id
    let artifactCreated = false

    // Resolve canonical project_id for hydration-safe navigation.
    // The customer funding card uses this to navigate directly to the
    // correct project detail without depending on job/project store hydration.
    let canonicalProjectId: string | null = null
    {
      const { data: projectRow } = await supabase
        .from('projects')
        .select('id')
        .eq('source_job_id', canonicalJob.id)
        .limit(1)
        .maybeSingle()
      canonicalProjectId = projectRow?.id ?? null
    }
    let artifactReused = false

    if (conversationId) {
      const { data: existingArtifact } = await supabase
        .from('thread_artifacts')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('artifact_type', 'funding_step')
        .limit(1)
        .maybeSingle()

      if (existingArtifact) {
        artifactReused = true
        logInfo('api.request_funding.artifact_reused', {
          artifactId: existingArtifact.id,
          jobId: canonicalJob.id,
          conversationId,
        })
      } else {
        const now = Date.now()
        const { error: artifactError } = await supabase
          .from('thread_artifacts')
          .insert({
            id: generateUUID(),
            conversation_id: conversationId,
            artifact_type: 'funding_step',
            funding_request_id: fundingRequestId,
            escrow_plan_id: escrowPlanId,
            job_id: canonicalJob.id,
            project_id: canonicalProjectId,
            phase: 'sent',
            snapshot_price: formatEuro(escrowTotalAmount),
            snapshot_phase_label: 'Treuhand-Einzahlung angefordert',
            snapshot_summary: `Vollständige Treuhand-Einzahlung über ${formatEuro(escrowTotalAmount)}`,
            customer_user_id: customerUserId,
            craftsman_user_id: providerUserId ?? auth.userId,
            created_at: now,
            updated_at: now,
          })

        if (artifactError) {
          logError('api.request_funding.artifact_create_failed', artifactError, {
            jobId: canonicalJob.id,
            conversationId,
          })
          res.status(500).json({
            error: 'Failed to create funding step artifact for thread visibility.',
            code: 'FUNDING_ARTIFACT_CREATE_FAILED' satisfies FundingCreationErrorCode,
          })
          return
        }

        artifactCreated = true
        logInfo('api.request_funding.artifact_created', {
          jobId: canonicalJob.id,
          conversationId,
        })
      }
    } else {
      // No conversation_id on the offer means we cannot create the customer-
      // visible funding card.  This is a data integrity issue — fail clearly
      // instead of returning a silent partial success.
      logError('api.request_funding.no_conversation_id', undefined, {
        jobId: canonicalJob.id,
        sourceOfferId,
      })
      res.status(500).json({
        error: 'Cannot create customer-visible funding path: offer has no conversation linkage.',
        code: 'FUNDING_ARTIFACT_CREATE_FAILED' satisfies FundingCreationErrorCode,
      })
      return
    }

    // ── 13. Return structured canonical creation/reuse result ──────────
    logInfo('api.request_funding.success', {
      jobId: canonicalJob.id,
      escrowPlanId,
      fundingRequestId,
      fundingRequestStatus,
      amount: fundingRequestAmount,
      conversationId: conversationId ?? null,
      artifactCreated,
      artifactReused,
    })

    res.status(200).json({
      status: 'ok',
      fundingRequestId,
      fundingRequestStatus,
      escrowPlanId,
      escrowPlanStatus,
      jobId: canonicalJob.id,
      amount: fundingRequestAmount,
      currency: 'EUR',
      conversationId: conversationId ?? null,
      idempotent: !!existingFundingReq,
      escrowPlanCreated: !existingPlan,
      escrowPlanReused: !!existingPlan,
      fundingRequestCreated: !existingFundingReq,
      fundingRequestReused: !!existingFundingReq,
      artifactCreated,
      artifactReused,
    })
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err)
    logError('api.request_funding.unexpected_error', err instanceof Error ? err : undefined, {
      jobId: jobId.trim(),
      detail,
    })
    // Detail is logged above; never echo internal error text to the client.
    res.status(500).json({ error: 'Interner Serverfehler.' })
  }
}
