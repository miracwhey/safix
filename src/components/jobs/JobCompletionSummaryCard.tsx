import { useState } from 'react'
import { getJobById, subscribeJobs, deriveCompletedWorkProof } from '../../lib/jobs'
import type { CompletedWorkProofViewModel } from '../../lib/jobs'
import { getPaymentForJob, subscribePayments, isPaymentRepositoryHydrated } from '../../lib/payments'
import { getDisputeByJobId, subscribeDisputes, isDisputeRepositoryHydrated } from '../../lib/disputes'
import { getArtifactsByJobId, subscribeMedia } from '../../lib/media'
import { getFeedbackByJobId, subscribeFeedback } from '../../lib/feedback'
import { useStoreSync } from '../../lib/reactive'

type Props = {
  jobId: string
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

function JobCompletionSummaryCardView({ vm }: { vm: CompletedWorkProofViewModel }) {
  const isRefund = !vm.isFullyPaid
  // While a dispute decision is still settling, the money has NOT moved yet —
  // render an in-progress (amber) state and never a terminal "Betrag erstattet /
  // Zahlung freigegeben" on the date row or status banner. The decision-driven
  // direction copy already lives in vm.headline / vm.summary (selector layer).
  const isSettling = vm.settlementPending
  // Amber = in-progress / refund; emerald = clean settled release.
  const useAmber = isRefund || isSettling

  const ringColor = useAmber ? 'ring-amber-200/80' : 'ring-emerald-200/80'
  const accentBar = useAmber
    ? 'bg-gradient-to-b from-amber-500 via-amber-400 to-amber-300'
    : 'bg-gradient-to-b from-emerald-500 via-emerald-400 to-emerald-300'
  const iconBg = useAmber ? 'bg-amber-500' : 'bg-emerald-500'
  const iconShadow = useAmber
    ? '0 8px 20px -12px rgba(245,158,11,0.5)'
    : '0 8px 20px -12px rgba(16,185,129,0.5)'
  const iconEmoji = isSettling ? '⏳' : isRefund ? '↩' : '🎉'
  const badgeBg = useAmber
    ? 'bg-amber-50 text-amber-700 ring-amber-100'
    : 'bg-emerald-50 text-emerald-700 ring-emerald-100'
  const statusBannerBg = useAmber ? 'bg-amber-50' : 'bg-emerald-50'
  const statusBannerText = useAmber ? 'text-amber-800' : 'text-emerald-800'
  const highlightColor = useAmber ? 'text-amber-700' : 'text-emerald-700'

  return (
    <section
      className={`relative overflow-hidden rounded-[28px] bg-white p-5 ring-1 ${ringColor} shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]`}
    >
      {/* Left accent bar */}
      <div className={`pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] ${accentBar}`} />

      {/* Eyebrow + badge */}
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          Abschluss & Auszahlung
        </span>
        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] ring-1 ${badgeBg}`}>
          {vm.badgeLabel}
        </span>
      </div>

      {/* Icon + headline */}
      <div className="mt-3 flex items-center gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${iconBg}`}
          style={{ boxShadow: iconShadow }}
        >
          <span className="text-[18px] leading-none">{iconEmoji}</span>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold leading-snug text-slate-900">
            {vm.headline}
          </h2>
        </div>
      </div>

      {/* Summary text */}
      <p className="mt-3 text-[14px] leading-relaxed text-slate-500">
        {vm.summary}
      </p>

      {/* Divider */}
      <div className="my-4 h-px bg-slate-100" />

      {/* Closure detail rows */}
      <div className="space-y-2.5">
        <DetailRow label="Auftraggeber" value={vm.customer} />
        <DetailRow label="Ausführungsort" value={vm.location} />
        {vm.totalAmount > 0 && (
          <DetailRow
            label="Gesamtbetrag"
            value={vm.formattedTotal}
            valueColor={highlightColor}
          />
        )}
        <DetailRow
          label="Arbeit abgeschlossen"
          value={formatDate(vm.workCompletedAt)}
        />
        <DetailRow
          label={isSettling ? 'Abwicklung' : vm.isFullyPaid ? 'Zahlung freigegeben' : 'Betrag erstattet'}
          value={isSettling ? 'In Bearbeitung' : formatDate(vm.paymentReleasedAt)}
        />
      </div>

      {/* Proof signals */}
      {vm.proofSignals.length > 0 && (
        <>
          <div className="my-4 h-px bg-slate-100" />
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              Arbeitsnachweise
            </div>
            <div className="flex flex-wrap gap-2">
              {vm.proofSignals.map((signal) => (
                <span
                  key={signal.kind}
                  className="inline-flex items-center gap-1.5 rounded-full bg-slate-50 px-3 py-1.5 text-[12px] font-semibold text-slate-700 ring-1 ring-slate-200/70"
                >
                  <span className="text-[13px] leading-none">{signal.icon}</span>
                  {signal.label}
                </span>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Status banner */}
      <div className={`mt-4 flex items-center gap-2 rounded-2xl px-4 py-3 ${statusBannerBg}`}>
        <span className="text-[16px]">{isSettling ? '⏳' : isRefund ? '↩' : '✅'}</span>
        <span className={`text-[13px] font-semibold ${statusBannerText}`}>
          {isSettling
            ? 'Auftrag geschlossen · Abwicklung läuft'
            : vm.isFullyPaid
              ? 'Auszahlung gesichert · Auftrag geschlossen'
              : 'Auftrag geschlossen · Streitfall beigelegt'}
        </span>
      </div>
    </section>
  )
}

function DetailRow({
  label,
  value,
  valueColor,
}: {
  label: string
  value: string
  valueColor?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[13px] text-slate-400">{label}</span>
      <span
        className={`text-right text-[13px] font-semibold ${
          valueColor ? valueColor : 'text-slate-700'
        }`}
      >
        {value}
      </span>
    </div>
  )
}

export default function JobCompletionSummaryCard({ jobId }: Props) {
  function buildVm(): CompletedWorkProofViewModel | null {
    // Hydration gate: settlement truth lives on the dispute and the terminal
    // payment story on the payment repo. Until both are hydrated we cannot tell
    // a still-settling refund/payout from a finished one — never render a
    // terminal "Betrag erstattet / Zahlung freigegeben" from not-yet-loaded data.
    if (!isPaymentRepositoryHydrated() || !isDisputeRepositoryHydrated()) return null
    const job = getJobById(jobId)
    if (!job) return null
    const payment = getPaymentForJob(jobId)
    const artifacts = getArtifactsByJobId(jobId)
    const feedback = getFeedbackByJobId(jobId)
    const dispute = getDisputeByJobId(jobId)
    return deriveCompletedWorkProof(job, payment ?? undefined, artifacts, feedback, dispute)
  }

  const [vm, setVm] = useState<CompletedWorkProofViewModel | null>(buildVm)

  useStoreSync([subscribeJobs, subscribePayments, subscribeMedia, subscribeFeedback, subscribeDisputes], () => {
    setVm(buildVm())
  })

  if (!vm) return null

  return <JobCompletionSummaryCardView vm={vm} />
}
