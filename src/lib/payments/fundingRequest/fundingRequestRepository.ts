/**
 * Funding Request Repository — Interface
 *
 * Persistence contract for funding request entities.
 * Implementations: InMemory (tests/dev), Supabase (production).
 */

import type { FundingRequest } from './types.js'

export interface FundingRequestRepository {
  /** One-time async initialisation (e.g. fetch from Supabase). */
  initialize(): Promise<void>

  /**
   * Returns `true` once the repository has completed its initial data load
   * (i.e. `initialize()` has resolved at least once).
   *
   * Used by screens that need to distinguish between "entity not loaded yet"
   * and "entity genuinely does not exist" without resorting to a timeout.
   *
   * For InMemoryFundingRequestRepository this is always `true` (data is
   * available at construction time).
   */
  isHydrated(): boolean

  /** Return all funding requests. */
  getAll(): FundingRequest[]

  /** Find a funding request by its unique ID. */
  getById(id: string): FundingRequest | undefined

  /** Find a funding request by its escrow plan ID (one per plan). */
  getByEscrowPlanId(escrowPlanId: string): FundingRequest | undefined

  /** Find a funding request by its job ID. */
  getByJobId(jobId: string): FundingRequest | undefined

  /** Find a funding request by its source offer ID. */
  getByOfferId(offerId: string): FundingRequest | undefined

  /** Persist a new funding request. */
  add(request: FundingRequest): Promise<void>

  /** Update an existing funding request in-place. */
  update(id: string, updater: (r: FundingRequest) => FundingRequest): Promise<void>

  /** Subscribe to data changes. */
  subscribe(listener: () => void): () => void
}
