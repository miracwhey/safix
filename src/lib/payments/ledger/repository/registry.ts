import { InMemoryLedgerRepository } from './InMemoryLedgerRepository.js'
import type { LedgerRepository } from './LedgerRepository.js'

let activeRepository: LedgerRepository = new InMemoryLedgerRepository()

export function getLedgerRepository(): LedgerRepository {
  return activeRepository
}

export function setLedgerRepository(repository: LedgerRepository): void {
  activeRepository = repository
}

export async function initializeLedgerRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}
