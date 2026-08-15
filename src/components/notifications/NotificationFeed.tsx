// @deprecated — dissolve into operative inline signals; no NotificationFeed on screens
import { useEffect, useState } from 'react'
import {
  subscribeNotifications,
  getNotificationSignals,
  getUnreadNotificationSignals,
  markNotificationRead,
  markAllNotificationsRead,
  buildNotificationItems,
  buildNotificationItemsForRole,
} from '../../lib/notifications'
import type { NotificationItem as NotificationItemType, AttentionRole } from '../../lib/notifications'
import NotificationItem from './NotificationItem'

type Props = {
  role?: AttentionRole
  limit?: number
}

export default function NotificationFeed({ role, limit }: Props) {
  const [items, setItems] = useState<NotificationItemType[]>(() => {
    const signals = getNotificationSignals()
    return role
      ? buildNotificationItemsForRole(signals, role)
      : buildNotificationItems(signals)
  })
  const [unreadCount, setUnreadCount] = useState<number>(
    () => getUnreadNotificationSignals().length
  )

  useEffect(() => {
    const unsubscribe = subscribeNotifications(() => {
      const signals = getNotificationSignals()
      setItems(
        role
          ? buildNotificationItemsForRole(signals, role)
          : buildNotificationItems(signals)
      )
      setUnreadCount(getUnreadNotificationSignals().length)
    })

    return unsubscribe
  }, [role])

  const displayItems = limit ? items.slice(0, limit) : items

  if (displayItems.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <div className="text-[32px]">🔔</div>
        <p className="mt-2 text-[14px] text-slate-400">Keine Benachrichtigungen</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {unreadCount > 0 && (
        <div className="flex items-center justify-between px-1 pb-1">
          <span className="text-[12px] font-semibold text-slate-400">
            {unreadCount} ungelesen
          </span>
          <button
            onClick={markAllNotificationsRead}
            className="text-[12px] font-medium text-blue-500 hover:text-blue-700 transition"
          >
            Alle als gelesen markieren
          </button>
        </div>
      )}

      {displayItems.map((item) => (
        <NotificationItem
          key={item.id}
          item={item}
          onMarkRead={markNotificationRead}
          role={role}
        />
      ))}
    </div>
  )
}
