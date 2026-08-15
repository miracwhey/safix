import { InMemoryTimeEntryRepository } from './InMemoryTimeEntryRepository'
import type { TimeEntryRepository } from './TimeEntryRepository'

let activeRepository: TimeEntryRepository = new InMemoryTimeEntryRepository()

export function getTimeEntryRepository(): TimeEntryRepository {
  return activeRepository
}

export function setTimeEntryRepository(repository: TimeEntryRepository): void {
  activeRepository = repository
}

/**
 * Calls `initialize()` on the currently active repository.
 * Must be awaited at application bootstrap before any time-tracking
 * reads or writes occur. For `InMemoryTimeEntryRepository` this resolves
 * immediately. For `SupabaseTimeEntryRepository` this loads the visible
 * dataset and starts the realtime subscription.
 */
export async function initializeTimeEntryRepository(forResync = false): Promise<void> {
  if (forResync) {
    ;(activeRepository as { prepareForResync?: () => void }).prepareForResync?.()
  }
  await activeRepository.initialize()
}

export function restartTimeEntryRealtimeIfDead(options?: { force?: boolean }): void {
  ;(activeRepository as { restartRealtimeIfDead?: (options?: { force?: boolean }) => void }).restartRealtimeIfDead?.(options)
}
