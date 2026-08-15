import type { JobStatus } from '../../lib/shared/coreTypes'

export type StatusPillStyle = {
  pill: string
  dot: string
}

export const jobStatusPillStyles: Record<JobStatus, StatusPillStyle> = {
  new: {
    pill: 'bg-blue-50 text-blue-700 ring-blue-100',
    dot: 'bg-blue-500',
  },
  booked: {
    pill: 'bg-sky-50 text-sky-700 ring-sky-100',
    dot: 'bg-sky-500',
  },
  scheduled: {
    pill: 'bg-amber-50 text-amber-700 ring-amber-100',
    dot: 'bg-amber-500',
  },
  in_progress: {
    pill: 'bg-violet-50 text-violet-700 ring-violet-100',
    dot: 'bg-violet-500',
  },
  waiting_payment: {
    pill: 'bg-orange-50 text-orange-700 ring-orange-100',
    dot: 'bg-orange-500',
  },
  completed: {
    pill: 'bg-slate-100 text-slate-600 ring-slate-200',
    dot: 'bg-slate-400',
  },
  cancelled: {
    pill: 'bg-rose-50 text-rose-600 ring-rose-200',
    dot: 'bg-rose-400',
  },
}
