import { mockCorrectionRequests } from '../mockData'
import type { CorrectionRequest } from '../types'
import type { CorrectionRepository } from './CorrectionRepository'

type Listener = () => void

export class InMemoryCorrectionRepository implements CorrectionRepository {
  private requests: CorrectionRequest[]
  private readonly listeners = new Set<Listener>()

  constructor(initialData: CorrectionRequest[] = [...mockCorrectionRequests]) {
    this.requests = initialData
  }

  async initialize(): Promise<void> {
    // In-memory data is already available at construction time
  }

  isHydrated(): boolean {
    return true
  }

  private notify(): void {
    this.listeners.forEach((l) => l())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): CorrectionRequest[] {
    return [...this.requests]
  }

  getById(id: string): CorrectionRequest | undefined {
    return this.requests.find((r) => r.id === id)
  }

  async add(request: CorrectionRequest): Promise<void> {
    this.requests = [request, ...this.requests]
    this.notify()
  }

  async update(
    id: string,
    updater: (r: CorrectionRequest) => CorrectionRequest,
  ): Promise<void> {
    this.requests = this.requests.map((r) => (r.id === id ? updater(r) : r))
    this.notify()
  }
}
