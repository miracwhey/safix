/**
 * Active Work Context Resolver — Block 6
 *
 * Resolves whether an expired owner has an active escrow-bound job that
 * qualifies for the Active-Work-Exception. Uses canonical repository data,
 * not screen-level projections.
 *
 * Active escrow = escrow plan status is 'funded_in_escrow' or 'partially_released'.
 * Bound thread = job.sourceConversationId (persisted DB value).
 */

import { getJobs, type Job } from '../jobs'
import { getEscrowPlanByJobId } from '../payments/escrow'
import type { EscrowPlanStatus } from '../payments/escrow/escrowTypes'
import type { ActiveWorkContext } from './types'

const ACTIVE_ESCROW_STATUSES: ReadonlySet<EscrowPlanStatus> = new Set([
  'funded_in_escrow',
  'partially_released',
])

const ACTIVE_JOB_STATUSES: ReadonlySet<string> = new Set([
  'booked',
  'in_progress',
  'waiting_payment',
])

/**
 * Resolves the ActiveWorkContext for a specific job.
 * Returns null if the job does not qualify (no active escrow).
 */
export function resolveActiveWorkContextForJob(jobId: string): ActiveWorkContext | null {
  const jobs = getJobs()
  const job = jobs.find((j) => j.id === jobId)
  if (!job) return null
  return buildContext(job)
}

/**
 * Resolves all active-work contexts for the current owner's jobs.
 * Used by the entitlement layer to check if ANY active escrow job exists.
 */
export function resolveAllActiveWorkContexts(): ActiveWorkContext[] {
  const jobs = getJobs()
  const contexts: ActiveWorkContext[] = []

  for (const job of jobs) {
    if (!ACTIVE_JOB_STATUSES.has(job.status)) continue
    const ctx = buildContext(job)
    if (ctx && ctx.hasActiveEscrow) {
      contexts.push(ctx)
    }
  }

  return contexts
}

function buildContext(job: Job): ActiveWorkContext | null {
  const escrowPlan = getEscrowPlanByJobId(job.id)
  if (!escrowPlan) return null

  const hasActiveEscrow = ACTIVE_ESCROW_STATUSES.has(escrowPlan.status)
  if (!hasActiveEscrow) return null

  return {
    jobId: job.id,
    hasActiveEscrow: true,
    boundThreadId: job.sourceConversationId ?? null,
  }
}
