import { InMemoryAbsenceRepository } from './InMemoryAbsenceRepository'
import type { AbsenceRepository } from './AbsenceRepository'

let activeRepository: AbsenceRepository = new InMemoryAbsenceRepository()

export function getAbsenceRepository(): AbsenceRepository {
  return activeRepository
}

export function setAbsenceRepository(repository: AbsenceRepository): void {
  activeRepository = repository
}

/**
 * Calls `initialize()` on the currently active repository. Must be awaited at
 * application bootstrap before any absence reads or writes occur. For
 * `InMemoryAbsenceRepository` this resolves immediately. For
 * `SupabaseAbsenceRepository` this loads the visible dataset and starts the
 * realtime subscription.
 */
export async function initializeAbsenceRepository(forResync = false): Promise<void> {
  if (forResync) {
    ;(activeRepository as { prepareForResync?: () => void }).prepareForResync?.()
  }
  await activeRepository.initialize()
}

export function restartAbsenceRealtimeIfDead(options?: { force?: boolean }): void {
  ;(activeRepository as { restartRealtimeIfDead?: (options?: { force?: boolean }) => void }).restartRealtimeIfDead?.(options)
}
