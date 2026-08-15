import { useState } from 'react'
import { getJobById, subscribeJobs, deriveJobOutcome } from '../../lib/jobs'
import type { JobOutcomeViewModel } from '../../lib/jobs'
import { getPaymentForJob, subscribePayments, isPaymentRepositoryHydrated } from '../../lib/payments'
import { getDisputeByJobId, subscribeDisputes, isDisputeRepositoryHydrated } from '../../lib/disputes'
import { useStoreSync } from '../../lib/reactive'

type Props = {
  jobId: string
}

export default function JobOutcomeBanner({ jobId }: Props) {
  function buildVm(): JobOutcomeViewModel | null {
    // Settlement truth lives on the dispute. Until the dispute repo is hydrated
    // we cannot tell a still-settling refund/payout from a finished one — never
    // render a terminal "Betrag erstattet / erfolgreich abgeschlossen" derived
    // from a not-yet-loaded dispute store.
    if (!isDisputeRepositoryHydrated()) return null
    const job = getJobById(jobId)
    if (!job) return null
    const payment = getPaymentForJob(jobId)
    const dispute = getDisputeByJobId(jobId)
    const vm = deriveJobOutcome(job, payment ?? undefined, isPaymentRepositoryHydrated(), dispute)
    return vm.isTerminal ? vm : null
  }

  const [vm, setVm] = useState<JobOutcomeViewModel | null>(buildVm)

  useStoreSync([subscribeJobs, subscribePayments, subscribeDisputes], () => {
    setVm(buildVm())
  })

  if (!vm) return null

  const isReleased = vm.outcomeType === 'released'

  // Style variants
  const bannerBg = isReleased
    ? 'bg-emerald-50 ring-emerald-200/80'
    : 'bg-amber-50 ring-amber-200/80'
  const accentBar = isReleased
    ? 'bg-gradient-to-b from-emerald-500 via-emerald-400 to-emerald-300'
    : 'bg-gradient-to-b from-amber-500 via-amber-400 to-amber-300'
  const iconBg = isReleased ? 'bg-emerald-500' : 'bg-amber-500'
  const badgeBg = isReleased
    ? 'bg-emerald-100 text-emerald-700 ring-emerald-200'
    : 'bg-amber-100 text-amber-700 ring-amber-200'
  const headlineColor = isReleased ? 'text-emerald-900' : 'text-amber-900'
  const subtextColor = isReleased ? 'text-emerald-700' : 'text-amber-700'

  return (
    <section
      className={`relative overflow-hidden rounded-[28px] p-5 ring-1 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)] ${bannerBg}`}
    >
      <div
        className={`pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] ${accentBar}`}
      />

      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          Auftragsergebnis
        </span>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] ring-1 ${badgeBg}`}
        >
          {vm.outcomeBadgeLabel}
        </span>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${iconBg}`}
          style={{
            boxShadow: isReleased
              ? '0 8px 20px -12px rgba(16,185,129,0.5)'
              : '0 8px 20px -12px rgba(245,158,11,0.5)',
          }}
        >
          <span className="text-[18px] leading-none">{vm.outcomeIcon}</span>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className={`text-[17px] font-semibold leading-snug ${headlineColor}`}>
            {vm.outcomeHeadline}
          </h2>
        </div>
      </div>

      <p className={`mt-2 text-[14px] leading-relaxed ${subtextColor}`}>
        {vm.outcomeSubtext}
      </p>
    </section>
  )
}
