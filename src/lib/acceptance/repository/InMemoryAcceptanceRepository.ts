import type { Acceptance } from '../types'
import type { AcceptanceRepository } from './AcceptanceRepository'

type Listener = () => void

export class InMemoryAcceptanceRepository implements AcceptanceRepository {
  private acceptances: Acceptance[]
  private readonly listeners = new Set<Listener>()

  constructor(initialData: Acceptance[] = []) {
    this.acceptances = initialData
  }

  async initialize(): Promise<void> {
    // In-memory data is already loaded at construction time
  }

  isHydrated(): boolean {
    return true
  }

  private notify(): void {
    this.listeners.forEach((l) => l())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getAll(): Acceptance[] {
    return [...this.acceptances]
  }

  getById(acceptanceId: string): Acceptance | undefined {
    return this.acceptances.find((a) => a.id === acceptanceId)
  }

  getByJobId(jobId: string): Acceptance | undefined {
    return this.acceptances.find((a) => a.jobId === jobId)
  }

  getExpiredPending(nowMs: number): Acceptance[] {
    return this.acceptances.filter(
      (a) => a.status === 'pending' && a.expiresAt != null && a.expiresAt <= nowMs
    )
  }

  async add(acceptance: Acceptance): Promise<void> {
    this.acceptances = [acceptance, ...this.acceptances]
    this.notify()
  }

  async update(acceptanceId: string, updater: (a: Acceptance) => Acceptance): Promise<void> {
    this.acceptances = this.acceptances.map((a) =>
      a.id === acceptanceId ? updater(a) : a
    )
    this.notify()
  }
}
