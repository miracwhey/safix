import { InMemoryMediaRepository } from './InMemoryMediaRepository'
import type { MediaRepository } from './MediaRepository'

let activeRepository: MediaRepository = new InMemoryMediaRepository()

export function getMediaRepository(): MediaRepository {
  return activeRepository
}

export function setMediaRepository(repository: MediaRepository): void {
  activeRepository = repository
}

export async function initializeMediaRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}
