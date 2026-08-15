import type { Job, TeamMember } from './types'
import { getJobRepository } from './repository'
import { getTeamMemberRepository } from '../team/repository'

export function subscribeJobs(listener: () => void): () => void {
  return getJobRepository().subscribe(listener)
}

export function getJobs(): Job[] {
  return getJobRepository().getAll()
}

export function getJobById(jobId: string): Job | undefined {
  return getJobRepository().getById(jobId)
}

/**
 * Returns the current team members from the TeamMemberRepository.
 * Reads are served from the canonical team member store, which is backed by
 * real Supabase persistence when VITE_DATA_SOURCE=supabase.
 */
export function getTeamMembers(): TeamMember[] {
  return getTeamMemberRepository().getAll()
}

export function reloadJobsFromService(): void {
  getJobRepository().reset()
}
