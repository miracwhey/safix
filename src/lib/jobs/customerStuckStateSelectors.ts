import type { Job } from './types'
import type { Payment } from '../payments/types'

const MS_PER_HOUR = 1000 * 60 * 60

/**
 * Returns true if the job is in 'new' status with no proposal sent yet.
 * Used to show a customer-facing informational warning that the craftsman
 * has not yet responded with an offer.
 *
 * Note: Job does not carry a createdAt, so the "48h threshold" from the
 * problem spec is approximated by checking for the presence of an
 * intakeContext (indicating a real inquiry was received) combined with
 * the absence of a proposal.
 */
export function isProposalStuck(job: Job): boolean {
  return job.status === 'new' && !job.proposalSentAt && job.intakeContext != null
}

/**
 * Returns true if the proposal was accepted but scheduling has not progressed
 * for more than 72h (job is still not in_progress/waiting_payment/completed).
 */
export function isSchedulingStuck(job: Job, nowMs = Date.now()): boolean {
  if (!job.proposalAcceptedAt) return false
  if (
    job.status === 'in_progress' ||
    job.status === 'waiting_payment' ||
    job.status === 'completed' ||
    job.status === 'cancelled'
  ) {
    return false
  }
  const ageHours = (nowMs - job.proposalAcceptedAt) / MS_PER_HOUR
  return ageHours > 72
}

/**
 * Returns true if the job is in_progress but no timeline signal has been
 * recorded for more than 72h (execution appears to be silent).
 */
export function isExecutionSilent(job: Job, nowMs = Date.now()): boolean {
  if (job.status !== 'in_progress') return false
  const lastSignalMs = job.workCompletedAt ?? job.proposalAcceptedAt
  if (!lastSignalMs) return false
  const ageHours = (nowMs - lastSignalMs) / MS_PER_HOUR
  return ageHours > 72
}

/**
 * Returns true if the job is waiting for the customer to release payment.
 * This state occurs after the craftsman has marked work as complete and
 * requested payment release (payment.state === 'release_pending').
 */
export function isPaymentReleasePending(payment: Payment | undefined): boolean {
  return payment?.state === 'release_pending'
}
