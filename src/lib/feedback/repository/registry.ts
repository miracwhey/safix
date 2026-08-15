import { InMemoryFeedbackRepository } from './InMemoryFeedbackRepository'
import type { FeedbackRepository } from './FeedbackRepository'

let activeRepository: FeedbackRepository = new InMemoryFeedbackRepository()

export function getFeedbackRepository(): FeedbackRepository {
  return activeRepository
}

export function setFeedbackRepository(repository: FeedbackRepository): void {
  activeRepository = repository
}

/**
 * Calls `initialize()` on the currently active repository.
 * Must be awaited at application bootstrap before any reads or writes occur.
 * For `InMemoryFeedbackRepository` this resolves immediately.
 * For `SupabaseFeedbackRepository` this loads the initial dataset from the database.
 */
export async function initializeFeedbackRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}
