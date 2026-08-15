import type { AnalyticsEvent, AnalyticsEventType } from './analyticsTypes'
import { getAnalyticsRepository } from './repository/registry'
import { logInfo } from '../observability'

/**
 * Records a marketplace analytics event.
 *
 * Appends the event to the analytics store and emits an observability log.
 * Never throws — persistence failures are handled by the repository layer.
 */
export function recordAnalyticsEvent(
  event: Omit<AnalyticsEvent, 'eventId' | 'createdAt'> & { eventId?: string; createdAt?: number }
): void {
  const fullEvent: AnalyticsEvent = {
    eventId: event.eventId ?? crypto.randomUUID(),
    eventType: event.eventType,
    entityType: event.entityType,
    entityId: event.entityId,
    actorUserId: event.actorUserId,
    metadata: event.metadata,
    createdAt: event.createdAt ?? Date.now(),
  }

  getAnalyticsRepository().add(fullEvent)

  logInfo('analytics.event_recorded', {
    eventType: fullEvent.eventType,
    entityType: fullEvent.entityType,
    entityId: fullEvent.entityId,
  })
}

/**
 * Retrieves all analytics events, optionally filtered.
 */
export function getAnalyticsEvents(): AnalyticsEvent[] {
  return getAnalyticsRepository().getAll()
}

/**
 * Retrieves analytics events of a specific type.
 */
export function getAnalyticsEventsByType(eventType: AnalyticsEventType): AnalyticsEvent[] {
  return getAnalyticsRepository().getByEventType(eventType)
}

/**
 * Retrieves analytics events since a given timestamp.
 */
export function getAnalyticsEventsSince(since: number): AnalyticsEvent[] {
  return getAnalyticsRepository().getSince(since)
}

/**
 * Subscribes to analytics event changes.
 */
export function subscribeAnalyticsEvents(listener: () => void): () => void {
  return getAnalyticsRepository().subscribe(listener)
}

/**
 * Records an analytics event only if no event of the same type already exists
 * for the given entity.
 *
 * Use this for one-time transition events (e.g. onboarding_completed,
 * provider_discovery_ready, payout_ready) where duplicates would inflate
 * metric counts.
 */
export function recordAnalyticsEventOnce(
  event: Omit<AnalyticsEvent, 'eventId' | 'createdAt'> & { eventId?: string; createdAt?: number }
): void {
  const existing = getAnalyticsRepository()
    .getByEntityId(event.entityId)
    .find((e) => e.eventType === event.eventType)

  if (existing) return

  recordAnalyticsEvent(event)
}
