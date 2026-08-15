import { InMemoryAcceptanceRepository } from './InMemoryAcceptanceRepository'
import type { AcceptanceRepository } from './AcceptanceRepository'

let activeRepository: AcceptanceRepository = new InMemoryAcceptanceRepository()

export function getAcceptanceRepository(): AcceptanceRepository {
  return activeRepository
}

export function setAcceptanceRepository(repository: AcceptanceRepository): void {
  activeRepository = repository
}

export async function initializeAcceptanceRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}
