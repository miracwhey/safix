import { InMemoryInvoiceRepository } from './InMemoryInvoiceRepository'
import type { InvoiceRepository } from './InvoiceRepository'

let activeRepository: InvoiceRepository = new InMemoryInvoiceRepository()

export function getInvoiceRepository(): InvoiceRepository {
  return activeRepository
}

export function setInvoiceRepository(repository: InvoiceRepository): void {
  activeRepository = repository
}

export async function initializeInvoiceRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}

/** Resume-cascade passthrough (R4) — duck-typed so the in-memory repo no-ops. */
export function restartInvoiceRealtimeIfDead(options?: { force?: boolean }): void {
  (activeRepository as { restartRealtimeIfDead?: (options?: { force?: boolean }) => void }).restartRealtimeIfDead?.(options)
}
