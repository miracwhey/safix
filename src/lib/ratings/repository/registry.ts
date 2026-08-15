import { InMemoryRatingRepository } from './InMemoryRatingRepository'
import type { RatingRepository } from './RatingRepository'

let activeRepository: RatingRepository = new InMemoryRatingRepository()

export function getRatingRepository(): RatingRepository {
  return activeRepository
}

export function setRatingRepository(repository: RatingRepository): void {
  activeRepository = repository
}

export async function initializeRatingRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}
