import { Link } from 'react-router-dom'
import CraftsmanSectionCard from '../CraftsmanSectionCard'
import {
  getCraftsmanTimelineNavTarget,
  type ProjectTimelineEvent,
} from '../../lib/timeline'

type Props = {
  events: ProjectTimelineEvent[]
}

function getAccentClass(accent: ProjectTimelineEvent['accent']): string {
  if (accent === 'blue') return 'bg-blue-50 text-blue-700'
  if (accent === 'emerald') return 'bg-emerald-50 text-emerald-700'
  if (accent === 'violet') return 'bg-violet-50 text-violet-700'
  if (accent === 'amber') return 'bg-amber-50 text-amber-700'
  if (accent === 'rose') return 'bg-rose-50 text-rose-700'
  return 'bg-slate-100 text-slate-700'
}

export default function JobTimelineCard({ events }: Props) {
  return (
    <CraftsmanSectionCard
      eyebrow="Timeline"
      title="Auftragsverlauf"
      subtitle="Hier laufen operative Schritte, Dokumentation, Rechnung und Zahlung in einer gemeinsamen Ansicht zusammen."
    >
      <div className="space-y-3">
        {events.map((event) => {
          const navTarget = getCraftsmanTimelineNavTarget(event)
          return (
          <div
            key={event.id}
            className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[16px] font-semibold text-slate-900">
                  {event.title}
                </div>
                <div className="mt-1 text-[14px] text-slate-500">
                  {event.description}
                </div>
              </div>

              <div
                className={[
                  'shrink-0 rounded-full px-3 py-1 text-[12px] font-semibold',
                  getAccentClass(event.accent),
                ].join(' ')}
              >
                {event.label}
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between">
              <div className="text-[12px] text-slate-400">
                {event.dateLabel}
              </div>

              {navTarget ? (
                <Link
                  to={navTarget.path}
                  className="text-[12px] font-medium text-blue-500 hover:text-blue-700 transition"
                >
                  {navTarget.label}
                </Link>
              ) : null}
            </div>
          </div>
          )
        })}
      </div>
    </CraftsmanSectionCard>
  )
}
