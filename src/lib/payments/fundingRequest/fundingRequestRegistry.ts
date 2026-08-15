/**
 * Funding Request Repository — Service Locator
 *
 * Same pattern used by every other domain in SaFix.
 */

import { InMemoryFundingRequestRepository } from './InMemoryFundingRequestRepository.js'
import type { FundingRequestRepository } from './fundingRequestRepository.js'

let activeRepository: FundingRequestRepository = new InMemoryFundingRequestRepository()

export function getFundingRequestRepository(): FundingRequestRepository {
  return activeRepository
}

export function setFundingRequestRepository(repository: FundingRequestRepository): void {
  activeRepository = repository
}

export async function initializeFundingRequestRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}

export function restartFundingRequestRealtimeIfDead(options?: { force?: boolean }): void {
  (activeRepository as { restartRealtimeIfDead?: (options?: { force?: boolean }) => void }).restartRealtimeIfDead?.(options)
}
