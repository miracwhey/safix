import {
  getDisputeById,
  getDisputeByJobId,
  openDisputeAtomic,
  settleDispute,
} from '../disputes/disputesService'
import { getDisputeRepository } from '../disputes/repository'
import { canTransitionDispute, isTerminalDisputeStatus } from '../disputes/stateMachine'
import {
  emitDisputeEvidenceRequestedEvent,
  emitDisputeOpenedEvent,
  emitDisputeResolvedEvent,
  emitDisputeResolvedWithDecision,
  emitDisputeUnderReviewEvent,
} from '../disputes/disputeTimeline'
import type { Dispute, DisputeDecision, DisputeReason, SplitProposal } from '../disputes/types'
import { buildDisputeContextSnapshot } from '../disputes/disputeContextSnapshot'
import {
  releaseEscrowWorkflow,
  refundEscrowWorkflow,
  updatePaymentWorkflow,
  getPaymentForJobWorkflow,
} from './paymentWorkflow'
import { updateJobDisputeStatus, getJobById } from '../jobs'
import { canTransition } from '../payments/stateMachine'
import { logWarning, logError } from '../observability'
import { logOperatorAction } from '../audit/logOperatorAction'
import {
  sendDisputeOpenedEmail,
  sendDisputeEvidenceRequestedEmail,
} from '../notifications/delivery'
import { syncInvoiceWithPayment } from '../invoices'

// ---------------------------------------------------------------------------
// Hydration guard — ensures the dispute repository has completed its initial
// data load before any trust-critical dispute read.  Without this, an empty
// cache could be mistaken for "no dispute exists" and allow unsafe actions.
// ---------------------------------------------------------------------------
function assertDisputeRepoHydrated(context: string, meta: Record<string, string>): void {
  if (!getDisputeRepository().isHydrated()) {
    const err = new Error(
      `${context}: dispute repository is not hydrated yet. Cannot safely evaluate dispute state.`
    )
    logError('workflow.dispute.unhydrated_guard', err, meta)
    throw err
  }
}

// ---------------------------------------------------------------------------
// P4 Teil B — consensus-split proposal flow (dormant behind VITE_CONSENSUS_SPLIT_ENABLED)
// ---------------------------------------------------------------------------
// Like the operator-split path (resolveDisputeWorkflow → repo.operatorResolveSplit
// → supabase.rpc), this flow is entirely client-side: the browser supabase client
// carries the party's session JWT, so auth.uid() inside the SECDEF RPCs resolves to
// the caller and enforces all authorization in the DB. There is no server route.
//
// The flag mirrors the FUNDING_DESTINATION_CHARGE_ENABLED discipline (read at call
// time, strict `=== 'true'`, default OFF) but is the VITE_-prefixed client var so
// PR C can flip it in Vercel to surface the UI. While OFF every entry point
// early-throws BEFORE touching the repository, keeping the feature dormant and
// byte-identical to today. The DB-side authz (auth.uid()) is the real security
// boundary; this is the mandated workflow-layer gate (CLAUDE.md).
function assertConsensusSplitEnabled(context: string): void {
  if (import.meta.env.VITE_CONSENSUS_SPLIT_ENABLED !== 'true') {
    const err = new Error(`${context}: consensus-split flow is disabled (VITE_CONSENSUS_SPLIT_ENABLED).`)
    logWarning('workflow.dispute.consensus_split_disabled', { context })
    throw err
  }
}

/**
 * Proposes a split ratio for the dispute. Authorization (caller must be a party
 * of the dispute) and all state guards are enforced in the DB RPC via
 * auth.uid(); this layer only applies the flag + hydration gates and delegates.
 */
export async function proposeSplitWorkflow(disputeId: string, ratio: number): Promise<SplitProposal> {
  assertConsensusSplitEnabled('Cannot propose split')
  assertDisputeRepoHydrated('Cannot propose split', { disputeId })
  return getDisputeRepository().proposeSplit(disputeId, ratio)
}

