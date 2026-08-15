import type { InAppNotification } from '../types'

export interface InAppNotificationRepository {
  initialize(userId: string): Promise<void>
  getAll(): InAppNotification[]
  getUnread(): InAppNotification[]
  getUnreadCount(): number
  hasNotification(id: string): boolean
  create(notification: InAppNotification): void
  markRead(notificationId: string): void
  markAllRead(userId: string): void
  subscribe(listener: () => void): () => void
  notify(): void
  /** Clears all cached notifications and notifies subscribers. */
  reset(): void
  /** Restarts the realtime subscription if it is dead (exhausted or never connected).
   *  No-op if already connected or no user — unless `force` is set (pessimistic
   *  restart after a real background stay: socket dead, flag still true). */
  restartRealtimeIfDead(options?: { force?: boolean }): void
}
