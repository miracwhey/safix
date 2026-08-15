import CraftsmanSectionCard from '../CraftsmanSectionCard'
import type { CalendarEntry } from '../../lib/calendar'
import { getTeamMembers } from '../../lib/jobs'

type Props = {
  selectedEntry: CalendarEntry | null
  onMoveToToday: () => void
  onMoveToTomorrow: () => void
  onAssignMember: (memberId: string) => void
  onRemoveMember: (memberId: string) => void
}

export default function CalendarPlannerCard({
  selectedEntry,
  onMoveToToday,
  onMoveToTomorrow,
  onAssignMember,
  onRemoveMember,
}: Props) {
  const teamMembers = getTeamMembers()

  if (!selectedEntry) {
    return (
      <CraftsmanSectionCard
        eyebrow="Planung"
        title="Einsatz bearbeiten"
        subtitle="Wähle unten einen Einsatz aus der Liste oder dem Kalender aus."
      />
    )
  }

  const assignedSet = new Set(selectedEntry.assignedMemberIds)

  return (
    <CraftsmanSectionCard
      eyebrow="Planung"
      title={selectedEntry.title}
      subtitle="Verschiebe den Einsatz oder passe die Team-Zuordnung direkt an."
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onMoveToToday}
            className="rounded-[18px] bg-white px-4 py-3 text-[14px] font-semibold text-slate-900 ring-1 ring-slate-200/70"
          >
            Auf Heute setzen
          </button>

          <button
            type="button"
            onClick={onMoveToTomorrow}
            className="rounded-[18px] bg-white px-4 py-3 text-[14px] font-semibold text-slate-900 ring-1 ring-slate-200/70"
          >
            Auf Morgen setzen
          </button>
        </div>

        <div className="space-y-2">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Team-Zuordnung
          </div>

          <div className="space-y-2">
            {teamMembers.map((member) => {
              const assigned = assignedSet.has(member.id)

              return (
                <div
                  key={member.id}
                  className="flex items-center justify-between gap-3 rounded-[18px] bg-slate-50 px-4 py-3 ring-1 ring-slate-200/70"
                >
                  <div>
                    <div className="text-[14px] font-semibold text-slate-900">
                      {member.name}
                    </div>
                    {'role' in member && member.role ? (
                      <div className="mt-1 text-[12px] text-slate-500">
                        {member.role}
                      </div>
                    ) : null}
                  </div>

                  {assigned ? (
                    <button
                      type="button"
                      onClick={() => onRemoveMember(member.id)}
                      className="rounded-[14px] bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-700"
                    >
                      Entfernen
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onAssignMember(member.id)}
                      className="rounded-[14px] bg-emerald-50 px-3 py-2 text-[12px] font-semibold text-emerald-700"
                    >
                      Zuweisen
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </CraftsmanSectionCard>
  )
}
