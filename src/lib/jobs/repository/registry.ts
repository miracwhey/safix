import { InMemoryJobRepository } from './InMemoryJobRepository'
import type { JobRepository } from './JobRepository'

let activeRepository: JobRepository = new InMemoryJobRepository()

export function getJobRepository(): JobRepository {
  return activeRepository
}

export function setJobRepository(repository: JobRepository): void {
  activeRepository = repository
}

/**
 * Calls `initialize()` on the currently active repository.
 * Must be awaited at application bootstrap before any reads or writes occur.
 * For `InMemoryJobRepository` this resolves immediately.
 * For `SupabaseJobRepository` this loads the initial dataset from the database.
 */
export async function initializeJobRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}

export function restartJobRealtimeIfDead(options?: { force?: boolean }): void {
  (activeRepository as { restartRealtimeIfDead?: (options?: { force?: boolean }) => void }).restartRealtimeIfDead?.(options)
}
