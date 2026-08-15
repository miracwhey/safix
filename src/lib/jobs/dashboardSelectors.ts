import type { Job } from './types'
import { getActionablePaymentState } from './helpers'

/**
 * Returns jobs that are currently in progress.
 * These are the most operationally active jobs.
 */
export function getJobsInProgress(jobs: Job[]): Job[] {
  return jobs.filter((job) => job.status === 'in_progress')
}

/**
 * Returns jobs waiting for payment release.
 * Primary check: 'waiting_payment' job status (set by finishJobWorkflow).
 * Belt-and-suspenders: also catches jobs whose cached paymentState is
 * 'release_pending' but whose status may lag (e.g. during store hydration).
 * After lifecycle hardening, status and paymentState are always co-updated so
 * both checks should be equivalent in practice.
 */
export function getJobsWaitingPayment(jobs: Job[]): Job[] {
  return jobs.filter((job) => {
    const paymentState = getActionablePaymentState(job)
    return job.status === 'waiting_payment' || paymentState === 'release_pending'
  })
}

/**
 * Returns jobs that are scheduled (upcoming work).
 */
export function getUpcomingScheduledJobs(jobs: Job[]): Job[] {
  return jobs.filter((job) => job.status === 'scheduled')
}

/**
 * Returns new incoming requests requiring attention.
 */
export function getNewIncomingJobs(jobs: Job[]): Job[] {
  return jobs.filter((job) => job.status === 'new')
}

/**
 * Returns jobs that require immediate operator attention, ordered by urgency.
 * Urgent = waiting_payment/release_pending, then in_progress, then new.
 */
export function getUrgentJobs(jobs: Job[]): Job[] {
  const urgent = jobs.filter((job) => {
    const paymentState = getActionablePaymentState(job)
    return job.status === 'waiting_payment' || paymentState === 'release_pending'
  })
  const active = jobs.filter(
    (job) =>
      job.status === 'in_progress' &&
      getActionablePaymentState(job) !== 'release_pending'
  )
  const incoming = jobs.filter((job) => job.status === 'new')

  return [...urgent, ...active, ...incoming]
}

/**
 * Returns all non-completed jobs with at least some activity.
 * Returns up to `limit` jobs in their current store order.
 */
export function getRecentlyActiveJobs(jobs: Job[], limit = 5): Job[] {
  return jobs
    .filter((job) => job.status !== 'completed' && job.status !== 'cancelled' && job.activities.length > 0)
    .slice(0, limit)
}

/**
 * Returns the most recently completed jobs, capped to `limit`.
 *
 * Uses the same priority ordering as `sortJobsByPriority` so that the
 * most relevant completed jobs surface first when the list is truncated.
 * Callers that want to render a bounded "recently completed" section
 * should prefer this helper over filtering + sorting inline.
 */
export function getRecentCompletedJobs(
  jobs: Job[],
  limit: number,
  sortFn: (jobs: Job[]) => Job[],
): Job[] {
  const completed = jobs.filter((job) => job.status === 'completed')
  return sortFn(completed).slice(0, limit)
}

/**
 * Returns the count of jobs that need operator attention
 * (new, in_progress, or waiting_payment).
 */
export function getAttentionJobCount(jobs: Job[]): number {
  return jobs.filter(
    (job) =>
      job.status === 'new' ||
      job.status === 'in_progress' ||
      job.status === 'waiting_payment'
  ).length
}
