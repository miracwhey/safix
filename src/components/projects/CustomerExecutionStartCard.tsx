import { useState } from 'react'
import { getJobById, subscribeJobs } from '../../lib/jobs'
import { useStoreSync } from '../../lib/reactive'

type Props = { jobId: string }

function buildIsActive(jobId: string): boolean {
  const job = getJobById(jobId)
  return job?.status === 'in_progress'
}

/**
 * Prominent "work started" signal shown to customers when the job is in_progress.
 * Informs the customer that the craftsman has begun execution and sets
 * expectations about documentation and the upcoming acceptance step.
 */
export default function CustomerExecutionStartCard({ jobId }: Props) {
  const [isActive, setIsActive] = useState(() => buildIsActive(jobId))

  useStoreSync([subscribeJobs], () => setIsActive(buildIsActive(jobId)))

  if (!isActive) return null

  return (
    <section className="relative overflow-hidden rounded-[28px] bg-white p-5 ring-1 ring-emerald-200/80 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
      {/* Left accent bar — emerald (matches accepted state) */}
      <div className="pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] bg-gradient-to-b from-emerald-500 via-emerald-400 to-emerald-300" />

      {/* Eyebrow + badge */}
      <div className="flex items-center gap-2">
        <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-emerald-600">
          Ausführung
        </div>
        <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] text-emerald-700 ring-1 ring-emerald-200">
          AKTIV
        </span>
      </div>

      {/* Icon + title row */}
      <div className="mt-3 flex items-center gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-500"
          style={{ boxShadow: '0 8px 20px -12px rgba(2,6,23,0.4)' }}
        >
          <span className="text-[18px] leading-none">🔨</span>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold leading-snug text-slate-900">
            Arbeit hat begonnen
          </h2>
        </div>
      </div>

      {/* Description */}
      <p className="mt-3 text-[14px] leading-relaxed text-slate-500">
        Der Handwerker hat mit der Ausführung begonnen. Du kannst den Fortschritt und die Dokumentationsfotos hier verfolgen.
      </p>

      {/* Next-steps box */}
      <div className="mt-4 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-100 space-y-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-[16px] leading-none">📷</span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-slate-700">Dokumentation</div>
            <div className="text-[12px] text-slate-500 leading-snug">
              Fortschrittsfotos werden laufend hinzugefügt
            </div>
          </div>
        </div>
        <div className="border-t border-slate-100" />
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-[16px] leading-none">✅</span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-slate-700">Abnahme</div>
            <div className="text-[12px] text-slate-500 leading-snug">
              Nach Abschluss erhältst du eine Freigabeanfrage
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
