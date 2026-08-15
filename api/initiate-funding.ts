import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import { applyCors } from './_cors.js'
import { toSmallestUnit } from './_shared.js'
import { requireAuth } from './_auth.js'
import { getSupabaseAdminWithStatus, formatAdminUnavailable } from './_supabase.js'
import { logWarning, logError, logInfo } from './_observability.js'
import { resolveCommercialFeeRate } from './_feeRate.js'
import { assertAttributionFinalized, attributionGateToHttpResponse } from './_attributionGuard.js'
import { applyRateLimit } from './_rateLimit.js'

// ---------------------------------------------------------------------------
// Explicit outcome contract for /api/initiate-funding
// ---------------------------------------------------------------------------

/**
 * Deterministic outcome codes returned by the initiate-funding endpoint.
 *
 * The client must switch on `outcome` — never infer meaning from missing fields.
 *
 * - PAYMENT_FORM_READY   → clientSecret is present; mount Stripe PaymentElement
 * - PAYMENT_ALREADY_FUNDED → no payment needed; show funded state
 * - PAYMENT_RETRY_READY  → replacement intent created; clientSecret is present
 * - PAYMENT_INIT_FAILED  → explicit failure; show retryable error
 */
type InitiateFundingOutcome =
  | 'PAYMENT_FORM_READY'
  | 'PAYMENT_ALREADY_FUNDED'
  | 'PAYMENT_RETRY_READY'
  | 'PAYMENT_INIT_FAILED'
  | 'FUNDING_REQUEST_EXPIRED'

const SUPPORTED_CURRENCIES = new Set(['eur', 'usd', 'gbp', 'chf', 'sek', 'nok', 'dkk'])

const MAX_ESCROW_AMOUNTS: Record<string, number> = {
  eur: 50_000,
  usd: 55_000,
  gbp: 45_000,
  chf: 52_000,
  sek: 580_000,
  nok: 590_000,
  dkk: 375_000,
}

let stripeClient: Stripe | null = null

function getStripe(secretKey: string): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(secretKey)
  }
  return stripeClient
}

/**
 * Distinguishes transient Stripe failures (network blips / Stripe 5xx) from
 * terminal ones. A transient failure on `paymentIntents.retrieve` must NOT be
 * treated as a missing intent — the original PaymentIntent may still be live
 * and payable. Replacing it would create a second live PI → double charge.
 */
