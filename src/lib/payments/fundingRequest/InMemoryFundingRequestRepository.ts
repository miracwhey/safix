/**
 * In-memory implementation of FundingRequestRepository.
 *
 * Used in tests and local development. Starts with an empty data set.
 */

import type { FundingRequest } from './types.js'
import type { FundingRequestRepository } from './fundingRequestRepository.js'

type Listener = () => void

export class InMemoryFundingRequestRepository implements FundingRequestRepository {
  private requests: FundingRequest[]
  private readonly listeners = new Set<Listener>()

  constructor(initial: FundingRequest[] = []) {
    this.requests = [...initial]
  }

  async initialize(): Promise<void> {
    // In-memory — nothing to load
  }

  isHydrated(): boolean {
    // In-memory repos are always hydrated — data is available at construction
    return true
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn())
  }

  getAll(): FundingRequest[] {
    return [...this.requests]
  }

  getById(id: string): FundingRequest | undefined {
    return this.requests.find((r) => r.id === id)
  }

  getByEscrowPlanId(escrowPlanId: string): FundingRequest | undefined {
    return this.requests.find((r) => r.escrowPlanId === escrowPlanId)
  }

  getByJobId(jobId: string): FundingRequest | undefined {
    return this.requests.find((r) => r.jobId === jobId)
  }

  getByOfferId(offerId: string): FundingRequest | undefined {
    return this.requests.find((r) => r.sourceOfferId === offerId)
  }

  async add(request: FundingRequest): Promise<void> {
    this.requests = [request, ...this.requests]
    this.notify()
  }

  async update(id: string, updater: (r: FundingRequest) => FundingRequest): Promise<void> {
    this.requests = this.requests.map((r) => (r.id === id ? updater(r) : r))
    this.notify()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
