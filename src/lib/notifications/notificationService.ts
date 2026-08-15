import { getNotificationRepository } from './repository'
import { isNotificationRepositoryHydrated } from './notificationStore'
import { logWarning } from '../observability'
import type { NotificationSignal } from './types'

export function addNotificationSignal(signal: NotificationSignal): void {
  if (!isNotificationRepositoryHydrated()) {
    logWarning('notification.add.skipped_unhydrated', { signalId: signal.id, jobId: signal.jobId })
    return
  }
  getNotificationRepository().add(signal)
}

export function markNotificationRead(id: string): void {
  getNotificationRepository().markRead(id)
}

export function markAllNotificationsRead(): void {
  getNotificationRepository().markAllRead()
}
