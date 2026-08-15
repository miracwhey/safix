import { mockLedgerEntries } from '../mockData.js'
import type { LedgerEntry } from '../ledgerTypes.js'
import type { LedgerRepository } from './LedgerRepository.js'

type Listener = () => void

export class InMemoryLedgerRepository implements LedgerRepository {
  private ledger: LedgerEntry[]
  private readonly listeners = new Set<Listener>()

  constructor(initialData: LedgerEntry[] = [...mockLedgerEntries]) {
    this.ledger = initialData
  }

  async initialize(): Promise<void> {
    // In-memory data is already loaded from mock data at construction time
  }

  isHydrated(): boolean {
    return true
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): LedgerEntry[] {
    return [...this.ledger]
  }

  getForPayment(paymentId: string): LedgerEntry[] {
    return this.ledger.filter((entry) => entry.paymentId === paymentId)
  }

  getForJob(jobId: string): LedgerEntry[] {
    return this.ledger.filter((entry) => entry.jobId === jobId)
  }

  add(entry: LedgerEntry): void {
    this.ledger = [entry, ...this.ledger]
    this.notify()
  }

  updateEntryAmount(entryId: string, newAmount: number): void {
    this.ledger = this.ledger.map((e) =>
      e.id === entryId ? { ...e, amount: newAmount } : e
    )
    this.notify()
  }
}
