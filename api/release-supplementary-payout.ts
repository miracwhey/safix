import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import { applyCors } from './_cors.js'
import { secureCompare } from './_secureCompare.js'
import { authenticateRequest } from './_auth.js'
import { getSupabaseAdminWithStatus, formatAdminUnavailable } from './_supabase.js'
import { logError, logInfo, logWarning } from './_observability.js'
import { applyRateLimit } from './_rateLimit.js'
import { fetchIsOperator } from './_paymentAuth.js'
import { releaseSupplementaryPayout } from './_releaseSupplementaryPayout.js'
import { attributionGateToHttpResponse } from './_attributionGuard.js'

/**
 * Server-side supplementary payout release endpoint.
 *
 * POST /api/release-supplementary-payout
 *
 * Transfers the net amount from a funded supplementary payment to the
 * craftsman's Stripe Connect account.  Creates Stripe Transfer + ledger entries.
 *
 * Primary use case: retry when the automatic release in the webhook failed
 * (e.g., provider payout account was not ready at the time of funding).
 *
 * Authorization — dual auth (either path accepted):
 *   1. RELEASE_CONFIRM_SECRET header — server-to-server / cron (trusted, no
 *      ownership check)
 *   2. Supabase JWT — authenticated client calls; the caller must be the
 *      customer or the craftsman on the supplementary payment request, or an
 *      operator (profiles.is_operator) — everyone else gets 403
 *
 * Idempotent: if the SPR is already released, returns 200 with the existing state.
 */

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
  // When JWT-authenticated, the userId is stored for ownership verification
  // against the supplementary payment request (see authorization gate below).
  const serverSecret = process.env.RELEASE_CONFIRM_SECRET
  const providedSecret = req.headers['x-release-confirm-secret']
  const hasServerSecret =
    !!serverSecret &&
    typeof providedSecret === 'string' &&
    secureCompare(providedSecret, serverSecret)

  let authUserId: string | null = null

  if (!hasServerSecret) {
    const auth = await authenticateRequest(req)
    if (auth.ok === false) {
      res.status(auth.statusCode).json({ error: auth.error })
      return
    }
    if (await applyRateLimit(res, 'critical', auth.userId)) return
    authUserId = auth.userId
  }

  const { supplementaryPaymentId } = req.body as { supplementaryPaymentId: unknown }

  if (!supplementaryPaymentId || typeof supplementaryPaymentId !== 'string' || supplementaryPaymentId.trim() === '') {
    res.status(400).json({ error: 'supplementaryPaymentId is required.' })
    return
  }

  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    logError('api.release_supplementary.no_stripe_key', undefined, {})
    res.status(500).json({ error: 'Server misconfiguration: Stripe secret key not configured.' })
    return
  }

  const adminResult = getSupabaseAdminWithStatus()
  if (adminResult.ok === false) {
    logError('api.release_supplementary.admin_unavailable', undefined, {
      missing: adminResult.missing,
    })
    res.status(500).json({ error: `Server misconfiguration: ${formatAdminUnavailable(adminResult.missing)}` })
    return
  }

  // ── Authorization: JWT-authenticated callers must own the SPR ──────────────
  // Server-secret calls (hasServerSecret) are trusted and skip this check.
  // JWT callers must be the customer, the craftsman, or an operator.  The
  // craftsman is allowed because this endpoint is the manual retry path for a
  // payout whose money-movement is already guarded by funded-status,
  // attribution, and Stripe Connect readiness inside releaseSupplementaryPayout.
  if (authUserId) {
    const { data: spr, error: sprAuthzError } = await adminResult.client
      .from('supplementary_payment_requests')
      .select('id, customer_user_id, craftsman_user_id')
      .eq('id', supplementaryPaymentId.trim())
      .maybeSingle()

    if (sprAuthzError) {
      logError('api.release_supplementary.authz_fetch_failed', sprAuthzError, {
        supplementaryPaymentId,
        userId: authUserId,
      })
      res.status(500).json({ error: 'Failed to verify authorization for this supplementary payout.' })
      return
    }

    if (!spr) {
      // Same shape as the helper's NOT_FOUND mapping below — clients see one format.
      res.status(404).json({ error: 'NOT_FOUND' })
      return
    }

    const isCustomer = spr.customer_user_id === authUserId
    const isCraftsman = spr.craftsman_user_id === authUserId
    if (!isCustomer && !isCraftsman) {
      const isOperator = await fetchIsOperator(authUserId, adminResult.client)
      if (!isOperator) {
        logWarning('api.release_supplementary.authorization_failed', {
          supplementaryPaymentId,
          userId: authUserId,
          customerUserId: spr.customer_user_id,
          craftsmanUserId: spr.craftsman_user_id,
          reason: 'caller_is_not_customer_craftsman_or_operator',
        })
        res.status(403).json({ error: 'Forbidden: you are not authorized to release this supplementary payout.' })
        return
      }
    }
  }

  try {
    const result = await releaseSupplementaryPayout(
      adminResult.client,
      getStripe(secretKey),
      supplementaryPaymentId.trim(),
    )

    if (result.ok && result.outcome === 'RELEASED') {
      logInfo('api.release_supplementary.success', {
        supplementaryPaymentId,
        transferId: result.transferId,
        netAmountCents: result.netAmountCents,
      })
      res.status(200).json({
        status: 'released',
        supplementaryPaymentId: supplementaryPaymentId.trim(),
        transferId: result.transferId,
        netAmountCents: result.netAmountCents,
        platformFeeCents: result.platformFeeCents,
      })
      return
    }

    if (result.ok && result.outcome === 'ALREADY_RELEASED') {
      res.status(200).json({
        status: 'released',
        supplementaryPaymentId: supplementaryPaymentId.trim(),
        transferId: result.transferId,
        idempotent: true,
      })
      return
    }

    // Error cases
    if (!result.ok) {
      // Attribution blocks map through the shared HTTP contract so every
      // surface (create-escrow, supplementary funding, tranche release,
      // supplementary payout release) returns the same error shape.
      if (result.outcome === 'ATTRIBUTION_BLOCKED') {
        const mapped = attributionGateToHttpResponse(result.gate)
        res.status(mapped.status).json(mapped.body)
        return
      }

      const statusMap: Record<string, number> = {
        NOT_FOUND: 404,
        NOT_FUNDED: 409,
        PROVIDER_NOT_PAYOUT_READY: 409,
        MISSING_FUNDING_REF: 409,
        INTENT_NOT_CAPTURED: 409,
        TRANSFER_FAILED: 502,
        DB_UPDATE_FAILED: 500,
      }
      const httpStatus = statusMap[result.outcome] ?? 500
      res.status(httpStatus).json({
        error: result.outcome,
        ...('reason' in result && { message: result.reason }),
        ...('error' in result && { detail: result.error }),
        ...('transferId' in result && { transferId: result.transferId }),
        ...('currentStatus' in result && { currentStatus: result.currentStatus }),
        ...('intentStatus' in result && { intentStatus: result.intentStatus }),
      })
      return
    }
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err)
    logError('api.release_supplementary.unexpected_error', err instanceof Error ? err : undefined, {
      supplementaryPaymentId,
    })
    res.status(500).json({ error: `Unexpected server error: ${detail}` })
  }
}
