/**
 * CustomerHomeHeader — brand wordmark + notification bell for the customer home.
 *
 * The bell links to the notification center and shows a red dot only when there
 * are genuinely unread signals (subscribed to the notification store) — never a
 * fake badge.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell, House } from 'lucide-react'
import {
  getUnreadNotificationSignals,
  subscribeNotifications,
} from '../../lib/notifications'

function useHasUnread(): boolean {
  const [count, setCount] = useState(() => {
    try {
      return getUnreadNotificationSignals().length
    } catch {
      return 0
    }
  })
  useEffect(
    () =>
      subscribeNotifications(() => {
        try {
          setCount(getUnreadNotificationSignals().length)
        } catch {
          setCount(0)
        }
      }),
    [],
  )
  return count > 0
}

export default function CustomerHomeHeader() {
  const hasUnread = useHasUnread()

  return (
    <div className="flex items-center justify-between px-1">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[linear-gradient(160deg,#3B82F6,#2563EB_60%,#1D4ED8)] text-white shadow-[0_8px_16px_-8px_rgba(37,99,235,0.7)]">
          <House size={17} aria-hidden />
        </span>
        <span className="text-[19px] font-bold tracking-[-0.02em] text-ink">
          Sa<span className="text-brand">Fix</span>
        </span>
      </div>
      <Link
        to="/notifications"
        aria-label="Benachrichtigungen"
        className="relative flex h-9 w-9 items-center justify-center rounded-full bg-surface text-ink-sub ring-1 ring-edge/70 shadow-subtle transition active:scale-[0.95]"
      >
        <Bell size={18} aria-hidden />
        {hasUnread && (
          <span
            className="absolute right-2 top-2 h-2 w-2 rounded-full bg-red-500 ring-2 ring-white"
            aria-hidden
          />
        )}
      </Link>
    </div>
  )
}
