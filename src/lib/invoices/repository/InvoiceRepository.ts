import type { Invoice } from '../types'

export interface InvoiceRepository {
  initialize(): Promise<void>
  isHydrated(): boolean
  getAll(): Invoice[]
  getByJobId(jobId: string): Invoice | undefined
  /** Best-effort lazy-load of a single invoice by id not in the cache (RLS-scoped). */
  ensureLoaded(id: string): Promise<void>
  /**
   * Best-effort lazy-load of a job's original invoice (kind='invoice') not in
   * the cache (RLS-scoped). Distinct from ensureLoaded(id): the payment-sync
   * path only knows the jobId, and a provider's invoice can sit outside the
   * initial 200-row window. Resolves silently on a miss; the caller re-reads
   * via getByJobId afterwards.
   */
  ensureLoadedByJobId(jobId: string): Promise<void>
  /**
   * True when a server-side settle path owns the invoice→'paid' transition
   * (R3: the SECURITY DEFINER trigger on `payments`). When true, the client
   * payment-sync must NOT attempt the →'paid' write — it is RLS/immutability-
   * rejected and the 'paid' status arrives via realtime instead. When false
   * (in-memory / mock), no server exists, so the client drives →'paid' itself.
   * This is the single-writer boundary, not an error-swallow.
   */
  serverDrivesPaidStatus(): boolean
  add(invoice: Invoice): Promise<void>
  update(invoiceId: string, updater: (invoice: Invoice) => Invoice): Promise<void>
  subscribe(listener: () => void): () => void
  notify(): void
}
