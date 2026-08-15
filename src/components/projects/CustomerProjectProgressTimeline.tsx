import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import CraftsmanSectionCard from '../CraftsmanSectionCard'
import { getCalendarEntryByJobId } from '../../lib/calendar'
import { getInvoiceByJobId } from '../../lib/invoices'
import { getJobById } from '../../lib/jobs'
import {
  buildProjectTimeline,
  getCustomerTimelineNavTarget,
  subscribeTimeline,
  type ProjectTimelineEvent,
} from '../../lib/timeline'
import { getProjectByJobId } from '../../lib/projects'
import { getPaymentForJobWorkflow } from '../../lib/workflow'

type Props = {
  jobId: string
}

function getDotClass(accent: ProjectTimelineEvent['accent']): string {
  if (accent === 'blue') return 'bg-blue-100 text-blue-600'
  if (accent === 'emerald') return 'bg-emerald-100 text-emerald-600'
  if (accent === 'violet') return 'bg-violet-100 text-violet-600'
  if (accent === 'amber') return 'bg-amber-100 text-amber-600'
  if (accent === 'rose') return 'bg-rose-100 text-rose-600'
  return 'bg-slate-100 text-slate-500'
}

function getLabelClass(accent: ProjectTimelineEvent['accent']): string {
  if (accent === 'blue') return 'bg-blue-50 text-blue-700'
  if (accent === 'emerald') return 'bg-emerald-50 text-emerald-700'
  if (accent === 'violet') return 'bg-violet-50 text-violet-700'
  if (accent === 'amber') return 'bg-amber-50 text-amber-700'
  if (accent === 'rose') return 'bg-rose-50 text-rose-700'
  return 'bg-slate-100 text-slate-700'
}

function deriveEvents(jobId: string): ProjectTimelineEvent[] {
  const job = getJobById(jobId)
  if (!job) return []
  return buildProjectTimeline({
    job,
    calendarEntry: getCalendarEntryByJobId(jobId),
    invoice: getInvoiceByJobId(jobId),
    payment: getPaymentForJobWorkflow(jobId),
  })
}

export default function CustomerProjectProgressTimeline({ jobId }: Props) {
  const [events, setEvents] = useState<ProjectTimelineEvent[]>(() =>
    deriveEvents(jobId)
  )

  useEffect(() => {
    function sync() {
      setEvents(deriveEvents(jobId))
    }

    const unsubTimeline = subscribeTimeline(sync)
    return () => {
      unsubTimeline()
    }
  }, [jobId])

  if (events.length === 0) return null

  const project = getProjectByJobId(jobId)

  return (
    <CraftsmanSectionCard
      eyebrow="Fortschritt"
      title="Projektverlauf"
      subtitle="Chronologische Übersicht aller Ereignisse – von der Beauftragung bis zum Abschluss."
    >
      <div className="relative">
        {events.map((event, index) => {
          const navTarget = project
            ? getCustomerTimelineNavTarget(event, project.id)
            : null
          return (
          <div key={event.id} className="relative flex gap-4 pb-6 last:pb-0">
            {index < events.length - 1 ? (
              <div className="absolute left-[11px] top-6 h-full w-[2px] bg-slate-100" />
            ) : null}

            <div
              className={[
                'relative z-10 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                getDotClass(event.accent),
              ].join(' ')}
            >
              <div className="h-2 w-2 rounded-full bg-current" />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div className="text-[15px] leading-snug font-semibold text-slate-900">
                  {event.title}
                </div>
                <div
                  className={[
                    'shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold',
                    getLabelClass(event.accent),
                  ].join(' ')}
                >
                  {event.label}
                </div>
              </div>

              <div className="mt-1 text-[13px] leading-relaxed text-slate-500">
                {event.description}
              </div>

              <div className="mt-1.5 flex items-center justify-between gap-2">
                <div className="text-[11px] text-slate-400">
                  {event.dateLabel}
                </div>

                {navTarget ? (
                  <Link
                    to={navTarget.path}
                    className="text-[11px] font-medium text-blue-500 hover:text-blue-700 transition"
                  >
                    {navTarget.label}
                  </Link>
                ) : null}
              </div>
            </div>
          </div>
          )
        })}
      </div>
    </CraftsmanSectionCard>
  )
}
