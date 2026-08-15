import { InMemoryCorrectionRepository } from './InMemoryCorrectionRepository'
import type { CorrectionRepository } from './CorrectionRepository'

let activeRepository: CorrectionRepository = new InMemoryCorrectionRepository()

export function getCorrectionRepository(): CorrectionRepository {
  return activeRepository
}

export function setCorrectionRepository(repository: CorrectionRepository): void {
  activeRepository = repository
}

export async function initializeCorrectionRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}