/**
 * Confirms a pending split proposal AND drives the money settlement — the
 * client-side sibling of resolveDisputeWorkflow's operator split branch
 * (the two-party consensus path instead of an operator decision).
 *
 * Flow (dormant behind VITE_CONSENSUS_SPLIT_ENABLED — flag-OFF early-throws
 * before any repository or money action, keeping the path byte-identical):
 *
 *  1. confirm_split_proposal RPC resolves the dispute (status='resolved',
 *     decision='split', split_ratio set, settlement_status='pending') and
 *     returns it. The DB RPC rejects a proposer confirming their own proposal
 *     and enforces ALL authorization via auth.uid().
 *  2. Money leg: releaseEscrowWorkflow with actor='consensus' and the
 *     SERVER-PERSISTED split ratio (never a client parameter) — partial refund
 *     to the customer + remainder transfer to the craftsman.
 *  3. Settlement is gated EXACTLY like the operator split branch: only a fully
 *     successful release + refund + bridge settles the dispute; any partial
 *     failure leaves settlement_status='pending' for operator reconcile.
 *
 * Retry-safety: confirm_split_proposal is NOT idempotent — once the proposal
 * leaves 'pending' a second call raises P0002. On retry we map the proposal →
 * its already-resolved dispute via a read-only lookup (getDisputeForProposal)
 * and re-drive ONLY the money leg, mirroring resolveDisputeWorkflow's
 * needsDecisionPersist=false shape. An already-settled dispute returns
 * immediately without moving money.
 */
export async function confirmSplitWorkflow(proposalId: string): Promise<Dispute> {
  assertConsensusSplitEnabled('Cannot confirm split')
  assertDisputeRepoHydrated('Cannot confirm split', { proposalId })

  // ── 1. Resolve proposal → dispute (persist consensus decision on first pass) ──
  let dispute: Dispute
  try {
    // FIRST pass: confirm_split_proposal resolves the dispute and returns it.
    dispute = await getDisputeRepository().confirmSplitProposal(proposalId)
  } catch (confirmErr) {
    // RETRY path: the proposal is already consumed (P0002 / not pending) or the
    // first attempt failed after the RPC committed. Re-calling the non-idempotent
    // RPC would crash, so map proposalId → its dispute via a read-only lookup and
    // re-drive only the money leg. Proceed ONLY when the dispute genuinely
    // reflects a confirmed split; otherwise the original error is the truth (the
    // RPC never committed, the caller is the proposer, the proposal was
    // rejected/superseded, etc.).
    let recovered: Dispute | undefined
    try {
      recovered = await getDisputeRepository().getDisputeForProposal(proposalId)
    } catch {
      // Recovery lookup itself failed — surface the original confirm error, which
      // is the actionable root cause.
      throw confirmErr
    }
    if (!recovered || recovered.status !== 'resolved' || recovered.decision !== 'split') {
      throw confirmErr
    }
    dispute = recovered
  }

  const { jobId } = dispute

  // ── 2. Idempotent re-entry: already settled → return without moving money ──
  if (isAlreadyDecided(dispute, 'split') && dispute.settlementStatus === 'settled') {
    return dispute
  }

  // The split ratio is the SERVER-persisted truth from the resolved dispute —
  // never a client parameter. A resolved split always carries it; guard
  // defensively and leave settlement pending for operator reconcile if absent.
  if (dispute.splitRatio === undefined) {
    logError('workflow.dispute.consensus_split_missing_persisted_ratio', undefined, {
      jobId,
      disputeId: dispute.id,
      proposalId,
      errorCode: 'PERSISTED_RATIO_INVALID',
    })
    return getDisputeByJobId(jobId) ?? dispute
  }

  const payment = getPaymentForJobWorkflow(jobId)
  if (!payment) {
    logWarning('workflow.dispute.consensus_split_payment_not_found', {
      jobId,
      disputeId: dispute.id,
      proposalId,
    })
    return getDisputeByJobId(jobId) ?? dispute
  }

  // ── 3. Money leg — mirrors resolveDisputeWorkflow's operator split branch ──
  // splitRatio sourced from the server-persisted dispute; actor='consensus'.
  // All three conditions must hold for settlement:
  //   1. payment found (releasedPayment)
  //   2. customer refund confirmed (refundFullySucceeded)
  //   3. tranche bridge completed (bridgeFullySucceeded)
  const {
    payment: releasedPayment,
    bridgeFullySucceeded: splitBridgeSucceeded,
    refundFullySucceeded: splitRefundSucceeded,
  } = await releaseEscrowWorkflow(jobId, dispute.id, dispute.splitRatio, 'consensus')

  // ── 4. Settlement gating — EXACTLY like the operator split branch ──────────
  const splitSettlementSucceeded =
    releasedPayment !== undefined && splitBridgeSucceeded && splitRefundSucceeded
  if (splitSettlementSucceeded) {
    // Consensus path settles via the SECDEF settle_consensus_split RPC — NOT the
    // plain settleDispute() PostgREST UPDATE. settleDispute's UPDATE is blocked
    // for a dispute PARTY by disputes_status_change_guard (verified 42501 on
    // prod); the RPC re-verifies party membership, arms the settle-scoped
    // sentinel and flips settlement_status pending→settled idempotently. The
    // operator split branch (resolveDisputeWorkflow) keeps using settleDispute —
    // operators pass the guard's operator branch.
    try {
      await getDisputeRepository().settleSplitConsensus(dispute.id)
      await updateJobDisputeStatus(jobId, 'resolved')
      emitDisputeResolvedWithDecision(jobId, 'split')
      emitDisputeResolvedEvent(jobId)
    } catch (settleErr) {
      // The money leg (release + refund + bridge) fully succeeded but the settle
      // RPC failed. Leave settlement_status='pending' for operator reconcile; the
      // idempotent retry (release is a no-op once done) re-attempts the settle.
      // Never crash here — money has already moved.
      logError('workflow.dispute.consensus_split_settle_failed', settleErr as Error, {
        jobId,
        disputeId: dispute.id,
        proposalId,
        splitRatio: dispute.splitRatio,
        errorCode: 'CONSENSUS_SETTLE_RPC_FAILED',
      })
    }
  } else {
    logError('workflow.dispute.consensus_split_settlement_failed', undefined, {
      jobId,
      disputeId: dispute.id,
      proposalId,
      splitRatio: dispute.splitRatio,
      failedStep: !releasedPayment
        ? 'release_payment_not_found'
        : !splitRefundSucceeded
          ? 'refund_partial_failure'
          : 'bridge_partial_failure',
      errorCode: !releasedPayment
        ? 'RELEASE_PAYMENT_NOT_FOUND'
        : !splitRefundSucceeded
          ? 'SPLIT_REFUND_FAILED'
          : 'DISPUTE_SPLIT_BRIDGE_FAILED',
    })
  }

  return getDisputeByJobId(jobId) ?? dispute
}

