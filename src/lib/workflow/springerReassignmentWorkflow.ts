/**
 * Springer reassignment workflow — Block 3.
 *
 * Owner-driven: when a worker is sick, the owner picks a Springer to take
 * over the sick member's jobs for today. Each per-job swap is atomic via
 * the `reassign_job_member` RPC (which also writes the audit row in the
 * same transaction).
 *
 * Multi-job semantics: if the owner picks a single Springer to cover all
 * affected jobs, we run the per-job swaps in sequence. Idempotent — a
 * partial-failure retry converges (the RPC handles the "to-already-present"
 * and "from-already-missing" cases as no-ops).
 */

import { assertOwnerRole } from '../auth/rbacGuards'
import { getJobRepository } from '../jobs/repository/registry'
import type { Job } from '../jobs/types'
import { logError, logInfo } from '../observability'
import type { SessionState } from '../session'

export type SpringerReassignmentResult = {
  jobId: string
  status: 'reassigned' | 'failed'
  error?: string
}

export async function reassignSpringerWorkflow(
  jobIds: string[],
  fromMemberId: string,
  toMemberId: string,
  options: { session?: SessionState } = {},
): Promise<SpringerReassignmentResult[]> {
  assertOwnerRole(options.session)
  if (fromMemberId === toMemberId) {
    throw new Error('reassign: fromMemberId and toMemberId must differ')
  }

  const repo = getJobRepository()
  const results: SpringerReassignmentResult[] = []

  for (const jobId of jobIds) {
    try {
      await repo.reassignAssignedMember(jobId, fromMemberId, toMemberId)
      logInfo('springerReassign.success', { jobId, fromMemberId, toMemberId })
      results.push({ jobId, status: 'reassigned' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logError('springerReassign.job_failed', err as Error, {
        jobId,
        fromMemberId,
        toMemberId,
      })
      results.push({ jobId, status: 'failed', error: message })
    }
  }

  return results
}

/**
 * Convenience: filter jobs to those assigned to the from-member that are
 * still operational today. Caller passes the result into
 * `reassignSpringerWorkflow`.
 */
export function selectJobsForSpringer(jobs: Job[], fromMemberId: string): Job[] {
  return jobs.filter(
    (j) =>
      j.assignedMemberIds.includes(fromMemberId) &&
      (j.status === 'new' || j.status === 'scheduled' || j.status === 'in_progress'),
  )
}
