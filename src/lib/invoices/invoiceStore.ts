import { getInvoiceRepository } from './repository'
import type { Invoice } from './types'

type Listener = () => void

export function subscribeInvoices(listener: Listener): () => void {
  return getInvoiceRepository().subscribe(listener)
}

export function getInvoices(): Invoice[] {
  return getInvoiceRepository().getAll()
}

export function getInvoiceByJobId(jobId: string): Invoice | undefined {
  return getInvoiceRepository().getByJobId(jobId)
}

export function getInvoiceById(invoiceId: string): Invoice | undefined {
  return getInvoiceRepository().getAll().find((inv) => inv.id === invoiceId)
}

/**
 * Best-effort lazy load of an invoice not in the user-scoped cache (e.g. a
 * customer opening a Rechnung card). RLS decides visibility; on success
 * listeners fire and getInvoiceById resolves.
 */
export function ensureInvoiceLoaded(invoiceId: string): Promise<void> {
  return getInvoiceRepository().ensureLoaded(invoiceId)
}

export function isInvoiceRepositoryHydrated(): boolean {
  return getInvoiceRepository().isHydrated()
}
