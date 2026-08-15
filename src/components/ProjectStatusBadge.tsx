import type { ProjectStatus } from '../lib/projects/projectTypes'

type Props = {
  status: ProjectStatus
}

function getLabel(status: ProjectStatus) {
  if (status === 'request') return 'Anfrage'
  if (status === 'accepted') return 'Angenommen'
  if (status === 'scheduled') return 'Geplant'
  if (status === 'in_progress') return 'In Arbeit'
  if (status === 'review') return 'Prüfung'
  if (status === 'cancelled') return 'Storniert'
  return 'Abgeschlossen'
}

function getClassName(status: ProjectStatus) {
  if (status === 'request') {
    return 'bg-slate-100 text-slate-700'
  }

  if (status === 'accepted') {
    return 'bg-amber-50 text-amber-700'
  }

  if (status === 'scheduled') {
    return 'bg-violet-50 text-violet-700'
  }

  if (status === 'in_progress') {
    return 'bg-blue-50 text-blue-700'
  }

  if (status === 'review') {
    return 'bg-orange-50 text-orange-700'
  }

  if (status === 'cancelled') {
    return 'bg-rose-50 text-rose-700'
  }

  return 'bg-emerald-50 text-emerald-700'
}

export default function ProjectStatusBadge({ status }: Props) {
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
