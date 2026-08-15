import { InMemoryScheduleRepository } from './InMemoryScheduleRepository'
import type { ScheduleRepository } from './ScheduleRepository'

let activeRepository: ScheduleRepository = new InMemoryScheduleRepository()

export function getScheduleRepository(): ScheduleRepository {
  return activeRepository
}

export function setScheduleRepository(repository: ScheduleRepository): void {
  activeRepository = repository
}

export async function initializeScheduleRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}

export function restartScheduleRealtimeIfDead(options?: { force?: boolean }): void {
  (activeRepository as { restartRealtimeIfDead?: (options?: { force?: boolean }) => void }).restartRealtimeIfDead?.(options)
}
