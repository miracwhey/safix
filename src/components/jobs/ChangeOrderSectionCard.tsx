import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import InlineFeedback from '../system/InlineFeedback'
import {
  getChangeOrdersByJobId,
  subscribeChangeOrders,
  isChangeOrderRepositoryHydrated,
} from '../../lib/changeOrders'
import type { ChangeOrder } from '../../lib/changeOrders/types'
import { cancelChangeOrderWorkflow } from '../../lib/workflow/changeOrderWorkflow'
import { getJobById } from '../../lib/jobs'
import { jobKindAllowsStandardExecution } from '../../lib/offers/commercialDocumentPolicy'
import { formatCents } from '../../lib/shared/formatters'
import {
  getSupplementaryPaymentByChangeOrderId,
  subscribeSupplementaryPayments,
  reconcileSupplementaryTimelineEvents,
} from '../../lib/payments/supplementary'
import type { SupplementaryPaymentRequest } from '../../lib/payments/supplementary'
import { useStoreSubscriptions } from '../../lib/reactive'
import { normalizeErrorMessage } from '../../lib/diagnostics'

type Props = {
  jobId: string
  craftsmanUserId: string
  /** Whether the current user is the craftsman (shows different CTAs). */
  isCraftsman: boolean
}

// ── Status display helpers ────────────────────────────────────────────────────

type StatusMeta = {
  icon: string
  label: string
  tone: string
}

function getStatusMeta(status: ChangeOrder['status']): StatusMeta {
  switch (status) {
    case 'pending':
      return { icon: '📝', label: 'Ausstehend', tone: 'text-amber-700' }
    case 'accepted':
      return { icon: '✅', label: 'Angenommen', tone: 'text-emerald-700' }
    case 'declined':
      return { icon: '❌', label: 'Abgelehnt', tone: 'text-rose-700' }
    case 'cancelled':
      return { icon: '↩️', label: 'Zurückgezogen', tone: 'text-slate-500' }
    default:
      return { icon: '📋', label: status, tone: 'text-slate-500' }
  }
}

function getSupplementaryBadge(
  co: ChangeOrder,
  allSupplementary: Map<string, SupplementaryPaymentRequest>
): { show: boolean; label: string } {
  if (co.status !== 'accepted') return { show: false, label: '' }
  const req = allSupplementary.get(co.id)
  if (!req) return { show: false, label: '' }
  if (req.status === 'paid' || req.status === 'funded' || req.status === 'released' || req.status === 'waived') return { show: false, label: '' }
  const amount = formatCents(req.amountCents)
  return {
    show: true,
    label: req.status === 'funding_initiated'
      ? `⏳ Nachzahlung ${amount} wird verarbeitet`
      : req.status === 'acknowledged'
        ? `⚡ Nachzahlung ${amount} bestätigt`
        : `⚠ Nachzahlung ${amount} offen`,
  }
}

/**
 * ChangeOrder (Nachtrag) section for CraftsmanJobDetailScreen.
 *
 * Shows all ChangeOrders for a job with their current status.
 * Craftsman can create a new Nachtrag (CTA) and cancel pending ones.
 * Each row deep-links to ChangeOrderDetailScreen.
 *
 * Accepted COs with a pending supplementary payment request show a badge.
 *
 * CTA only shown for:
 *   - standard (binding_offer-origin) jobs
 *   - status 'in_progress' or 'waiting_payment'
 */
