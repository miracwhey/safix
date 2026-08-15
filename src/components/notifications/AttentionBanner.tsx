// @deprecated — inline attention zone replaces this in operative Start screens
import { Link } from 'react-router-dom'
import type {
  AttentionItem,
  AttentionRole,
  AttentionSummary,
} from '../../lib/notifications'

type Props = {
  summary: AttentionSummary
  /**
   * Viewer role — used to pick `customerLinkTo` over `linkTo` for customer
   * viewers so multi-role attention items (e.g. dispute under_review) land
   * on the customer's project surface instead of the craftsman job route
   * (which is OwnerRouteGate-blocked for customers). Defaults to undefined
   * = render the craftsman-side `linkTo` for backwards compatibility.
   * (Block 7.2.8.)
   */
  viewerRole?: AttentionRole
}

function resolveLinkTo(
  item: AttentionItem,
  viewerRole: AttentionRole | undefined,
): string {
  if (viewerRole === 'customer' && item.customerLinkTo) {
    return item.customerLinkTo
  }
  return item.linkTo
}

/**
 * Defensive routing for the inline primary CTA.
 *
 * Today every selector that emits `primaryAction` does so on single-role
 * items (`*_waiting`), where `primaryAction.to === linkTo` and points at
 * the surface for the viewer's role. If a future selector emits
 * `primaryAction` on a multi-role item, we MUST NOT route a customer to
 * the craftsman path — `customerLinkTo` then provides the customer
 * surface and we route there.
 *
 * (N13 hardening — closes the leak window the Block 7.2.8 fix only
 * patched on the secondary "Verlauf öffnen" link.)
 */
function resolvePrimaryActionTo(
  item: AttentionItem,
  viewerRole: AttentionRole | undefined,
): string {
  if (!item.primaryAction) return ''
  if (viewerRole === 'customer' && item.customerLinkTo) {
    return item.customerLinkTo
  }
  return item.primaryAction.to
}

const SEVERITY_STYLES = {
  urgent: {
    bg: 'bg-red-50',
    ring: 'ring-red-200/60',
    dot: 'bg-red-500',
    text: 'text-red-700',
    badge: 'bg-red-100 text-red-700',
    label: 'Dringend',
  },
  action: {
    bg: 'bg-amber-50',
    ring: 'ring-amber-200/60',
    dot: 'bg-amber-500',
    text: 'text-amber-700',
    badge: 'bg-amber-100 text-amber-700',
    label: 'Aktion',
  },
  waiting: {
    bg: 'bg-blue-50',
    ring: 'ring-blue-200/60',
    dot: 'bg-blue-400',
    text: 'text-blue-600',
    badge: 'bg-blue-100 text-blue-700',
    label: 'Wartet',
  },
  info: {
    bg: 'bg-slate-50',
    ring: 'ring-slate-200/60',
    dot: 'bg-slate-400',
    text: 'text-slate-600',
    badge: 'bg-slate-100 text-slate-600',
    label: 'Info',
  },
} as const

function AttentionRow({
  item,
  viewerRole,
}: {
  item: AttentionItem
  viewerRole?: AttentionRole
}) {
  const style = SEVERITY_STYLES[item.severity]
  const hasPrimary = !!item.primaryAction
  const resolvedLinkTo = resolveLinkTo(item, viewerRole)
  const resolvedPrimaryTo = resolvePrimaryActionTo(item, viewerRole)

  // When the item carries an inline primary action we render the row as a
  // <div> instead of a <Link> and put two explicit links inside (primary
  // CTA + secondary "Verlauf öffnen ›"). React Router would otherwise nest
  // a <Link> inside a <Link>, which is invalid DOM and breaks click
  // routing in nested anchor elements.
  if (hasPrimary && item.primaryAction) {
    return (
      <div
        className={`rounded-2xl px-4 py-3 ring-1 ${style.bg} ${style.ring}`}
      >
        <div className="flex items-center gap-3">
          <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[15px] leading-none">{item.icon}</span>
              <span className={`text-[14px] font-semibold leading-snug ${style.text}`}>
                {item.title}
              </span>
            </div>
            <p className="mt-0.5 text-[12px] text-slate-500 leading-snug">
              {item.description}
            </p>
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${style.badge}`}
          >
            {style.label}
          </span>
        </div>

        <div className="mt-2.5 flex items-center justify-between gap-3">
          <Link
            to={resolvedPrimaryTo}
            className="inline-flex flex-1 items-center justify-center rounded-xl bg-slate-900 px-3 py-2 text-[12px] font-semibold text-white transition active:scale-[0.97]"
          >
            {item.primaryAction.label}
          </Link>
          <Link
            to={resolvedLinkTo}
            className="text-[11px] font-semibold text-slate-500 hover:text-slate-700"
          >
            Verlauf öffnen ›
          </Link>
        </div>
      </div>
    )
  }

  return (
    <Link
      to={resolvedLinkTo}
      className={`flex items-center gap-3 rounded-2xl px-4 py-3 ring-1 transition hover:brightness-95 ${style.bg} ${style.ring}`}
    >
      <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[15px] leading-none">{item.icon}</span>
          <span className={`text-[14px] font-semibold leading-snug ${style.text}`}>
            {item.title}
          </span>
        </div>
        <p className="mt-0.5 text-[12px] text-slate-500 leading-snug">
          {item.description}
        </p>
      </div>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${style.badge}`}
      >
        {style.label}
      </span>
    </Link>
  )
}

export default function AttentionBanner({ summary, viewerRole }: Props) {
  if (summary.totalCount === 0) return null

  const topItems = summary.items.slice(0, 3)

  return (
    <div className="space-y-2">
      {/* Summary bar */}
      <div className="flex items-center gap-2 px-1">
        <span className="text-[16px] leading-none">🔔</span>
        <span className="text-[13px] font-semibold text-slate-700">
          {summary.totalCount === 1
            ? '1 Vorgang erfordert Aufmerksamkeit'
            : `${summary.totalCount} Vorgänge erfordern Aufmerksamkeit`}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {summary.urgentCount > 0 && (
            <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-100 px-1.5 text-[11px] font-bold text-red-700">
              {summary.urgentCount}
            </span>
          )}
          {summary.actionCount > 0 && (
            <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-amber-100 px-1.5 text-[11px] font-bold text-amber-700">
              {summary.actionCount}
            </span>
          )}
          {summary.waitingCount > 0 && (
            <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-blue-100 px-1.5 text-[11px] font-bold text-blue-700">
              {summary.waitingCount}
            </span>
          )}
        </div>
      </div>

      {/* Top items */}
      {topItems.map((item) => (
        <AttentionRow key={item.id} item={item} viewerRole={viewerRole} />
      ))}
    </div>
  )
}
