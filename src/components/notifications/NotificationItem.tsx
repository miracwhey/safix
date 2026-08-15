import { Link } from 'react-router-dom'
import type { NotificationItem as NotificationItemType } from '../../lib/notifications'
import type { AttentionRole } from '../../lib/notifications'

type Props = {
  item: NotificationItemType
  onMarkRead?: (id: string) => void
  role?: AttentionRole
}

const PRIORITY_CONFIG = {
  info: {
    dot: 'bg-blue-500',
    badge: 'bg-blue-50 text-blue-600',
    icon: 'ℹ',
    border: 'border-l-4 border-blue-400',
  },
  action: {
    dot: 'bg-amber-500',
    badge: 'bg-amber-50 text-amber-700',
    icon: '!',
    border: 'border-l-4 border-amber-400',
  },
  alert: {
    dot: 'bg-red-500',
    badge: 'bg-red-50 text-red-600',
    icon: '⚠',
    border: 'border-l-4 border-red-400',
  },
} as const

function formatTimestamp(ms: number): string {
  const date = new Date(ms)
  const now = Date.now()
  const diffMs = now - ms

  if (diffMs < 0) {
    return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
  }

  const diffMin = Math.floor(diffMs / 60_000)
  const diffHours = Math.floor(diffMs / 3_600_000)
  const diffDays = Math.floor(diffMs / 86_400_000)

  if (diffMin < 1) return 'Gerade eben'
  if (diffMin < 60) return `vor ${diffMin} Min.`
  if (diffHours < 24) return `vor ${diffHours} Std.`
  if (diffDays < 7) return `vor ${diffDays} Tag${diffDays !== 1 ? 'en' : ''}`

  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function getJobLink(jobId: string, role: AttentionRole | undefined): string {
  if (role === 'customer') return `/projects/${jobId}`
  return `/craftsman/jobs/${jobId}`
}

function getJobLinkLabel(role: AttentionRole | undefined): string {
  if (role === 'customer') return 'Projekt ansehen →'
  return 'Auftrag ansehen →'
}

export default function NotificationItem({ item, onMarkRead, role }: Props) {
  const config = PRIORITY_CONFIG[item.priority]

  return (
    <div
      className={`flex gap-3 rounded-2xl px-4 py-3 ring-1 transition ${
        item.read
          ? 'bg-white ring-slate-200/70'
          : `bg-blue-50/40 ring-blue-200/60 ${config.border}`
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
            {!item.read && (
              <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${config.dot}`} />
            )}
            <span className="text-[14px] font-semibold leading-snug text-slate-900">
              {item.title}
            </span>
          </div>
        </div>

        <p className="mt-0.5 text-[13px] leading-snug text-slate-500">
          {item.description}
        </p>

        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[11px] text-slate-400">
            {formatTimestamp(item.occurredAt)}
          </span>

          <div className="flex items-center gap-2">
            {!item.read && onMarkRead && (
              <button
                onClick={() => onMarkRead(item.id)}
                className="text-[11px] font-medium text-blue-500 hover:text-blue-700 transition"
              >
                Als gelesen markieren
              </button>
            )}
            {item.jobId && (
              <Link
                to={getJobLink(item.jobId, role)}
                className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-semibold transition active:scale-[0.97] ${config.badge}`}
              >
                {getJobLinkLabel(role)}
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
