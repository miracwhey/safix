import { Link } from 'react-router-dom'
import CalendarStatusBadge from './CalendarStatusBadge'
import type { CalendarEntry } from '../../lib/calendar'
import { getTeamMembers } from '../../lib/jobs'

type Props = {
  entry: CalendarEntry
}

function getAssignedMemberNames(memberIds: string[]): string {
  const teamMembers = getTeamMembers()

  const names = memberIds
    .map((memberId) => teamMembers.find((member) => member.id === memberId)?.name)
    .filter((name): name is string => Boolean(name))

  if (names.length === 0) {
    return 'Noch niemand zugewiesen'
  }

  return names.join(', ')
}

export default function CalendarEntryCard({ entry }: Props) {
  const isCustom = entry.kind === 'custom'

  const cardContent = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[16px] font-semibold text-slate-900">
            {entry.title}
          </div>

          {isCustom ? (
            <div className="mt-1 text-[13px] font-medium text-slate-500">
              Eigener Termin
            </div>
          ) : (
            <div className="mt-1 text-[14px] text-slate-500">
              {entry.customerName}
            </div>
          )}

          {entry.description && (
            <div className="mt-1 text-[13px] text-slate-400">
              {entry.description}
            </div>
          )}

          {entry.location && (
            <div className="mt-1 text-[13px] text-slate-400">
              {entry.location}
            </div>
          )}
        </div>

        {isCustom ? (
          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
            Intern
          </span>
        ) : (
          <CalendarStatusBadge status={entry.status} />
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 text-[13px] text-slate-500">
        <div>
          <div className="font-semibold text-slate-900">{entry.dateLabel}</div>
          <div>Datum</div>
        </div>

        <div>
          <div className="font-semibold text-slate-900">
            {entry.startsAtLabel} – {entry.endsAtLabel}
          </div>
          <div>Zeitfenster</div>
        </div>
      </div>

      {!isCustom && (
        <div className="mt-4 rounded-[18px] bg-slate-50 px-4 py-3 ring-1 ring-slate-200/70">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Team
          </div>
          <div className="mt-2 text-[14px] text-slate-700">
            {getAssignedMemberNames(entry.assignedMemberIds)}
          </div>
        </div>
      )}
    </>
  )

  const className = 'block rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)] transition active:scale-[0.99]'

  return isCustom ? (
    <div className={className}>
      {cardContent}
    </div>
  ) : (
    <Link
      to={`/craftsman/jobs/${entry.jobId}`}
      className={className}
    >
      {cardContent}
    </Link>
  )
}
