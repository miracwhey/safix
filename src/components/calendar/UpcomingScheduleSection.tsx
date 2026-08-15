import CraftsmanSectionCard from '../CraftsmanSectionCard'
import CalendarEntryCard from './CalendarEntryCard'
import type { CalendarEntry } from '../../lib/calendar'

type Props = {
  entries: CalendarEntry[]
}

function groupByDate(
  entries: CalendarEntry[]
): Array<{ dateLabel: string; entries: CalendarEntry[] }> {
  const map = new Map<string, CalendarEntry[]>()

  for (const entry of entries) {
    const key = entry.dateLabel
    const list = map.get(key) ?? []
    list.push(entry)
    map.set(key, list)
  }

  return Array.from(map.entries()).map(([dateLabel, grouped]) => ({
    dateLabel,
    entries: grouped,
  }))
}

export default function UpcomingScheduleSection({ entries }: Props) {
  const groups = groupByDate(entries)

  return (
    <CraftsmanSectionCard
      eyebrow="Als Nächstes"
      title="Nächste Termine"
      subtitle="Alle kommenden Einsätze im Überblick, nach Datum gruppiert."
    >
      <div className="space-y-5">
        {entries.length === 0 ? (
          <div className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)]">
            <div className="text-[16px] font-semibold text-slate-900">
              Noch keine kommenden Termine
            </div>
            <div className="mt-1 text-[14px] text-slate-500">
              Weitere Einsätze tauchen hier automatisch auf.
            </div>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.dateLabel} className="space-y-3">
              <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                {group.dateLabel}
              </div>
              {group.entries.map((entry) => (
                <CalendarEntryCard key={entry.id} entry={entry} />
              ))}
            </div>
          ))
        )}
      </div>
    </CraftsmanSectionCard>
  )
}
