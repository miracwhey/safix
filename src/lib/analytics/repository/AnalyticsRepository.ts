import type { AnalyticsEvent, AnalyticsEventType } from '../analyticsTypes'

export interface AnalyticsRepository {
  initialize(): Promise<void>
  isHydrated(): boolean
  getAll(): AnalyticsEvent[]
  getByEventType(eventType: AnalyticsEventType): AnalyticsEvent[]
  getByEntityId(entityId: string): AnalyticsEvent[]
  getSince(since: number): AnalyticsEvent[]
  add(event: AnalyticsEvent): void
  subscribe(listener: () => void): () => void
}
