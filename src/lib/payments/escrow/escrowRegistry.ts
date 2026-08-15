/**
 * Escrow Plan Repository — Service Locator
 *
 * Same pattern used by every other domain in SaFix:
 *   - activeRepository starts as InMemory
 *   - production code calls setEscrowPlanRepository() at boot with
 *     a Supabase-backed implementation
 *   - tests call setEscrowPlanRepository(new InMemoryEscrowPlanRepository())
 */

import { InMemoryEscrowPlanRepository } from './InMemoryEscrowPlanRepository.js'
import type { EscrowPlanRepository } from './escrowRepository.js'

let activeRepository: EscrowPlanRepository = new InMemoryEscrowPlanRepository()

export function getEscrowPlanRepository(): EscrowPlanRepository {
  return activeRepository
}

export function setEscrowPlanRepository(repository: EscrowPlanRepository): void {
  activeRepository = repository
}

export async function initializeEscrowPlanRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}

export function restartEscrowPlanRealtimeIfDead(options?: { force?: boolean }): void {
  (activeRepository as { restartRealtimeIfDead?: (options?: { force?: boolean }) => void }).restartRealtimeIfDead?.(options)
}
