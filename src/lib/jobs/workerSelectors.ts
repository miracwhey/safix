import type { Job, TeamMember } from './types'

/**
 * Returns jobs that are actively assigned to a specific user, bridging
 * their Supabase user ID → TeamMember.id → Job.assignedMemberIds.
 *
 * Resolution order:
 * 1. Find the TeamMember whose `userId` matches the provided `userId`.
 * 2. Return jobs where the member's `id` appears in `assignedMemberIds`.
 * 3. Fallback: treat `userId` as a direct member ID (backward compat / demo).
 */
export function getAssignedJobsForUser(
  jobs: Job[],
  teamMembers: TeamMember[],
  userId: string
): Job[] {
  const member = teamMembers.find((m) => m.userId === userId)
  const memberId = member?.id ?? userId
  return jobs.filter((job) => job.assignedMemberIds.includes(memberId))
}

/**
 * Returns active jobs assigned to a user — excludes 'completed' and
 * 'waiting_payment' (execution work done; payment release is a customer/owner
 * action) so the worker sees only jobs with remaining execution work.
 * 'new' and 'scheduled' jobs are included because they represent upcoming or
 * assigned-but-not-started work.
 *
 * Lifecycle alignment: once a worker calls markWorkCompleteWorkflow, the job
 * transitions to 'waiting_payment' and drops off the active list automatically.
 */
export function getActiveAssignedJobsForUser(
  jobs: Job[],
  teamMembers: TeamMember[],
  userId: string
): Job[] {
  return getAssignedJobsForUser(jobs, teamMembers, userId).filter(
    (job) => job.status !== 'completed' && job.status !== 'cancelled' && job.status !== 'waiting_payment'
  )
}

// ---------------------------------------------------------------------------
// Worker linkage diagnostic
// ---------------------------------------------------------------------------

/**
 * Linkage state between a Supabase user and the team member registry.
 *
 * - `linked`     – a TeamMember record exists with a matching `userId` field
 * - `unlinked`   – no TeamMember record has this `userId`; worker may not see
 *                  their assigned jobs (data integrity gap)
 * - `no_members` – the team member list itself is empty (bootstrapping or
 *                  data not yet loaded)
 */
export type WorkerLinkageState = 'linked' | 'unlinked' | 'no_members'

export type WorkerLinkageDiagnostic = {
  /** Resolved linkage state for this user */
  linkageState: WorkerLinkageState
  /** True when the user has a confirmed team member record */
  isLinked: boolean
  /**
   * True when the team members list is non-empty but this user has no
   * matching record — indicates a data integrity problem.
   */
  hasLinkageGap: boolean
  /**
   * Display name of the linked team member, if found.
   * Null when linkageState is not 'linked'.
   */
  linkedMemberName: string | null
}

/**
 * Derives the worker linkage diagnostic for a given user.
 *
 * Checks whether any TeamMember record has `userId` matching the provided
 * Supabase user ID. If no match is found and the team list is non-empty,
 * this indicates that the worker account is not linked to a team member
 * record — meaning assigned-job lookups will silently return empty.
 *
 * Pure function — does not read from any store.
 */
export function deriveWorkerLinkageDiagnostic(
  userId: string | undefined,
  teamMembers: TeamMember[]
): WorkerLinkageDiagnostic {
  if (!userId) {
    return {
      linkageState: teamMembers.length === 0 ? 'no_members' : 'unlinked',
      isLinked: false,
      hasLinkageGap: teamMembers.length > 0,
      linkedMemberName: null,
    }
  }

  if (teamMembers.length === 0) {
    return {
      linkageState: 'no_members',
      isLinked: false,
      hasLinkageGap: false,
      linkedMemberName: null,
    }
  }

  const member = teamMembers.find((m) => m.userId === userId)

  if (member) {
    return {
      linkageState: 'linked',
      isLinked: true,
      hasLinkageGap: false,
      linkedMemberName: member.name,
    }
  }

  return {
    linkageState: 'unlinked',
    isLinked: false,
    hasLinkageGap: true,
    linkedMemberName: null,
  }
}
