import type { Job } from './types'
import type { TeamMember } from './types'
import { isJobOperational } from './helpers'

/**
 * Statuses considered "active" for team workload purposes.
 * Used consistently across all selectors in this module.
 */
const ACTIVE_STATUSES = new Set<Job['status']>(['new', 'scheduled', 'in_progress'])

/**
 * Returns all jobs where the given member ID appears in assignedMemberIds.
 * The workerId here is a TeamMember.id (not a Supabase user ID).
 */
export function getWorkerAssignmentSummary(
  jobs: Job[],
  workerId: string
): Job[] {
  return jobs.filter((job) => job.assignedMemberIds.includes(workerId))
}

export type WorkerWorkload = {
  memberId: string
  memberName: string
  memberRole: string
  totalJobs: number
  activeJobs: Job[]
  scheduledJobs: Job[]
}

/**
 * Returns per-worker assignment counts and active job lists for all team members.
 * Useful for owner operational overview: who has how much work, and what jobs.
 *
 * Members with zero jobs are included so the owner can see the full team.
 */
export function getTeamWorkloadDistribution(
  jobs: Job[],
  teamMembers: TeamMember[]
): WorkerWorkload[] {
  return teamMembers.map((member) => {
    const activeJobs: Job[] = []
    const scheduledJobs: Job[] = []
    let totalJobs = 0

    for (const job of jobs) {
      if (!job.assignedMemberIds.includes(member.id)) continue
      totalJobs++
      if (ACTIVE_STATUSES.has(job.status) && isJobOperational(job)) {
        activeJobs.push(job)
      }
      if (job.status === 'scheduled') scheduledJobs.push(job)
    }

    return {
      memberId: member.id,
      memberName: member.name,
      memberRole: member.role,
      totalJobs,
      activeJobs,
      scheduledJobs,
    }
  })
}

/**
 * Returns non-completed jobs that have upcoming scheduled dates.
 * Jobs are considered "upcoming" when status is 'scheduled' or 'new'.
 * When calendarEntries are provided, they are used to enrich the result
 * with date context; without them we simply return scheduled/new jobs.
 *
 * Note: Job.dateLabel is a display string (e.g. "15. Jul 2025"), not a
 * sortable timestamp — we return in store order.
 */
export function getUpcomingWorkPressure(jobs: Job[]): Job[] {
  return jobs.filter(
    (job) =>
      job.status === 'scheduled' ||
      (job.status === 'new' && job.proposalAcceptedAt !== undefined)
  )
}

export type JobsByWorker = Record<
  string,
  { memberName: string; jobs: Job[] }
>

/**
 * Groups currently active jobs (in_progress + scheduled) by the team member ID
 * of each assigned worker. A job that is assigned to multiple members will
 * appear under each member's bucket.
 *
 * Members with zero active jobs are NOT included in the result — only members
 * who appear in at least one active job's assignedMemberIds are returned.
 *
 * Uses teamMembers to resolve member IDs → display names.
 */
export function getActiveJobsByWorker(
  jobs: Job[],
  teamMembers: TeamMember[]
): JobsByWorker {
  const nameMap = new Map(teamMembers.map((m) => [m.id, m.name]))

  const activeJobs = jobs.filter(
    (job) => ACTIVE_STATUSES.has(job.status) && isJobOperational(job)
  )

  const result: JobsByWorker = {}

  for (const job of activeJobs) {
    for (const memberId of job.assignedMemberIds) {
      if (!result[memberId]) {
        result[memberId] = {
          memberName: nameMap.get(memberId) ?? memberId,
          jobs: [],
        }
      }
      result[memberId].jobs.push(job)
    }
  }

  return result
}

/**
 * Returns all jobs that have no assigned team members.
 * Useful for the owner to identify work that needs to be staffed.
 */
export function getUnassignedJobs(jobs: Job[]): Job[] {
  return jobs.filter(
    (job) =>
      job.assignedMemberIds.length === 0 &&
      job.status !== 'completed' &&
      job.status !== 'cancelled' &&
      isJobOperational(job)
  )
}
