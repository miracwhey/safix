/**
 * In-memory implementation of SupplementaryPaymentRepository.
 *
 * Used in tests and local development (VITE_DATA_SOURCE=in-memory).
 * Starts with an empty dataset; always hydrated at construction.
 */

import type { SupplementaryPaymentRequest } from './types.js'
import type { SupplementaryPaymentRepository } from './SupplementaryPaymentRepository.js'

type Listener = () => void

export class InMemorySupplementaryPaymentRepository implements SupplementaryPaymentRepository {
  private requests: SupplementaryPaymentRequest[]
  private readonly listeners = new Set<Listener>()

  constructor(initial: SupplementaryPaymentRequest[] = []) {
    this.requests = [...initial]
  }

  async initialize(): Promise<void> {
    // In-memory — nothing to load
  }

  isHydrated(): boolean {
    return true
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn())
  }

  getAll(): SupplementaryPaymentRequest[] {
    return [...this.requests]
  }

  getById(id: string): SupplementaryPaymentRequest | undefined {
    return this.requests.find((r) => r.id === id)
  }

  getByChangeOrderId(changeOrderId: string): SupplementaryPaymentRequest | undefined {
    return this.requests.find((r) => r.changeOrderId === changeOrderId)
  }

  getByJobId(jobId: string): SupplementaryPaymentRequest[] {
    return this.requests.filter((r) => r.jobId === jobId)
  }

  async add(request: SupplementaryPaymentRequest): Promise<void> {
    this.requests = [request, ...this.requests]
    this.notify()
  }

  async update(id: string, updater: (r: SupplementaryPaymentRequest) => SupplementaryPaymentRequest): Promise<void> {
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
