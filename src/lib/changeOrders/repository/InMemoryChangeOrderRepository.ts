import type { ChangeOrder } from '../types'
import type { ChangeOrderRepository } from './ChangeOrderRepository'

type Listener = () => void

export class InMemoryChangeOrderRepository implements ChangeOrderRepository {
  private changeOrders: ChangeOrder[]
  private readonly listeners = new Set<Listener>()

  constructor(initialData: ChangeOrder[] = []) {
    this.changeOrders = initialData
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

  getAll(): ChangeOrder[] {
    return [...this.changeOrders]
  }

  getById(changeOrderId: string): ChangeOrder | undefined {
    return this.changeOrders.find((co) => co.id === changeOrderId)
  }

  getByJobId(jobId: string): ChangeOrder[] {
    return this.changeOrders
      .filter((co) => co.jobId === jobId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  getAcceptedByJobId(jobId: string): ChangeOrder | undefined {
    return this.changeOrders
      .filter((co) => co.jobId === jobId && co.status === 'accepted')
      .sort((a, b) => b.createdAt - a.createdAt)[0]
  }

  async add(changeOrder: ChangeOrder): Promise<void> {
    this.changeOrders = [changeOrder, ...this.changeOrders]
    this.notify()
  }

  async update(changeOrderId: string, updater: (co: ChangeOrder) => ChangeOrder): Promise<void> {
    this.changeOrders = this.changeOrders.map((co) =>
      co.id === changeOrderId ? updater(co) : co
    )
    this.notify()
  }

  /** No realtime/lazy load needed in memory — the store is always current. */
  ensureLoaded(): Promise<void> {
    return Promise.resolve()
  }
}
