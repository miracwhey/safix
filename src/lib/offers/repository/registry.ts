import { InMemoryOfferRepository } from './InMemoryOfferRepository'
import type { OfferRepository } from './OfferRepository'

let activeRepository: OfferRepository = new InMemoryOfferRepository()

export function getOfferRepository(): OfferRepository {
  return activeRepository
}

export function setOfferRepository(repository: OfferRepository): void {
  activeRepository = repository
}

/**
 * Calls `initialize()` on the currently active repository.
 * Must be awaited at application bootstrap before any reads or writes occur.
 * For `InMemoryOfferRepository` this resolves immediately.
 * For `SupabaseOfferRepository` this loads the initial dataset from the database.
 */
export async function initializeOfferRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}
