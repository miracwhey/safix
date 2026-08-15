import { logInfo } from '../observability'
import { getInAppNotificationRepository } from './repository'
import type { InAppNotification } from './types'

export function createInAppNotification(notification: InAppNotification): void {
  getInAppNotificationRepository().create(notification)
  logInfo('notification.created', {
    notification_type: notification.type,
    entity_type: notification.entityType,
    user_id: notification.userId,
  })
}

export function markInAppNotificationRead(notificationId: string): void {
  getInAppNotificationRepository().markRead(notificationId)
  logInfo('notification.read', { notificationId })
}

export function markAllInAppNotificationsRead(userId: string): void {
  getInAppNotificationRepository().markAllRead(userId)
  logInfo('notification.read_all', { user_id: userId })
}
