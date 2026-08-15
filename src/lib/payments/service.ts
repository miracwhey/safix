import {
  getPayments,
  getPaymentForJob as getPaymentForJobFromStore,
  subscribePayments,
} from './paymentsStore.js'
import { getPaymentRepository } from './repository/index.js'

import { createLedgerEntry, correctEscrowCreatedAmount } from './ledger/ledgerService.js'
import { getPaymentProvider, getPaymentProviderName } from './providers/index.js'
import {
  markDepositPaid,
  lockEscrow,
  startWork,
  requestRelease,
  releasePayment,
  openDispute,
  refundPayment,
} from './paymentEngine.js'

import type { Payment } from './types.js'
import type { PaymentState } from '../shared/coreTypes.js'
import { logError } from '../observability/index.js'
import { generateUUID } from '../shared/generateUUID.js'
import { resolveJobFeeRate } from '../shared/feeRate.js'
import { calculateTrancheAmounts } from './escrow/escrowService.js'
import { canTransition } from './stateMachine.js'
import { recordPersistenceFailure } from '../persistence/index.js'

function buildDefaultAmounts(totalAmount: number) {
  const { depositAmount, finalAmount } = calculateTrancheAmounts(totalAmount)
  return { totalAmount, depositAmount, finalAmount }
}

export { subscribePayments }

/**
 * Returns `true` once the payment repository has completed its initial data
 * load.  Used by screens to distinguish "not loaded yet" from "genuinely
 * does not exist" without resorting to a timeout.
 */
export function isPaymentRepositoryHydrated(): boolean {
  return getPaymentRepository().isHydrated()
}

export function getAllPayments(): Payment[] {
  return getPayments()
}

export function getPaymentForJob(jobId: string): Payment | undefined {
  return getPaymentForJobFromStore(jobId)
}

export function getActivePaymentProviderName() {
  return getPaymentProviderName()
}

type PaymentLinkage = {
  projectId?: string
  customerUserId?: string
  craftsmanUserId?: string
  offerId?: string
}

async function mergeLinkage(existing: Payment, linkage?: PaymentLinkage): Promise<Payment> {
  if (!linkage) return existing

  const next: Payment = {
    ...existing,
    projectId: existing.projectId ?? linkage.projectId,
    customerUserId: existing.customerUserId ?? linkage.customerUserId,
    craftsmanUserId: existing.craftsmanUserId ?? linkage.craftsmanUserId,
    offerId: existing.offerId ?? linkage.offerId,
  }

  if (
    next.projectId === existing.projectId &&
    next.customerUserId === existing.customerUserId &&
    next.craftsmanUserId === existing.craftsmanUserId &&
    next.offerId === existing.offerId
  ) {
    return existing
  }

  await getPaymentRepository().update(existing.id, () => next)
  return next
}

