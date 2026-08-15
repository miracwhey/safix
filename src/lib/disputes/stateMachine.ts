import type { DisputeStatus } from './types'

/**
 * Lifecycle states in which a dispute is still active and blocks job/payment
 * progression. Mirrors the production active-dispute index:
 *   `disputes_one_active_per_job_idx` UNIQUE WHERE status IN
 *     ('open','under_review','customer_waiting','provider_waiting').
 */
export const ACTIVE_DISPUTE_STATUSES = new Set<DisputeStatus>([
  'open',
  'under_review',
  'customer_waiting',
  'provider_waiting',
])

/**
 * Lifecycle states in which a dispute is finalised. The decision/booking
 * outcome is read from `decision` + `resolutionType` on the dispute itself.
 */
export const TERMINAL_DISPUTE_STATUSES = new Set<DisputeStatus>([
  'resolved',
  'closed',
  'cancelled',
])

export const disputeAllowedTransitions: Record<DisputeStatus, DisputeStatus[]> = {
  open: ['under_review', 'customer_waiting', 'provider_waiting', 'cancelled'],
  customer_waiting: ['under_review', 'resolved', 'cancelled'],
  provider_waiting: ['under_review', 'resolved', 'cancelled'],
  under_review: ['customer_waiting', 'provider_waiting', 'resolved', 'cancelled'],
  resolved: ['closed'],
  closed: [],
  cancelled: [],
}

/** Returns true if the dispute is in a non-terminal, blocking state. */
export function isDisputeBlocking(status: DisputeStatus): boolean {
  return ACTIVE_DISPUTE_STATUSES.has(status)
}

/** Returns true if the dispute lifecycle has reached a terminal state. */
export function isTerminalDisputeStatus(status: DisputeStatus): boolean {
  return TERMINAL_DISPUTE_STATUSES.has(status)
}

export function canTransitionDispute(
  from: DisputeStatus,
  to: DisputeStatus
): boolean {
  return disputeAllowedTransitions[from].includes(to)
}
