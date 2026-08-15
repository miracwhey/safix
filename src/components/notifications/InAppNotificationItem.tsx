import { Link } from 'react-router-dom'
import type { InAppNotification, InAppNotificationType, InAppNotificationEntityType } from '../../lib/inAppNotifications'

type Props = {
  item: InAppNotification
  onMarkRead?: (id: string) => void
}

type Priority = 'alert' | 'action' | 'info'

const PRIORITY_CONFIG = {
  info: {
    dot: 'bg-blue-500',
    badge: 'bg-blue-50 text-blue-600',
    icon: 'ℹ',
  },
  action: {
    dot: 'bg-amber-500',
    badge: 'bg-amber-50 text-amber-700',
    icon: '!',
  },
  alert: {
    dot: 'bg-red-500',
    badge: 'bg-red-50 text-red-600',
    icon: '⚠',
  },
} as const

const TYPE_TO_PRIORITY: Record<InAppNotificationType, Priority> = {
  dispute_opened: 'alert',
  dispute_resolved: 'alert',
  rating_received: 'action',
  proposal_received: 'action',
  payment_requested: 'action',
  payment_refunded: 'action',
  job_completed: 'info',
  payment_released: 'info',
  job_scheduled: 'info',
  onboarding_completed: 'info',
  tranche_released: 'info',
}

function getPriority(type: InAppNotificationType): Priority {
  return TYPE_TO_PRIORITY[type] ?? 'info'
}

function formatTimestamp(ms: number): string {
  const date = new Date(ms)
  const now = Date.now()
  const diffMs = now - ms

  if (diffMs < 0) {
    return date.toLocaleDateString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })
  }

  const diffMin = Math.floor(diffMs / 60_000)
  const diffHours = Math.floor(diffMs / 3_600_000)
  const diffDays = Math.floor(diffMs / 86_400_000)

  if (diffMin < 1) return 'Gerade eben'
  if (diffMin < 60) return `vor ${diffMin} Min.`
  if (diffHours < 24) return `vor ${diffHours} Std.`
  if (diffDays < 7) return `vor ${diffDays} Tag${diffDays !== 1 ? 'en' : ''}`

  return date.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

function getEntityLink(
  entityType: InAppNotificationEntityType,
  entityId: string,
): string | null {
  switch (entityType) {
    case 'job':
      return `/craftsman/jobs/${entityId}`
    case 'rating':
      return '/craftsman/profile'
    case 'payment':
      return '/craftsman/finance'
    default:
      return null
  }
}

export default function InAppNotificationItem({ item, onMarkRead }: Props) {
  const priority = getPriority(item.type)
  const config = PRIORITY_CONFIG[priority]
  const link = getEntityLink(item.entityType, item.entityId)

  return (
    <div
      className={`flex gap-3 rounded-2xl px-4 py-3 ring-1 transition ${
        item.isRead
          ? 'bg-white ring-slate-200/70'
          : 'bg-blue-50/40 ring-blue-200/60'
      }`}
    >
      {/* Priority icon */}
      <div
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-[15px] font-bold ${config.badge}`}
      >
        {config.icon}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            {!item.isRead && (
              <span
                className={`inline-block h-2 w-2 shrink-0 rounded-full ${config.dot}`}
              />
            )}
            <span className="text-[14px] font-semibold leading-snug text-slate-900">
              {item.title}
            </span>
          </div>
        </div>

        <p className="mt-0.5 text-[13px] leading-snug text-slate-500">
          {item.message}
        </p>

        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[11px] text-slate-400">
            {formatTimestamp(item.createdAt)}
          </span>

          <div className="flex items-center gap-3">
            {!item.isRead && onMarkRead && (
              <button
                onClick={() => onMarkRead(item.id)}
                className="text-[11px] font-medium text-blue-500 hover:text-blue-700 transition"
              >
                Als gelesen markieren
              </button>
            )}
            {link && (
              <Link
                to={link}
                className="text-[11px] font-medium text-slate-500 hover:text-slate-800 transition"
              >
                Ansehen →
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
