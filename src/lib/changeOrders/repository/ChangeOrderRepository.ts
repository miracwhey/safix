import type { ChangeOrder } from '../types'

export interface ChangeOrderRepository {
  initialize(): Promise<void>

  /**
   * Returns `true` once the repository has completed its initial data load.
   * For InMemoryChangeOrderRepository this is always `true`.
   * For SupabaseChangeOrderRepository this becomes `true` after `initialize()` completes.
   */
  isHydrated(): boolean

  getAll(): ChangeOrder[]
  getById(changeOrderId: string): ChangeOrder | undefined
  /** Returns all ChangeOrders for a given job, ordered newest first. */
  getByJobId(jobId: string): ChangeOrder[]
  /** Returns the latest accepted ChangeOrder for a job, if any. */
  getAcceptedByJobId(jobId: string): ChangeOrder | undefined

  add(changeOrder: ChangeOrder): Promise<void>
  update(changeOrderId: string, updater: (co: ChangeOrder) => ChangeOrder): Promise<void>

  /** Best-effort lazy load of a single ChangeOrder by id (counterparty card /
   *  on-mount status refresh — there is no change_orders realtime channel).
   *  No-op for the in-memory repository. */
  ensureLoaded(changeOrderId: string): Promise<void>

  subscribe(listener: () => void): () => void
}
