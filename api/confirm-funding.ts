import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import { applyCors } from './_cors.js'
import { secureCompare } from './_secureCompare.js'
import { requireCustomer } from './_authRole.js'
import { getSupabaseAdminWithStatus, formatAdminUnavailable } from './_supabase.js'
import { logError, logInfo, logWarning } from './_observability.js'
import { applyRateLimit } from './_rateLimit.js'
import { executeEscrowRefundForIntent } from './_escrowRefundService.js'

/**
 * Server-side funding confirmation endpoint.
 *
 * Transitions escrow plans to 'funded_in_escrow' after successful Stripe
 * payment.
 *
 * Authorization — dual auth (either path accepted):
 *   1. FUNDING_CONFIRM_SECRET header — server-to-server calls (webhook/cron)
 *   2. Supabase JWT in Authorization header — authenticated browser calls
 *
 * When using JWT auth, the caller must be the customer linked to the
 * funding request (ownership check).
 *
 * Payment verification (H9): BOTH auth paths verify the PaymentIntent
 * against Stripe before any DB write — status must be 'succeeded' and the
 * PI metadata (stamped by api/initiate-funding.ts) must bind it to THIS
 * funding request. Stripe is the source of truth; the caller-provided
 * paymentIntentId string is never trusted on its own. Fail-closed.
 *
 * Idempotent: webhook reconciliation may also confirm, so both paths
 * must be safe to call more than once.
 */

// ── Stripe singleton ──────────────────────────────────────────────────────────
let stripeClient: Stripe | null = null

