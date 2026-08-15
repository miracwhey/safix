import type { AnalyticsEvent, AnalyticsEventType } from '../analyticsTypes'
import type { AnalyticsRepository } from './AnalyticsRepository'

type Listener = () => void

export class InMemoryAnalyticsRepository implements AnalyticsRepository {
  private events: AnalyticsEvent[]
  private readonly listeners = new Set<Listener>()

  constructor(initialData: AnalyticsEvent[] = []) {
    this.events = initialData
  }

  async initialize(): Promise<void> {
    // Already loaded at construction
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

  getAll(): AnalyticsEvent[] {
    return [...this.events]
  }

  getByEventType(eventType: AnalyticsEventType): AnalyticsEvent[] {
    return this.events.filter((e) => e.eventType === eventType)
  }

  getByEntityId(entityId: string): AnalyticsEvent[] {
    return this.events.filter((e) => e.entityId === entityId)
  }

  getSince(since: number): AnalyticsEvent[] {
    return this.events.filter((e) => e.createdAt >= since)
  }

  add(event: AnalyticsEvent): void {
    this.events = [event, ...this.events]
    this.notify()
  }
}