/** Rejects a pending split proposal. Returns the rejected proposal row. */
export async function rejectSplitWorkflow(proposalId: string): Promise<SplitProposal> {
  assertConsensusSplitEnabled('Cannot reject split')
  assertDisputeRepoHydrated('Cannot reject split', { proposalId })
  return getDisputeRepository().rejectSplitProposal(proposalId)
}

export async function openDisputeWorkflow(params: {
  jobId: string
  reason: DisputeReason
  title: string
  description: string
  raisedBy?: string
}): Promise<Dispute> {
  assertDisputeRepoHydrated('Cannot open dispute', { jobId: params.jobId })

  // Build context snapshot BEFORE the payment state is transitioned to 'disputed'.
  // This ensures paymentStateAtOpen captures the pre-dispute state (e.g. 'release_pending').
  const contextSnapshot = buildDisputeContextSnapshot(params.jobId)

  // Look up payment now — before the disputed transition — so we can attach
  // paymentId to the dispute at creation time. If no payment exists for this
  // job (legitimate for pre-escrow disputes), paymentId is left unset.
  const payment = getPaymentForJobWorkflow(params.jobId)

  // ── Atomic RPC path ───────────────────────────────────────────────────────
  // open_dispute_atomic commits three writes in a single DB transaction:
  //   INSERT dispute, UPDATE payment.status='disputed', UPDATE job.dispute_status='open'
  // This eliminates the race window between dispute creation and payment locking
  // that existed when these were three separate sequential writes.
  const dispute = await openDisputeAtomic({
    ...params,
    contextSnapshot,
    paymentId: payment?.id,
  })

  // ── Sync local in-memory caches (RPC already committed to DB) ────────────
  // The RPC owns the payment and job DB writes.  These calls update the
  // in-memory stores so the UI reflects the new state immediately, without
  // waiting for the realtime subscription to deliver the update.
  // The Supabase UPDATEs they issue are idempotent (same value already in DB).

  if (payment && canTransition(payment.state, 'disputed')) {
    // updatePaymentWorkflow: local optimistic write + idempotent Supabase UPDATE
    // + syncPaymentStateToJobAndProject + syncInvoiceWithPayment
    await updatePaymentWorkflow(params.jobId, 'disputed', { disputeId: dispute.id })
  } else if (payment) {
    // Payment exists but transition not valid (e.g. already 'disputed').
    // Sync invoice state anyway to ensure consistency.
    await syncInvoiceWithPayment(params.jobId)
  }

  // updateJobDisputeStatus: local optimistic write + idempotent Supabase UPDATE
  // (RPC already set dispute_status='open' in DB; this syncs the local job store)
  await updateJobDisputeStatus(params.jobId, 'open')

  emitDisputeOpenedEvent(params.jobId)

  const job = getJobById(params.jobId)
  sendDisputeOpenedEmail(params.jobId, job?.customerUserId, 'customer', { jobTitle: job?.title })
  sendDisputeOpenedEmail(params.jobId, job?.craftsmanUserId, 'craftsman', { jobTitle: job?.title })

  return dispute
}

