import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import { applyCors } from './_cors.js'
import { requireAuth } from './_auth.js'
import { loadPaymentContext, canCaptureEscrowForPayment, fetchIsOperator } from './_paymentAuth.js'
import { evaluateConsensusSplitParty } from './_consensusSplitAuth.js'
import { getSupabaseAdmin } from './_supabase.js'
import { logInfo, logWarning } from './_observability.js'
import { applyRateLimit } from './_rateLimit.js'

// Initialised once at module level; reused across warm serverless invocations.
// The secret key is read lazily inside the handler so startup failures surface
// as clear 500 responses rather than silent boot crashes.
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

  // ── LEGACY PATH RETIRED ─────────────────────────────────────────────────
  // Manual-capture of a destination-charge escrow PaymentIntent. Retired
  // alongside create-escrow; the live release path is /api/release-tranche.
  if (process.env.ALLOW_LEGACY_ESCROW !== '1') {
    logWarning('api.escrow.legacy_path_blocked', {
      path: req.url,
      route: 'capture-escrow',
      reason: 'destination_charge_retired',
    })
    res.status(410).json({
      error: 'ESCROW_PATH_RETIRED',
      message:
        'This escrow capture endpoint has been retired. Use the tranche-release flow.',
    })
    return
  }

  // Authenticate — reject requests without a valid Supabase session.
  const auth = await requireAuth(req, res)
  if (!auth) return
  if (await applyRateLimit(res, 'critical', auth.userId)) return

  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    console.error('capture-escrow: STRIPE_SECRET_KEY is not set')
    res.status(500).json({ error: 'Server misconfiguration: Stripe secret key not configured.' })
    return
  }

  const { paymentIntentId, disputeId } = (req.body ?? {}) as {
    paymentIntentId: unknown
    disputeId: unknown
  }

  if (!paymentIntentId || typeof paymentIntentId !== 'string' || paymentIntentId.trim() === '') {
    res.status(400).json({ error: 'Validation error: paymentIntentId must be a non-empty string.' })
    return
  }

  // Authorization: verify the authenticated caller owns the payment/job context
  // before executing any Stripe operation.
  const admin = getSupabaseAdmin()
  if (!admin) {
    logWarning('api.payment.context_missing', {
      route: 'capture-escrow',
      paymentIntentId: paymentIntentId.trim(),
      reason: 'supabase_admin_unavailable',
    })
    res.status(500).json({ error: 'Server misconfiguration: authorization service unavailable.' })
    return
  }

  const context = await loadPaymentContext(paymentIntentId.trim(), admin, 'capture-escrow')
  if (!context) {
    res.status(404).json({ error: 'Payment not found or context unavailable.' })
    return
  }

  // ── Authorization (OPTION B) ────────────────────────────────────────────────
  //
  // The existing customer path is kept byte-identical: canCaptureEscrowForPayment
  // is the SOLE gate for a customer and its observability is unchanged. Only when
  // the caller is NOT the customer do we consider the two widened roles:
  //
  //   - OPERATOR (fetchIsOperator): trusted for dispute money. Closes the latent
  //     operator-split capture gap (an operator releasing the provider share was
  //     403'd before this leg). NOT flag-gated.
  //   - VALIDATED CONSENSUS DISPUTE-PARTY (shared helper, requireAmountMatch=false),
  //     gated by CONSENSUS_SPLIT_ENABLED. Lets a craftsman-confirmer (and a
  //     customer-confirmer) consensus release pass capture. Capture moves no
  //     customer-share amount, so no amount match is required here.
  //
  // Non-dispute captures are NOT loosened: with no disputeId (or flag OFF) the
  // helper returns allowed:false and a non-customer/non-operator caller is 403'd
  // exactly as before. In the destination-charge corridor the PI is already
  // captured at funding, so the Stripe action below is an idempotent no-op — this
  // is purely an authz widening.
  const isCustomer = canCaptureEscrowForPayment(auth.userId, context, 'capture-escrow')

  if (!isCustomer) {
    const isOperator = await fetchIsOperator(auth.userId, admin)

    let consensusAllowed = false
    if (!isOperator) {
      const consensusParty = await evaluateConsensusSplitParty(admin, {
        jobId: context.jobId,
        paymentId: context.paymentId,
        disputeId: typeof disputeId === 'string' ? disputeId : null,
        callerUid: auth.userId,
        requireAmountMatch: false,
        route: 'capture-escrow',
      })
      consensusAllowed = consensusParty.allowed
      if (consensusParty.allowed) {
        logInfo('api.capture.consensus_split_party_granted', {
          route: 'capture-escrow',
          paymentIntentId: paymentIntentId.trim(),
          paymentId: context.paymentId,
          jobId: context.jobId,
          disputeId: consensusParty.disputeId,
          splitRatio: consensusParty.splitRatio,
          callerRole: consensusParty.callerRole,
        })
      }
    }

    if (!isOperator && !consensusAllowed) {
      res.status(403).json({ error: 'Forbidden: you are not authorized to capture this payment.' })
      return
    }
  }

  const stripe = getStripe(secretKey)

  try {
    await stripe.paymentIntents.capture(paymentIntentId.trim())
    res.status(200).json({ captured: true })
  } catch (err: unknown) {
    if (
      err instanceof Stripe.errors.StripeInvalidRequestError &&
      err.code === 'payment_intent_unexpected_state'
    ) {
      // Retrieve the intent to differentiate terminal states:
      //   succeeded → already captured; idempotent success (duplicate/retry call)
      //   canceled  → was cancelled/refunded; capture is not valid here
      // Any other state is treated as a non-capturable conflict.
      try {
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId.trim())
        if (intent.status === 'succeeded') {
          console.log(
            `capture-escrow: PaymentIntent ${intent.id} already succeeded — treating as captured (idempotent).`,
          )
          res.status(200).json({ captured: true })
          return
        }
        // canceled, processing, requires_action, etc. — not a success state.
        console.warn(
          `capture-escrow: PaymentIntent ${intent.id} is in non-capturable state '${intent.status}'.`,
        )
        res.status(409).json({
          error: `PaymentIntent cannot be captured: status is '${intent.status}'.`,
        })
        return
      } catch (retrieveErr: unknown) {
        // Fall through to the generic Stripe error handler below.
        if (retrieveErr instanceof Stripe.errors.StripeError) {
          console.error(
            `capture-escrow: failed to retrieve intent after unexpected_state: [${retrieveErr.type}] ${retrieveErr.message}`,
          )
          res.status(502).json({
            error: `Stripe error (${retrieveErr.type}): ${retrieveErr.message}`,
          })
          return
        }
        throw retrieveErr
      }
    }
    if (err instanceof Stripe.errors.StripeError) {
      console.error(`capture-escrow: Stripe error [${err.type}] ${err.message}`)
      res.status(502).json({
        error: `Stripe error (${err.type}): ${err.message}`,
      })
    } else {
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`capture-escrow: unexpected error: ${detail}`)
      res.status(500).json({ error: `Unexpected server error: ${detail}` })
    }
  }
}
