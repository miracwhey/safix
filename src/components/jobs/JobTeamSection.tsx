import CraftsmanSectionCard from '../CraftsmanSectionCard'
import type { TeamMember } from '../../lib/jobs'

type Props = {
  teamMembers: TeamMember[]
  assignedMemberIds: string[]
  onToggleMember: (memberId: string) => void
}

export default function JobTeamSection({
  teamMembers,
  assignedMemberIds,
  onToggleMember,
}: Props) {
  return (
    <CraftsmanSectionCard
      eyebrow="Team"
      title="Zugewiesene Mitarbeiter"
      subtitle="Lege fest, wer an diesem Auftrag arbeitet."
    >
      <div className="space-y-3">
        {teamMembers.map((member) => {
          const active = assignedMemberIds.includes(member.id)

          return (
            <button
              key={member.id}
              type="button"
              onClick={() => onToggleMember(member.id)}
              className={[
                'flex w-full items-center justify-between rounded-[20px] px-4 py-4 text-left transition',
                active
                  ? 'bg-[#2563EB] text-white shadow-[0_18px_40px_-28px_rgba(37,99,235,0.65)]'
                  : 'bg-white text-slate-900 ring-1 ring-slate-200/70',
              ].join(' ')}
            >
              <div>
                <div className="text-[15px] font-semibold">{member.name}</div>
                {'role' in member && member.role ? (
                  <div
                    className={[
                      'mt-1 text-[13px]',
                      active ? 'text-white/80' : 'text-slate-500',
                    ].join(' ')}
                  >
                    {member.role}
                  </div>
                ) : null}
              </div>

              <div
                className={[
                  'text-[12px] font-semibold',
                  active ? 'text-white' : 'text-slate-400',
                ].join(' ')}
              >
                {active ? 'Zugewiesen' : 'Auswählen'}
              </div>
            </button>
          )
        })}
      </div>
    </CraftsmanSectionCard>
  )
}