async function requestEvidenceWorkflow(
  jobId: string,
  party: 'customer' | 'provider',
  operatorId: string | undefined,
): Promise<Dispute | undefined> {
  assertDisputeRepoHydrated('Cannot transition dispute', { jobId })

  const updated =
    party === 'customer'
      ? await getDisputeRepository().operatorRequestCustomerEvidence(jobId)
      : await getDisputeRepository().operatorRequestProviderEvidence(jobId)

  if (!updated) return updated

  await updateJobDisputeStatus(jobId, updated.status)
  emitDisputeEvidenceRequestedEvent(jobId)

  const job = getJobById(jobId)
  sendDisputeEvidenceRequestedEmail(jobId, job?.customerUserId, 'customer', { jobTitle: job?.title })
  sendDisputeEvidenceRequestedEmail(jobId, job?.craftsmanUserId, 'craftsman', { jobTitle: job?.title })

  if (operatorId) {
    logOperatorAction({
      operatorId,
      actionType: party === 'customer' ? 'dispute.request_customer_evidence' : 'dispute.request_provider_evidence',
      entityType: 'dispute',
      entityId: updated.id,
      metadata: { jobId, party },
    })
  }
  return updated
}

export async function requestCustomerEvidenceWorkflow(
  jobId: string,
  operatorId?: string
): Promise<Dispute | undefined> {
  return requestEvidenceWorkflow(jobId, 'customer', operatorId)
}

export async function requestProviderEvidenceWorkflow(
  jobId: string,
  operatorId?: string
): Promise<Dispute | undefined> {
  return requestEvidenceWorkflow(jobId, 'provider', operatorId)
}

export async function markDisputeUnderReviewWorkflow(
  jobId: string
): Promise<Dispute | undefined> {
  assertDisputeRepoHydrated('Cannot transition dispute', { jobId })

  // Operator-only state change. See requestCustomerEvidenceWorkflow for
  // the auth contract.
  const updated = await getDisputeRepository().operatorMarkUnderReview(jobId)
  if (updated) {
    await updateJobDisputeStatus(jobId, 'under_review')
    emitDisputeUnderReviewEvent(jobId)
  }
  return updated
}

/**
 * Transitions a dispute to 'under_review' by dispute ID.
 * This is the canonical path for the admin review step.
 */
export async function reviewDisputeWorkflow(disputeId: string): Promise<Dispute | undefined> {
  assertDisputeRepoHydrated('Cannot review dispute', { disputeId })

  const dispute = getDisputeById(disputeId)
  if (!dispute) return undefined

  if (!canTransitionDispute(dispute.status, 'under_review')) {
    const err = new Error(
      `Cannot review dispute: transition from '${dispute.status}' to 'under_review' is not allowed.`
    )
    logError('workflow.dispute.review_invalid_transition', err, {
      disputeId,
      fromStatus: dispute.status,
      toStatus: 'under_review',
    })
    throw err
  }

  // Operator-only state change. We resolve from disputeId → jobId locally so
  // the RPC can lock the dispute by job_id (its primary lookup key).
  const updated = await getDisputeRepository().operatorMarkUnderReview(dispute.jobId)
  if (updated) {
    await updateJobDisputeStatus(updated.jobId, 'under_review')
    emitDisputeUnderReviewEvent(updated.jobId)
  }
  return updated
}

