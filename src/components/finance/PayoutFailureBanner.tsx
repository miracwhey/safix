import { AlertTriangle, ArrowRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { PayoutFailureAlert } from '../../lib/payments/payoutFailureAlert'

type Props = {
  alert: PayoutFailureAlert
}

/**
 * Top-Banner auf dem CraftsmanFinanceScreen, der einen fehlgeschlagenen
 * Stripe-Payout sichtbar und handlungsorientiert darstellt. Wird nur
 * gerendert, wenn `alert.hasPayoutFailure` true ist.
 */
export default function PayoutFailureBanner({ alert }: Props) {
  const navigate = useNavigate()

  if (!alert.hasPayoutFailure) return null

  return (
    <button
      type="button"
      onClick={() => navigate(alert.actionRoute)}
      data-testid="payout-failure-banner"
      className="flex w-full items-start gap-3 rounded-card bg-rose-50 px-4 py-4 ring-1 ring-rose-200 text-left transition active:scale-[0.99]"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-rose-100 text-rose-600">
        <AlertTriangle size={18} aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-rose-700">
            Handlungsbedarf
          </span>
          {alert.count > 1 && (
            <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-700">
              {alert.count}
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[15px] font-bold text-rose-900">{alert.title}</div>
        <div className="mt-1 text-[12px] leading-relaxed text-rose-800">{alert.description}</div>
        <div className="mt-2 inline-flex items-center gap-1 text-[12px] font-bold text-rose-700">
          {alert.ctaLabel}
          <ArrowRight size={12} aria-hidden />
        </div>
      </div>
    </button>
  )
}
