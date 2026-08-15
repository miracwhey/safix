/**
 * Supplementary Payment Request — Repository Registry
 *
 * Service locator: same pattern used by every other domain in SaFix.
 * Default: InMemorySupplementaryPaymentRepository (no Supabase, no network).
 * Override with SupabaseSupplementaryPaymentRepository in bootstrapRepositories().
 */

import { InMemorySupplementaryPaymentRepository } from './InMemorySupplementaryPaymentRepository.js'
import type { SupplementaryPaymentRepository } from './SupplementaryPaymentRepository.js'

let activeRepository: SupplementaryPaymentRepository = new InMemorySupplementaryPaymentRepository()

export function getSupplementaryPaymentRepository(): SupplementaryPaymentRepository {
  return activeRepository
}

export function setSupplementaryPaymentRepository(repository: SupplementaryPaymentRepository): void {
  activeRepository = repository
}

export async function initializeSupplementaryPaymentRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}

export function restartSupplementaryPaymentRealtimeIfDead(options?: { force?: boolean }): void {
  (activeRepository as { restartRealtimeIfDead?: (options?: { force?: boolean }) => void }).restartRealtimeIfDead?.(options)
}
