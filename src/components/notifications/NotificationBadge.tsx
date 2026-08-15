// @deprecated — badge logic moves to BottomNav directly
import { useEffect, useState } from 'react'
import {
  subscribeNotifications,
  getUnreadNotificationSignals,
} from '../../lib/notifications'
import {
  subscribeInAppNotifications,
  getUnreadInAppNotificationCount,
} from '../../lib/inAppNotifications'

function getTotalUnread(): number {
  return getUnreadNotificationSignals().length + getUnreadInAppNotificationCount()
}

export default function NotificationBadge() {
  const [unreadCount, setUnreadCount] = useState<number>(getTotalUnread)

  useEffect(() => {
    const refresh = () => setUnreadCount(getTotalUnread())
    const unsubSignals = subscribeNotifications(refresh)
    const unsubInApp = subscribeInAppNotifications(refresh)

    return () => {
      unsubSignals()
      unsubInApp()
    }
  }, [])

  if (unreadCount === 0) return null

  return (
    <span className="inline-flex items-center justify-center min-w-[22px] h-[22px] rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white tabular-nums">
      {unreadCount > 99 ? '99+' : unreadCount}
    </span>
  )
}
