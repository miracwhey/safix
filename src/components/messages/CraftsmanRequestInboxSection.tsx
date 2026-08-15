import { Link, useNavigate } from 'react-router-dom'
import { MessageSquare, FileText, X } from 'lucide-react'
import {
  sortIncomingRequests,
  type IncomingRequestItem,
  type IncomingRequestStatus,
  type IncomingRequestSort,
} from '../../lib/messages'
import {
  REQUEST_QUALITY_TIER_LABEL,
  type RequestQualityTier,
} from '../../lib/requestQuality'
import Avatar from './Avatar'

// ── Status configuration ───────────────────────────────────────────────────

type StatusConfig = {
  label: string
  dotColor: string
  badgeStyle: string
  groupHeading: string
  groupIcon: string
}

const STATUS_CONFIG: Record<IncomingRequestStatus, StatusConfig> = {
  new_unread: {
    label: 'Neu',
    dotColor: 'bg-blue-500',
    badgeStyle: 'bg-blue-50 text-blue-700 ring-blue-200',
    groupHeading: 'Neue Anfragen',
    groupIcon: '🔔',
  },
  needs_response: {
    label: 'Antwort ausstehend',
    dotColor: 'bg-amber-500',
    badgeStyle: 'bg-amber-50 text-amber-700 ring-amber-200',
    groupHeading: 'Antwort ausstehend',
    groupIcon: '⏳',
  },
  in_conversation: {
    label: 'Im Gespräch',
    dotColor: 'bg-emerald-500',
    badgeStyle: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    groupHeading: 'Im Gespräch',
    groupIcon: '💬',
  },
}

// ── Quality tier badge ─────────────────────────────────────────────────────

// Contrast note: the lowest tier must stay legible — those are exactly the
// low-info requests that must never be hidden. `pruefen` uses slate-600 on
// slate-50 (~7:1), well above WCAG AA for this 10px label.
const TIER_BADGE_STYLE: Record<RequestQualityTier, string> = {
  top: 'bg-brand/10 text-brand ring-brand/20',
  solide: 'bg-slate-100 text-slate-700 ring-slate-200',
  pruefen: 'bg-slate-50 text-slate-600 ring-slate-300',
}

/**
 * Craftsman-facing quality flag. Replaces the older intake badge: the tier is
 * derived from the full quality score, not just field presence. The raw score
 * stays internal (shown only in the request detail), the card carries the tier.
 */
function QualityTierBadge({ tier }: { tier: RequestQualityTier }) {
  return (
    <span
      className={[
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1',
        TIER_BADGE_STYLE[tier],
      ].join(' ')}
    >
      {REQUEST_QUALITY_TIER_LABEL[tier]}
    </span>
  )
}

// ── Origin badge ───────────────────────────────────────────────────────────

function OriginBadge({ origin }: { origin: IncomingRequestItem['inquiryOrigin'] }) {
  if (!origin) return null

  const config = {
    project: { label: 'Projektanfrage', style: 'bg-violet-50 text-violet-700 ring-violet-100' },
    reel: { label: 'Explore-Reel', style: 'bg-sky-50 text-sky-700 ring-sky-100' },
    profile: { label: 'Profil', style: 'bg-slate-100 text-slate-600 ring-slate-200' },
    category: { label: 'Kategorie', style: 'bg-teal-50 text-teal-700 ring-teal-100' },
  }[origin]

  return (
    <span
      className={[
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1',
        config.style,
      ].join(' ')}
    >
      {config.label}
    </span>
  )
}

// ── Inline action button ──────────────────────────────────────────────────

type ActionButtonProps = {
  icon: React.ReactNode
  label: string
  variant: 'primary' | 'muted' | 'danger'
  onClick: (e: React.MouseEvent) => void
}

const VARIANT_STYLES: Record<ActionButtonProps['variant'], string> = {
  primary: 'bg-brand/10 text-brand ring-brand/20 hover:bg-brand/15',
  muted: 'bg-slate-50 text-slate-600 ring-slate-200 hover:bg-slate-100',
  danger: 'bg-red-50 text-red-600 ring-red-200 hover:bg-red-100',
}

function ActionButton({ icon, label, variant, onClick }: ActionButtonProps) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onClick(e)
      }}
      className={[
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold ring-1 transition active:scale-[0.97]',
        VARIANT_STYLES[variant],
      ].join(' ')}
    >
      {icon}
      {label}
    </button>
  )
}

// ── Single request card ────────────────────────────────────────────────────

type RequestCardProps = {
  item: IncomingRequestItem
  detailBasePath: string
  onDecline?: (threadId: string) => void
}

