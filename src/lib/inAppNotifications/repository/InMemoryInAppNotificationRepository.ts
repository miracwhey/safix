import type { InAppNotification } from '../types'
import type { InAppNotificationRepository } from './InAppNotificationRepository'

type Listener = () => void

export class InMemoryInAppNotificationRepository
  implements InAppNotificationRepository
{
  private notifications: InAppNotification[] = []
  private readonly listeners = new Set<Listener>()

  async initialize(_userId: string): Promise<void> {
    // Clear state for testing; in-memory data is not persisted.
    this.notifications = []
  }

  notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): InAppNotification[] {
    return [...this.notifications]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((n) => ({ ...n }))
  }

  getUnread(): InAppNotification[] {
    return this.notifications
      .filter((n) => !n.isRead)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((n) => ({ ...n }))
  }

  getUnreadCount(): number {
    return this.notifications.filter((n) => !n.isRead).length
  }

  hasNotification(id: string): boolean {
    return this.notifications.some((n) => n.id === id)
  }

  create(notification: InAppNotification): void {
    if (this.hasNotification(notification.id)) return

    this.notifications = [...this.notifications, notification].sort(
      (a, b) => b.createdAt - a.createdAt,
    )
    this.notify()
  }

  markRead(notificationId: string): void {
    const updated = this.notifications.map((n) =>
      n.id === notificationId ? { ...n, isRead: true } : n,
    )
    if (updated.some((n, i) => n.isRead !== this.notifications[i].isRead)) {
      this.notifications = updated
      this.notify()
    }
  }

  markAllRead(_userId: string): void {
    const hasUnread = this.notifications.some((n) => !n.isRead)
    if (!hasUnread) return

    this.notifications = this.notifications.map((n) => ({ ...n, isRead: true }))
    this.notify()
  }

  reset(): void {
    this.notifications = []
    this.notify()
  }

  restartRealtimeIfDead(): void {
    // no-op: in-memory repository has no realtime subscription
  }
}
