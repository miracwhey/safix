import { Link } from 'react-router-dom'
import CalendarStatusBadge from './CalendarStatusBadge'
import type { CalendarEntry } from '../../lib/calendar'

type Props = {
  entries: CalendarEntry[]
}

type DayConfig = {
  key: string
  label: string
  shortLabel: string
}

const weekDays: DayConfig[] = [
  { key: '2026-03-07', label: 'Samstag', shortLabel: 'Sa' },
  { key: '2026-03-08', label: 'Sonntag', shortLabel: 'So' },
  { key: '2026-03-09', label: 'Montag', shortLabel: 'Mo' },
  { key: '2026-03-10', label: 'Dienstag', shortLabel: 'Di' },
  { key: '2026-03-11', label: 'Mittwoch', shortLabel: 'Mi' },
  { key: '2026-03-12', label: 'Donnerstag', shortLabel: 'Do' },
  { key: '2026-03-13', label: 'Freitag', shortLabel: 'Fr' },
]

function sortEntries(entries: CalendarEntry[]): CalendarEntry[] {
  return [...entries].sort((a, b) =>
    a.startsAtLabel.localeCompare(b.startsAtLabel)
  )
}

export default function CalendarWeekView({ entries }: Props) {
  return (
    <div className="space-y-3">
      {weekDays.map((day) => {
        const dayEntries = sortEntries(
          entries.filter((entry) => entry.dateKey === day.key)
        )

        return (
          <div
            key={day.key}
            className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)]"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  {day.shortLabel}
                </div>
                <div className="mt-1 text-[18px] font-semibold text-slate-900">
                  {day.label}
                </div>
              </div>

              <div className="rounded-full bg-slate-100 px-3 py-1 text-[12px] font-semibold text-slate-700">
                {dayEntries.length} Einsatz{dayEntries.length === 1 ? '' : 'e'}
              </div>
            </div>

            {dayEntries.length === 0 ? (
              <div className="mt-4 rounded-[18px] bg-slate-50 px-4 py-3 text-[14px] text-slate-500 ring-1 ring-slate-200/70">
                Kein Einsatz geplant.
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                {dayEntries.map((entry) => (
                  <Link
                    key={entry.id}
                    to={`/craftsman/jobs/${entry.jobId}`}
                    className="block rounded-[18px] bg-slate-50 px-4 py-3 ring-1 ring-slate-200/70 transition active:scale-[0.99]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[15px] font-semibold text-slate-900">
                          {entry.title}
                        </div>
                        <div className="mt-1 text-[13px] text-slate-500">
                          {entry.customerName} · {entry.location}
                        </div>
                        <div className="mt-2 text-[13px] font-medium text-slate-700">
                          {entry.startsAtLabel} – {entry.endsAtLabel}
                        </div>
                      </div>

                      <CalendarStatusBadge status={entry.status} />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
