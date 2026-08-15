import { InMemoryAnalyticsRepository } from './InMemoryAnalyticsRepository'
import type { AnalyticsRepository } from './AnalyticsRepository'

let activeRepository: AnalyticsRepository = new InMemoryAnalyticsRepository()

export function getAnalyticsRepository(): AnalyticsRepository {
  return activeRepository
}

export function setAnalyticsRepository(repository: AnalyticsRepository): void {
  activeRepository = repository
}

export async function initializeAnalyticsRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}
