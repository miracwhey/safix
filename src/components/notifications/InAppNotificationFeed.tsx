import { useEffect, useState } from 'react'
import {
  subscribeInAppNotifications,
  getInAppNotifications,
  getUnreadInAppNotificationCount,
  markInAppNotificationRead,
  markAllInAppNotificationsRead,
} from '../../lib/inAppNotifications'
import type { InAppNotification } from '../../lib/inAppNotifications'
import InAppNotificationItem from './InAppNotificationItem'

interface Props {
  /**
   * The current user's ID.
   * When provided, the "Alle als gelesen markieren" button is shown for users
   * with unread notifications. When omitted, mark-all-read is not available.
   */
  userId?: string
  /** Maximum number of notifications to display. Defaults to all. */
  limit?: number
}

export default function InAppNotificationFeed({ userId, limit }: Props) {
  const [notifications, setNotifications] = useState<InAppNotification[]>(() =>
    getInAppNotifications(),
  )
  const [unreadCount, setUnreadCount] = useState<number>(
    () => getUnreadInAppNotificationCount(),
  )

  useEffect(() => {
    const unsubscribe = subscribeInAppNotifications(() => {
      setNotifications(getInAppNotifications())
      setUnreadCount(getUnreadInAppNotificationCount())
    })
    return unsubscribe
  }, [])

  const displayed =
    limit !== undefined ? notifications.slice(0, limit) : notifications

  return (
    <div className="space-y-2">
      {/* Mark-all-read header */}
      {unreadCount > 0 && userId && (
        <div className="flex justify-end">
          <button
            onClick={() => markAllInAppNotificationsRead(userId)}
            className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-200 transition"
          >
            Alle als gelesen markieren
          </button>
        </div>
      )}

      {/* Notification list */}
      {displayed.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="text-[32px]">🔔</div>
          <p className="mt-2 text-[13px] text-slate-400">
            Keine persönlichen Benachrichtigungen
          </p>
        </div>
      ) : (
        displayed.map((item) => (
          <InAppNotificationItem
            key={item.id}
            item={item}
            onMarkRead={markInAppNotificationRead}
          />
        ))
      )}
    </div>
  )
}
