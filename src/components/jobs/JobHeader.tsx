import JobStatusBadge from '../JobStatusBadge'
import type { Job } from '../../lib/jobs'
import { useSmartBack } from '../../hooks/useSmartBack'

type Props = {
  job: Job
}

export default function JobHeader({ job }: Props) {
  const goBack = useSmartBack('/craftsman/jobs')

  return (
    <div className="flex items-center justify-between gap-3">
      <button
        type="button"
        onClick={goBack}
        aria-label="Zurück"
        className="inline-flex items-center rounded-full bg-white px-4 py-2 text-[14px] font-semibold text-slate-700 ring-1 ring-slate-200/70 shadow-[0_12px_28px_-24px_rgba(2,6,23,0.35)]"
      >
        ← Zurück
      </button>

      <JobStatusBadge status={job.status} />
    </div>
  )
}
