import CraftsmanSectionCard from '../CraftsmanSectionCard'
import CalendarEntryCard from './CalendarEntryCard'
import type { CalendarEntry } from '../../lib/calendar'

type Props = {
  activeEntries: CalendarEntry[]
  upcomingEntries: CalendarEntry[]
  completedEntries: CalendarEntry[]
}

function EmptyState({ message, sub }: { message: string; sub: string }) {
  return (
    <div className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)]">
      <div className="text-[16px] font-semibold text-slate-900">{message}</div>
      <div className="mt-1 text-[14px] text-slate-500">{sub}</div>
    </div>
  )
}

function SectionLabel({ text }: { text: string }) {
  return (
    <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
      {text}
    </div>
  )
}

export default function TodayScheduleSection({
  activeEntries,
  upcomingEntries,
  completedEntries,
}: Props) {
  const hasAny =
    activeEntries.length > 0 ||
    upcomingEntries.length > 0 ||
    completedEntries.length > 0

  return (
    <CraftsmanSectionCard
      eyebrow="Heute"
      title="Deine Einsätze heute"
      subtitle="Aktive, geplante und abgeschlossene Einsätze des Tages."
    >
      <div className="space-y-4">
        {!hasAny && (
          <EmptyState
            message="Keine Einsätze heute geplant"
            sub="Sobald Jobs für heute geplant sind, erscheinen sie hier."
          />
        )}

        {activeEntries.length > 0 && (
          <div className="space-y-3">
            <SectionLabel text="In Arbeit" />
            {activeEntries.map((entry) => (
              <CalendarEntryCard key={entry.id} entry={entry} />
            ))}
          </div>
        )}

        {upcomingEntries.length > 0 && (
          <div className="space-y-3">
            <SectionLabel text="Noch heute" />
            {upcomingEntries.map((entry) => (
              <CalendarEntryCard key={entry.id} entry={entry} />
            ))}
          </div>
        )}

        {completedEntries.length > 0 && (
          <div className="space-y-3">
            <SectionLabel text="Erledigt" />
            {completedEntries.map((entry) => (
              <CalendarEntryCard key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </CraftsmanSectionCard>
  )
}