// ---------------------------------------------------------------------------
// Resolution helpers — under γ a resolved dispute is identified by
//   status='resolved' AND decision=<token> AND resolutionType=<booking outcome>.
// `isAlreadyDecided(dispute, decision)` answers "did the decision token match
// what we are about to persist again?" so retries can skip the persist step.
// ---------------------------------------------------------------------------

function isAlreadyDecided(dispute: Dispute, decision: DisputeDecision): boolean {
  return dispute.status === 'resolved' && dispute.decision === decision
}

function hasDifferentDecision(dispute: Dispute, decision: DisputeDecision): boolean {
  return (
    isTerminalDisputeStatus(dispute.status) &&
    dispute.decision != null &&
    dispute.decision !== decision
  )
}

export async function rejectDisputeWorkflow(jobId: string, operatorId?: string): Promise<Dispute | undefined> {
  assertDisputeRepoHydrated('Cannot reject dispute', { jobId })

  const dispute = getDisputeByJobId(jobId)
  if (!dispute) return undefined

  // Already fully settled — idempotent return
  if (isAlreadyDecided(dispute, 'reject') && dispute.settlementStatus === 'settled') {
    return dispute
  }

  // Different terminal decision already recorded → conflict, no retry.
  if (hasDifferentDecision(dispute, 'reject')) {
    return dispute
  }

  // Retry path: if already rejected but not yet settled, skip decision persist
  // and go straight to money action.
  const needsDecisionPersist = !isAlreadyDecided(dispute, 'reject')

  if (needsDecisionPersist) {
    // Guard: validate the state transition BEFORE triggering any Stripe action.
    if (!canTransitionDispute(dispute.status, 'resolved')) {
      const err = new Error(
        `Cannot reject dispute: transition from '${dispute.status}' to 'resolved' is not allowed.`,
      )
      logError('workflow.dispute.reject_invalid_transition', err, {
        jobId,
        disputeId: dispute.id,
        fromStatus: dispute.status,
        toStatus: 'resolved',
      })
      throw err
    }

    // PERSIST DISPUTE TRUTH FIRST — before any irreversible money action.
    // If this fails the error propagates and no money moves.
    // The operator RPC sets settlementStatus='pending'; non-operator callers
    // are rejected at the DB layer with SQLSTATE 42501.
    const rejected = await getDisputeRepository().operatorReject(jobId)
    if (!rejected) return undefined
  }

  // THEN release the escrowed funds to the craftsman.  A rejection means the
  // customer's claim is denied, so the original payment stands.
  // Dispute truth is safely persisted — if this fails the dispute stays
  // settlementStatus='pending' and retry is explicitly allowed.
  const { payment: updatedPayment, bridgeFullySucceeded: releaseBridgeSucceeded } =
    await releaseEscrowWorkflow(jobId, dispute.id, undefined, 'operator')
  if (!updatedPayment) {
    logWarning('workflow.dispute.reject_release_payment_not_found', { jobId, disputeId: dispute.id })
  }

  // Gate settlement and all job-level mirrors on full money-movement success.
  // Job-level consumers lack settlementStatus; they treat resolved status as final.
  // A failed bridge must not produce a false "rejected / resolved" signal in the UI.
  const rejectSettlementSucceeded = updatedPayment !== undefined && releaseBridgeSucceeded
  if (rejectSettlementSucceeded) {
    await settleDispute(jobId)
    await updateJobDisputeStatus(jobId, 'resolved')
    emitDisputeResolvedWithDecision(jobId, 'reject')
    emitDisputeResolvedEvent(jobId)
  } else {
    logError('workflow.dispute.reject_settlement_failed', undefined, {
      jobId,
      disputeId: dispute.id,
      failedStep: !updatedPayment ? 'release_not_found' : 'bridge_partial_failure',
      errorCode: !updatedPayment ? 'RELEASE_PAYMENT_NOT_FOUND' : 'RELEASE_BRIDGE_FAILED',
    })
  }

  if (operatorId) {
    logOperatorAction({
      operatorId,
      actionType: 'dispute.reject',
      entityType: 'dispute',
      entityId: dispute.id,
      metadata: {
        jobId,
        paymentId: updatedPayment?.id ?? 'payment_not_found',
        previousStatus: dispute.status,
        newStatus: 'resolved',
        newDecision: 'reject',
        settlementSucceeded: rejectSettlementSucceeded,
      },
    })
  }

  return getDisputeByJobId(jobId)
}

