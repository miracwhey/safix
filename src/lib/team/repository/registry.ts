import { InMemoryTeamMemberRepository } from './InMemoryTeamMemberRepository'
import type { TeamMemberRepository } from './TeamMemberRepository'

let activeRepository: TeamMemberRepository = new InMemoryTeamMemberRepository()

export function getTeamMemberRepository(): TeamMemberRepository {
  return activeRepository
}

export function setTeamMemberRepository(repository: TeamMemberRepository): void {
  activeRepository = repository
}

/**
 * Calls `initialize()` on the currently active repository.
 * Must be awaited at application bootstrap before any reads or writes occur.
 * For `InMemoryTeamMemberRepository` this resolves immediately.
 * For `SupabaseTeamMemberRepository` this loads the initial dataset from the database.
 */
export async function initializeTeamMemberRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}
