import type { Job } from './types'
import type { Payment } from '../payments/types'
import type { Dispute } from '../disputes/types'
import { ACTIVE_DISPUTE_STATUSES } from '../disputes/stateMachine'

export type JobHealthStatus = 'healthy' | 'attention' | 'blocked'

const MS_PER_HOUR = 1000 * 60 * 60

/**
 * Derives a simple 3-state job health summary from the job, optional payment,
 * and optional dispute.
 *
 * blocked
 *   - active dispute (status ∈ ACTIVE_DISPUTE_STATUSES)
 *   - payment frozen (state === 'disputed')
 *
 * attention
 *   - proposal pending > 48h (proposalSentAt set, no proposalAcceptedAt)
 *   - scheduling pending > 72h (proposalAcceptedAt set, not yet in_progress)
 *
 * healthy
 *   - everything else
 *
 * Pure function — no mutations, no side effects.
 */
export function deriveJobHealth(
  job: Job,
  payment?: Payment,
  dispute?: Dispute,
  nowMs = Date.now()
): JobHealthStatus {
  // blocked: open dispute or payment frozen
  if (dispute && ACTIVE_DISPUTE_STATUSES.has(dispute.status)) return 'blocked'
  if (payment?.state === 'disputed') return 'blocked'

  // attention: proposal pending > 48h
  if (job.proposalSentAt && !job.proposalAcceptedAt) {
    const ageHours = (nowMs - job.proposalSentAt) / MS_PER_HOUR
    if (ageHours > 48) return 'attention'
  }

  // attention: scheduling pending > 72h
  if (
    job.proposalAcceptedAt &&
    job.status !== 'in_progress' &&
    job.status !== 'waiting_payment' &&
    job.status !== 'completed' &&
    job.status !== 'cancelled'
  ) {
    const ageHours = (nowMs - job.proposalAcceptedAt) / MS_PER_HOUR
    if (ageHours > 72) return 'attention'
  }

  return 'healthy'
}