export default function ChangeOrderSectionCard({ jobId, craftsmanUserId, isCraftsman }: Props) {
  const navigate = useNavigate()

  const [changeOrders, setChangeOrders] = useState<ChangeOrder[]>(() =>
    isChangeOrderRepositoryHydrated() ? getChangeOrdersByJobId(jobId) : []
  )
  // Map changeOrderId → SupplementaryPaymentRequest for quick badge lookup
  const [supplementaryMap, setSupplementaryMap] = useState<Map<string, SupplementaryPaymentRequest>>(() => {
    const orders = isChangeOrderRepositoryHydrated() ? getChangeOrdersByJobId(jobId) : []
    const m = new Map<string, SupplementaryPaymentRequest>()
    for (const co of orders) {
      const req = getSupplementaryPaymentByChangeOrderId(co.id)
      if (req) m.set(co.id, req)
    }
    return m
  })
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)

  function refreshOrders() {
    const orders = getChangeOrdersByJobId(jobId)
    setChangeOrders(orders)
    const m = new Map<string, SupplementaryPaymentRequest>()
    for (const co of orders) {
      const req = getSupplementaryPaymentByChangeOrderId(co.id)
      if (req) {
        m.set(co.id, req)
        reconcileSupplementaryTimelineEvents(req)
      }
    }
    setSupplementaryMap(m)
  }

  useStoreSubscriptions([
    {
      subscribe: subscribeChangeOrders,
      onChange: refreshOrders,
    },
    {
      subscribe: subscribeSupplementaryPayments,
      onChange: refreshOrders,
    },
  ])

  useEffect(() => {
    refreshOrders()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  const job = getJobById(jobId)

  // CTA eligibility
  const isStandardJob = jobKindAllowsStandardExecution(job?.jobKind)
  const isActiveStatus = job?.status === 'in_progress' || job?.status === 'waiting_payment'
  const canCreateNachtrag = isCraftsman && isStandardJob && isActiveStatus

  const handleCancel = async (changeOrderId: string) => {
    if (cancellingId) return
    setCancellingId(changeOrderId)
    setCancelError(null)
    try {
      await cancelChangeOrderWorkflow(changeOrderId, craftsmanUserId)
      refreshOrders()
    } catch (err) {
      setCancelError(`Zurückziehen fehlgeschlagen: ${normalizeErrorMessage(err)}`)
    } finally {
      setCancellingId(null)
    }
  }

  const handleCreateNachtrag = () => {
    navigate(`/craftsman/nachtrag/neu?jobId=${jobId}`)
  }

  if (changeOrders.length === 0 && !canCreateNachtrag) return null

  return (
    <div className="space-y-3">
      {/* Section header */}
      <div className="flex items-center gap-2">
        <div className="h-px flex-1 bg-slate-100" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Nachträge
        </span>
        <div className="h-px flex-1 bg-slate-100" />
      </div>

    <div className="rounded-container bg-surface p-4 ring-1 ring-edge shadow-subtle space-y-3">
      {changeOrders.length > 0 && (
        <ul className="space-y-2">
          {changeOrders.map((co) => {
            const meta = getStatusMeta(co.status)
            const deltaLabel = co.grossTotal != null
              ? (co.grossTotal >= 0 ? '+' : '') + formatCents(co.grossTotal)
              : co.price
            const detailPath = isCraftsman
              ? `/craftsman/nachtrag/${co.id}`
              : `/nachtrag/${co.id}`
            const suppBadge = getSupplementaryBadge(co, supplementaryMap)

            return (
              <li
                key={co.id}
                className="flex items-start gap-3 rounded-card bg-white px-3 py-2.5 ring-1 ring-edge/60 shadow-subtle"
              >
                <span className="mt-0.5 text-[14px] leading-none">{meta.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={['text-[12px] font-semibold', meta.tone].join(' ')}>
                      {meta.label}
                    </span>
                    <span className="ml-auto text-[13px] font-bold text-slate-900">
                      {deltaLabel}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-slate-500">
                    {co.description}
                  </p>
                  {suppBadge.show && (
                    <p className="mt-1 text-[11px] font-medium text-amber-700">
                      {suppBadge.label}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <button
                    type="button"
                    onClick={() => navigate(detailPath)}
                    className="text-[11px] font-medium text-blue-600 transition hover:text-blue-700"
                  >
                    Details →
                  </button>
                  {isCraftsman && co.status === 'pending' && (
                    <button
                      type="button"
                      onClick={() => void handleCancel(co.id)}
                      disabled={cancellingId === co.id}
                      className="text-[10px] text-slate-400 transition hover:text-slate-600 disabled:opacity-50"
                    >
                      {cancellingId === co.id ? 'Wird zurückgezogen…' : 'Zurückziehen'}
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <InlineFeedback error={cancelError} onDismiss={() => setCancelError(null)} />

      {canCreateNachtrag && (
        <button
          type="button"
          onClick={handleCreateNachtrag}
          className="w-full rounded-card border border-dashed border-slate-300 bg-white px-4 py-2.5 text-[13px] font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 active:scale-[0.98]"
          data-testid="create-change-order-cta"
        >
          + Nachtrag erstellen
        </button>
      )}
    </div>
    </div>
  )
}
