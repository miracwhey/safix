import { InMemoryPaymentRepository } from './InMemoryPaymentRepository.js'
import type { PaymentRepository } from './PaymentRepository.js'

let activeRepository: PaymentRepository = new InMemoryPaymentRepository()

export function getPaymentRepository(): PaymentRepository {
  return activeRepository
}

export function setPaymentRepository(repository: PaymentRepository): void {
  activeRepository = repository
}

export async function initializePaymentRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}

export function restartPaymentRealtimeIfDead(options?: { force?: boolean }): void {
  (activeRepository as { restartRealtimeIfDead?: (options?: { force?: boolean }) => void }).restartRealtimeIfDead?.(options)
}
