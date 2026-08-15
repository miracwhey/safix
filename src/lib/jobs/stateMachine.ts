import type { JobStatus } from '../shared/coreTypes'

export const allowedJobTransitions: Record<JobStatus, JobStatus[]> = {
  new: ['booked', 'scheduled', 'in_progress', 'cancelled'],
  booked: ['scheduled', 'in_progress', 'cancelled'],
  scheduled: ['in_progress', 'cancelled'],
  in_progress: ['waiting_payment', 'cancelled'],
  waiting_payment: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
}

/** Terminal job statuses — no further transitions allowed */
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  'completed',
  'cancelled',
])

export function canTransitionJob(
  from: JobStatus,
  to: JobStatus
): boolean {
  return allowedJobTransitions[from].includes(to)
}
