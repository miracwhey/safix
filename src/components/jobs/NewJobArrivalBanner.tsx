import { useState } from 'react'
import { getJobById, subscribeJobs } from '../../lib/jobs'
import type { Job } from '../../lib/jobs'
import { useStoreSync } from '../../lib/reactive'

type Props = {
  jobId: string
}

/**
 * Top-of-page orientation banner shown to the craftsman when a job has just
 * been converted (status='new', proposalSentAt undefined). Guides them through
 * the first 3 steps of turning an inquiry into a proposal.
 */
export default function NewJobArrivalBanner({ jobId }: Props) {
  const [job, setJob] = useState<Job | undefined>(() => getJobById(jobId))

  useStoreSync([subscribeJobs], () => {
    setJob(getJobById(jobId))
  })

  if (!job || job.status !== 'new' || job.proposalSentAt) return null

  return (
    <section className="relative overflow-hidden rounded-[28px] bg-blue-50 p-5 ring-1 ring-blue-100 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
      {/* Left blue accent bar */}
      <div className="pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] bg-gradient-to-b from-blue-500 via-blue-400 to-blue-300" />

      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          Neue Anfrage
        </span>
        <span className="inline-flex items-center rounded-full bg-blue-100 px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] text-blue-700 ring-1 ring-blue-200">
          EINGEGANGEN
        </span>
      </div>

      <h2 className="mt-3 text-[17px] font-semibold leading-snug text-blue-900">
        🆕 Neue Anfrage eingegangen
      </h2>
      <p className="mt-1 text-[14px] leading-relaxed text-blue-700">
        Prüfe die Angaben und erstelle ein Angebot für den Kunden.
      </p>

      {/* 3-step hint row */}
      <div className="mt-4 flex flex-col gap-2.5">
        {ARRIVAL_STEPS.map((step) => (
          <div key={step.title} className="flex items-start gap-3">
            <span className="mt-0.5 shrink-0 text-[16px] leading-none">
              {step.icon}
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-blue-900">
                {step.title}
              </div>
              <div className="text-[12px] text-blue-700 leading-snug">
                {step.description}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

const ARRIVAL_STEPS = [
  {
    icon: '📋',
    title: 'Anfrage prüfen',
    description: 'Details und Kontext unten überprüfen',
  },
  {
    icon: '✍️',
    title: 'Angebot erstellen',
    description: 'Betrag, Beschreibung und Timing ausfüllen',
  },
  {
    icon: '🚀',
    title: 'Angebot senden',
    description: 'Angebot einreichen und auf Kundenantwort warten',
  },
]