export async function resolveDisputeReleaseWorkflow(jobId: string, operatorId?: string): Promise<Dispute | undefined> {
  assertDisputeRepoHydrated('Cannot resolve dispute', { jobId })

  const dispute = getDisputeByJobId(jobId)
  if (!dispute) return undefined

  // Already fully settled — idempotent return
  if (isAlreadyDecided(dispute, 'release') && dispute.settlementStatus === 'settled') {
    return dispute
  }

  // Different terminal decision already recorded → conflict, no retry.
  if (hasDifferentDecision(dispute, 'release')) {
    return dispute
  }

  // Retry path: if already decided but not settled, skip decision persist
  // and go straight to money action.
  const needsDecisionPersist = !isAlreadyDecided(dispute, 'release')

  if (needsDecisionPersist) {
    // Guard: validate the state transition BEFORE triggering any Stripe action.
    if (!canTransitionDispute(dispute.status, 'resolved')) {
      const err = new Error(
        `Cannot resolve dispute with release: transition from '${dispute.status}' to 'resolved' is not allowed.`,
      )
      logError('workflow.dispute.resolve_release_invalid_transition', err, {
        jobId,
        disputeId: dispute.id,
        fromStatus: dispute.status,
        toStatus: 'resolved',
      })
      throw err
    }

    // PERSIST DISPUTE TRUTH FIRST — before any irreversible money action.
    // If this fails the error propagates and no money moves.
    // The operator RPC sets decision='release', resolutionType='release_full'
    // and settlementStatus='pending'; non-operator callers are rejected at
    // the DB layer with SQLSTATE 42501.
    const resolved = await getDisputeRepository().operatorResolveRelease(jobId)
    if (!resolved) return undefined
  }

  // THEN release escrow — dispute truth is safely persisted.
  // If this fails the dispute stays settlementStatus='pending' and retry is allowed.
  const { payment: updatedPayment, bridgeFullySucceeded: releaseBridgeSucceeded } =
    await releaseEscrowWorkflow(jobId, dispute.id, undefined, 'operator')
  if (!updatedPayment) {
    logWarning('workflow.dispute.resolve_release_payment_not_found', { jobId, disputeId: dispute.id })
  }

  const releaseSettlementSucceeded = updatedPayment !== undefined && releaseBridgeSucceeded
  if (releaseSettlementSucceeded) {
    await settleDispute(jobId)
    await updateJobDisputeStatus(jobId, 'resolved')
    emitDisputeResolvedWithDecision(jobId, 'release')
    emitDisputeResolvedEvent(jobId)
  } else if (updatedPayment) {
    // Payment was found but bridge failed — operator must reconcile.
    // payment-not-found case is already logged as a warning above.
    logError('workflow.dispute.resolve_release_settlement_bridge_failed', undefined, {
      jobId,
      disputeId: dispute.id,
      failedStep: 'release_bridge',
      errorCode: 'RELEASE_BRIDGE_FAILED',
    })
  }

  if (operatorId) {
    logOperatorAction({
      operatorId,
      actionType: 'dispute.resolve_release',
      entityType: 'dispute',
      entityId: dispute.id,
      metadata: {
        jobId,
        paymentId: updatedPayment?.id ?? 'payment_not_found',
        previousStatus: dispute.status,
        newStatus: 'resolved',
        newDecision: 'release',
        settlementSucceeded: releaseSettlementSucceeded,
      },
    })
  }

  return getDisputeByJobId(jobId)
}

