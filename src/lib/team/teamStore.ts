import type { TeamMember } from '../jobs/types'
import { getTeamMemberRepository, initializeTeamMemberRepository } from './repository'

export function getTeamMembers(): TeamMember[] {
  return getTeamMemberRepository().getAll()
}

export function subscribeTeamMembers(listener: () => void): () => void {
  return getTeamMemberRepository().subscribe(listener)
}

export function isTeamMembersHydrated(): boolean {
  return getTeamMemberRepository().isHydrated()
}

export function retryTeamMembersHydration(): void {
  void initializeTeamMemberRepository(true)
}
