import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import { applyCors } from './_cors.js'
import { requireAuth } from './_auth.js'
import { getSupabaseAdminWithStatus, formatAdminUnavailable } from './_supabase.js'
import { logWarning, logError, logInfo } from './_observability.js'
import { resolveCommercialFeeRate } from './_feeRate.js'
import { assertAttributionFinalized, attributionGateToHttpResponse } from './_attributionGuard.js'
import { applyRateLimit } from './_rateLimit.js'

/**
 * Server-authoritative Supplementary Funding Initiation Endpoint
 *
 * POST /api/initiate-supplementary-funding
 *
 * Creates a Stripe PaymentIntent for a supplementary payment request
 * (Nachtrag delta that cannot be added to the original locked escrow).
 *
 * Authorization: Supabase JWT — caller must be the customer on the request.
 *
 * Idempotent: if a usable PaymentIntent already exists (via external_ref),
 * returns the existing clientSecret. Canceled/expired intents are replaced.
 *
 * Outcome contract (same pattern as initiate-funding):
 *   PAYMENT_FORM_READY      → clientSecret present, mount Stripe PaymentElement
 *   PAYMENT_ALREADY_FUNDED  → no payment needed, show funded state
 *   PAYMENT_RETRY_READY     → replacement intent created, clientSecret present
 *   PAYMENT_INIT_FAILED     → explicit failure, retryable
 */

type InitiateOutcome =
  | 'PAYMENT_FORM_READY'
  | 'PAYMENT_ALREADY_FUNDED'
  | 'PAYMENT_RETRY_READY'
  | 'PAYMENT_INIT_FAILED'

let stripeClient: Stripe | null = null

function getStripe(secretKey: string): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(secretKey)
  }
  return stripeClient
}

function isStripeResourceMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; statusCode?: unknown; status?: unknown }
  return candidate.code === 'resource_missing' || candidate.statusCode === 404 || candidate.status === 404
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

  const auth = await requireAuth(req, res)
  if (!auth) return
  if (await applyRateLimit(res, 'critical', auth.userId)) return

  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    logError('api.supplementary_funding.no_stripe_key', undefined, {})
    res.status(500).json({ error: 'Server misconfiguration: Stripe secret key not configured.' })
    return
  }

  const { supplementaryPaymentId } = req.body as { supplementaryPaymentId: unknown }

  if (!supplementaryPaymentId || typeof supplementaryPaymentId !== 'string' || supplementaryPaymentId.trim() === '') {
    res.status(400).json({ error: 'Validation error: supplementaryPaymentId must be a non-empty string.' })
    return
  }

  const adminResult = getSupabaseAdminWithStatus()
  if (adminResult.ok === false) {
    logError('api.supplementary_funding.admin_unavailable', undefined, {
      missing: adminResult.missing,
    })
    res.status(500).json({ error: `Server misconfiguration: ${formatAdminUnavailable(adminResult.missing)}` })
    return
  }

  const supabase = adminResult.client

  try {
    // ── 1. Load supplementary payment request ────────────────────────────
    const { data: spr, error: sprError } = await supabase
      .from('supplementary_payment_requests')
      .select('*')
      .eq('id', supplementaryPaymentId.trim())
      .maybeSingle()

    if (sprError) {
      logError('api.supplementary_funding.lookup_failed', sprError, { supplementaryPaymentId })
      res.status(500).json({ error: 'Failed to lookup supplementary payment request.' })
      return
    }

    if (!spr) {
      res.status(404).json({ error: 'Supplementary payment request not found.' })
      return
    }

    // ── 2. Authorization: caller must be the customer ────────────────────
    if (spr.customer_user_id !== auth.userId) {
      logWarning('api.supplementary_funding.auth_failed', {
        userId: auth.userId,
        customerUserId: spr.customer_user_id,
      })
      res.status(403).json({ error: 'Forbidden: you are not the customer for this payment request.' })
      return
    }

    // ── 3. Status gate ───────────────────────────────────────────────────
    const fundableStatuses = new Set(['pending', 'acknowledged', 'funding_initiated'])
    if (!fundableStatuses.has(spr.status)) {
      if (spr.status === 'funded' || spr.status === 'released' || spr.status === 'paid') {
        logInfo('api.supplementary_funding.already_funded', {
          supplementaryPaymentId,
          status: spr.status,
          outcome: 'PAYMENT_ALREADY_FUNDED' as InitiateOutcome,
        })
        res.status(200).json({
          ok: true,
          outcome: 'PAYMENT_ALREADY_FUNDED' as InitiateOutcome,
          message: 'Supplementary payment already completed.',
          paymentIntentId: spr.external_ref ?? null,
          clientSecret: null,
        })
        return
      }
      // waived
      res.status(400).json({
        error: `Supplementary payment is '${spr.status}' and cannot be funded.`,
      })
      return
    }

    const amountCents = spr.amount_cents as number
    const currency = ((spr.currency as string) ?? 'eur').toLowerCase()

    // ── 4. Provider payout readiness ─────────────────────────────────────
    const { data: payoutAccount } = await supabase
      .from('provider_payout_accounts')
      .select('stripe_connect_account_id, charges_enabled, payouts_enabled')
      .eq('provider_user_id', spr.craftsman_user_id)
      .maybeSingle()

    if (!payoutAccount || !payoutAccount.stripe_connect_account_id || !payoutAccount.charges_enabled) {
      logWarning('api.supplementary_funding.provider_payout_not_ready', {
        supplementaryPaymentId,
        craftsmanUserId: spr.craftsman_user_id,
      })
      res.status(400).json({
        ok: false,
        outcome: 'PAYMENT_INIT_FAILED' as InitiateOutcome,
        error: 'PROVIDER_PAYOUT_NOT_READY',
        message: 'Der Handwerker hat noch kein Auszahlungskonto eingerichtet.',
      })
      return
    }

    // ── 5. Attribution gate + fee resolution ─────────────────────────────
    // Shared contract across all money-moving surfaces.  See `_attributionGuard`.
    const gate = await assertAttributionFinalized(
      supabase,
      spr.job_id as string,
      'api.supplementary_funding',
    )
    if (gate.ok === false) {
      const mapped = attributionGateToHttpResponse(gate)
      res.status(mapped.status).json(mapped.body)
      return
    }

    const effectiveOrigin = gate.commercialOrigin
    const { rate: platformFeeRate } = resolveCommercialFeeRate(effectiveOrigin)
    const platformFeeAmount = Math.round(amountCents * platformFeeRate) / 100

    // ── 6. Check for existing PaymentIntent (idempotency / resume) ───────
    let isReplacement = false
    let replacementAnchor: string | null = null
    const stripe = getStripe(secretKey)

    if (spr.external_ref) {
      try {
        const existingIntent = await stripe.paymentIntents.retrieve(spr.external_ref)

        if (existingIntent.status === 'succeeded') {
          logInfo('api.supplementary_funding.intent_already_succeeded', {
            supplementaryPaymentId,
            paymentIntentId: existingIntent.id,
            outcome: 'PAYMENT_ALREADY_FUNDED' as InitiateOutcome,
          })
          res.status(200).json({
            ok: true,
            outcome: 'PAYMENT_ALREADY_FUNDED' as InitiateOutcome,
            message: 'Payment already succeeded.',
            paymentIntentId: existingIntent.id,
            clientSecret: null,
          })
          return
        }

        if (existingIntent.status !== 'canceled' && existingIntent.client_secret) {
          logInfo('api.supplementary_funding.resumed_existing', {
            supplementaryPaymentId,
            paymentIntentId: existingIntent.id,
            intentStatus: existingIntent.status,
            outcome: 'PAYMENT_FORM_READY' as InitiateOutcome,
          })
          res.status(200).json({
            ok: true,
            outcome: 'PAYMENT_FORM_READY' as InitiateOutcome,
            paymentIntentId: existingIntent.id,
            clientSecret: existingIntent.client_secret,
          })
          return
        }

        // Only a terminally cancelled Intent is safe to replace. An active
        // Intent without a client secret is a reconciliation problem, not a
        // license to create another customer-payable object.
        if (existingIntent.status !== 'canceled') {
          logError('api.supplementary_funding.existing_intent_unusable', undefined, {
            supplementaryPaymentId,
            paymentIntentId: existingIntent.id,
            intentStatus: existingIntent.status,
          })
          res.status(409).json({
            ok: false,
            outcome: 'PAYMENT_INIT_FAILED' as InitiateOutcome,
            error: 'EXISTING_PAYMENT_INTENT_UNUSABLE',
            message: 'Die bestehende Zahlung kann nicht sicher fortgesetzt werden. Bitte kontaktiere den Support.',
          })
          return
        }

        isReplacement = true
        replacementAnchor = existingIntent.id
      } catch (retrieveError: unknown) {
        // A timeout/5xx is ambiguous: Stripe may still hold a live, payable
        // Intent. Creating a replacement here can produce two captures. Only
        // a confirmed resource-missing response is safe to replace.
        if (!isStripeResourceMissing(retrieveError)) {
          logError(
            'api.supplementary_funding.retrieve_existing_failed',
            retrieveError instanceof Error ? retrieveError : undefined,
            { supplementaryPaymentId, externalRef: spr.external_ref },
          )
          res.status(502).json({
            ok: false,
            outcome: 'PAYMENT_INIT_FAILED' as InitiateOutcome,
            error: 'EXISTING_PAYMENT_INTENT_UNVERIFIED',
            message: 'Die bestehende Zahlung konnte nicht sicher geprüft werden. Bitte versuche es später erneut.',
          })
          return
        }

        isReplacement = true
        replacementAnchor = spr.external_ref
        logWarning('api.supplementary_funding.existing_intent_missing', {
          supplementaryPaymentId,
          externalRef: spr.external_ref,
        })
      }
    }

    // ── 7. Create Stripe PaymentIntent ───────────────────────────────────
    const idempotencyKey = isReplacement
      ? `supp_funding_${supplementaryPaymentId.trim()}_r_${replacementAnchor}`
      : `supp_funding_${supplementaryPaymentId.trim()}`

    const intentParams: Stripe.PaymentIntentCreateParams = {
      amount: amountCents,
      currency,
      metadata: {
        type: 'supplementary_funding',
        supplementaryPaymentId: supplementaryPaymentId.trim(),
        changeOrderId: spr.change_order_id,
        jobId: spr.job_id,
        customerUserId: auth.userId,
        craftsmanUserId: spr.craftsman_user_id,
        platformFeeRate: String(platformFeeRate),
        platformFeeAmount: String(platformFeeAmount),
        commercialOrigin: effectiveOrigin,
      },
    }

    const paymentIntent = await stripe.paymentIntents.create(intentParams, {
      idempotencyKey,
    })

    if (!paymentIntent.client_secret) {
      logError('api.supplementary_funding.no_client_secret', undefined, {
        supplementaryPaymentId,
        paymentIntentId: paymentIntent.id,
      })
      res.status(500).json({
        ok: false,
        outcome: 'PAYMENT_INIT_FAILED' as InitiateOutcome,
        message: 'PaymentIntent created but client_secret was not returned by Stripe.',
      })
      return
    }

    // ── 8. Persist external reference ────────────────────────────────────
    const nowMs = Date.now()

    const { data: persistedRows, error: persistError } = await supabase
      .from('supplementary_payment_requests')
      .update({
        status: 'funding_initiated',
        external_ref: paymentIntent.id,
        funding_initiated_at: nowMs,
        updated_at: nowMs,
      })
      .eq('id', supplementaryPaymentId.trim())
      .in('status', ['pending', 'acknowledged', 'funding_initiated'])
      .select('id, external_ref, status')

    if (persistError) {
      // Do not expose a client secret for an intent the next retry cannot find
      // through canonical state. The stable Stripe idempotency key lets that
      // retry retrieve the same Intent and complete this write without a second
      // customer-payable PaymentIntent.
      logError('api.supplementary_funding.persist_external_ref_failed', persistError, {
        supplementaryPaymentId: supplementaryPaymentId.trim(),
        paymentIntentId: paymentIntent.id,
      })
      res.status(500).json({
        ok: false,
        outcome: 'PAYMENT_INIT_FAILED' as InitiateOutcome,
        error: 'PAYMENT_INTENT_PERSIST_FAILED',
        message: 'Die Zahlung konnte nicht sicher vorbereitet werden. Bitte versuche es erneut.',
      })
      return
    }

    if (!persistedRows || persistedRows.length !== 1) {
      // A concurrent terminal transition won the guarded write. This newly
      // created Intent has no canonical request to settle against, so cancel it
      // before returning an error. A cancellation failure is logged for Stripe
      // reconciliation; it is never hidden behind a client secret.
      try {
        await stripe.paymentIntents.cancel(paymentIntent.id)
      } catch (cancelError: unknown) {
        logError(
          'api.supplementary_funding.unlinked_intent_cancel_failed',
          cancelError instanceof Error ? cancelError : undefined,
          { supplementaryPaymentId: supplementaryPaymentId.trim(), paymentIntentId: paymentIntent.id },
        )
      }
      logWarning('api.supplementary_funding.persist_external_ref_zero_rows', {
        supplementaryPaymentId: supplementaryPaymentId.trim(),
        paymentIntentId: paymentIntent.id,
      })
      res.status(409).json({
        ok: false,
        outcome: 'PAYMENT_INIT_FAILED' as InitiateOutcome,
        error: 'SUPPLEMENTARY_REQUEST_NO_LONGER_FUNDABLE',
        message: 'Die Nachtragszahlung ist nicht mehr finanzierbar.',
      })
      return
    }

    const outcome: InitiateOutcome = isReplacement
      ? 'PAYMENT_RETRY_READY'
      : 'PAYMENT_FORM_READY'

    logInfo('api.supplementary_funding.initiated', {
      supplementaryPaymentId: supplementaryPaymentId.trim(),
      paymentIntentId: paymentIntent.id,
      amountCents,
      currency,
      platformFeeRate,
      commercialOrigin: effectiveOrigin,
      isReplacement,
      outcome,
    })

    res.status(200).json({
      ok: true,
      outcome,
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
    })
  } catch (err: unknown) {
    if (err instanceof Stripe.errors.StripeError) {
      logError('api.supplementary_funding.stripe_error', err, {
        supplementaryPaymentId,
        errorType: err.type,
      })
      res.status(502).json({
        ok: false,
        outcome: 'PAYMENT_INIT_FAILED' as InitiateOutcome,
        message: `Stripe error (${err.type}): ${err.message}`,
      })
    } else {
      const detail = err instanceof Error ? err.message : String(err)
      logError('api.supplementary_funding.unexpected_error', err instanceof Error ? err : undefined, {
        supplementaryPaymentId,
      })
      res.status(500).json({
        ok: false,
        outcome: 'PAYMENT_INIT_FAILED' as InitiateOutcome,
        message: `Unexpected server error: ${detail}`,
      })
    }
  }
}