export async function resolveDisputeRefundWorkflow(jobId: string, operatorId?: string): Promise<Dispute | undefined> {
  assertDisputeRepoHydrated('Cannot resolve dispute', { jobId })

  const dispute = getDisputeByJobId(jobId)
  if (!dispute) return undefined

  // Already fully settled — idempotent return
  if (isAlreadyDecided(dispute, 'refund') && dispute.settlementStatus === 'settled') {
    return dispute
  }

  // Different terminal decision already recorded → conflict, no retry.
  if (hasDifferentDecision(dispute, 'refund')) {
    return dispute
  }

  // Retry path: if already decided but not settled, skip decision persist
  const needsDecisionPersist = !isAlreadyDecided(dispute, 'refund')

  if (needsDecisionPersist) {
    // Guard: validate the state transition BEFORE triggering any Stripe action.
    if (!canTransitionDispute(dispute.status, 'resolved')) {
      const err = new Error(
        `Cannot resolve dispute with refund: transition from '${dispute.status}' to 'resolved' is not allowed.`,
      )
      logError('workflow.dispute.resolve_refund_invalid_transition', err, {
        jobId,
        disputeId: dispute.id,
        fromStatus: dispute.status,
        toStatus: 'resolved',
      })
      throw err
    }

    // PERSIST DISPUTE TRUTH FIRST — before any irreversible money action.
    // The operator RPC sets decision='refund', resolutionType='refund_full'
    // and settlementStatus='pending'; non-operator callers are rejected at
    // the DB layer with SQLSTATE 42501.
    const resolved = await getDisputeRepository().operatorResolveRefund(jobId)
    if (!resolved) return undefined
  }

  // THEN refund escrow — dispute truth is safely persisted.
  // If this fails the dispute stays settlementStatus='pending' and retry is allowed.
  // refundEscrowWorkflow is idempotent: if payment is already 'refunded', it skips
  // the provider call and re-runs any side effects that may have failed before.
  const updatedPayment = await refundEscrowWorkflow(jobId, dispute.id)
  if (!updatedPayment) {
    logWarning('workflow.dispute.resolve_refund_payment_not_found', { jobId, disputeId: dispute.id })
  }

  const refundSettlementSucceeded = updatedPayment !== undefined
  if (refundSettlementSucceeded) {
    await settleDispute(jobId)
    await updateJobDisputeStatus(jobId, 'resolved')
    emitDisputeResolvedWithDecision(jobId, 'refund')
    emitDisputeResolvedEvent(jobId)
  } else {
    logError('workflow.dispute.refund_settlement_failed', undefined, {
      jobId,
      disputeId: dispute.id,
      failedStep: 'refund_failed',
      errorCode: 'REFUND_BLOCKED',
    })
  }

  if (operatorId) {
    logOperatorAction({
      operatorId,
      actionType: 'dispute.resolve_refund',
      entityType: 'dispute',
      entityId: dispute.id,
      metadata: {
        jobId,
        paymentId: updatedPayment?.id ?? 'payment_not_found',
        previousStatus: dispute.status,
        newStatus: 'resolved',
        newDecision: 'refund',
        settlementSucceeded: refundSettlementSucceeded,
      },
    })
  }

  return getDisputeByJobId(jobId)
}

/**
 * Unified dispute resolution workflow by dispute ID.
 *
 * Handles all four resolution decisions in a single canonical entry point:
 * - `release`  → release escrow to craftsman
 * - `refund`   → refund escrow to customer
 * - `split`    → partial refund to customer + craftsman receives remainder
 * - `reject`   → dispute dismissed; release escrow to craftsman
 *
 * @param disputeId  - ID of the dispute to resolve
 * @param decision   - The resolution decision
 * @param splitRatio - For 'split': fraction [0.0–1.0] to release to craftsman.
 *                     E.g. 0.7 = 70 % craftsman, 30 % customer refund.
 *                     Required when decision = 'split'.
 */
