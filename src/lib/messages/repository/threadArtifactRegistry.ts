import { InMemoryThreadArtifactRepository } from './InMemoryThreadArtifactRepository'
import type { ThreadArtifactRepository } from '../threadArtifactRecord'

let activeRepository: ThreadArtifactRepository =
  new InMemoryThreadArtifactRepository()

export function getThreadArtifactRepository(): ThreadArtifactRepository {
  return activeRepository
}

/**
 * Subscribe to changes in the active thread artifact repository cache.
 * Fires when artifacts are loaded from the database, upserted, or cleared.
 */
export function subscribeThreadArtifacts(listener: () => void): () => void {
  return activeRepository.subscribe(listener)
}

export function setThreadArtifactRepository(
  repository: ThreadArtifactRepository
): void {
  activeRepository = repository
}

/**
 * Calls `initialize()` on the currently active repository if it exposes one.
 * Must be awaited at application bootstrap before any reads or writes occur.
 * For `InMemoryThreadArtifactRepository` this resolves immediately.
 * For `SupabaseThreadArtifactRepository` this loads the initial dataset
 * from the Supabase `thread_artifacts` table for the current user.
 */
export async function initializeThreadArtifactRepository(forResync = false): Promise<void> {
  const repo = activeRepository as { prepareForResync?: () => void; initialize?: () => Promise<void> }
  if (forResync) repo.prepareForResync?.()
  if (typeof repo.initialize === 'function') {
    await repo.initialize()
  }
}
