import { Link } from 'react-router-dom'
import CraftsmanSectionCard from '../CraftsmanSectionCard'
import { getDisputeStatusLabelFor, getDisputeReasonLabel } from '../../lib/disputes'
import type { DisputeWithContext } from '../../lib/finance/types'
import type { DisputeStatus } from '../../lib/disputes/types'

type Props = {
  disputes: DisputeWithContext[]
}

function getStatusBadgeStyle(status: DisputeStatus): string {
  if (status === 'customer_waiting' || status === 'provider_waiting') return 'bg-orange-100 text-orange-700'
  if (status === 'open') return 'bg-amber-100 text-amber-700'
  if (status === 'under_review') return 'bg-blue-100 text-blue-700'
  return 'bg-slate-100 text-slate-600'
}

function getUrgencyBorderStyle(urgencyLevel: 'critical' | 'elevated' | 'normal'): string {
  if (urgencyLevel === 'critical') return 'ring-orange-200/80'
  if (urgencyLevel === 'elevated') return 'ring-amber-200/70'
  return 'ring-slate-200/70'
}

export default function FinanceDisputesSection({ disputes }: Props) {
  return (
    <CraftsmanSectionCard
      eyebrow="Konflikte"
      title="Dispute Center"
      subtitle="Alle aktiven Zahlungskonflikte mit Status, Dauer und eingefrorenem Betrag."
    >
      <div className="space-y-3">
        {disputes.length === 0 ? (
          <div className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70">
            <div className="text-[15px] font-semibold text-slate-900">Keine Konfliktfälle</div>
            <div className="mt-1 text-[13px] text-slate-500">Konflikte erscheinen hier automatisch, sobald ein Zahlungsfall eskaliert.</div>
          </div>
        ) : (
          <>
            {disputes.map(({ dispute, ageLabel, urgencyLevel, escrowAmountLabel }) => (
              <Link
                key={dispute.id}
                to={`/craftsman/jobs/${dispute.jobId}`}
                className={`block rounded-[24px] bg-white p-4 ring-1 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)] transition hover:ring-slate-300 ${getUrgencyBorderStyle(urgencyLevel)}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[15px] font-semibold text-slate-900">{dispute.title}</div>
                    <div className="mt-0.5 text-[13px] text-slate-500">{getDisputeReasonLabel(dispute.reason)}</div>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${getStatusBadgeStyle(dispute.status)}`}>
                    {getDisputeStatusLabelFor(dispute)}
                  </span>
                </div>

                <div className="mt-3 flex items-center gap-4 text-[12px] text-slate-500">
                  <span>{ageLabel}</span>
                  {escrowAmountLabel && (
                    <span className="font-semibold text-amber-700">{escrowAmountLabel} eingefroren</span>
                  )}
                </div>

                {urgencyLevel === 'critical' && (
                  <div className="mt-2 rounded-[12px] bg-orange-50 px-3 py-2 text-[12px] font-semibold text-orange-700 ring-1 ring-orange-200/60">
                    Belege angefordert – sofortiger Handlungsbedarf
                  </div>
                )}
                {urgencyLevel === 'elevated' && (
                  <div className="mt-2 rounded-[12px] bg-amber-50 px-3 py-2 text-[12px] font-semibold text-amber-700 ring-1 ring-amber-200/60">
                    Priorisieren – Fall seit mehr als 3 Tagen offen
                  </div>
                )}
              </Link>
            ))}
            <Link
              to="/craftsman/disputes"
              className="block rounded-[20px] bg-slate-50 px-4 py-3 text-center text-[13px] font-semibold text-slate-600 ring-1 ring-slate-200/70 transition hover:bg-slate-100"
            >
              Alle Fälle im Dispute Center →
            </Link>
          </>
        )}
      </div>
    </CraftsmanSectionCard>
  )
}