function RequestCard({ item, detailBasePath, onDecline }: RequestCardProps) {
  const navigate = useNavigate()
  const statusCfg = STATUS_CONFIG[item.status]

  const primaryAction =
    item.status === 'in_conversation'
      ? { icon: <FileText size={12} />, label: 'Angebot senden', variant: 'primary' as const }
      : { icon: <MessageSquare size={12} />, label: 'Antworten', variant: 'primary' as const }

  return (
    <Link
      to={`${detailBasePath}/${item.threadId}`}
      className="flex items-start gap-3 rounded-[20px] bg-white px-4 py-4 ring-1 ring-slate-200/70 shadow-[0_8px_20px_-14px_rgba(2,6,23,0.14)] transition active:bg-slate-50"
    >
      {/* Avatar with status dot */}
      <div className="relative shrink-0">
        <Avatar
          src={item.customerAvatarUrl}
          name={item.customerName}
          size="md"
          className="ring-1 ring-slate-200/70"
        />
        <span
          className={[
            'absolute bottom-0 right-0 h-3 w-3 rounded-full ring-2 ring-white',
            statusCfg.dotColor,
          ].join(' ')}
        />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        {/* Header row: customer name + time */}
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[15px] font-semibold text-slate-900">
            {item.customerName}
          </span>
          {item.timeLabel ? (
            <span className="shrink-0 text-[12px] text-slate-400">
              {item.timeLabel}
            </span>
          ) : null}
        </div>

        {/* Project title */}
        <div className="mt-0.5 truncate text-[13px] font-medium text-slate-700">
          {item.projectTitle}
        </div>

        {/* Location + budget row */}
        {(item.projectLocation || item.projectCostRange) ? (
          <div className="mt-0.5 flex items-center gap-2 text-[12px] text-slate-500">
            {item.projectLocation ? (
              <span>📍 {item.projectLocation}</span>
            ) : null}
            {item.projectCostRange ? (
              <span>· 💶 {item.projectCostRange}</span>
            ) : null}
          </div>
        ) : null}

        {/* Badge row */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <OriginBadge origin={item.inquiryOrigin} />
          <QualityTierBadge tier={item.qualityTier} />
          {item.hasProjectAttachment ? (
            <span className="inline-flex shrink-0 items-center rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700 ring-1 ring-indigo-100">
              📋 Projekt
            </span>
          ) : null}
        </div>

        {/* Last message preview */}
        <div className="mt-1.5 truncate text-[12px] text-slate-400">
          {item.lastMessagePreview}
        </div>

        {/* Action buttons */}
        <div className="mt-3 flex items-center gap-2">
          <ActionButton
            icon={primaryAction.icon}
            label={primaryAction.label}
            variant={primaryAction.variant}
            onClick={() => navigate(`${detailBasePath}/${item.threadId}`)}
          />
          {onDecline ? (
            <ActionButton
              icon={<X size={12} />}
              label="Ablehnen"
              variant="danger"
              onClick={() => onDecline(item.threadId)}
            />
          ) : null}
        </div>
      </div>

      {/* Unread badge */}
      {item.unreadCount > 0 ? (
        <div className="ml-1 flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-blue-600 px-1.5 text-[11px] font-semibold text-white">
          {item.unreadCount}
        </div>
      ) : null}
    </Link>
  )
}

// ── Group section ──────────────────────────────────────────────────────────

type GroupSectionProps = {
  status: IncomingRequestStatus
  items: IncomingRequestItem[]
  detailBasePath: string
  onDecline?: (threadId: string) => void
}

function GroupSection({ status, items, detailBasePath, onDecline }: GroupSectionProps) {
  if (items.length === 0) return null
  const cfg = STATUS_CONFIG[status]

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <span className="text-[14px] leading-none">{cfg.groupIcon}</span>
        <span className="text-[13px] font-semibold text-slate-600">
          {cfg.groupHeading}
        </span>
        <span
          className={[
            'ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11px] font-bold ring-1',
            cfg.badgeStyle,
          ].join(' ')}
        >
          {items.length}
        </span>
      </div>

      {items.map((item) => (
        <RequestCard key={item.threadId} item={item} detailBasePath={detailBasePath} onDecline={onDecline} />
      ))}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

type Props = {
  requests: IncomingRequestItem[]
  /** Base path for navigating to a thread, e.g. "/craftsman/messages" */
  detailBasePath?: string
  /** Called when the craftsman declines a request. Omit to hide decline buttons. */
  onDecline?: (threadId: string) => void
  /** Within-group ordering. Defaults to newest-first. */
  sortBy?: IncomingRequestSort
}

/**
 * Craftsman-facing request inbox section.
 *
 * Renders incoming project requests grouped by triage status:
 *   1. Neue Anfragen (unread, no reply yet)
 *   2. Antwort ausstehend (read but no craftsman reply)
 *   3. Im Gespräch (active exchange)
 *
 * Each card shows customer identity, project context, intake quality,
 * a direct link into the thread, and inline action buttons for quick triage.
 */
export default function CraftsmanRequestInboxSection({
  requests,
  detailBasePath = '/craftsman/messages',
  onDecline,
  sortBy = 'newest',
}: Props) {
  if (requests.length === 0) {
    return (
      <p className="px-1 text-[14px] text-slate-400">
        Keine offenen Anfragen vorhanden.
      </p>
    )
  }

  const newUnread = sortIncomingRequests(
    requests.filter((r) => r.status === 'new_unread'),
    sortBy,
  )
  const needsResponse = sortIncomingRequests(
    requests.filter((r) => r.status === 'needs_response'),
    sortBy,
  )
  const inConversation = sortIncomingRequests(
    requests.filter((r) => r.status === 'in_conversation'),
    sortBy,
  )

  return (
    <div className="space-y-5">
      <GroupSection
        status="new_unread"
        items={newUnread}
        detailBasePath={detailBasePath}
        onDecline={onDecline}
      />
      <GroupSection
        status="needs_response"
        items={needsResponse}
        detailBasePath={detailBasePath}
        onDecline={onDecline}
      />
      <GroupSection
        status="in_conversation"
        items={inConversation}
        detailBasePath={detailBasePath}
        onDecline={onDecline}
      />
    </div>
  )
}
