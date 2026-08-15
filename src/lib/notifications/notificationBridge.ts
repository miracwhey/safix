import { subscribeTimeline, getTimelineSignals, isTimelineRepositoryHydrated } from '../timeline'
import {
  isNotifiableEventType,
  getNotificationPriority,
  getNotificationRoleRelevance,
} from './notificationConfig'
import { addNotificationSignal } from './notificationService'
import { logWarning } from '../observability'
import type { NotificationSignal } from './types'

function deriveSignalsFromTimeline(timelineSignalId: string): NotificationSignal[] {
  const all = getTimelineSignals()
  const source = all.find((s) => s.id === timelineSignalId)
  if (!source) return []
  if (!isNotifiableEventType(source.type)) return []

  const priority = getNotificationPriority(source.type)
  if (!priority) return []

  const roleRelevance = getNotificationRoleRelevance(source.type)
  // undefined means the event is relevant to all roles (per config contract)
  const roles = (roleRelevance ?? (['customer', 'craftsman'] as const)).filter(
    (r): r is 'customer' | 'craftsman' => r === 'customer' || r === 'craftsman',
  )

  return roles.map((role) => ({
    id: role === 'craftsman' ? `notif-${source.id}` : `notif-${source.id}-c`,
    jobId: source.jobId,
    type: source.type,
    priority,
    read: false,
    occurredAt: source.occurredAt,
    recipientRole: role,
    ...(source.entityId != null ? { entityId: source.entityId } : {}),
  }))
}

let previousSignalIds = new Set<string>()
let unsubscribe: (() => void) | undefined

/**
 * Starts the notification bridge.
 * Subscribes to the timeline store and derives notification signals
 * from newly added, notification-worthy timeline events.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startNotificationBridge(): void {
  if (unsubscribe) return

  // Process any timeline signals already present before the bridge started.
  // Skip initial sync if timeline is not yet hydrated — the subscription below
  // will process all signals as "new" once the timeline repo fires notify() on
  // hydration, ensuring no events are lost.
  if (!isTimelineRepositoryHydrated()) {
    logWarning('notification.bridge.initial_sync_skipped_unhydrated')
  } else {
    const existing = getTimelineSignals()
    for (const signal of existing) {
      previousSignalIds.add(signal.id)
      if (isNotifiableEventType(signal.type)) {
        for (const notifSignal of deriveSignalsFromTimeline(signal.id)) {
          addNotificationSignal(notifSignal)
        }
      }
    }
  }

  unsubscribe = subscribeTimeline(() => {
    const current = getTimelineSignals()
    for (const signal of current) {
      if (!previousSignalIds.has(signal.id)) {
        previousSignalIds.add(signal.id)
        for (const notifSignal of deriveSignalsFromTimeline(signal.id)) {
          addNotificationSignal(notifSignal)
        }
      }
    }
  })
}

/**
 * Stops the notification bridge and resets internal state.
 * Primarily useful for testing.
 */
export function stopNotificationBridge(): void {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = undefined
  }
  previousSignalIds = new Set()
}
