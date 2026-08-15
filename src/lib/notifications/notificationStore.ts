import { getNotificationRepository } from './repository'
import type { NotificationSignal } from './types'

type Listener = () => void

export function subscribeNotifications(listener: Listener): () => void {
  return getNotificationRepository().subscribe(listener)
}

export function getNotificationSignals(): NotificationSignal[] {
  return getNotificationRepository().getAll()
}

export function getNotificationSignalsForJob(jobId: string): NotificationSignal[] {
  return getNotificationRepository().getForJob(jobId)
}

export function getUnreadNotificationSignals(): NotificationSignal[] {
  return getNotificationRepository().getUnread()
}

export function isNotificationRepositoryHydrated(): boolean {
  return getNotificationRepository().isHydrated()
}
