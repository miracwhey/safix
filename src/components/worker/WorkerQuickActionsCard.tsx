import type { CalendarEntry } from '../../lib/calendar'
import CraftsmanSectionCard from '../CraftsmanSectionCard'

type Props = {
  activeEntry: CalendarEntry | null
  onStartJob: () => void
  onMarkComplete: () => void
}

export default function WorkerQuickActionsCard({
  activeEntry,
  onStartJob,
  onMarkComplete,
}: Props) {
  if (!activeEntry) return null

  const canStart = activeEntry.status === 'scheduled'
  const canComplete = activeEntry.status === 'in_progress'
  return (
    <CraftsmanSectionCard eyebrow="Aktionen" title="Schnellzugriff">
      <div className="flex flex-col gap-3">
        {canStart && (
          <button
            type="button"
            onClick={onStartJob}
            className="w-full rounded-[20px] bg-[#0F172A] px-4 py-4 text-[15px] font-semibold text-white shadow-[0_12px_28px_-16px_rgba(15,23,42,0.5)] transition active:scale-[0.98]"
          >
            Job starten
          </button>
        )}
        {canComplete && (
          <button
            type="button"
            onClick={onMarkComplete}
            className="w-full rounded-[20px] bg-emerald-600 px-4 py-4 text-[15px] font-semibold text-white shadow-[0_12px_28px_-16px_rgba(5,150,105,0.45)] transition active:scale-[0.98]"
          >
            Arbeit abschließen
          </button>
        )}
      </div>
    </CraftsmanSectionCard>
  )
}
