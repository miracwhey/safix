import { getJobById } from '../jobs'
import { getPaymentForJob } from '../payments/service'
import type { DisputeContextSnapshot } from './types'

/**
 * Builds a `DisputeContextSnapshot` from the current in-memory state of a job
 * and its associated payment.
 *
 * CONTRACT
 * --------
 * - Pure side-effect-free function. Only reads from stores, never writes.
 * - **Never throws.** If any data is missing the function returns null rather
 *   than propagating an error, so callers never need to guard against failure.
 *   Dispute opening must succeed even when context data is unavailable.
 * - Must be called BEFORE the payment is transitioned to 'disputed' so that
 *   `paymentStateAtOpen` captures the pre-dispute state.
 *
 * REFERENCE vs SNAPSHOT
 * ----------------------
 * IDs (`sourceConversationId`, `sourceOfferId`) are stored as plain references —
 * the underlying entities are stable enough to query at review time.
 * Values that mutate (`paymentStateAtOpen`, `paymentTotalAmount`, job title,
 * description, parties) are captured here because they will differ by the time
 * a reviewer looks at the dispute.
 *
 * @param jobId  The job ID for which the dispute is being opened.
 * @returns A populated snapshot, or `null` when the job cannot be found.
 *          Partial snapshots (payment absent) are valid and use `null` for
 *          payment-specific fields.
 */
export function buildDisputeContextSnapshot(
  jobId: string
): DisputeContextSnapshot | null {
  try {
    const job = getJobById(jobId)
    if (!job) return null

    const payment = getPaymentForJob(jobId)

    return {
      jobTitle: job.title,
      jobDescription: job.description,
      craftsmanUserId: job.craftsmanUserId ?? null,
      customerUserId: job.customerUserId ?? null,
      sourceConversationId: job.sourceConversationId ?? null,
      sourceOfferId: job.sourceOfferId ?? null,
      paymentStateAtOpen: payment?.state ?? null,
      paymentTotalAmount: payment?.amounts.totalAmount ?? null,
      snapshotAt: new Date().toISOString(),
    }
  } catch {
    // Defensive: if any getter throws unexpectedly, never block dispute opening.
    return null
  }
}
