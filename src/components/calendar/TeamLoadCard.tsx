import { getTeamMembers } from '../../lib/jobs'
import type { CalendarEntry } from '../../lib/calendar'

type Props = {
  memberId: string
  jobs: CalendarEntry[]
}

function getMemberName(memberId: string): string {
  const member = getTeamMembers().find((entry) => entry.id === memberId)
  return member?.name ?? 'Mitarbeiter'
}

function getLoadLabel(jobCount: number): {
  text: string
  className: string
} {
  if (jobCount > 2) {
    return {
      text: 'Überbucht',
      className: 'bg-rose-50 text-rose-700',
    }
  }

  if (jobCount === 2) {
    return {
      text: 'Gut ausgelastet',
      className: 'bg-amber-50 text-amber-700',
    }
  }

  return {
    text: 'Kapazität ok',
    className: 'bg-emerald-50 text-emerald-700',
  }
}

export default function TeamLoadCard({ memberId, jobs }: Props) {
  const memberName = getMemberName(memberId)
  const load = getLoadLabel(jobs.length)

  return (
    <div className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[14px] font-semibold text-slate-900">
            {memberName}
          </div>

          <div className="mt-2 text-[13px] text-slate-500">
            {jobs.length} Einsatz{jobs.length === 1 ? '' : 'e'}
          </div>
        </div>

        <div
          className={[
            'rounded-full px-3 py-1 text-[12px] font-semibold',
            load.className,
          ].join(' ')}
        >
          {load.text}
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {jobs.map((job) => (
          <div
            key={job.id}
            className="rounded-lg bg-slate-50 px-3 py-2 text-[13px] text-slate-700 ring-1 ring-slate-200/70"
          >
            <div className="font-medium text-slate-900">{job.title}</div>
            <div className="mt-1 text-[12px] text-slate-500">
              {job.dateLabel} · {job.startsAtLabel} – {job.endsAtLabel}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
