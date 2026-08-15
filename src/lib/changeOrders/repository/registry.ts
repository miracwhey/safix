import { InMemoryChangeOrderRepository } from './InMemoryChangeOrderRepository'
import type { ChangeOrderRepository } from './ChangeOrderRepository'

let activeRepository: ChangeOrderRepository = new InMemoryChangeOrderRepository()

export function getChangeOrderRepository(): ChangeOrderRepository {
  return activeRepository
}

export function setChangeOrderRepository(repository: ChangeOrderRepository): void {
  activeRepository = repository
}

export async function initializeChangeOrderRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}
