import { Link } from 'react-router-dom'
import CraftsmanSectionCard from '../CraftsmanSectionCard'
import { getPaymentStateLabel } from '../../lib/payments'
import type { PaymentWithJobContext } from '../../lib/finance/types'
import { resolveCommercialDisplayContext } from '../../lib/shared/canonicalCommercialDisplay'

type Props = {
  payments: PaymentWithJobContext[]
}

// disputed → red, release_pending → amber, in_escrow/work_in_progress → blue,
// deposit_required/deposit_paid/released/refunded → slate (neutral)
function getStateBadgeStyle(state: string): string {
  if (state === 'disputed') return 'bg-rose-100 text-rose-700'
  if (state === 'release_pending') return 'bg-amber-100 text-amber-700'
  if (state === 'in_escrow' || state === 'work_in_progress') return 'bg-blue-100 text-blue-700'
  return 'bg-slate-100 text-slate-700'
}

export default function FinancePaymentsSection({ payments }: Props) {
  return (
    <CraftsmanSectionCard
      eyebrow="Zahlungsfälle"
      title="Aktive Payments"
      subtitle="Diese Fälle laufen aktuell durch Zahlung, Freigabe oder Konflikt."
    >
      <div className="space-y-3">
        {payments.length === 0 ? (
          <div className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)]">
            <div className="text-[16px] font-semibold text-slate-900">Keine aktiven Zahlungsfälle</div>
            <div className="mt-1 text-[14px] text-slate-500">Sobald Jobs in den Zahlungsfluss gehen, erscheinen sie hier.</div>
          </div>
        ) : (
          payments.map(({ payment, jobTitle, jobId }) => {
            // Canonical commercial context — no payment.amounts fallback.
            const ctx = resolveCommercialDisplayContext(jobId)
            const totalFormatted = ctx.orderValue.formatted
            const depositFormatted = ctx.depositReleaseFormatted
            const finalFormatted = ctx.finalReleaseFormatted

            return (
            <Link
              key={payment.id}
              to={`/craftsman/jobs/${jobId}`}
              className="block rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)] transition hover:ring-slate-300"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-semibold text-slate-900">{jobTitle}</div>
                  <div className="mt-0.5 text-[13px] text-slate-500">{getPaymentStateLabel(payment.state)}</div>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${getStateBadgeStyle(payment.state)}`}>
                  {getPaymentStateLabel(payment.state)}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3 text-[13px] text-slate-500">
                <div className="min-w-0">
                  <div className="font-semibold tabular-nums text-slate-900">{totalFormatted}</div>
                  <div>Gesamt</div>
                </div>
                <div className="min-w-0">
                  <div className="font-semibold tabular-nums text-slate-900">{depositFormatted}</div>
                  <div>Freigabe Beginn</div>
                </div>
                <div className="min-w-0">
                  <div className="font-semibold tabular-nums text-slate-900">{finalFormatted}</div>
                  <div>Rest</div>
                </div>
              </div>
            </Link>
            )
          })
        )}
      </div>
    </CraftsmanSectionCard>
  )
}
