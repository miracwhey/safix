import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { SupabaseClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { applyCors } from './_cors.js'
import { toSmallestUnit } from './_shared.js'
import { requireAuth } from './_auth.js'
import { loadPaymentContext, fetchIsOperator, canRefundEscrowForPayment } from './_paymentAuth.js'
import { evaluateConsensusSplitParty } from './_consensusSplitAuth.js'
import { getSupabaseAdmin } from './_supabase.js'
import { logInfo, logWarning } from './_observability.js'
import { applyRateLimit } from './_rateLimit.js'
import { executeEscrowRefundForIntent } from './_escrowRefundService.js'

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

// ── Refund guard: block if any tranche has moved (or is moving) money ────────
//
// V1 policy: a refund-escrow request must not reach Stripe if the linked
// escrow already has a tranche released, a Stripe Transfer on record, or any
// state outside the known refund-safe set. Partial refunds are not a general
// feature in V1 — the single supported exception is a server-validated dispute
// split settlement, where the dispute has been resolved as 'split' and the
// requested amount stays within the customer share computed from the
// escrow plan's total_amount and the dispute's split_ratio.
//
// Canonical status enums live in src/lib/payments/escrow/escrowTypes.ts.

const REFUND_BLOCKING_TRANCHE_STATUSES = new Set<string>([
  'released',
  'release_pending',
])

const REFUND_SAFE_TRANCHE_STATUSES = new Set<string>([
  'pending_funding',
  'funded',
  'locked',
  'eligible_for_release',
  'blocked',
  'disputed',
  'refunded',
  'cancelled',
])

// ── C6: payment-status whitelist for non-operator refunds ────────────────────
//
// A customer may only trigger a refund while funds are provably still fully
// held and no work state has begun. Everything else is operator-only:
//   - work_in_progress / release_pending / disputed → money is working or moving
//   - diagnosis_payment_pending / diagnosis_payment_completed → operator-only by decision
//   - legacy prod statuses ('pending', 'authorized', 'captured', …) and null → fail-closed
//
// Deliberately NOT implemented via !canTransition(status, 'refunded'): the
// client FSM (src/lib/payments/stateMachine.ts) also allows
// release_pending → refunded and disputed → refunded, which must stay
// operator-only on the server.
const NON_OPERATOR_REFUNDABLE_PAYMENT_STATUSES = new Set<string>([
  'deposit_paid',
  'in_escrow',
])

// Strict equality in the smallest currency unit (after toSmallestUnit rounding)
// is the canonical comparator for dispute-split refunds. This eliminates both
// float drift and the off-by-one-cent over-refund that a major-unit tolerance
// would allow.

type TrancheGuardRow = {
  id: string
  status: string | null
  external_release_ref: string | null
  transfer_reversal_ref: string | null
  external_payout_ref: string | null
}

type RefundGuardBlockReason =
  | 'tranche_released'
  | 'tranche_release_pending'
  | 'transfer_created'
  | 'payout_created'
  | 'transfer_reversed'
  | 'tranche_status_unknown'
  | 'guard_lookup_failed'

/**
 * Block reasons that may be bypassed by a server-validated dispute split
 * settlement. Only reasons that positively prove a prior tranche release are
 * listed — reconciliation states (transfer_reversed), schema drift
 * (tranche_status_unknown), and lookup failures (guard_lookup_failed) stay
 * operator-only.
 *
 * Symmetry with release-tranche: api/release-tranche.ts caps each remaining
 * tranche's transfer to providerTargetGross − alreadyReleasedProviderGross,
 * so on a post-release split the provider never receives more than
 * total × splitRatio. This endpoint refunds the customer share
 * (total × (1 − splitRatio)) in exact smallest units. Together the two sides
 * converge on the correct split settlement even when the deposit tranche has
 * already been paid out.
 */
const BYPASSABLE_BLOCK_REASONS: ReadonlySet<RefundGuardBlockReason> = new Set<RefundGuardBlockReason>([
  'tranche_released',
  'tranche_release_pending',
  'transfer_created',
  'payout_created',
])

type RefundGuardBlock = {
  code: 'REFUND_BLOCKED_RELEASED_TRANCHE'
  trancheId: string
  trancheStatus: string | null
  reason: RefundGuardBlockReason
}

type DisputeBypassDenyReason =
  | 'no_dispute_id'
  | 'dispute_not_found'
  | 'dispute_wrong_job'
  | 'dispute_wrong_payment'
  | 'dispute_not_resolved_split'
  | 'dispute_split_ratio_missing'
  | 'dispute_already_settled'
  | 'amount_missing'
  | 'plan_total_missing'
  | 'plan_currency_missing'
  | 'amount_mismatches_customer_share'
  | 'bypass_lookup_failed'
  | 'bypass_not_applicable'
  | 'bypass_operator_only'

type DisputeBypassResult =
  | {
      allowed: true
      disputeId: string
      splitRatio: number
      customerShareMinor: number
      requestedMinor: number
    }
  | {
      allowed: false
      reason: DisputeBypassDenyReason
    }

function inspectTrancheForRefundGuard(
  tranche: TrancheGuardRow,
): RefundGuardBlock | null {
  const status = tranche.status

  // transfer_reversal_ref is populated alongside external_release_ref when a
  // transfer is reversed (both refs stay on the row). Check reversal FIRST so
  // the row is classified as reconciliation state rather than a plain
  // transfer_created — the two need different operator handling.
  if (tranche.transfer_reversal_ref !== null && tranche.transfer_reversal_ref !== '') {
    return {
      code: 'REFUND_BLOCKED_RELEASED_TRANCHE',
      trancheId: tranche.id,
      trancheStatus: status,
      reason: 'transfer_reversed',
    }
  }

  if (status !== null && REFUND_BLOCKING_TRANCHE_STATUSES.has(status)) {
    return {
      code: 'REFUND_BLOCKED_RELEASED_TRANCHE',
      trancheId: tranche.id,
      trancheStatus: status,
      reason: status === 'released' ? 'tranche_released' : 'tranche_release_pending',
    }
  }

  // A Stripe Transfer was created; even if the DB status lags (split-brain
  // after a release succeeded on Stripe but the DB write failed), money has
  // moved or is about to reach the provider. Refund must not overlap.
  if (tranche.external_release_ref !== null && tranche.external_release_ref !== '') {
    return {
      code: 'REFUND_BLOCKED_RELEASED_TRANCHE',
      trancheId: tranche.id,
      trancheStatus: status,
      reason: 'transfer_created',
    }
  }

  // A Stripe Payout was created (payouts.create succeeded) even if the DB status
  // write lagged (post-payout split-brain: tranche still eligible_for_release but
  // external_payout_ref set). Funds are en route to the provider's bank — a refund
  // must not race an in-flight payout, and reverse_transfer can never overlap it.
  // Like transfer_created this positively proves a release happened, so it is
  // bypassable by an operator dispute-split settlement (which reverses the transfer
  // behind the payout). Flag-OFF this ref is always NULL → block is dormant.
  if (tranche.external_payout_ref !== null && tranche.external_payout_ref !== '') {
    return {
      code: 'REFUND_BLOCKED_RELEASED_TRANCHE',
      trancheId: tranche.id,
      trancheStatus: status,
      reason: 'payout_created',
    }
  }

  // Unknown / unrecognised status: fail-closed so schema drift cannot silently
  // open an unsafe refund path.
  if (status === null || !REFUND_SAFE_TRANCHE_STATUSES.has(status)) {
    return {
      code: 'REFUND_BLOCKED_RELEASED_TRANCHE',
      trancheId: tranche.id,
      trancheStatus: status,
      reason: 'tranche_status_unknown',
    }
  }

  return null
}

type RefundGuardState = {
  block: RefundGuardBlock | null
  planTotalAmount: number | null
  planCurrency: string | null
}

async function loadRefundGuardState(
  admin: SupabaseClient,
  jobId: string,
  paymentIntentId: string,
): Promise<RefundGuardState> {
  const { data: planRow, error: planError } = await admin
    .from('escrow_payment_plans')
    .select('id, total_amount, currency')
    .eq('job_id', jobId)
    .maybeSingle()

  if (planError) {
    logWarning('api.refund.guard_lookup_failed', {
      route: 'refund-escrow',
      paymentIntentId,
      jobId,
      stage: 'load_plan',
      detail: planError.message,
    })
    return {
      block: {
        code: 'REFUND_BLOCKED_RELEASED_TRANCHE',
        trancheId: '',
        trancheStatus: null,
        reason: 'guard_lookup_failed',
      },
      planTotalAmount: null,
      planCurrency: null,
    }
  }

  if (!planRow) return { block: null, planTotalAmount: null, planCurrency: null }

  const plan = planRow as {
    id: string
    total_amount: number | string | null
    currency: string | null
  }
  const planId = plan.id
  const planTotalAmount =
    plan.total_amount === null || plan.total_amount === undefined
      ? null
      : Number(plan.total_amount)
  const planCurrency =
    typeof plan.currency === 'string' && plan.currency.trim() !== ''
      ? plan.currency.trim()
      : null

  const { data: trancheRows, error: trancheError } = await admin
    .from('escrow_tranches')
    .select('id, status, external_release_ref, transfer_reversal_ref, external_payout_ref')
    .eq('plan_id', planId)

  if (trancheError) {
    logWarning('api.refund.guard_lookup_failed', {
      route: 'refund-escrow',
      paymentIntentId,
      jobId,
      planId,
      stage: 'load_tranches',
      detail: trancheError.message,
    })
    return {
      block: {
        code: 'REFUND_BLOCKED_RELEASED_TRANCHE',
        trancheId: '',
        trancheStatus: null,
        reason: 'guard_lookup_failed',
      },
      planTotalAmount,
      planCurrency,
    }
  }

  const rows = (trancheRows ?? []) as TrancheGuardRow[]
  for (const row of rows) {
    const block = inspectTrancheForRefundGuard(row)
    if (block) return { block, planTotalAmount, planCurrency }
  }
  return { block: null, planTotalAmount, planCurrency }
}

// ── Dispute-split bypass ─────────────────────────────────────────────────────
//
// The only legitimate way to refund money to the customer after a tranche has
// already been released is a dispute resolution with decision='split'. The
// dispute row must:
//   1. exist in the DB (caller cannot fabricate the id),
//   2. belong to the same job (and payment, if that column is populated),
//   3. be in status='resolved' with decision='split', settlement_status
//      still 'pending', and a non-null split_ratio,
//   4. the caller must supply an explicit amount that — after conversion to
//      the currency's smallest unit — matches the server-computed customer
//      share exactly (total × (1 − split_ratio), rounded via toSmallestUnit).
//
// All of these facts come from DB rows the server owns; the client cannot lie
// their way through the bypass. Any partial-of-partial refund, replay, or
// tolerance-abuse is rejected.

async function evaluateDisputeSplitBypass(
  admin: SupabaseClient,
  jobId: string,
  paymentId: string,
  disputeId: string | null,
  requestedAmount: number | undefined,
  planTotalAmount: number | null,
  planCurrency: string | null,
): Promise<DisputeBypassResult> {
  if (!disputeId || disputeId.trim() === '') {
    return { allowed: false, reason: 'no_dispute_id' }
  }

  if (typeof requestedAmount !== 'number' || !Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    // A split bypass cannot fall back to a full refund — an explicit amount is
    // required so the server can match it against the customer share.
    return { allowed: false, reason: 'amount_missing' }
  }

  if (planTotalAmount === null || planTotalAmount <= 0) {
    return { allowed: false, reason: 'plan_total_missing' }
  }

  if (planCurrency === null || planCurrency === '') {
    return { allowed: false, reason: 'plan_currency_missing' }
  }

  const { data: disputeRow, error: disputeError } = await admin
    .from('disputes')
    .select('id, job_id, payment_id, status, decision, split_ratio, settlement_status')
    .eq('id', disputeId.trim())
    .maybeSingle()

  if (disputeError) {
    logWarning('api.refund.bypass_lookup_failed', {
      route: 'refund-escrow',
      jobId,
      paymentId,
      disputeId: disputeId.trim(),
      detail: disputeError.message,
    })
    return { allowed: false, reason: 'bypass_lookup_failed' }
  }

  if (!disputeRow) {
    return { allowed: false, reason: 'dispute_not_found' }
  }

  const dispute = disputeRow as {
    id: string
    job_id: string | null
    payment_id: string | null
    status: string | null
    decision: string | null
    split_ratio: number | string | null
    settlement_status: string | null
  }

  if (dispute.job_id !== jobId) {
    return { allowed: false, reason: 'dispute_wrong_job' }
  }

  // payment_id is nullable on legacy dispute rows; only enforce linkage when
  // it is populated. The job-id check above already binds the dispute to the
  // correct job.
  if (dispute.payment_id !== null && dispute.payment_id !== '' && dispute.payment_id !== paymentId) {
    return { allowed: false, reason: 'dispute_wrong_payment' }
  }

  if (dispute.status !== 'resolved' || dispute.decision !== 'split') {
    return { allowed: false, reason: 'dispute_not_resolved_split' }
  }

  // settlement_status is 'pending' from the moment the split is persisted
  // until the customer share has been refunded and settleDispute() runs.
  // Rejecting anything other than 'pending' prevents replay of an already
  // settled split (Stripe idempotency key changes with amount, so a second
  // call with a smaller amount would otherwise issue a real extra refund).
  if (dispute.settlement_status !== 'pending') {
    return { allowed: false, reason: 'dispute_already_settled' }
  }

  const splitRatio =
    dispute.split_ratio === null || dispute.split_ratio === undefined
      ? null
      : Number(dispute.split_ratio)

  // (0,1) EXCLUSIVE — consistent with operator_resolve_dispute_split, the
  // consensus proposal RPC, the disputes_split_ratio_exclusive_chk DB constraint,
  // and the release-tranche guard. 0 % = refund, 100 % = release — neither is a
  // split, and the inclusive bound was the residual sibling of the ratio=0 double-pay.
  if (splitRatio === null || !Number.isFinite(splitRatio) || splitRatio <= 0 || splitRatio >= 1) {
    return { allowed: false, reason: 'dispute_split_ratio_missing' }
  }

  // Compare in the smallest currency unit so that rounding drift in the
  // major-unit representation cannot leak an extra cent into the refund.
  // toSmallestUnit() applies Math.round per currency class, so both sides
  // end up as integer minor units and equality is exact.
  const customerShareMinor = toSmallestUnit(planTotalAmount * (1 - splitRatio), planCurrency)
  const requestedMinor = toSmallestUnit(requestedAmount, planCurrency)

  if (requestedMinor !== customerShareMinor) {
    return { allowed: false, reason: 'amount_mismatches_customer_share' }
  }

  return {
    allowed: true,
    disputeId: dispute.id,
    splitRatio,
    customerShareMinor,
    requestedMinor,
  }
}

// ── P4A: consensus-confirmed-party refund authorization ──────────────────────
//
// The operator dispute-split bypass above is an operator-only post-release money
// action. P4A opens a SEPARATE, PRE-release-only path: a NON-operator dispute
// PARTY (the customer OR the craftsman) who reached a genuine two-party consensus
// split may drive the customer-share refund leg themselves. The authorization now
// lives in api/_consensusSplitAuth.ts (shared with capture-escrow); see that
// module for the full validation contract and the TRUE dormancy boundary
// (CONSENSUS_SPLIT_ENABLED server flag + REVOKEd RPCs + two-party DB-consensus
// proof — NOT the client VITE flag, which never gated the server).

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
    console.error('refund-escrow: STRIPE_SECRET_KEY is not set')
    res.status(500).json({ error: 'Server misconfiguration: Stripe secret key not configured.' })
    return
  }

  const { paymentIntentId, amount, disputeId } = (req.body ?? {}) as {
    paymentIntentId: unknown
    amount: unknown
    disputeId: unknown
  }

  if (!paymentIntentId || typeof paymentIntentId !== 'string' || paymentIntentId.trim() === '') {
    res.status(400).json({ error: 'Validation error: paymentIntentId must be a non-empty string.' })
    return
  }

  if (amount !== undefined && (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0)) {
    res.status(400).json({ error: 'Validation error: amount must be a positive finite number when provided.' })
    return
  }

  // Authorization: verify the authenticated caller is the customer who owns
  // this payment, or an operator, before executing any Stripe operation.
  const admin = getSupabaseAdmin()
  if (!admin) {
    logWarning('api.payment.context_missing', {
      route: 'refund-escrow',
      paymentIntentId: paymentIntentId.trim(),
      reason: 'supabase_admin_unavailable',
    })
    res.status(500).json({ error: 'Server misconfiguration: authorization service unavailable.' })
    return
  }

  const context = await loadPaymentContext(paymentIntentId.trim(), admin, 'refund-escrow')
  if (!context) {
    res.status(404).json({ error: 'Payment not found or context unavailable.' })
    return
  }

  const isOperator = await fetchIsOperator(auth.userId, admin)

  // Refund guard state (plan total/currency + any prior-release block) is loaded
  // up front because the P4A consensus-split party authorization below needs the
  // plan total + currency to compute the exact customer share BEFORE the canRefund
  // and C6 gates run. This is a pure read; the block itself is still acted on later.
  const guard = await loadRefundGuardState(admin, context.jobId, paymentIntentId.trim())

  // P4A consensus-split party authorization. Dormant unless the CONSENSUS_SPLIT_ENABLED
  // server flag is ON (checked inside the helper BEFORE any DB read) AND a two-party
  // 'accepted' dispute_split_proposals row exists (only confirm_split_proposal — a
  // REVOKEd RPC — can write one). When it grants, a non-operator dispute PARTY may
  // drive the customer-share refund leg PRE-release. requireAmountMatch=true: the
  // amount must equal the customer share in exact minor units.
  const consensusParty = await evaluateConsensusSplitParty(admin, {
    jobId: context.jobId,
    paymentId: context.paymentId,
    disputeId: typeof disputeId === 'string' ? disputeId : null,
    callerUid: auth.userId,
    requireAmountMatch: true,
    requestedAmount: typeof amount === 'number' ? amount : undefined,
    planTotalAmount: guard.planTotalAmount,
    planCurrency: guard.planCurrency,
    route: 'refund-escrow',
  })

  // canRefundEscrowForPayment still runs (preserving its authorization logging),
  // but a validated consensus party is allowed through the 403 it raises for a
  // craftsman caller. Flag-OFF, consensusParty.allowed is always false → identical.
  if (!canRefundEscrowForPayment(auth.userId, context, isOperator, 'refund-escrow') && !consensusParty.allowed) {
    res.status(403).json({ error: 'Forbidden: you are not authorized to refund this payment.' })
    return
  }

  // C6 server guard: non-operator callers may only refund while the payment is
  // in a fully-held pre-work state. Runs BEFORE the tranche guard — it needs no
  // extra DB reads (status comes from the payment context) and closes the
  // work_in_progress hole the tranche guard cannot see (tranches still
  // 'funded'/'locked' are refund-safe there). Operators skip this gate: dispute
  // refund/split settlement legitimately refunds from 'disputed'/'released'. A
  // validated P4A consensus party also skips it — its dispute is by definition
  // resolved='split' (status 'disputed'/'resolved'), outside the pre-work whitelist.
  if (!isOperator && !consensusParty.allowed) {
    const paymentStatus = context.paymentStatus
    const isRefundableForCustomer =
      paymentStatus !== null && NON_OPERATOR_REFUNDABLE_PAYMENT_STATUSES.has(paymentStatus)
    if (!isRefundableForCustomer) {
      const reason =
        paymentStatus === null ? 'payment_status_missing' : 'payment_status_not_refundable'
      logWarning('api.refund.blocked_by_payment_status', {
        route: 'refund-escrow',
        paymentIntentId: paymentIntentId.trim(),
        paymentId: context.paymentId,
        jobId: context.jobId,
        paymentStatus,
        reason,
      })
      res.status(409).json({
        error: 'Refund blocked: payment is not in a refundable state for this caller.',
        code: 'REFUND_BLOCKED_PAYMENT_STATUS',
        message: 'Eine Rückerstattung ist in diesem Zahlungsstatus nicht möglich.',
        reason,
      })
      return
    }
  }

  if (consensusParty.allowed) {
    logInfo('api.refund.consensus_split_party_granted', {
      route: 'refund-escrow',
      paymentIntentId: paymentIntentId.trim(),
      paymentId: context.paymentId,
      jobId: context.jobId,
      disputeId: consensusParty.disputeId,
      splitRatio: consensusParty.splitRatio,
      customerShareMinor: consensusParty.customerShareMinor,
      requestedMinor: consensusParty.requestedMinor,
      callerRole: consensusParty.callerRole,
    })
  }

  // Tranche-release guard: fail-closed unless the request qualifies as a
  // server-validated dispute split settlement. The Stripe client is not
  // constructed until after the guard finishes. Bypass is only even attempted
  // for block reasons that positively prove a prior release — reconciliation
  // states, schema drift, and lookup failures are operator-only.
  //
  // A P4A consensus party reaches here too, but this block stays operator-only:
  // post-release, a non-operator consensus party is denied (bypass_operator_only)
  // — a party can never self-trigger a payout clawback. PRE-release (guard.block
  // null) the consensus party simply falls through to the Stripe refund below.
  //
  // Tracks whether an operator dispute-split bypass actually granted, so the
  // plan-currency assert below can guard the bypass path the same as the consensus
  // path (both validate the requested amount against the customer share computed in
  // planCurrency, while the Stripe refund converts in intent.currency).
  let disputeSplitBypassGranted = false
  if (guard.block) {
    const canAttemptBypass = BYPASSABLE_BLOCK_REASONS.has(guard.block.reason)
    // Split-settlement bypass is an operator-controlled money action. A
    // customer cannot trigger it themselves — even knowing a valid disputeId
    // and the exact customer-share amount — because the bypass would turn the
    // post-release Stripe refund into a self-service action. canRefundEscrowForPayment
    // allows both customers and operators; here we further restrict bypass to
    // operators only.
    const bypass: DisputeBypassResult = !canAttemptBypass
      ? { allowed: false, reason: 'bypass_not_applicable' }
      : !isOperator
        ? { allowed: false, reason: 'bypass_operator_only' }
        : await evaluateDisputeSplitBypass(
            admin,
            context.jobId,
            context.paymentId,
            typeof disputeId === 'string' ? disputeId : null,
            typeof amount === 'number' ? amount : undefined,
            guard.planTotalAmount,
            guard.planCurrency,
          )

    if (bypass.allowed === false) {
      logWarning('api.refund.blocked_by_tranche_state', {
        route: 'refund-escrow',
        paymentIntentId: paymentIntentId.trim(),
        paymentId: context.paymentId,
        jobId: context.jobId,
        trancheId: guard.block.trancheId,
        trancheStatus: guard.block.trancheStatus,
        reason: guard.block.reason,
        bypassDenyReason: bypass.reason,
      })
      res.status(409).json({
        error: 'Refund blocked: a tranche has already been released to the provider.',
        code: guard.block.code,
        message:
          'Eine Rückerstattung ist nicht mehr möglich, weil bereits ein Teilbetrag freigegeben wurde.',
        reason: guard.block.reason,
        bypassDenyReason: bypass.reason,
      })
      return
    }

    logInfo('api.refund.dispute_split_bypass_granted', {
      route: 'refund-escrow',
      paymentIntentId: paymentIntentId.trim(),
      paymentId: context.paymentId,
      jobId: context.jobId,
      disputeId: bypass.disputeId,
      splitRatio: bypass.splitRatio,
      customerShareMinor: bypass.customerShareMinor,
      requestedMinor: bypass.requestedMinor,
      trancheReason: guard.block.reason,
    })
    disputeSplitBypassGranted = true
  }

  const stripe = getStripe(secretKey)

  try {
    // Always retrieve the PaymentIntent first so we can:
    //   1. Check its status to decide whether to cancel or refund.
    //   2. Obtain the currency for partial-refund amount conversion.
    //
    // Stripe only allows stripe.refunds.create() against charges that have
    // already been captured (status: 'succeeded').  When the PaymentIntent
    // is still in 'requires_capture' (authorised but not yet captured — the
    // normal state while funds are in escrow), the correct operation is to
    // cancel the intent, which releases the authorisation hold immediately.
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId.trim())

    // P4 corridor refund flag (FUNDING_DESTINATION_CHARGE_ENABLED-gated, dormant
    // today). Read at call time (not a module-level const) so tests can flip the
    // env between cases; strict === 'true' ⇒ unset/''/'false' all mean OFF. Passed
    // into the shared refund service, which ADDITIONALLY requires the PI to be a
    // real destination charge (transfer_data.destination present) before emitting
    // any corridor params — so a post-flip refund of a pre-flip separate-charge PI
    // carries NO reverse_transfer and mixed pre/post-flip inventory self-handles.
    const destinationChargeEnabled = process.env.FUNDING_DESTINATION_CHARGE_ENABLED === 'true'

    // R2-LOW currency assert: the consensus party + operator bypass paths validated
    // the requested amount against the customer share computed in guard.planCurrency,
    // but the Stripe refund below converts `amount` in intent.currency. If those
    // currencies differ (e.g. EUR plan vs USD PI, or a 2-decimal vs 3-decimal class),
    // the minor-unit equality the authorization trusted is meaningless and could
    // over/under-refund. Require an exact case-insensitive currency match before the
    // refund executes. Only fires for amount-validated split paths — a plain customer
    // full refund never sets either flag, so its behaviour is unchanged.
    if (consensusParty.allowed || disputeSplitBypassGranted) {
      const planCurrencyLower =
        typeof guard.planCurrency === 'string' && guard.planCurrency.trim() !== ''
          ? guard.planCurrency.trim().toLowerCase()
          : null
      if (planCurrencyLower === null || planCurrencyLower !== intent.currency.toLowerCase()) {
        logWarning('api.refund.plan_currency_mismatch', {
          route: 'refund-escrow',
          paymentIntentId: paymentIntentId.trim(),
          paymentId: context.paymentId,
          jobId: context.jobId,
          planCurrency: guard.planCurrency,
          intentCurrency: intent.currency,
          path: consensusParty.allowed ? 'consensus_party' : 'operator_bypass',
        })
        res.status(409).json({
          error: 'Refund blocked: dispute plan currency does not match the payment currency.',
          code: 'REFUND_BLOCKED_PLAN_CURRENCY_MISMATCH',
          message:
            'Eine Rückerstattung ist nicht möglich, weil die Währung der Streit-Abrechnung von der Zahlungswährung abweicht.',
          reason: 'plan_currency_mismatch',
        })
        return
      }
    }

    // Hand the retrieved intent to the shared refund mechanic (reused verbatim by
    // the flag-gated T+80 dispute-default-cut cron). It owns: requires_capture →
    // cancel (idempotent on the payment_intent_unexpected_state race), canceled →
    // no-op, non-succeeded → warn, the corridor refundParams (reverse_transfer /
    // metadata.disputeId / amount conversion + MAX guard / refund_application_fee),
    // the stable idempotency key, and stripe.refunds.create. Real Stripe errors
    // propagate to the catch below so the Stripe-error mapping stays unchanged.
    const outcome = await executeEscrowRefundForIntent(stripe, intent, {
      amount: typeof amount === 'number' ? amount : undefined,
      disputeId: typeof disputeId === 'string' ? disputeId : null,
      destinationChargeEnabled,
    })

    if (outcome.ok === true) {
      res.status(200).json({ refunded: true })
    } else {
      res.status(outcome.httpStatus).json(outcome.body)
    }
  } catch (err: unknown) {
    if (err instanceof Stripe.errors.StripeError) {
      console.error(`refund-escrow: Stripe error [${err.type}] ${err.message}`)
      res.status(502).json({
        error: `Stripe error (${err.type}): ${err.message}`,
      })
    } else {
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`refund-escrow: unexpected error: ${detail}`)
      res.status(500).json({ error: `Unexpected server error: ${detail}` })
    }
  }
}
