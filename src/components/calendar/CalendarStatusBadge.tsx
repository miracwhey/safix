import type { CalendarEntryStatus } from '../../lib/calendar'

type Props = {
  status: CalendarEntryStatus
}

function getLabel(status: CalendarEntryStatus) {
  if (status === 'pending') return 'Terminplanung offen'
  if (status === 'scheduled') return 'Geplant'
  if (status === 'in_progress') return 'In Arbeit'
  if (status === 'awaiting_payment') return 'Wartet auf Zahlung'
  if (status === 'completed') return 'Abgeschlossen'
  return 'Abgesagt'
}

function getClassName(status: CalendarEntryStatus) {
  if (status === 'pending') {
    return 'bg-slate-50 text-slate-600'
  }

  if (status === 'scheduled') {
    return 'bg-blue-50 text-blue-700'
  }

  if (status === 'in_progress') {
    return 'bg-amber-50 text-amber-700'
  }

  if (status === 'awaiting_payment') {
    return 'bg-orange-50 text-orange-700'
  }

  if (status === 'completed') {
    return 'bg-emerald-50 text-emerald-700'
  }

  return 'bg-rose-50 text-rose-700'
}

export default function CalendarStatusBadge({ status }: Props) {
  return (
    <div
      className={[
        'inline-flex rounded-full px-3 py-1 text-[12px] font-semibold',
        getClassName(status),
      ].join(' ')}
    >
      {getLabel(status)}
    </div>
  )
}