function getStripe(secretKey: string): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(secretKey)
  }
  return stripeClient
}
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (applyCors(req, res)) return

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed. Use POST.' })
    return
  }

  // Dual auth: accept either server secret OR authenticated Supabase session.
  // Server-secret callers (webhook/cron) skip role enforcement. Browser
  // callers must additionally pass the customer-role gate before any body
  // parsing or DB work.
  const serverSecret = process.env.FUNDING_CONFIRM_SECRET
  const providedSecret = req.headers['x-funding-confirm-secret']
  const hasServerSecret =
    !!serverSecret &&
    typeof providedSecret === 'string' &&
    secureCompare(providedSecret, serverSecret)

  let authenticatedUserId: string | null = null

  if (!hasServerSecret) {
    const auth = await requireCustomer(req, res)
    if (!auth) return
    authenticatedUserId = auth.userId
    if (await applyRateLimit(res, 'critical', auth.userId)) return
  }

  const { paymentIntentId, fundingRequestId } = req.body as {
    paymentIntentId: unknown
    fundingRequestId: unknown
  }

  if (!paymentIntentId || typeof paymentIntentId !== 'string') {
    res.status(400).json({ error: 'paymentIntentId is required.' })
    return
  }

  const adminResult = getSupabaseAdminWithStatus()
  if (adminResult.ok === false) {
    logError('api.confirm_funding.admin_unavailable', undefined, {
      reason: 'supabase_admin_unavailable',
      missing: adminResult.missing,
    })
    res.status(500).json({ error: `Server misconfiguration: ${formatAdminUnavailable(adminResult.missing)}` })
    return
  }

  const supabase = adminResult.client

  // ── Stripe secret key — required for PaymentIntent verification ────────────
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    logError('api.confirm_funding.stripe_key_missing', undefined, {
      paymentIntentId: paymentIntentId.trim(),
    })
    res.status(500).json({ error: 'Server misconfiguration: Stripe secret key not configured.' })
    return
  }

  try {
    // Resolve the complete relationship from the canonical funding request.
    // Request-body plan/job IDs are intentionally ignored: accepting an
    // optional or caller-controlled plan lets the atomic RPC mark only the
    // funding request as funded while the plan, tranches and ledger lag behind.
    const requestedFundingRequestId =
      typeof fundingRequestId === 'string' ? fundingRequestId.trim() : ''
    const fundingRequestLookup = supabase
      .from('funding_requests')
      .select('id, escrow_plan_id, job_id, customer_user_id, external_funding_ref')
    const { data: fundingRequest, error: fundingRequestError } = requestedFundingRequestId
      ? await fundingRequestLookup.eq('id', requestedFundingRequestId).maybeSingle()
      : await fundingRequestLookup.eq('external_funding_ref', paymentIntentId.trim()).maybeSingle()

    if (fundingRequestError) {
      logError('api.confirm_funding.funding_request_fetch_failed', fundingRequestError, {
        paymentIntentId: paymentIntentId.trim(),
        fundingRequestId: requestedFundingRequestId || null,
      })
      res.status(500).json({ error: 'Failed to load the funding request.' })
      return
    }

    if (!fundingRequest) {
      logWarning('api.confirm_funding.no_funding_request', {
        paymentIntentId: paymentIntentId.trim(),
        fundingRequestId: requestedFundingRequestId || null,
      })
      res.status(404).json({ error: 'No funding request found for this payment.' })
      return
    }

    const resolvedFundingRequestId = fundingRequest.id
    const resolvedEscrowPlanId = fundingRequest.escrow_plan_id
    const resolvedJobId = fundingRequest.job_id

    if (!resolvedEscrowPlanId || !resolvedJobId || !fundingRequest.customer_user_id) {
      logError('api.confirm_funding.funding_request_linkage_invalid', undefined, {
        paymentIntentId: paymentIntentId.trim(),
        fundingRequestId: resolvedFundingRequestId,
        hasEscrowPlanId: !!resolvedEscrowPlanId,
        hasJobId: !!resolvedJobId,
        hasCustomerUserId: !!fundingRequest.customer_user_id,
      })
      res.status(409).json({
        error: 'Funding request is missing its canonical escrow relationship.',
        code: 'FUNDING_REQUEST_LINKAGE_INVALID',
      })
      return
    }

    // Ownership check: when using JWT auth (browser path), verify the
    // authenticated user is the customer linked to this funding request.
    // Server-secret callers (webhooks/cron) skip this check.
    if (authenticatedUserId) {
      if (fundingRequest.customer_user_id !== authenticatedUserId) {
        logWarning('api.confirm_funding.ownership_denied', {
          userId: authenticatedUserId,
          fundingRequestId: resolvedFundingRequestId,
        })
        res.status(403).json({ error: 'Forbidden: you are not the customer for this funding request.' })
        return
      }
    }

    // ── Stripe PaymentIntent verification (H9) — fail closed ───────────────
    // Funding may only be marked confirmed when the PaymentIntent has
    // actually been captured ('succeeded') AND its metadata binds it to THIS
    // funding request. Applies to BOTH auth paths (JWT and server secret):
    // Stripe is the truth, not the caller-provided string.
    let intent: Stripe.PaymentIntent
    try {
      intent = await getStripe(secretKey).paymentIntents.retrieve(paymentIntentId.trim())
    } catch (stripeErr: unknown) {
      const detail = stripeErr instanceof Error ? stripeErr.message : String(stripeErr)
      logError('api.confirm_funding.intent_retrieve_failed', stripeErr instanceof Error ? stripeErr : undefined, {
        paymentIntentId: paymentIntentId.trim(),
        fundingRequestId: resolvedFundingRequestId,
      })
      res.status(502).json({ error: `Failed to retrieve funding PaymentIntent: ${detail}` })
      return
    }

    if (intent.status !== 'succeeded') {
      logWarning('api.confirm_funding.intent_not_succeeded', {
        paymentIntentId: paymentIntentId.trim(),
        fundingRequestId: resolvedFundingRequestId,
        intentStatus: intent.status,
      })
      res.status(409).json({
        error: `Funding PaymentIntent is not in 'succeeded' state (current: '${intent.status}'). Payment may not be captured.`,
        code: 'INTENT_NOT_CAPTURED',
      })
      return
    }

    // Metadata binding — api/initiate-funding.ts stamps every escrow funding
    // PI with type='escrow_funding' + fundingRequestId + escrowPlanId.
    const md = (intent.metadata ?? {}) as Record<string, string | undefined>
    const mdFundingRequestId = (md.fundingRequestId ?? '').trim()
    const mdEscrowPlanId = (md.escrowPlanId ?? '').trim()
    const mdJobId = (md.jobId ?? '').trim()
    const storedFundingRef = (fundingRequest.external_funding_ref ?? '').trim()
    const metadataMismatch =
      md.type !== 'escrow_funding' ||
      mdFundingRequestId !== resolvedFundingRequestId ||
      mdEscrowPlanId !== resolvedEscrowPlanId ||
      (mdJobId !== '' && mdJobId !== resolvedJobId) ||
      (storedFundingRef !== '' && storedFundingRef !== paymentIntentId.trim())

    if (metadataMismatch) {
      logWarning('api.confirm_funding.pi_metadata_mismatch', {
        paymentIntentId: paymentIntentId.trim(),
        fundingRequestId: resolvedFundingRequestId,
        escrowPlanId: resolvedEscrowPlanId,
        metadataType: md.type ?? null,
        metadataFundingRequestId: mdFundingRequestId,
        metadataEscrowPlanId: mdEscrowPlanId,
        metadataJobId: mdJobId || null,
        storedFundingRef: storedFundingRef || null,
      })
      res.status(409).json({
        error: 'PaymentIntent does not belong to this funding request.',
        code: 'PI_METADATA_MISMATCH',
      })
      return
    }

    // Atomic funding confirmation — single DB transaction via RPC.
    // Prevents the split-state where funding_request=funded but
    // plan/tranches remain in pre-funded states.
    const { data: rpcResult, error: rpcError } = await supabase.rpc(
      'confirm_funding_atomic',
      {
        p_funding_request_id: resolvedFundingRequestId,
        p_escrow_plan_id: resolvedEscrowPlanId,
        p_payment_intent_id: paymentIntentId.trim(),
      },
    )

    if (rpcError) {
      logError('api.confirm_funding.rpc_failed', rpcError, {
        fundingRequestId: resolvedFundingRequestId,
        escrowPlanId: resolvedEscrowPlanId,
      })
      res.status(500).json({ error: `Funding confirmation failed: ${rpcError.message}` })
      return
    }

    const outcome = rpcResult?.outcome ?? 'unknown'

    if (outcome === 'not_found') {
      res.status(404).json({ error: 'Funding request not found.' })
      return
    }

    if (outcome === 'invalid_state') {
      logWarning('api.confirm_funding.invalid_state', {
        fundingRequestId: resolvedFundingRequestId,
        detail: rpcResult?.detail,
      })
      res.status(409).json({ error: rpcResult?.detail ?? 'Funding request in non-fundable state.' })
      return
    }

    if (outcome === 'job_terminal') {
      // Job was cancelled/completed before this confirmation landed. The PI is
      // captured ('succeeded' asserted above), so refund the money — it must not
      // sit on a dead order — then tell the client the job is gone. The refund
      // is idempotent (stable key); the webhook path refunds the same PI too, so
      // a failure here is still healed there.
      const destinationChargeEnabled = process.env.FUNDING_DESTINATION_CHARGE_ENABLED === 'true'
      try {
        const refund = await executeEscrowRefundForIntent(getStripe(secretKey), intent, {
          destinationChargeEnabled,
        })
        logWarning('api.confirm_funding.job_terminal_refunded', {
          paymentIntentId: paymentIntentId.trim(),
          fundingRequestId: resolvedFundingRequestId,
          jobId: resolvedJobId,
          jobStatus: rpcResult?.job_status ?? null,
          refundMode: refund.ok ? refund.mode : 'refused',
        })
      } catch (refundErr: unknown) {
        // Non-fatal: the webhook path refunds the same PI (idempotent). Still
        // tell the client the job is terminal so they are not left waiting.
        logError(
          'api.confirm_funding.job_terminal_refund_failed',
          refundErr instanceof Error ? refundErr : undefined,
          {
            paymentIntentId: paymentIntentId.trim(),
            fundingRequestId: resolvedFundingRequestId,
            jobId: resolvedJobId,
          },
        )
      }
      res.status(409).json({
        error: 'Dieser Auftrag ist nicht mehr aktiv. Deine Zahlung wurde nicht verbucht und wird erstattet.',
        code: 'JOB_TERMINAL',
      })
      return
    }

    // 'confirmed' or 'already_funded' — both are success from the caller's perspective
    logInfo('api.confirm_funding.success', {
      paymentIntentId: paymentIntentId.trim(),
      fundingRequestId: resolvedFundingRequestId,
      escrowPlanId: resolvedEscrowPlanId,
      jobId: resolvedJobId,
      outcome,
      tranchesUpdated: rpcResult?.tranches_updated,
    })

    res.status(200).json({
      status: 'funded_in_escrow',
      fundingRequestId: resolvedFundingRequestId,
      escrowPlanId: resolvedEscrowPlanId,
      jobId: resolvedJobId,
    })
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err)
    logError('api.confirm_funding.unexpected_error', err instanceof Error ? err : undefined, {
      paymentIntentId,
    })
    res.status(500).json({ error: `Unexpected server error: ${detail}` })
  }
}
