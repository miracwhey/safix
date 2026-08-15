import CraftsmanSectionCard from '../CraftsmanSectionCard'

type Props = {
  activeCount: number
  upcomingTodayCount: number
  completedTodayCount: number
  nextCount: number
}

export default function TodayScheduleOverviewCard({
  activeCount,
  upcomingTodayCount,
  completedTodayCount,
  nextCount,
}: Props) {
  return (
    <CraftsmanSectionCard
      eyebrow="Heute"
      title="Tagesplanung"
      subtitle="Dein operativer Überblick – aktive, geplante und abgeschlossene Einsätze."
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-[22px] bg-[#0F172A] p-4 text-white shadow-[0_18px_40px_-28px_rgba(15,23,42,0.55)]">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
            <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-white/60">
              Aktiv
            </div>
          </div>
          <div className="mt-3 text-[24px] font-semibold leading-none">
            {activeCount}
          </div>
          <div className="mt-2 text-[13px] text-white/70">
            In Arbeit jetzt
          </div>
        </div>

        <div className="rounded-[22px] bg-blue-50 p-4 ring-1 ring-blue-100">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-blue-600">
            Geplant
          </div>
          <div className="mt-3 text-[24px] font-semibold leading-none text-slate-900">
            {upcomingTodayCount}
          </div>
          <div className="mt-2 text-[13px] text-blue-700">
            Noch heute
          </div>
        </div>

        <div className="rounded-[22px] bg-emerald-50 p-4 ring-1 ring-emerald-100">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-emerald-600">
            Erledigt
          </div>
          <div className="mt-3 text-[24px] font-semibold leading-none text-slate-900">
            {completedTodayCount}
          </div>
          <div className="mt-2 text-[13px] text-emerald-700">
            Heute fertig
          </div>
        </div>

        <div className="rounded-[22px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.22)]">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Danach
          </div>
          <div className="mt-3 text-[24px] font-semibold leading-none text-slate-900">
            {nextCount}
          </div>
          <div className="mt-2 text-[13px] text-slate-500">
            Nächste Termine
          </div>
        </div>
      </div>
    </CraftsmanSectionCard>
  )
}
