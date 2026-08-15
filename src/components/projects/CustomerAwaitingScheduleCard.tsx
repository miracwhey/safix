import { useState } from 'react'
import { getJobById, subscribeJobs } from '../../lib/jobs'
import { getScheduleForJob, subscribeOperations } from '../../lib/operations'
import { useStoreSync } from '../../lib/reactive'

type Props = {
  jobId: string
}

function buildIsVisible(jobId: string): boolean {
  const job = getJobById(jobId)
  // Only show when proposal has been accepted but job has not yet started
  if (!job || !job.proposalAcceptedAt) return false
  if (job.status === 'in_progress' || job.status === 'waiting_payment' || job.status === 'completed') return false
  // Hide when a schedule already exists — CustomerSchedulingCard takes over
  const schedule = getScheduleForJob(jobId)
  return schedule === undefined || schedule === null
}

/**
 * Shown in the "Termin" section when the customer has accepted a proposal
 * but the craftsman has not yet created a schedule.
 *
 * Fills the otherwise-empty scheduling section with a clear waiting-state
 * message so the customer knows what to expect next.
 */
export default function CustomerAwaitingScheduleCard({ jobId }: Props) {
  const [isVisible, setIsVisible] = useState(() => buildIsVisible(jobId))

  useStoreSync([subscribeJobs, subscribeOperations], () =>
    setIsVisible(buildIsVisible(jobId))
  )

  if (!isVisible) return null

  return (
    <section className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-2 shrink-0 rounded-full bg-blue-400" />
          <span className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
            Termin
          </span>
        </div>
        <span className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-[11px] font-semibold text-blue-700 ring-1 ring-blue-100">
          Wird geplant
        </span>
      </div>

      {/* Icon + title */}
      <div className="mt-3 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white ring-1 ring-slate-200/70 shadow-[0_6px_16px_-10px_rgba(2,6,23,0.22)]">
          <span className="text-[18px] leading-none">📅</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold leading-snug text-slate-900">
            Termin wird noch festgelegt
          </p>
          <p className="mt-0.5 text-[13px] text-slate-400">
            Dein Handwerker plant die Ausführung
          </p>
        </div>
      </div>

      {/* Info box */}
      <div className="mt-4 rounded-[14px] bg-blue-50 px-3.5 py-3 ring-1 ring-blue-100">
        <p className="text-[13px] leading-relaxed text-slate-600">
          Dein Handwerker bereitet den Termin vor. Sobald ein Datum feststeht,
          siehst du es hier und erhältst eine Benachrichtigung.
        </p>
      </div>

      {/* What to expect */}
      <div className="mt-3 flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-[14px] leading-none">💡</span>
        <p className="text-[12px] leading-relaxed text-slate-500">
          Stelle sicher, dass der Zugang zum Objekt wenn der Termin feststeht gewährleistet ist und du erreichbar bist.
        </p>
      </div>
    </section>
  )
}
