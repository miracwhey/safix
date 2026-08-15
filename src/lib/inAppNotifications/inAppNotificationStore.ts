import { getInAppNotificationRepository } from './repository'
import type { InAppNotification } from './types'

type Listener = () => void

export function subscribeInAppNotifications(listener: Listener): () => void {
  return getInAppNotificationRepository().subscribe(listener)
}

export function getInAppNotifications(): InAppNotification[] {
  return getInAppNotificationRepository().getAll()
}

export function getUnreadInAppNotifications(): InAppNotification[] {
  return getInAppNotificationRepository().getUnread()
}

export function getUnreadInAppNotificationCount(): number {
  return getInAppNotificationRepository().getUnreadCount()
}
