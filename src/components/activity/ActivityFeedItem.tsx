import { Link } from 'react-router-dom'
import {
  getCraftsmanJobNavTarget,
  getCraftsmanTimelineNavTarget,
  type ProjectTimelineEvent,
} from '../../lib/timeline'

type Props = {
  event: ProjectTimelineEvent
  isLast: boolean
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

export default function ActivityFeedItem({ event, isLast }: Props) {
  const jobNavTarget = getCraftsmanJobNavTarget(event)
  const contextNavTarget = getCraftsmanTimelineNavTarget(event)

  return (
    <div className="relative flex gap-4 pb-6 last:pb-0">
      {!isLast ? (
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
          <div className="text-[11px] text-slate-400">{event.dateLabel}</div>

          <div className="flex items-center gap-3">
            {contextNavTarget ? (
              <Link
                to={contextNavTarget.path}
                className="text-[11px] font-medium text-blue-500 hover:text-blue-700 transition"
              >
                {contextNavTarget.label}
              </Link>
            ) : null}
            <Link
              to={jobNavTarget.path}
              className="text-[11px] font-medium text-slate-500 hover:text-slate-800 transition"
            >
              {jobNavTarget.label}
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
