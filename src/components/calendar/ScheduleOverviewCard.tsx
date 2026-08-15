import CraftsmanSectionCard from '../CraftsmanSectionCard'

type Props = {
  scheduledCount: number
  inProgressCount: number
  completedCount: number
}

export default function ScheduleOverviewCard({
  scheduledCount,
  inProgressCount,
  completedCount,
}: Props) {
  return (
    <CraftsmanSectionCard
      eyebrow="Kalender"
      title="Einsatzübersicht"
      subtitle="Hier steuerst du geplante, laufende und abgeschlossene Einsätze."
    >
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-[20px] bg-blue-50 p-4 ring-1 ring-blue-100">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-blue-600">
            Geplant
          </div>
          <div className="mt-2 text-[22px] font-semibold leading-none text-slate-900">
            {scheduledCount}
          </div>
        </div>

        <div className="rounded-[20px] bg-amber-50 p-4 ring-1 ring-amber-100">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-amber-600">
            Läuft
          </div>
          <div className="mt-2 text-[22px] font-semibold leading-none text-slate-900">
            {inProgressCount}
          </div>
        </div>

        <div className="rounded-[20px] bg-emerald-50 p-4 ring-1 ring-emerald-100">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-emerald-600">
            Fertig
          </div>
          <div className="mt-2 text-[22px] font-semibold leading-none text-slate-900">
            {completedCount}
          </div>
        </div>
      </div>
    </CraftsmanSectionCard>
  )
}
