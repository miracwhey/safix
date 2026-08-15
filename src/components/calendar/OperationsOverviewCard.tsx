import CraftsmanSectionCard from '../CraftsmanSectionCard'

type Props = {
  totalAssignments: number
  busyMembers: number
  overbookedMembers: number
  freeMembers: number
}

export default function OperationsOverviewCard({
  totalAssignments,
  busyMembers,
  overbookedMembers,
  freeMembers,
}: Props) {
  return (
    <CraftsmanSectionCard
      eyebrow="Operations"
      title="Tagessteuerung"
      subtitle="Operative Sicht auf Team-Auslastung, Einsatzverteilung und Engpässe."
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-[20px] bg-blue-50 p-4 ring-1 ring-blue-100">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-blue-600">
            Zuweisungen
          </div>
          <div className="mt-2 text-[22px] font-semibold leading-none text-slate-900">
            {totalAssignments}
          </div>
        </div>

        <div className="rounded-[20px] bg-emerald-50 p-4 ring-1 ring-emerald-100">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-emerald-600">
            Aktiv
          </div>
          <div className="mt-2 text-[22px] font-semibold leading-none text-slate-900">
            {busyMembers}
          </div>
        </div>

        <div className="rounded-[20px] bg-rose-50 p-4 ring-1 ring-rose-100">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-rose-600">
            Überbucht
          </div>
          <div className="mt-2 text-[22px] font-semibold leading-none text-slate-900">
            {overbookedMembers}
          </div>
        </div>

        <div className="rounded-[20px] bg-slate-100 p-4 ring-1 ring-slate-200">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-600">
            Frei
          </div>
          <div className="mt-2 text-[22px] font-semibold leading-none text-slate-900">
            {freeMembers}
          </div>
        </div>
      </div>
    </CraftsmanSectionCard>
  )
}