function isTransientStripeError(err: unknown): boolean {
  if (err instanceof Stripe.errors.StripeError) {
    if (
      err.type === 'StripeConnectionError' ||
      err.type === 'StripeAPIError' ||
      err.type === 'StripeRateLimitError'
    ) {
      return true
    }
    // 429 rate-limit and any 5xx are transient: the original PaymentIntent is
    // still live and payable, so the client must retry the SAME PI (→ 502)
    // rather than mint a replacement. A 429 reaching here is NOT auto-retried
    // by the SDK, so it must be classified here or it spawns a second live PI.
    if (typeof err.statusCode === 'number' && (err.statusCode === 429 || err.statusCode >= 500)) {
      return true
    }
  }
  return false
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

  // Authenticate — reject requests without a valid Supabase session.
  const auth = await requireAuth(req, res)
  if (!auth) return
  if (await applyRateLimit(res, 'critical', auth.userId)) return

  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    console.error('initiate-funding: STRIPE_SECRET_KEY is not set')
    res.status(500).json({ error: 'Server misconfiguration: Stripe secret key not configured.' })
    return
  }

  const { fundingRequestId, escrowPlanId, jobId } = req.body as {
    fundingRequestId: unknown
    escrowPlanId: unknown
    jobId: unknown
  }

  if (!fundingRequestId || typeof fundingRequestId !== 'string' || fundingRequestId.trim() === '') {
    res.status(400).json({ error: 'Validation error: fundingRequestId must be a non-empty string.' })
    return
  }
  if (!escrowPlanId || typeof escrowPlanId !== 'string' || escrowPlanId.trim() === '') {
    res.status(400).json({ error: 'Validation error: escrowPlanId must be a non-empty string.' })
    return
  }
  if (!jobId || typeof jobId !== 'string' || jobId.trim() === '') {
    res.status(400).json({ error: 'Validation error: jobId must be a non-empty string.' })
    return
  }

  const adminResult = getSupabaseAdminWithStatus()
  if (adminResult.ok === false) {
    logError('api.funding.admin_unavailable', undefined, {
      reason: 'supabase_admin_unavailable',
      missing: adminResult.missing,
    })
    res.status(500).json({
      error: `Server misconfiguration: ${formatAdminUnavailable(adminResult.missing)}`,
    })
    return
  }

  const supabase = adminResult.client

  try {
    // 1. Validate funding request exists and belongs to the authenticated customer
    const { data: fundingRequest, error: frError } = await supabase
      .from('funding_requests')
      .select('id, source_offer_id, job_id, escrow_plan_id, customer_user_id, provider_user_id, status, amount, currency, external_funding_ref, funding_idempotency_key, expires_at')
      .eq('id', fundingRequestId.trim())
      .maybeSingle()

    if (frError) {
      logError('api.funding.request_lookup_failed', frError, { fundingRequestId })
      res.status(500).json({ error: 'Failed to lookup funding request.' })
      return
    }

    if (!fundingRequest) {
      res.status(404).json({ error: 'Funding request not found.' })
      return
    }

    // Authorization: the caller must be the customer
    if (fundingRequest.customer_user_id !== auth.userId) {
      logWarning('api.funding.authorization_failed', {
        path: req.url,
        userId: auth.userId,
        reason: 'customer_user_id_mismatch',
      })
      res.status(403).json({ error: 'Forbidden: you are not the customer for this funding request.' })
      return
    }

    // ── Hard job-status terminal recheck ──────────────────────────────────────
    // A job can be cancelled (or completed) while its FundingRequest is still in
    // a pre-PaymentIntent state — cancel is only blocked once funds are CONFIRMED.
    // Without this gate a customer could still fund a dead order and park real
    // money in escrow. This MUST run before ANY Stripe PaymentIntent retrieve /
    // create or funding-request mutation below.
    const { data: jobRow, error: jobLookupError } = await supabase
      .from('jobs')
      .select('id, status')
      .eq('id', fundingRequest.job_id)
      .maybeSingle()

    if (jobLookupError) {
      logError('api.funding.job_status_lookup_failed', jobLookupError, {
        fundingRequestId,
        jobId: fundingRequest.job_id,
      })
      res.status(500).json({ error: 'Failed to lookup job status.' })
      return
    }

    if (jobRow && (jobRow.status === 'cancelled' || jobRow.status === 'completed')) {
      logWarning('api.funding.job_terminal', {
        fundingRequestId,
        jobId: fundingRequest.job_id,
        jobStatus: jobRow.status,
      })
      res.status(409).json({
        ok: false,
        error: 'JOB_NOT_FUNDABLE',
        message:
          'Dieser Auftrag wurde storniert oder abgeschlossen und kann nicht mehr finanziert werden.',
        errorCode: 'JOB_TERMINAL',
      })
      return
    }

    const amount = Number(fundingRequest.amount)
    const currency = (fundingRequest.currency ?? 'eur').toLowerCase()

    if (!SUPPORTED_CURRENCIES.has(currency)) {
      res.status(400).json({ error: `Unsupported currency: ${currency}` })
      return
    }

    const maxForCurrency = MAX_ESCROW_AMOUNTS[currency]
    if (maxForCurrency !== undefined && amount > maxForCurrency) {
      logWarning('api.funding.amount_exceeds_max', { amount, currency, fundingRequestId, jobId })
      res.status(400).json({
        error: `Validation error: amount exceeds maximum allowed escrow for ${currency.toUpperCase()} (${maxForCurrency}).`,
      })
      return
    }

    // Validate status: must be in a fundable state
    const fundableStatuses = new Set(['created', 'sent', 'funding_started', 'funding_failed'])
    if (!fundableStatuses.has(fundingRequest.status)) {
      // Already fully funded → explicit outcome, no clientSecret needed
      if (fundingRequest.status === 'funded') {
        logInfo('api.funding.already_funded', {
          fundingRequestId,
          lifecyclePath: 'already-funded',
          outcome: 'PAYMENT_ALREADY_FUNDED' as InitiateFundingOutcome,
        })
        res.status(200).json({
          ok: true,
          outcome: 'PAYMENT_ALREADY_FUNDED' as InitiateFundingOutcome,
          message: 'Funding already completed.',
          paymentIntentId: fundingRequest.external_funding_ref ?? null,
          clientSecret: null,
        })
        return
      }

      // funding_initiated — intent exists; try to retrieve usable clientSecret
      if (fundingRequest.status === 'funding_initiated' && fundingRequest.external_funding_ref) {
        const stripe = getStripe(secretKey)
        try {
          const existingIntent = await stripe.paymentIntents.retrieve(
            fundingRequest.external_funding_ref,
          )
          if (existingIntent.client_secret && existingIntent.status !== 'canceled' && existingIntent.status !== 'succeeded') {
            logInfo('api.funding.resumed_initiated', {
              fundingRequestId,
              paymentIntentId: existingIntent.id,
              lifecyclePath: 'resume-initiated',
              intentStatus: existingIntent.status,
              hasClientSecret: true,
              outcome: 'PAYMENT_FORM_READY' as InitiateFundingOutcome,
            })
            res.status(200).json({
              ok: true,
              outcome: 'PAYMENT_FORM_READY' as InitiateFundingOutcome,
              paymentIntentId: existingIntent.id,
              clientSecret: existingIntent.client_secret,
              status: 'funding_initiated',
            })
            return
          }
          if (existingIntent.status === 'succeeded') {
            logInfo('api.funding.intent_already_succeeded', {
              fundingRequestId,
              paymentIntentId: existingIntent.id,
              lifecyclePath: 'already-funded',
              outcome: 'PAYMENT_ALREADY_FUNDED' as InitiateFundingOutcome,
            })
            res.status(200).json({
              ok: true,
              outcome: 'PAYMENT_ALREADY_FUNDED' as InitiateFundingOutcome,
              message: 'Payment already succeeded.',
              paymentIntentId: existingIntent.id,
              clientSecret: null,
            })
            return
          }
          // canceled or no client_secret → fall through to create replacement
        } catch {
          logWarning('api.funding.retrieve_initiated_failed', {
            fundingRequestId,
            externalRef: fundingRequest.external_funding_ref,
          })
          // NOTE: this catch is intentionally NOT transient-guarded. Double-
          // charge safety for the funding_initiated-resume path is enforced by
          // the second, transient-guarded retrieve below (isTransientStripeError
          // → 502), which this fall-through always re-enters. Do not remove that
          // second retrieve without porting the transient guard here.
          // Fall through to create replacement
        }
        // Fall through: the funding_initiated intent is stale/canceled → will create replacement below
      } else if (fundingRequest.status === 'funding_initiated') {
        // funding_initiated but no external ref → treat as needing new intent
        // Fall through to creation below
      } else if (fundingRequest.status === 'expired') {
        // Cron already expired this row — return the canonical expiry outcome.
        logWarning('api.funding.already_expired', { fundingRequestId: fundingRequestId.trim() })
        res.status(409).json({
          ok: false,
          outcome: 'FUNDING_REQUEST_EXPIRED' as InitiateFundingOutcome,
          error: 'This funding request has expired. Please contact your service provider.',
        })
        return
      } else {
        res.status(400).json({ error: `Funding request is in state '${fundingRequest.status}' and cannot be funded.` })
        return
      }
    }

    // ── Synchronous expiry gate ───────────────────────────────────────────────
    // The daily cron may be delayed or skipped. If expires_at has passed,
    // reject immediately and atomically mark the row expired so subsequent
    // calls get the correct status without waiting for the cron.
    // funding_initiated with a live PI returns early above and never reaches here.
    if (fundingRequest.expires_at != null && (fundingRequest.expires_at as number) <= Date.now()) {
      await supabase
        .from('funding_requests')
        .update({ status: 'expired', updated_at: new Date().toISOString() })
        .eq('id', fundingRequestId.trim())
        .in('status', ['created', 'sent', 'funding_started', 'funding_failed'])
      logWarning('api.funding.deadline_expired', {
        fundingRequestId: fundingRequestId.trim(),
        expiresAt: fundingRequest.expires_at,
        nowMs: Date.now(),
      })
      res.status(409).json({
        ok: false,
        outcome: 'FUNDING_REQUEST_EXPIRED' as InitiateFundingOutcome,
        error: 'This funding request has expired. Please contact your service provider.',
      })
      return
    }

    // Validate escrow plan linkage
    if (fundingRequest.escrow_plan_id !== escrowPlanId.trim()) {
      res.status(400).json({ error: 'Escrow plan ID does not match the funding request.' })
      return
    }
    if (fundingRequest.job_id !== jobId.trim()) {
      res.status(400).json({ error: 'Job ID does not match the funding request.' })
      return
    }

    // 2. Validate the escrow plan
    const { data: escrowPlan, error: epError } = await supabase
      .from('escrow_payment_plans')
      .select('id, status, total_amount, currency, provider_id, source_offer_id, platform_fee_rate')
      .eq('id', escrowPlanId.trim())
      .maybeSingle()

    if (epError) {
      logError('api.funding.escrow_plan_lookup_failed', epError, { escrowPlanId })
      res.status(500).json({ error: 'Failed to lookup escrow plan.' })
      return
    }

    if (!escrowPlan) {
      res.status(404).json({ error: 'Escrow plan not found.' })
      return
    }

    // Validate escrow plan is in a fundable state
    const fundablePlanStatuses = new Set(['awaiting_customer_funding', 'funding_failed'])
    if (!fundablePlanStatuses.has(escrowPlan.status) && escrowPlan.status !== 'funding_initiated') {
      if (escrowPlan.status === 'funded_in_escrow') {
        logInfo('api.funding.escrow_already_funded', {
          fundingRequestId,
          escrowPlanId,
          lifecyclePath: 'already-funded',
          outcome: 'PAYMENT_ALREADY_FUNDED' as InitiateFundingOutcome,
        })
        res.status(200).json({
          ok: true,
          outcome: 'PAYMENT_ALREADY_FUNDED' as InitiateFundingOutcome,
          message: 'Escrow is already funded.',
          paymentIntentId: fundingRequest.external_funding_ref ?? null,
          clientSecret: null,
        })
        return
      }
      res.status(400).json({ error: `Escrow plan is in state '${escrowPlan.status}' and cannot be funded.` })
      return
    }

    // ── Attribution gate ─────────────────────────────────────────────────────
    // Shared contract across all money-moving surfaces (create-escrow,
    // initiate-funding, initiate-supplementary-funding, release-tranche,
    // release-supplementary-payout).  See `_attributionGuard`.
    const gate = await assertAttributionFinalized(supabase, jobId.trim(), 'api.funding')
    if (gate.ok === false) {
      const mapped = attributionGateToHttpResponse(gate)
      res.status(mapped.status).json(mapped.body)
      return
    }
    const effectiveOrigin = gate.commercialOrigin
    // ── End attribution gate ─────────────────────────────────────────────────

    const { rate: platformFeeRate } = resolveCommercialFeeRate(effectiveOrigin)

    // 3. Check if we already have a PaymentIntent (idempotency / resume)
    let isReplacement = false
    if (fundingRequest.external_funding_ref) {
      // A PaymentIntent was already created — retrieve and validate it
      const stripe = getStripe(secretKey)
      try {
        const existingIntent = await stripe.paymentIntents.retrieve(
          fundingRequest.external_funding_ref,
        )

        if (existingIntent.status === 'succeeded') {
          // Intent already succeeded → treat as already funded
          logInfo('api.funding.intent_succeeded_on_reuse', {
            fundingRequestId,
            paymentIntentId: existingIntent.id,
            lifecyclePath: 'already-funded',
            outcome: 'PAYMENT_ALREADY_FUNDED' as InitiateFundingOutcome,
          })
          res.status(200).json({
            ok: true,
            outcome: 'PAYMENT_ALREADY_FUNDED' as InitiateFundingOutcome,
            message: 'Payment already succeeded.',
            paymentIntentId: existingIntent.id,
            clientSecret: null,
          })
          return
        }

        if (existingIntent.status !== 'canceled' && existingIntent.client_secret) {
          // Intent is still usable with a valid client_secret
          logInfo('api.funding.resumed_existing', {
            paymentIntentId: existingIntent.id,
            fundingRequestId,
            intentStatus: existingIntent.status,
            lifecyclePath: 'reuse',
            hasClientSecret: true,
            outcome: 'PAYMENT_FORM_READY' as InitiateFundingOutcome,
          })
          res.status(200).json({
            ok: true,
            outcome: 'PAYMENT_FORM_READY' as InitiateFundingOutcome,
            paymentIntentId: existingIntent.id,
            clientSecret: existingIntent.client_secret,
            status: 'funding_initiated',
          })
          return
        }

        // Intent is canceled or has no client_secret → create replacement
        logInfo('api.funding.stale_intent_replaced', {
          fundingRequestId,
          oldIntentId: existingIntent.id,
          oldStatus: existingIntent.status,
          lifecyclePath: 'replace',
        })
        isReplacement = true
        // Fall through to create a new PaymentIntent
      } catch (retrieveErr: unknown) {
        // FIX 4 (P1 #327): a transient retrieve failure (network / Stripe 5xx)
        // does NOT mean the existing PaymentIntent is gone. Treating it as a
        // replacement would mint a SECOND live PI while the original remains
        // payable with its already-delivered clientSecret → double charge.
        // Return 502 so the client retries against the SAME PI.
        if (isTransientStripeError(retrieveErr)) {
          logError(
            'api.funding.retrieve_existing_transient',
            retrieveErr instanceof Error ? retrieveErr : undefined,
            {
              fundingRequestId,
              externalRef: fundingRequest.external_funding_ref,
              lifecyclePath: 'retry',
              outcome: 'PAYMENT_INIT_FAILED' as InitiateFundingOutcome,
            },
          )
          res.status(502).json({
            ok: false,
            outcome: 'PAYMENT_INIT_FAILED' as InitiateFundingOutcome,
            message:
              'Zahlungsdienst vorübergehend nicht erreichbar. Bitte versuche es erneut.',
            errorCode: 'STRIPE_RETRIEVE_TRANSIENT',
          })
          return
        }
        // Genuine missing/terminal intent (e.g. resource_missing) → replace.
        logWarning('api.funding.retrieve_existing_failed', {
          fundingRequestId,
          externalRef: fundingRequest.external_funding_ref,
          lifecyclePath: 'replace',
        })
        isReplacement = true
        // Fall through to create a new PaymentIntent
      }
    }

    // ── Hard gate: provider payout readiness ────────────────────────────────────
    // The provider MUST have a fully ready Stripe Connect account before any
    // PaymentIntent is created. Funds are collected on the platform account and
    // transferred to the provider per-tranche via api/release-tranche.ts.
    // Without this gate, the provider would be unable to receive those transfers.
    const { data: payoutAccount, error: payoutLookupError } = await supabase
      .from('provider_payout_accounts')
      .select('stripe_connect_account_id, onboarding_status, charges_enabled, payouts_enabled')
      .eq('provider_user_id', fundingRequest.provider_user_id)
      .maybeSingle()

    if (payoutLookupError) {
      logError('api.funding.payout_account_lookup_failed', payoutLookupError, {
        fundingRequestId,
        providerUserId: fundingRequest.provider_user_id,
      })
      res.status(500).json({ error: 'Failed to lookup provider payout account.' })
      return
    }

    if (!payoutAccount || !payoutAccount.stripe_connect_account_id) {
      logWarning('api.funding.provider_payout_not_setup', {
        fundingRequestId,
        providerUserId: fundingRequest.provider_user_id,
        reason: 'no_stripe_account',
      })
      res.status(400).json({
        ok: false,
        outcome: 'PAYMENT_INIT_FAILED' as InitiateFundingOutcome,
        error: 'PROVIDER_PAYOUT_NOT_READY',
        message: 'Der Handwerker hat noch kein Auszahlungskonto eingerichtet. Bitte warte auf die Einrichtung.',
        blockingReason: 'no_stripe_account',
      })
      return
    }

    if (!payoutAccount.charges_enabled) {
      logWarning('api.funding.provider_charges_not_enabled', {
        fundingRequestId,
        providerUserId: fundingRequest.provider_user_id,
        onboardingStatus: payoutAccount.onboarding_status,
        reason: 'charges_disabled',
      })
      res.status(400).json({
        ok: false,
        outcome: 'PAYMENT_INIT_FAILED' as InitiateFundingOutcome,
        error: 'PROVIDER_PAYOUT_NOT_READY',
        message: 'Das Zahlungskonto des Handwerkers ist noch nicht für Zahlungen aktiviert. Bitte warte auf die Einrichtung.',
        blockingReason: 'charges_disabled',
      })
      return
    }

    if (!payoutAccount.payouts_enabled) {
      logWarning('api.funding.provider_payouts_not_enabled', {
        fundingRequestId,
        providerUserId: fundingRequest.provider_user_id,
        onboardingStatus: payoutAccount.onboarding_status,
        reason: 'payouts_disabled',
      })
      res.status(400).json({
        ok: false,
        outcome: 'PAYMENT_INIT_FAILED' as InitiateFundingOutcome,
        error: 'PROVIDER_PAYOUT_NOT_READY',
        message: 'Das Zahlungskonto des Handwerkers ist noch nicht für Auszahlungen aktiviert. Bitte warte auf die Einrichtung.',
        blockingReason: 'payouts_disabled',
      })
      return
    }
    // ── End provider payout readiness gate ──────────────────────────────────────

    // 4. Create the Stripe PaymentIntent (first-time or replacement)
    const stripe = getStripe(secretKey)
    // Idempotency key: stable per funding request for first-time creation so that
    // concurrent requests don't create duplicate PIs. For replacements (stale/canceled
    // intent) a timestamp suffix forces a fresh PI.
    const replacementMinute = Math.floor(Date.now() / 60_000)
    const idempotencyKey = isReplacement
      ? `funding_${fundingRequestId.trim()}_r${replacementMinute}`
      : `funding_${fundingRequestId.trim()}`

    const platformFeeAmount = Math.round(amount * platformFeeRate * 100) / 100

    // ── P2 funding charge model (flag-gated: FUNDING_DESTINATION_CHARGE_ENABLED) ──
    // DEFAULT (flag OFF): Separate Charges and Transfers.
    //   Funds are collected on the SaFix platform account (automatic capture).
    //   The webhook confirms funding via payment_intent.succeeded →
    //   reconcileFundingConfirmation. Per-tranche Stripe Transfers are created when
    //   the customer releases funds (api/release-tranche.ts), NOT here at funding time.
    //
    // FLAG ON (FUNDING_DESTINATION_CHARGE_ENABLED === 'true'): Destination Charge.
    //   The funding PI routes the money straight to the provider's connected account
    //   (transfer_data.destination, guaranteed present/charges_enabled/payouts_enabled
    //   by the readiness gate above) minus application_fee_amount equal to the SAME
    //   platformFeeAmount snapshot persisted below — so funding-time fee accounting
    //   stays internally consistent (no double-count AT FUNDING). This is the proven
    //   template from api/initiate-diagnosis-payment.ts.
    //
    // ⚠ HARD RULE — the flag MUST stay OFF until P3 (release = stripe payouts.create
    //   on the connected account) is built AND the ZAG legal gutachten signs off.
    //   With the flag ON the funding money lands on the PROVIDER's connected account,
    //   leaving the platform balance empty; api/release-tranche.ts still does
    //   stripe.transfers.create FROM the platform balance (separate-charges model),
    //   so release would break — and it would also deduct the platform fee a SECOND
    //   time (netTransferAmount already nets the fee). Do NOT flip this flag before
    //   P3 (payouts.create) + refund-escrow reverse_transfer exist.
    //
    // Keep automatic capture (do NOT set capture_method to manual — manual capture
    // caused a critical bug where the PI sat in requires_capture and expired after 7
    // days; the new model delays at PAYOUT level, not capture). Do NOT add
    // on_behalf_of or request card_payments here — lawyer-gated, out of scope for P2.
    //
    // Read the flag at call time (not a module-level const) so tests can flip the env
    // between cases. Strict `=== 'true'` ⇒ unset / '' / 'false' / '1' all mean OFF.
    const destinationChargeEnabled =
      process.env.FUNDING_DESTINATION_CHARGE_ENABLED === 'true'

    const intentParams: Stripe.PaymentIntentCreateParams = {
      amount: toSmallestUnit(amount, currency),
      currency,
      // FIX 3b (P1 #321): pin card-only. There is NO redirect-return handler for
      // this flow, so redirect-based LPMs (Klarna/EPS/…) must not surface in the
      // PaymentElement and strand the customer mid-redirect. Do NOT add
      // automatic_payment_methods here — that would re-enable redirect LPMs.
      payment_method_types: ['card'],
      metadata: {
        fundingRequestId: fundingRequestId.trim(),
        escrowPlanId: escrowPlanId.trim(),
        jobId: jobId.trim(),
        customerUserId: auth.userId,
        providerUserId: fundingRequest.provider_user_id,
        sourceOfferId: fundingRequest.source_offer_id,
        type: 'escrow_funding',
        platformFeeRate: String(platformFeeRate),
        platformFeeAmount: String(platformFeeAmount),
        commercialOrigin: effectiveOrigin,
      },
      // P2 (flag-gated, see HARD RULE above): when enabled, convert the funding PI
      // into a Destination Charge with an application fee. These are TOP-LEVEL
      // siblings of `metadata` (not inside it). With the flag OFF this spread
      // contributes nothing, so intentParams is BYTE-IDENTICAL to the
      // separate-charges model — the safety contract for shipping dormant.
      ...(destinationChargeEnabled
        ? {
            application_fee_amount: toSmallestUnit(platformFeeAmount, currency),
            transfer_data: { destination: payoutAccount.stripe_connect_account_id },
          }
        : {}),
    }

    // FIX 4 (P1 #327): before minting a replacement PI, best-effort cancel the
    // stale/old one so it can no longer be paid. Without this the old PI's
    // already-delivered clientSecret stays live alongside the new PI → two
    // payable intents → potential double charge.
    if (isReplacement && fundingRequest.external_funding_ref) {
      try {
        await stripe.paymentIntents.cancel(fundingRequest.external_funding_ref)
        logInfo('api.funding.old_intent_canceled', {
          fundingRequestId,
          oldIntentId: fundingRequest.external_funding_ref,
          lifecyclePath: 'replace',
        })
      } catch (cancelErr: unknown) {
        // Idempotent best-effort: the old PI may already be canceled/succeeded
        // or otherwise in a non-cancelable state. Log and proceed.
        logWarning('api.funding.old_intent_cancel_failed', {
          fundingRequestId,
          oldIntentId: fundingRequest.external_funding_ref,
          reason: cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
        })
      }
    }

    const paymentIntent = await stripe.paymentIntents.create(intentParams, {
      idempotencyKey,
    })

    // Guard: PaymentIntent must have a client_secret
    if (!paymentIntent.client_secret) {
      logError('api.funding.missing_client_secret_on_create', undefined, {
        fundingRequestId,
        paymentIntentId: paymentIntent.id,
        lifecyclePath: isReplacement ? 'replace' : 'create',
        outcome: 'PAYMENT_INIT_FAILED' as InitiateFundingOutcome,
      })
      res.status(500).json({
        ok: false,
        outcome: 'PAYMENT_INIT_FAILED' as InitiateFundingOutcome,
        message: 'PaymentIntent created but client_secret was not returned by Stripe.',
        errorCode: 'STRIPE_NO_CLIENT_SECRET',
      })
      return
    }

    // 5. Persist the external reference back to the funding request + escrow plan
    const now = new Date().toISOString()

    await supabase
      .from('funding_requests')
      .update({
        status: 'funding_initiated',
        external_funding_ref: paymentIntent.id,
        funding_idempotency_key: idempotencyKey,
        updated_at: now,
      })
      .eq('id', fundingRequestId.trim())

    await supabase
      .from('escrow_payment_plans')
      .update({
        status: 'funding_initiated',
        external_funding_ref: paymentIntent.id,
        funding_idempotency_key: idempotencyKey,
        funding_initiated_at: now,
        updated_at: now,
        // Store fee snapshot for Supabase-side auditability, independent of Stripe PI metadata.
        // Only written on first creation; not overwritten on replacement to preserve the
        // original contractual rate.
        ...(escrowPlan.platform_fee_rate == null && {
          platform_fee_rate: platformFeeRate,
          platform_fee_amount: platformFeeAmount,
          commercial_origin: effectiveOrigin,
        }),
      })
      .eq('id', escrowPlanId.trim())

    const outcome: InitiateFundingOutcome = isReplacement
      ? 'PAYMENT_RETRY_READY'
      : 'PAYMENT_FORM_READY'

    logInfo('api.funding.initiated', {
      paymentIntentId: paymentIntent.id,
      fundingRequestId: fundingRequestId.trim(),
      escrowPlanId: escrowPlanId.trim(),
      jobId: jobId.trim(),
      amount,
      currency,
      platformFeeRate,
      commercialOrigin: effectiveOrigin,
      lifecyclePath: isReplacement ? 'replace' : 'create',
      hasClientSecret: true,
      outcome,
    })

    res.status(200).json({
      ok: true,
      outcome,
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      status: 'funding_initiated',
    })
  } catch (err: unknown) {
    if (err instanceof Stripe.errors.StripeError) {
      console.error(`initiate-funding: Stripe error [${err.type}] ${err.message}`)
      logError('api.funding.stripe_error', err, {
        fundingRequestId,
        errorType: err.type,
        lifecyclePath: 'fail',
        outcome: 'PAYMENT_INIT_FAILED' as InitiateFundingOutcome,
      })
      res.status(502).json({
        ok: false,
        outcome: 'PAYMENT_INIT_FAILED' as InitiateFundingOutcome,
        message: `Stripe error (${err.type}): ${err.message}`,
        errorCode: `STRIPE_${err.type?.toUpperCase() ?? 'UNKNOWN'}`,
      })
    } else {
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`initiate-funding: unexpected error: ${detail}`)
      logError('api.funding.unexpected_error', err instanceof Error ? err : undefined, {
        fundingRequestId,
        lifecyclePath: 'fail',
        outcome: 'PAYMENT_INIT_FAILED' as InitiateFundingOutcome,
      })
      res.status(500).json({
        ok: false,
        outcome: 'PAYMENT_INIT_FAILED' as InitiateFundingOutcome,
        message: `Unexpected server error: ${detail}`,
        errorCode: 'UNEXPECTED_ERROR',
      })
    }
  }
}
