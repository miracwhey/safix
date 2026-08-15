import { InMemoryDisputeRepository } from './InMemoryDisputeRepository'
import type { DisputeRepository } from './DisputeRepository'

let activeRepository: DisputeRepository = new InMemoryDisputeRepository()

export function getDisputeRepository(): DisputeRepository {
  return activeRepository
}

export function setDisputeRepository(repository: DisputeRepository): void {
  activeRepository = repository
}

export async function initializeDisputeRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}

export function restartDisputeRealtimeIfDead(options?: { force?: boolean }): void {
  (activeRepository as { restartRealtimeIfDead?: (options?: { force?: boolean }) => void }).restartRealtimeIfDead?.(options)
}
