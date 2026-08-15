import { InMemoryProjectRepository } from './InMemoryProjectRepository'
import type { ProjectRepository } from './ProjectRepository'

let activeRepository: ProjectRepository = new InMemoryProjectRepository()

export function getProjectRepository(): ProjectRepository {
  return activeRepository
}

export function setProjectRepository(repository: ProjectRepository): void {
  activeRepository = repository
}

/**
 * Calls `initialize()` on the currently active repository.
 * Must be awaited at application bootstrap before any reads or writes occur.
 * For `InMemoryProjectRepository` this resolves immediately.
 * For `SupabaseProjectRepository` this loads the initial dataset from the database.
 */
export async function initializeProjectRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}
