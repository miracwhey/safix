import { InMemoryTimelineRepository } from './InMemoryTimelineRepository'
import type { TimelineRepository } from './TimelineRepository'

let activeRepository: TimelineRepository = new InMemoryTimelineRepository()

export function getTimelineRepository(): TimelineRepository {
  return activeRepository
}

export function setTimelineRepository(repository: TimelineRepository): void {
  activeRepository = repository
}

export async function initializeTimelineRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}

export function restartTimelineRealtimeIfDead(options?: { force?: boolean }): void {
  (activeRepository as { restartRealtimeIfDead?: (options?: { force?: boolean }) => void }).restartRealtimeIfDead?.(options)
}