export async function resolveDisputeWorkflow(
  disputeId: string,
  decision: DisputeDecision,
  splitRatio?: number,
  operatorId?: string
): Promise<Dispute | undefined> {
  assertDisputeRepoHydrated('Cannot resolve dispute', { disputeId })

  const dispute = getDisputeById(disputeId)
  if (!dispute) return undefined

  const { jobId } = dispute

  if (decision === 'release') {
    return resolveDisputeReleaseWorkflow(jobId, operatorId)
  }

  if (decision === 'refund') {
    return resolveDisputeRefundWorkflow(jobId, operatorId)
  }

  if (decision === 'reject') {
    return rejectDisputeWorkflow(jobId, operatorId)
  }

  // decision === 'split'
  // `ratio` is only used when persisting the initial decision.  On retry the
  // persisted dispute.splitRatio is the source of truth and cannot be overridden
  // by the caller's parameter.
  const ratio = splitRatio ?? 0.5

  // Already fully settled — idempotent return
  if (isAlreadyDecided(dispute, 'split') && dispute.settlementStatus === 'settled') {
    return dispute
  }

  // Different terminal decision already recorded → conflict, no retry.
  if (hasDifferentDecision(dispute, 'split')) {
    return dispute
  }

  // Retry path: if already decided as split but not settled, skip decision persist
  const needsDecisionPersist = !isAlreadyDecided(dispute, 'split')

  if (needsDecisionPersist) {
    if (!canTransitionDispute(dispute.status, 'resolved')) {
      const err = new Error(
        `Cannot resolve dispute with split: transition from '${dispute.status}' to 'resolved' is not allowed.`
      )
      logError('workflow.dispute.resolve_split_invalid_transition', err, {
        disputeId,
        fromStatus: dispute.status,
        toStatus: 'resolved',
      })
      throw err
    }

    // PERSIST DISPUTE TRUTH FIRST — before any irreversible money action.
    // The operator RPC sets decision='split', resolutionType='split',
    // split_ratio=ratio and settlementStatus='pending'; non-operator callers
    // are rejected at the DB layer with SQLSTATE 42501.
    const resolved = await getDisputeRepository().operatorResolveSplit(jobId, ratio)
    if (!resolved) return undefined
  }

  // Effective ratio for the money action:
  // — Initial call: use the caller's parameter (just persisted above).
  // — Retry: use the stored dispute.splitRatio — the caller's parameter is
  //   irrelevant and must not change the payout percentage.
  const effectiveRatio = needsDecisionPersist ? ratio : dispute.splitRatio
  if (effectiveRatio === undefined) {
    logError('workflow.dispute.split_retry_missing_persisted_ratio', undefined, {
      jobId,
      disputeId: dispute.id,
      errorCode: 'PERSISTED_RATIO_INVALID',
    })
    return getDisputeByJobId(jobId)
  }

  const payment = getPaymentForJobWorkflow(jobId)
  if (!payment) {
    logWarning('workflow.dispute.resolve_split_payment_not_found', { jobId, disputeId })
    return undefined
  }

  // THEN release escrow with split — dispute truth is safely persisted.
  // All three conditions must hold for settlement:
  //   1. payment found (releasedPayment)
  //   2. customer refund confirmed (refundFullySucceeded)
  //   3. tranche bridge completed (bridgeFullySucceeded)
  const {
    payment: releasedPayment,
    bridgeFullySucceeded: splitBridgeSucceeded,
    refundFullySucceeded: splitRefundSucceeded,
  } = await releaseEscrowWorkflow(jobId, dispute.id, effectiveRatio, 'operator')

  const splitSettlementSucceeded = releasedPayment !== undefined && splitBridgeSucceeded && splitRefundSucceeded
  if (splitSettlementSucceeded) {
    await settleDispute(jobId)
    await updateJobDisputeStatus(jobId, 'resolved')
    emitDisputeResolvedWithDecision(jobId, 'split')
    emitDisputeResolvedEvent(jobId)
  } else {
    logError('workflow.dispute.split_settlement_failed', undefined, {
      jobId,
      disputeId: dispute.id,
      splitRatio: effectiveRatio,
      failedStep: !releasedPayment
        ? 'release_payment_not_found'
        : !splitRefundSucceeded
          ? 'refund_partial_failure'
          : 'bridge_partial_failure',
      errorCode: !releasedPayment
        ? 'RELEASE_PAYMENT_NOT_FOUND'
        : !splitRefundSucceeded
          ? 'SPLIT_REFUND_FAILED'
          : 'DISPUTE_SPLIT_BRIDGE_FAILED',
    })
  }
  if (operatorId) {
    logOperatorAction({
      operatorId,
      actionType: 'dispute.resolve_split',
      entityType: 'dispute',
      entityId: dispute.id,
      metadata: {
        jobId,
        paymentId: payment.id,
        splitRatio: effectiveRatio,
        previousStatus: dispute.status,
        newStatus: 'resolved',
        newDecision: 'split',
      },
    })
  }

  return getDisputeByJobId(jobId)
}
