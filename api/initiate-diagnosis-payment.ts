/**
 * POST /api/initiate-diagnosis-payment
 *
 * Creates (or retrieves) a Stripe PaymentIntent for a diagnosis instant-payment.
 *
 * PAYMENT MODEL
 * -------------
 * Diagnosis payments are separate from the standard escrow corridor:
 *   - Immediate charge (capture_method: 'automatic'), NOT manual capture
 *   - 5 % platform fee via application_fee_amount on the Connect transfer
 *   - Single tranche — no 25/75 split
 *   - PaymentIntent metadata.type = 'diagnosis_payment'
 *   - On success → webhook reconciles payment status to 'diagnosis_payment_completed'
 *
 * IDEMPOTENCY
 * -----------
 * If a Stripe PaymentIntent already exists on the payment record (provider_ref),
 * the existing intent is retrieved and returned (unless canceled/expired).
 * This allows the customer to retry without creating duplicate intents.
 *
 * REQUEST BODY
 * -----------
 * { jobId: string }  — the diagnosis Job ID
 *
 * RESPONSE
 * --------
 * 200: { clientSecret: string }
 * 4xx: { error: string }
 * 5xx: { error: string }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import { applyCors } from './_cors.js'
import { toSmallestUnit } from './_shared.js'
import { requireAuth } from './_auth.js'
import { getSupabaseAdminWithStatus, formatAdminUnavailable } from './_supabase.js'
import { logWarning, logError, logInfo } from './_observability.js'
import { applyRateLimit } from './_rateLimit.js'

/** Platform fee percentage for diagnosis instant-payments. Must match DIAGNOSIS_FEE_PERCENT. */
const DIAGNOSIS_FEE_PERCENT = 5
const DIAGNOSIS_CURRENCY = 'eur'

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

  const auth = await requireAuth(req, res)
  if (!auth) return
  if (await applyRateLimit(res, 'critical', auth.userId)) return

  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    console.error('initiate-diagnosis-payment: STRIPE_SECRET_KEY is not set')
    res.status(500).json({ error: 'Server misconfiguration: Stripe secret key not configured.' })
    return
  }

  const { jobId } = req.body as { jobId: unknown }

  if (!jobId || typeof jobId !== 'string' || jobId.trim() === '') {
    res.status(400).json({ error: 'Validation error: jobId must be a non-empty string.' })
    return
  }

  const adminResult = getSupabaseAdminWithStatus()
  if (adminResult.ok === false) {
    logError('api.diagnosis.admin_unavailable', undefined, {
      reason: 'supabase_admin_unavailable',
      missing: adminResult.missing,
    })
    res.status(500).json({
      error: `Server misconfiguration: ${formatAdminUnavailable(adminResult.missing)}`,
    })
    return
  }

  const supabase = adminResult.client
  const canonicalJobId = jobId.trim()

  try {
    // 1. Load the job — must exist, must be a diagnosis job, customer must match.
    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .select('id, job_kind, customer_user_id, craftsman_user_id')
      .eq('id', canonicalJobId)
      .maybeSingle()

    if (jobError) {
      logError('api.diagnosis.job_lookup_failed', jobError, { jobId: canonicalJobId })
      res.status(500).json({ error: 'Failed to lookup job record.' })
      return
    }

    if (!job) {
      res.status(404).json({ error: 'Job not found.' })
      return
    }

    if (job.job_kind !== 'diagnosis') {
      logWarning('api.diagnosis.wrong_job_kind', {
        jobId: canonicalJobId,
        job_kind: job.job_kind,
      })
      res.status(400).json({ error: 'This endpoint is only for diagnosis jobs.' })
      return
    }

    // Authorization: caller must be the customer.
    if (job.customer_user_id !== auth.userId) {
      logWarning('api.diagnosis.auth_failed', {
        jobId: canonicalJobId,
        userId: auth.userId,
        reason: 'customer_user_id_mismatch',
      })
      res.status(403).json({ error: 'Forbidden: you are not the customer for this job.' })
      return
    }

    const craftsmanUserId = job.craftsman_user_id as string | null

    // 2. Load the diagnosis payment record.
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .select('id, status, total_amount, provider_ref, client_secret')
      .eq('job_id', canonicalJobId)
      .in('status', ['diagnosis_payment_pending', 'diagnosis_payment_completed'])
      .maybeSingle()

    if (paymentError) {
      logError('api.diagnosis.payment_lookup_failed', paymentError, { jobId: canonicalJobId })
      res.status(500).json({ error: 'Failed to lookup diagnosis payment.' })
      return
    }

    if (!payment) {
      res.status(404).json({
        error: 'No pending diagnosis payment found for this job. Accept the offer first.',
      })
      return
    }

    if (payment.status === 'diagnosis_payment_completed') {
      logInfo('api.diagnosis.already_completed', { jobId: canonicalJobId, paymentId: payment.id })
      res.status(200).json({ ok: true, outcome: 'ALREADY_COMPLETED', clientSecret: null })
      return
    }

    const totalAmount = Number(payment.total_amount)
    if (!totalAmount || totalAmount <= 0) {
      res.status(400).json({ error: 'Invalid payment amount.' })
      return
    }

    const stripe = getStripe(secretKey)

    // 3. Idempotency: if a valid PI already exists, return its clientSecret.
    if (payment.provider_ref) {
      try {
        const existing = await stripe.paymentIntents.retrieve(payment.provider_ref)
        if (
          existing.status !== 'canceled' &&
          existing.status !== 'succeeded' &&
          existing.client_secret
        ) {
          logInfo('api.diagnosis.reuse_existing_intent', {
            jobId: canonicalJobId,
            paymentIntentId: existing.id,
            intentStatus: existing.status,
          })
          res.status(200).json({
            ok: true,
            outcome: 'PAYMENT_FORM_READY',
            clientSecret: existing.client_secret,
          })
          return
        }
        if (existing.status === 'succeeded') {
          logInfo('api.diagnosis.intent_already_succeeded', {
            jobId: canonicalJobId,
            paymentIntentId: existing.id,
          })
          res.status(200).json({ ok: true, outcome: 'ALREADY_COMPLETED', clientSecret: null })
          return
        }
        // Canceled or missing client_secret → fall through to create new intent.
      } catch {
        logWarning('api.diagnosis.retrieve_intent_failed', {
          jobId: canonicalJobId,
          providerRef: payment.provider_ref,
        })
        // Fall through to create new intent.
      }
    }

    // 4. Look up craftsman's Stripe Connect account.
    if (!craftsmanUserId) {
      res.status(400).json({ error: 'Craftsman user ID missing on job.' })
      return
    }

    const { data: payoutAccount, error: payoutError } = await supabase
      .from('provider_payout_accounts')
      .select('stripe_connect_account_id, charges_enabled, payouts_enabled')
      .eq('provider_user_id', craftsmanUserId)
      .maybeSingle()

    if (payoutError) {
      logError('api.diagnosis.payout_lookup_failed', payoutError, {
        jobId: canonicalJobId,
        craftsmanUserId,
      })
      res.status(500).json({ error: 'Failed to lookup provider payout account.' })
      return
    }

    if (!payoutAccount?.stripe_connect_account_id) {
      res.status(400).json({
        error: 'Der Handwerker hat noch kein Auszahlungskonto eingerichtet.',
        code: 'PROVIDER_PAYOUT_NOT_READY',
      })
      return
    }

    if (!payoutAccount.charges_enabled) {
      res.status(400).json({
        error: 'Das Zahlungskonto des Handwerkers ist noch nicht für Zahlungen aktiviert.',
        code: 'PROVIDER_PAYOUT_NOT_READY',
      })
      return
    }

    if (!payoutAccount.payouts_enabled) {
      res.status(400).json({
        error: 'Das Zahlungskonto des Handwerkers ist noch nicht für Auszahlungen aktiviert.',
        code: 'PROVIDER_PAYOUT_NOT_READY',
      })
      return
    }

    const connectAccountId = payoutAccount.stripe_connect_account_id

    // 5. Compute the platform fee.
    const platformFeeAmount = Math.round((totalAmount * DIAGNOSIS_FEE_PERCENT / 100) * 100) / 100

    // 6. Create Stripe PaymentIntent.
    //    capture_method: 'automatic' — immediate charge, not escrow hold.
    //    transfer_data.destination — funds go to craftsman's Connect account minus fee.
    //    application_fee_amount — platform takes DIAGNOSIS_FEE_PERCENT.
    const idempotencyKey = `diagnosis_${payment.id}`

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: toSmallestUnit(totalAmount, DIAGNOSIS_CURRENCY),
        currency: DIAGNOSIS_CURRENCY,
        capture_method: 'automatic',
        application_fee_amount: toSmallestUnit(platformFeeAmount, DIAGNOSIS_CURRENCY),
        transfer_data: {
          destination: connectAccountId,
        },
        metadata: {
          type: 'diagnosis_payment',
          jobId: canonicalJobId,
          paymentId: payment.id,
          customerUserId: auth.userId,
          craftsmanUserId,
          connectAccountId,
          diagnosisFeePercent: String(DIAGNOSIS_FEE_PERCENT),
          platformFeeAmount: String(platformFeeAmount),
        },
      },
      { idempotencyKey },
    )

    if (!paymentIntent.client_secret) {
      logError('api.diagnosis.missing_client_secret', undefined, {
        jobId: canonicalJobId,
        paymentIntentId: paymentIntent.id,
      })
      res.status(500).json({ error: 'PaymentIntent created but client_secret was not returned.' })
      return
    }

    // 7. Persist the PaymentIntent reference on the payment record.
    //    This allows the webhook to look up the payment by provider_ref,
    //    and allows idempotent resumption on retry.
    const now = new Date().toISOString()
    const { error: updateError } = await supabase
      .from('payments')
      .update({
        provider_ref: paymentIntent.id,
        client_secret: paymentIntent.client_secret,
        updated_at: now,
      })
      .eq('id', payment.id)

    if (updateError) {
      // Non-fatal: the PaymentIntent was created. The webhook will still fire
      // and can look up by metadata.paymentId. Log and continue.
      logWarning('api.diagnosis.payment_ref_update_failed', {
        jobId: canonicalJobId,
        paymentId: payment.id,
        paymentIntentId: paymentIntent.id,
        error: updateError.message,
      })
    }

    logInfo('api.diagnosis.initiated', {
      jobId: canonicalJobId,
      paymentId: payment.id,
      paymentIntentId: paymentIntent.id,
      totalAmount,
      platformFeeAmount,
      diagnosisFeePercent: DIAGNOSIS_FEE_PERCENT,
    })

    res.status(200).json({
      ok: true,
      outcome: 'PAYMENT_FORM_READY',
      clientSecret: paymentIntent.client_secret,
    })
  } catch (err: unknown) {
    if (err instanceof Stripe.errors.StripeError) {
      console.error(`initiate-diagnosis-payment: Stripe error [${err.type}] ${err.message}`)
      logError('api.diagnosis.stripe_error', err, {
        jobId: canonicalJobId,
        errorType: err.type,
      })
      res.status(502).json({ error: `Stripe error (${err.type}): ${err.message}` })
    } else {
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`initiate-diagnosis-payment: unexpected error: ${detail}`)
      logError('api.diagnosis.unexpected_error', err instanceof Error ? err : undefined, {
        jobId: canonicalJobId,
      })
      res.status(500).json({ error: `Unexpected server error: ${detail}` })
    }
  }
}
