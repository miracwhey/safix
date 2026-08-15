import { InMemoryCalendarRepository } from './InMemoryCalendarRepository'
import { mockCalendarEntries } from '../mockData'
import type { CalendarRepository } from './CalendarRepository'

// App-level default: seed with demo data for in-memory mode.
// Tests must inject their own repository via setCalendarRepository() to stay isolated.
let activeRepository: CalendarRepository = new InMemoryCalendarRepository([...mockCalendarEntries])

export function getCalendarRepository(): CalendarRepository {
  return activeRepository
}

export function setCalendarRepository(repository: CalendarRepository): void {
  activeRepository = repository
}

export async function initializeCalendarRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}

export function restartCalendarRealtimeIfDead(options?: { force?: boolean }): void {
  (activeRepository as { restartRealtimeIfDead?: (options?: { force?: boolean }) => void }).restartRealtimeIfDead?.(options)
}

/**
 * Awaits any in-flight supabase writes currently pending in the calendar
 * repository.  Used by `resyncRepositories` to break the race where a
 * subscriber-driven `replace()` fires during `initializeCalendarRepository`
 * (or any sibling repo's notify cascade) and the supabase update rejects
 * AFTER `clearPersistenceFailures` has already run — without the drain the
 * post-clear failure re-shows the SyncStatusBar and the user reads the
 * retry as a no-op.
 *
 * No-op for repositories without async writes (e.g. InMemoryCalendarRepository).
 */
export async function drainCalendarInFlightWrites(maxWaitMs = 5_000): Promise<void> {
  await (activeRepository as { drainInFlightWrites?: (ms?: number) => Promise<void> })
    .drainInFlightWrites?.(maxWaitMs)
}
