import { useNavigate } from 'react-router-dom'
import type { MessageRole } from '../../lib/messages'
import type { ChangeOrderArtifact } from '../../lib/messages/threadArtifactTypes'

type Props = {
  artifact: ChangeOrderArtifact
  role: MessageRole
}

// ── Status metadata ───────────────────────────────────────────────────────────

type StatusMeta = {
  icon: string
  label: string
  ring: string
  ctaLabel: string
}

function getStatusMeta(status: ChangeOrderArtifact['status'], role: MessageRole): StatusMeta {
  switch (status) {
    case 'pending':
      return {
        icon: '📝',
        label: 'Nachtrag liegt vor',
        ring: 'ring-amber-200/80',
        ctaLabel: role === 'customer' ? 'Nachtrag prüfen →' : 'Details anzeigen →',
      }
    case 'accepted':
      return {
        icon: '✅',
        label: 'Nachtrag angenommen',
        ring: 'ring-emerald-200/80',
        ctaLabel: 'Details anzeigen →',
      }
    case 'declined':
      return {
        icon: '❌',
        label: 'Nachtrag abgelehnt',
        ring: 'ring-slate-200/70',
        ctaLabel: 'Details anzeigen →',
      }
    case 'cancelled':
      return {
        icon: '↩️',
        label: 'Nachtrag zurückgezogen',
        ring: 'ring-slate-200/70',
        ctaLabel: 'Details anzeigen →',
      }
    default:
      return {
        icon: '📝',
        label: 'Nachtrag',
        ring: 'ring-slate-200/60',
        ctaLabel: 'Details anzeigen →',
      }
  }
}

/**
 * Compact ChangeOrder (Nachtrag) artifact card.
 *
 * Shown in the thread persistent context area when a ChangeOrder is pending
 * or recently resolved.  Shows the delta amount, description, and current
 * status.  Customer sees a CTA to accept/decline; craftsman sees status.
 *
 * Deep-links to ChangeOrderDetailScreen.
 */
export default function ThreadArtifactChangeOrderCard({ artifact, role }: Props) {
  const navigate = useNavigate()

  const { changeOrder, snapshot, status } = artifact
  const meta = getStatusMeta(status, role)
  const isCustomer = role === 'customer'

  // Display data: prefer live entity, fallback to snapshot
  const deltaAmount = changeOrder?.grossTotal != null
    ? (changeOrder.grossTotal >= 0 ? '+' : '') + new Intl.NumberFormat('de-DE', {
        style: 'currency',
        currency: 'EUR',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(changeOrder.grossTotal / 100)
    : snapshot?.deltaAmount ?? ''

  const description = changeOrder?.description ?? snapshot?.description ?? ''

  const changeOrderId = changeOrder?.id ?? snapshot?.changeOrderId
  const detailPath = changeOrderId
    ? isCustomer
      ? `/nachtrag/${changeOrderId}`
      : `/craftsman/nachtrag/${changeOrderId}`
    : null

  return (
    <div
      className={[
        'rounded-[12px] bg-white px-3 py-2 ring-1 shadow-[0_4px_12px_-8px_rgba(2,6,23,0.08)]',
        meta.ring,
      ].join(' ')}
    >
      {/* Primary row: icon · status · delta */}
      <div className="flex items-center gap-2">
        <span className="text-[14px] leading-none">{meta.icon}</span>
        <span className="text-[12px] font-semibold text-slate-700">
          {meta.label}
        </span>
        {deltaAmount && (
          <span
            className={[
              'ml-auto text-[13px] font-bold',
              deltaAmount.startsWith('+') || !deltaAmount.startsWith('-')
                ? 'text-slate-900'
                : 'text-rose-700',
            ].join(' ')}
          >
            {deltaAmount}
          </span>
        )}
      </div>

      {/* Badge row */}
      <div className="mt-0.5 flex items-center gap-1.5">
        <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500">
          Nachtrag
        </span>
      </div>

      {/* Description */}
      {description && (
        <p className="mt-1 truncate text-[11px] text-slate-400">
          {description}
        </p>
      )}

      {/* Detail CTA */}
      {detailPath && (
        <button
          type="button"
          onClick={() => navigate(detailPath)}
          className="mt-1.5 text-[11px] font-medium text-blue-600 transition hover:text-blue-700"
          data-testid="change-order-detail-link"
        >
          {meta.ctaLabel}
        </button>
      )}

      {/* Craftsman waiting hint for pending */}
      {status === 'pending' && !isCustomer && (
        <p className="mt-1 text-[10px] text-slate-400">
          Wartet auf Kundenentscheidung
        </p>
      )}
    </div>
  )
}
