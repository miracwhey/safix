/**
 * Diagnosis Instant-Payment — Domain module
 *
 * Models the payment path for Diagnose-Einsatz offers.
 *
 * This is SEPARATE from the standard escrow/tranche payment model.
 * A diagnosis payment is:
 *   - A single immediate payment (no 25/75 split)
 *   - Subject to a 5 % platform fee
 *   - State-tracked via PaymentState: 'diagnosis_payment_pending' → 'diagnosis_payment_completed'
 *   - Stored as a first-class Payment record, NOT an EscrowPlan
 *
 * V1 scope:
 *   - Domain model + UI truth
 *   - Stripe charge wiring is a separate implementation block
 *   - The Payment record is created on acceptance so UI can show the pending state immediately
 *
 * INVARIANT: Only creates a payment when job.jobKind === 'diagnosis'.
 * Never mixes with standard payment/escrow flows.
 */

import { getPaymentRepository } from './repository/index.js'
import { generateUUID } from '../shared/generateUUID.js'
import { logInfo, logWarning } from '../observability/index.js'
import type { Payment } from './types.js'
import type { EntityId } from '../shared/coreTypes.js'

/** Platform fee percentage for diagnosis instant-payments. */
export const DIAGNOSIS_FEE_PERCENT = 5

export type DiagnosisPaymentLinkage = {
  projectId?: string
  customerUserId?: string
  craftsmanUserId?: string
  offerId?: string
}

/**
 * Ensures a diagnosis payment record exists for the given job.
 *
 * Idempotent: if a payment already exists for this job, returns without creating a duplicate.
 * Creates a Payment with state 'diagnosis_payment_pending'.
 *
 * The amount is the full diagnosis fee from the offer.
 * The platform takes DIAGNOSIS_FEE_PERCENT; the craftsman net = amount * (1 - fee/100).
 *
 * @param jobId       - The diagnosis Job ID
 * @param totalAmount - Diagnosis fee in full units (e.g. 120.0 for "120 €")
 * @param linkage     - Optional project/user/offer IDs for attribution
 */
export async function ensureDiagnosisPaymentForJob(
  jobId: EntityId,
  totalAmount: number,
  linkage: DiagnosisPaymentLinkage = {}
): Promise<void> {
  const repo = getPaymentRepository()

  // Idempotent: do not create a second payment if one already exists
  const existing = repo.getByJobId(jobId)
  if (existing) {
    logInfo('payments.diagnosis.already_exists', { jobId, state: existing.state })
    return
  }

  const feeAmount = Number((totalAmount * DIAGNOSIS_FEE_PERCENT / 100).toFixed(2))
  const netToCraftsman = Number((totalAmount - feeAmount).toFixed(2))

  const payment: Payment = {
    id: generateUUID(),
    jobId,
    projectId: linkage.projectId,
    customerUserId: linkage.customerUserId,
    craftsmanUserId: linkage.craftsmanUserId,
    offerId: linkage.offerId,
    state: 'diagnosis_payment_pending',
    amounts: {
      totalAmount,
      depositAmount: netToCraftsman, // net payout to craftsman after fee
      finalAmount: 0,               // no second tranche — single payment
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  try {
    await repo.add(payment)
    logInfo('payments.diagnosis.created', {
      paymentId: payment.id,
      jobId,
      totalAmount,
      feeAmount,
      netToCraftsman,
    })
  } catch (err) {
    logWarning('payments.diagnosis.create_failed', {
      jobId,
      error: String(err),
    })
    throw err
  }
}

/**
 * Marks a diagnosis payment as completed.
 * Called when the Stripe charge for the diagnosis fee succeeds.
 */
export async function completeDiagnosisPayment(jobId: EntityId): Promise<void> {
  const repo = getPaymentRepository()
  const payment = repo.getByJobId(jobId)
  if (!payment) {
    logWarning('payments.diagnosis.complete_not_found', { jobId })
    return
  }
  if (payment.state === 'diagnosis_payment_completed') return

  await repo.update(payment.id, (p) => ({
    ...p,
    state: 'diagnosis_payment_completed' as const,
    updatedAt: Date.now(),
  }))

  logInfo('payments.diagnosis.completed', { paymentId: payment.id, jobId })
}
