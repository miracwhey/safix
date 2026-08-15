import { Link } from 'react-router-dom'
import type { CalendarEntry } from '../../lib/calendar'
import { getTeamMembers } from '../../lib/jobs'

type Props = {
  entry: CalendarEntry
}

function getAssignedMemberNames(memberIds: string[]): string {
  const teamMembers = getTeamMembers()
  const names = memberIds
    .map((id) => teamMembers.find((m) => m.id === id)?.name)
    .filter((name): name is string => Boolean(name))
  return names.length > 0 ? names.join(', ') : 'Noch niemand zugewiesen'
}

export default function ActiveExecutionCard({ entry }: Props) {
  return (
    <div className="rounded-[28px] bg-[#0F172A] p-5 shadow-[0_24px_48px_-20px_rgba(15,23,42,0.55)]">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-2 w-2 rounded-full bg-emerald-400" />
        <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-emerald-400">
          Aktiv jetzt
        </span>
      </div>

      <div className="mt-3 text-[20px] font-semibold leading-snug text-white">
        {entry.title}
      </div>

      <div className="mt-1 text-[14px] text-slate-400">{entry.customerName}</div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-[18px] bg-white/8 px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Zeitfenster
          </div>
          <div className="mt-1 text-[14px] font-semibold text-white">
            {entry.startsAtLabel} – {entry.endsAtLabel}
          </div>
        </div>

        <div className="rounded-[18px] bg-white/8 px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Ort
          </div>
          <div className="mt-1 text-[14px] font-semibold text-white">
            {entry.location}
          </div>
        </div>
      </div>

      {entry.assignedMemberIds.length > 0 && (
        <div className="mt-3 rounded-[18px] bg-white/8 px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Team vor Ort
          </div>
          <div className="mt-1 text-[14px] font-semibold text-white">
            {getAssignedMemberNames(entry.assignedMemberIds)}
          </div>
        </div>
      )}

      <Link
        to={`/craftsman/jobs/${entry.jobId}`}
        className="mt-4 block rounded-[20px] bg-white px-4 py-3 text-center text-[14px] font-semibold text-slate-900 transition active:scale-[0.99]"
      >
        Zum Auftrag →
      </Link>
    </div>
  )
}