export async function createPaymentForJob(
  jobId: string,
  totalAmount = 2000,
  linkage?: PaymentLinkage
): Promise<Payment> {
  const existing = getPaymentForJob(jobId)
  if (existing) return mergeLinkage(existing, linkage)

  const created: Payment = {
    id: generateUUID(),
    jobId,
    projectId: linkage?.projectId,
    customerUserId: linkage?.customerUserId,
    craftsmanUserId: linkage?.craftsmanUserId,
    offerId: linkage?.offerId,
    state: 'deposit_required',
    amounts: buildDefaultAmounts(totalAmount),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  await getPaymentRepository().add(created)

  createLedgerEntry({
    paymentId: created.id,
    jobId,
    type: 'escrow_created',
    amount: created.amounts.totalAmount,
    note: `Zahlungsvorgang angelegt (${getPaymentProviderName()})`,
  })

  return created
}

export async function ensurePaymentForJob(
  jobId: string,
  totalAmount = 2000,
  linkage?: PaymentLinkage
): Promise<Payment> {
  const existing = getPaymentForJob(jobId)
  if (existing) return mergeLinkage(existing, linkage)
  return createPaymentForJob(jobId, totalAmount, linkage)
}

/**
 * Updates the amounts on an existing payment to reflect the agreed total.
 *
 * If no payment exists for the job, a new one is created with the given amount.
 * If the payment already has matching amounts (within ±1 rounding tolerance),
 * the existing payment is returned unchanged.
 *
 * Only operates on payments in the `deposit_required` phase — once a deposit
 * has been received, amounts are considered final and will not be modified.
 */
export async function updatePaymentAmounts(
  jobId: string,
  totalAmount: number,
  linkage?: PaymentLinkage
): Promise<Payment> {
  const existing = getPaymentForJob(jobId)

  if (!existing) {
    return createPaymentForJob(jobId, totalAmount, linkage)
  }

  const paymentWithLinkage = await mergeLinkage(existing, linkage)

  // Amounts are locked once a deposit has been paid
  if (paymentWithLinkage.state !== 'deposit_required') {
    return paymentWithLinkage
  }

  // No-op when amounts already match
  if (Math.abs(paymentWithLinkage.amounts.totalAmount - totalAmount) < 1) {
    return paymentWithLinkage
  }

  const updated: Payment = {
    ...paymentWithLinkage,
    amounts: buildDefaultAmounts(totalAmount),
    updatedAt: Date.now(),
  }

  await getPaymentRepository().update(updated.id, () => updated)

  // Keep the escrow_created ledger entry aligned with the corrected amount so
  // GMV does not diverge from the canonical payment amount.
  correctEscrowCreatedAmount(updated.id, totalAmount)

  return updated
}

const engineTransitions: Partial<Record<PaymentState, (p: Payment) => Payment>> = {
  deposit_paid: markDepositPaid,
  in_escrow: lockEscrow,
  work_in_progress: startWork,
  release_pending: requestRelease,
  released: releasePayment,
  disputed: openDispute,
  refunded: refundPayment,
}

export async function updatePaymentState(
  jobId: string,
  state: PaymentState,
  options?: { disputeId?: string; splitRatio?: number; refundedAmount?: number }
): Promise<Payment | undefined> {
  const payment = getPaymentForJob(jobId)
  if (!payment) return undefined

  if (payment.state === state) {
    return payment
  }

  const applyTransition = engineTransitions[state]
  if (!applyTransition) {
    throw new Error(`No transition function defined for payment state: ${state}`)
  }

  const applied = applyTransition(payment)
  const updated: Payment =
    state === 'refunded' && options?.refundedAmount !== undefined
      ? { ...applied, refundedAmount: options.refundedAmount }
      : applied

  // Money-terminal writes (released / refunded) MUST go through the atomic RPC
  // chokepoint — NOT a raw client-direct payments UPDATE. finalizeStateAtomic:
  //   - commits payments + jobs.payment_state + jobs.status + projects in ONE tx
  //   - enforces the active-dispute guard (never release while a dispute is open)
  //   - restricts authority to customer / operator / system (never the payee)
  //   - writes a timeline_signals audit row
  // A raw repo.update() would bypass all four: it only flips payments.status and
  // leans on the BEFORE-UPDATE FSM trigger, which deliberately lets the non-payee
  // customer through (MED#1). Routing every released/refunded write here is the
  // single chokepoint that closes that gap for release-tranche, reconciliation
  // and post-server-release side effects alike. Non-terminal transitions keep the
  // plain update path. In-memory mode applies the change locally (no RPC); the
  // caller's syncPaymentStateToJobAndProject still propagates to job/project there.
  if (state === 'released' || state === 'refunded') {
    await getPaymentRepository().finalizeStateAtomic(jobId, state, {
      disputeId: options?.disputeId,
      refundedAmount: options?.refundedAmount,
    })
  } else {
    await getPaymentRepository().update(updated.id, () => updated)
  }

  if (state === 'deposit_paid') {
    createLedgerEntry({
      paymentId: updated.id,
      jobId,
      type: 'deposit_paid',
      amount: updated.amounts.depositAmount,
      note: 'Zahlung bestätigt',
    })
  }

  if (state === 'disputed') {
    const disputeId = options?.disputeId

    createLedgerEntry({
      paymentId: updated.id,
      jobId,
      type: 'dispute_hold',
      amount: updated.amounts.totalAmount,
      note: disputeId
        ? 'Zahlung eingefroren – Konflikt eröffnet'
        : 'Zahlung eingefroren – Konflikt (ohne Referenz)',
      disputeId,
    })
  }

  if (state === 'released') {
    const disputeId = options?.disputeId
    const splitRatio = options?.splitRatio

    // Per-job fee rate from commercial origin (5 % or 9 %).
    const feeRate = resolveJobFeeRate(jobId)
    const netRate = 1 - feeRate

    if (splitRatio !== undefined && disputeId) {
      // Split resolution: craftsman receives `splitRatio` of the total,
      // customer is refunded the remainder.  Both entries are created here
      // so the ledger fully reflects the hybrid release/refund outcome.
      const craftsmanPercent = Math.round(splitRatio * 100)
      const customerPercent = Math.round((1 - splitRatio) * 100)
      const craftsmanPortion = Number((updated.amounts.totalAmount * splitRatio).toFixed(2))
      const customerRefund = Number((updated.amounts.totalAmount * (1 - splitRatio)).toFixed(2))
      const craftsmanFee = Number((craftsmanPortion * feeRate).toFixed(2))
      const craftsmanNet = Number((craftsmanPortion * netRate).toFixed(2))

      createLedgerEntry({
        paymentId: updated.id,
        jobId,
        type: 'dispute_resolved_release',
        amount: craftsmanNet,
        note: `Freigabe nach Streitbeilegung (${craftsmanPercent} % Handwerkeranteil)`,
        disputeId,
      })

      createLedgerEntry({
        paymentId: updated.id,
        jobId,
        type: 'platform_fee',
        amount: craftsmanFee,
        note: `SaFix Plattformprovision (${Math.round(feeRate * 100)} %, anteilig)`,
        disputeId,
      })

      createLedgerEntry({
        paymentId: updated.id,
        jobId,
        type: 'dispute_resolved_refund',
        amount: customerRefund,
        note: `Teilerstattung nach Streitbeilegung (${customerPercent} % Kundenanteil)`,
        disputeId,
      })
    } else {
      createLedgerEntry({
        paymentId: updated.id,
        jobId,
        type: 'final_paid',
        amount: updated.amounts.finalAmount,
        note: 'Restzahlung freigegeben',
        disputeId,
      })

      createLedgerEntry({
        paymentId: updated.id,
        jobId,
        type: 'platform_fee',
        amount: Number((updated.amounts.totalAmount * feeRate).toFixed(2)),
        note: `SaFix Plattformprovision (${Math.round(feeRate * 100)} %)`,
        disputeId,
      })

      createLedgerEntry({
        paymentId: updated.id,
        jobId,
        type: disputeId ? 'dispute_resolved_release' : 'payout',
        amount: Number((updated.amounts.totalAmount * netRate).toFixed(2)),
        note: disputeId ? 'Freigabe nach Streitbeilegung' : 'Auszahlung an Betrieb',
        disputeId,
      })
    }
  }

  if (state === 'refunded') {
    const disputeId = options?.disputeId
    const refundAmount = options?.refundedAmount ?? updated.amounts.totalAmount

    createLedgerEntry({
      paymentId: updated.id,
      jobId,
      type: disputeId ? 'dispute_resolved_refund' : 'refund',
      amount: refundAmount,
      note: disputeId ? 'Erstattung nach Streitbeilegung' : 'Zahlung zurückerstattet',
      disputeId,
    })
  }

  return updated
}

export async function createEscrowPayment(
  jobId: string,
  amount: number,
  customerProviderRef: string
): Promise<Payment> {
  const provider = getPaymentProvider()

  const payment = await ensurePaymentForJob(jobId, amount)

  if (!payment.craftsmanUserId) {
    throw new Error(
      `createEscrowPayment: payment ${payment.id} has no craftsmanUserId — cannot create escrow with destination charge.`
    )
  }

  const result = await provider.createEscrow({
    jobId,
    customerId: customerProviderRef,
    craftsmanUserId: payment.craftsmanUserId,
    amount,
    currency: 'EUR',
  })

  if (result.escrowId !== payment.id) {
    const updated: Payment = {
      ...payment,
      providerRef: result.escrowId,
      clientSecret: result.clientSecret,
      updatedAt: Date.now(),
    }
    await getPaymentRepository().update(payment.id, () => updated)
    return updated
  }

  // providerRef already matches (idempotent re-call); still store clientSecret if
  // it has been returned and is not yet persisted.
  if (result.clientSecret !== undefined && payment.clientSecret === undefined) {
    const updated: Payment = { ...payment, clientSecret: result.clientSecret, updatedAt: Date.now() }
    await getPaymentRepository().update(payment.id, () => updated)
    return updated
  }

  return payment
}

export async function confirmDepositPayment(
  jobId: string
): Promise<Payment | undefined> {
  const payment = getPaymentForJob(jobId)
  if (!payment) return undefined

  const provider = getPaymentProvider()

  await provider.confirmDeposit({
    escrowId: payment.providerRef ?? payment.id,
    jobId,
    amount: payment.amounts.depositAmount,
  })

  return updatePaymentState(jobId, 'deposit_paid')
}

export async function releaseEscrowPayment(
  jobId: string,
  options?: { disputeId?: string; splitRatio?: number }
): Promise<{ payment: Payment; splitRefundSucceeded: boolean } | undefined> {
  const payment = getPaymentForJob(jobId)
  if (!payment) return undefined

  // Pre-flight: validate the state machine transition BEFORE calling Stripe.
  // The engine checks this again in updatePaymentState, but by then the Stripe
  // call is irreversible.  Fail-fast here to avoid paying for a point-of-no-return
  // that the state machine would reject anyway.
  if (!canTransition(payment.state, 'released')) {
    throw new Error(
      `releaseEscrowPayment: illegal transition from '${payment.state}' to 'released' for payment ${payment.id} (job ${jobId}).`
    )
  }

  const provider = getPaymentProvider()

  if (!payment.providerRef && getPaymentProviderName() === 'stripe') {
    throw new Error(
      `releaseEscrowPayment: payment ${payment.id} has no providerRef — cannot release escrow on Stripe without a real provider reference (pi_*).`,
    )
  }

  await provider.releaseEscrow({
    escrowId: payment.providerRef ?? payment.id,
    disputeId: options?.disputeId,
  })

  // ── Stripe succeeded (point of no return) ─────────────────────────────────

  // Split resolution: issue partial customer refund BEFORE state commit.
  // Payment state MUST advance even if the refund fails (Stripe already captured).
  // splitRefundSucceeded tracks the outcome so callers can gate settlement correctly.
  let splitRefundSucceeded = true
  if (options?.splitRatio !== undefined) {
    const customerRefundAmount = Number(
      (payment.amounts.totalAmount * (1 - options.splitRatio)).toFixed(2),
    )
    if (customerRefundAmount <= 0) {
      // No refund needed (100 % craftsman split) — treat as succeeded.
      splitRefundSucceeded = true
    } else {
      try {
        await provider.refundEscrow({
          escrowId: payment.providerRef ?? payment.id,
          amount: customerRefundAmount,
          disputeId: options.disputeId,
        })
      } catch (refundErr) {
        splitRefundSucceeded = false
        logError('payment.split_refund_failed', refundErr instanceof Error ? refundErr : undefined, {
          jobId,
          paymentId: payment.id,
          providerRef: payment.providerRef,
          amount: customerRefundAmount,
          disputeId: options.disputeId,
          action: 'MANUAL_PARTIAL_REFUND_REQUIRED',
        })
        recordPersistenceFailure({
          domain: 'payments',
          operation: 'split_refund',
          entityId: payment.id,
          error: refundErr instanceof Error ? refundErr : new Error(String(refundErr)),
          occurredAt: Date.now(),
        })
      }
    }
  }

  // ── Atomic DB commit: payments + jobs.payment_state + projects.payment_state ──
  // Single PostgreSQL transaction via finalize_payment_state_atomic RPC.
  // If this fails after Stripe succeeded, the operator must reconcile manually.
  let updatedPayment: Payment
  try {
    updatedPayment = await getPaymentRepository().finalizeStateAtomic(jobId, 'released', {
      disputeId: options?.disputeId,
      actor: 'system',
    })
  } catch (dbErr) {
    logError('payment.release_db_commit_failed', dbErr instanceof Error ? dbErr : undefined, {
      jobId,
      paymentId: payment.id,
      providerRef: payment.providerRef ?? 'none',
      disputeId: options?.disputeId ?? 'none',
      action: 'MANUAL_STATE_UPDATE_REQUIRED',
    })
    throw dbErr
  }

  // ── Ledger entries (non-atomic audit trail; after commit) ─────────────────
  const feeRate = resolveJobFeeRate(jobId)
  const netRate = 1 - feeRate
  const disputeId = options?.disputeId
  const splitRatio = options?.splitRatio

  if (splitRatio !== undefined && disputeId) {
    // Split ledger entries are written by releaseEscrowWorkflow at the appropriate
    // gates: refund entry after refund confirmation, payout entries after bridge success.
    // Writing them here (before bridge) would record realized payout before any
    // tranche transfer has happened.
  } else if (!disputeId) {
    // Non-dispute release: no tranche bridge required, write immediately after capture.
    createLedgerEntry({
      paymentId: updatedPayment.id,
      jobId,
      type: 'final_paid',
      amount: payment.amounts.finalAmount,
      note: 'Restzahlung freigegeben',
    })
    createLedgerEntry({
      paymentId: updatedPayment.id,
      jobId,
      type: 'platform_fee',
      amount: Number((payment.amounts.totalAmount * feeRate).toFixed(2)),
      note: `SaFix Plattformprovision (${Math.round(feeRate * 100)} %)`,
    })
    createLedgerEntry({
      paymentId: updatedPayment.id,
      jobId,
      type: 'payout',
      amount: Number((payment.amounts.totalAmount * netRate).toFixed(2)),
      note: 'Auszahlung an Betrieb',
    })
  }
  // Non-split dispute release: deferred to releaseEscrowWorkflow after bridge success.

  return { payment: updatedPayment, splitRefundSucceeded }
}

/**
 * Writes the dispute_resolved_refund ledger entry after the customer partial
 * refund is confirmed.  Safe to call on retry — the ledger idempotency guard
 * suppresses a second write for the same payment.
 */
export function writeSplitRefundLedgerEntry(
  payment: Payment,
  jobId: string,
  disputeId: string,
  splitRatio: number,
): void {
  const customerPercent = Math.round((1 - splitRatio) * 100)
  const customerRefund = Number((payment.amounts.totalAmount * (1 - splitRatio)).toFixed(2))
  createLedgerEntry({
    paymentId: payment.id,
    jobId,
    type: 'dispute_resolved_refund',
    amount: customerRefund,
    note: `Teilerstattung nach Streitbeilegung (${customerPercent} % Kundenanteil)`,
    disputeId,
  })
}

/**
 * Writes dispute_resolved_release and platform_fee ledger entries after the
 * tranche bridge transfer is confirmed.  Safe to call on retry — the ledger
 * idempotency guard suppresses duplicates for the same payment.
 */
export function writeSplitPayoutLedgerEntries(
  payment: Payment,
  jobId: string,
  disputeId: string,
  splitRatio: number,
): void {
  const feeRate = resolveJobFeeRate(jobId)
  const netRate = 1 - feeRate
  const craftsmanPercent = Math.round(splitRatio * 100)
  const craftsmanPortion = Number((payment.amounts.totalAmount * splitRatio).toFixed(2))
  const craftsmanFee = Number((craftsmanPortion * feeRate).toFixed(2))
  const craftsmanNet = Number((craftsmanPortion * netRate).toFixed(2))
  createLedgerEntry({
    paymentId: payment.id,
    jobId,
    type: 'dispute_resolved_release',
    amount: craftsmanNet,
    note: `Freigabe nach Streitbeilegung (${craftsmanPercent} % Handwerkeranteil)`,
    disputeId,
  })
  createLedgerEntry({
    paymentId: payment.id,
    jobId,
    type: 'platform_fee',
    amount: craftsmanFee,
    note: `SaFix Plattformprovision (${Math.round(feeRate * 100)} %, anteilig)`,
    disputeId,
  })
}

/**
 * Writes final_paid, platform_fee, and dispute_resolved_release ledger entries
 * for a non-split dispute release after the tranche bridge transfer is confirmed.
 * Safe to call on retry — the ledger idempotency guard suppresses duplicates.
 */
export function writeNonSplitDisputePayoutLedgerEntries(
  payment: Payment,
  jobId: string,
  disputeId: string,
): void {
  const feeRate = resolveJobFeeRate(jobId)
  const netRate = 1 - feeRate
  createLedgerEntry({
    paymentId: payment.id,
    jobId,
    type: 'final_paid',
    amount: payment.amounts.finalAmount,
    note: 'Restzahlung freigegeben',
    disputeId,
  })
  createLedgerEntry({
    paymentId: payment.id,
    jobId,
    type: 'platform_fee',
    amount: Number((payment.amounts.totalAmount * feeRate).toFixed(2)),
    note: `SaFix Plattformprovision (${Math.round(feeRate * 100)} %)`,
    disputeId,
  })
  createLedgerEntry({
    paymentId: payment.id,
    jobId,
    type: 'dispute_resolved_release',
    amount: Number((payment.amounts.totalAmount * netRate).toFixed(2)),
    note: 'Freigabe nach Streitbeilegung',
    disputeId,
  })
}

/**
 * Attempts the partial customer refund for a split dispute.
 * Used by the bridge-retry path (payment already 'released' but refund
 * completion unconfirmed) AND as the corridor split-refund leg (escrow-plan
 * jobs, where releaseEscrowPayment is skipped). Idempotent via the server
 * refund key, so a duplicate call returns the cached outcome.
 * Returns true when the refund succeeded or was not needed; false when the
 * provider call failed (operator must reconcile).
 *
 * `fundingRef` — the escrow plan's funding PaymentIntent (pi_*). Corridor
 * payments carry no providerRef (legacy column), so the caller passes the
 * plan-level funding reference explicitly; providerRef still wins when set.
 */
export async function attemptSplitRefundRetry(
  jobId: string,
  options: { splitRatio: number; disputeId?: string; fundingRef?: string },
): Promise<boolean> {
  const payment = getPaymentForJob(jobId)
  if (!payment) return false

  const customerRefundAmount = Number(
    (payment.amounts.totalAmount * (1 - options.splitRatio)).toFixed(2),
  )
  if (customerRefundAmount <= 0) return true

  const provider = getPaymentProvider()
  try {
    await provider.refundEscrow({
      escrowId: payment.providerRef ?? options.fundingRef ?? payment.id,
      amount: customerRefundAmount,
      disputeId: options.disputeId,
    })
    return true
  } catch (refundErr) {
    logError('payment.split_refund_retry_failed', refundErr instanceof Error ? refundErr : undefined, {
      jobId,
      paymentId: payment.id,
      providerRef: payment.providerRef,
      amount: customerRefundAmount,
      disputeId: options.disputeId,
      action: 'MANUAL_PARTIAL_REFUND_REQUIRED',
    })
    recordPersistenceFailure({
      domain: 'payments',
      operation: 'split_refund',
      entityId: payment.id,
      error: refundErr instanceof Error ? refundErr : new Error(String(refundErr)),
      occurredAt: Date.now(),
    })
    return false
  }
}

export async function refundEscrowPayment(
  jobId: string,
  amount?: number,
  options?: { disputeId?: string }
): Promise<Payment | undefined> {
  const payment = getPaymentForJob(jobId)
  if (!payment) return undefined

  // Pre-flight: validate the state machine transition BEFORE calling Stripe.
  // The provider refund is irreversible — failing fast here prevents a situation
  // where Stripe refunds but the DB write that follows fails.
  if (!canTransition(payment.state, 'refunded')) {
    throw new Error(
      `refundEscrowPayment: illegal transition from '${payment.state}' to 'refunded' for payment ${payment.id} (job ${jobId}).`
    )
  }

  const provider = getPaymentProvider()

  if (!payment.providerRef && getPaymentProviderName() === 'stripe') {
    throw new Error(
      `refundEscrowPayment: payment ${payment.id} has no providerRef — cannot refund escrow on Stripe without a real provider reference (pi_*).`,
    )
  }

  await provider.refundEscrow({
    escrowId: payment.providerRef ?? payment.id,
    amount,
    disputeId: options?.disputeId,
  })

  // ── Stripe refund succeeded (point of no return) ───────────────────────────
  // Atomic DB commit must now succeed.  If it fails, Stripe has refunded the
  // customer but our canonical store does not reflect this.  Re-throw so the
  // caller knows the DB is stale and can surface the error; do NOT swallow it.
  const refundAmount = amount ?? payment.amounts.totalAmount

  let updatedPayment: Payment
  try {
    updatedPayment = await getPaymentRepository().finalizeStateAtomic(jobId, 'refunded', {
      disputeId:      options?.disputeId,
      actor:          'system',
      refundedAmount: refundAmount,
    })
  } catch (dbErr) {
    logError('payment.refund_db_commit_failed', dbErr instanceof Error ? dbErr : undefined, {
      jobId,
      paymentId:   payment.id,
      providerRef: payment.providerRef ?? 'none',
      refundAmount: String(refundAmount),
      disputeId:   options?.disputeId ?? 'none',
      action:      'MANUAL_STATE_UPDATE_REQUIRED',
    })
    throw dbErr
  }

  // ── Ledger entry (non-atomic audit trail; after commit) ───────────────────
  createLedgerEntry({
    paymentId: updatedPayment.id,
    jobId,
    type:      options?.disputeId ? 'dispute_resolved_refund' : 'refund',
    amount:    refundAmount,
    note:      options?.disputeId ? 'Erstattung nach Streitbeilegung' : 'Zahlung zurückerstattet',
    disputeId: options?.disputeId,
  })

  return updatedPayment
}
