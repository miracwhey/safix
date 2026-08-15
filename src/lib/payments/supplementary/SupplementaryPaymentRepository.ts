/**
 * Supplementary Payment Request — Repository Interface
 *
 * Persistence contract for SupplementaryPaymentRequest entities.
 * Implementations: InMemory (tests/dev), Supabase (production).
 */

import type { SupplementaryPaymentRequest } from './types.js'

export interface SupplementaryPaymentRepository {
  /** One-time async initialisation (e.g. fetch from Supabase). */
  initialize(): Promise<void>

  /**
   * Returns `true` once the repository has completed its initial data load.
   * InMemorySupplementaryPaymentRepository always returns `true`.
   */
  isHydrated(): boolean

  /** Return all supplementary payment requests. */
  getAll(): SupplementaryPaymentRequest[]

  /** Find a request by its unique ID. */
  getById(id: string): SupplementaryPaymentRequest | undefined

  /** Find a request by the ChangeOrder it was created for (at most one per CO). */
  getByChangeOrderId(changeOrderId: string): SupplementaryPaymentRequest | undefined

  /** Find all requests linked to a job (a job can have multiple accepted COs). */
  getByJobId(jobId: string): SupplementaryPaymentRequest[]

  /** Persist a new supplementary payment request. */
  add(request: SupplementaryPaymentRequest): Promise<void>

  /** Update an existing request in-place. */
  update(id: string, updater: (r: SupplementaryPaymentRequest) => SupplementaryPaymentRequest): Promise<void>

  /** Subscribe to data changes. */
  subscribe(listener: () => void): () => void
}
