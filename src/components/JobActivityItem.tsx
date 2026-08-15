import type { JobActivity } from '../lib/jobs'

type Props = {
  activity: JobActivity
}

function getActivityIcon(type: JobActivity['type']) {
  if (type === 'status') return '↔'
  if (type === 'payment') return '€'
  if (type === 'note') return '✎'
  if (type === 'photo') return '◫'
  if (type === 'message') return '💬'
  return '•'
}

function getActivityAccent(type: JobActivity['type']) {
  if (type === 'status') return 'bg-blue-50 text-blue-600'
  if (type === 'payment') return 'bg-emerald-50 text-emerald-600'
  if (type === 'note') return 'bg-amber-50 text-amber-600'
  if (type === 'photo') return 'bg-violet-50 text-violet-600'
  if (type === 'message') return 'bg-fuchsia-50 text-fuchsia-600'
  return 'bg-slate-100 text-slate-600'
}

export default function JobActivityItem({ activity }: Props) {
  return (
    <div className="flex gap-3 rounded-2xl bg-white px-4 py-3 ring-1 ring-slate-200/70">
      <div
        className={[
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-[16px] font-semibold',
          getActivityAccent(activity.type),
        ].join(' ')}
      >
        {getActivityIcon(activity.type)}
      </div>

      <div className="min-w-0">
        <div className="text-[14px] font-medium text-slate-900">
          {activity.text}
        </div>
        <div className="mt-1 text-[12px] text-slate-400">
          {activity.createdAtLabel}
        </div>
      </div>
    </div>
  )
}
