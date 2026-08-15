type JobStatus = 'new' | 'booked' | 'scheduled' | 'in_progress' | 'waiting_payment' | 'completed' | 'cancelled';

type JobStatusBadgeProps = {
  status: JobStatus;
};

const statusMap: Record<
  JobStatus,
  { label: string; className: string }
> = {
  new: {
    label: 'Neu',
    className: 'bg-blue-50 text-blue-700 ring-blue-100',
  },
  booked: {
    label: 'Gebucht',
    className: 'bg-sky-50 text-sky-700 ring-sky-100',
  },
  scheduled: {
    label: 'Geplant',
    className: 'bg-amber-50 text-amber-700 ring-amber-100',
  },
  in_progress: {
    label: 'In Arbeit',
    className: 'bg-violet-50 text-violet-700 ring-violet-100',
  },
  waiting_payment: {
    label: 'Zahlung ausstehend',
    className: 'bg-orange-50 text-orange-700 ring-orange-100',
  },
  completed: {
    label: 'Abgeschlossen',
    className: 'bg-slate-100 text-slate-700 ring-slate-200',
  },
  cancelled: {
    label: 'Storniert',
    className: 'bg-rose-50 text-rose-700 ring-rose-200',
  },
};

export type { JobStatus };

export default function JobStatusBadge({ status }: JobStatusBadgeProps) {
  const config = statusMap[status];

  return (
    <span
      className={[
        'inline-flex items-center rounded-full px-3 py-1 text-[12px] font-semibold ring-1',
        config.className,
      ].join(' ')}
    >
      {config.label}
    </span>
  );
}
