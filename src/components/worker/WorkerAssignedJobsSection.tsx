import CraftsmanSectionCard from '../CraftsmanSectionCard'
import type { Job } from '../../lib/jobs'
import {
  deriveExecutionStatus,
  deriveExecutionNextStep,
  EXECUTION_STATUS_CONFIG,
} from '../../lib/jobs/executionSelectors'
import ExecutionStatusBadge from '../jobs/ExecutionStatusBadge'
import { resolveCanonicalProjectFacts } from '../../lib/shared/canonicalProjectFacts'

type Props = {
  jobs: Job[]
}

function JobRow({ job }: { job: Job }) {
  const executionStatus = deriveExecutionStatus(job)
  const config = EXECUTION_STATUS_CONFIG[executionStatus]
  const nextStep = deriveExecutionNextStep(job)
  const facts = resolveCanonicalProjectFacts(job.id)
  const displayTitle = facts?.title ?? job.title
  const displayCustomer = facts?.customer ?? job.customer
  const displayLocation = facts?.location ?? job.location

  return (
    <div className="rounded-[22px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-2 w-2 shrink-0 rounded-full ${config.dot}`}
            />
            <div className="truncate text-[15px] font-semibold text-slate-900">
              {displayTitle}
            </div>
          </div>
          <div className="mt-0.5 truncate text-[13px] text-slate-500">
            {displayCustomer}
          </div>
          {displayLocation && (
            <div className="mt-0.5 truncate text-[12px] text-slate-400">
              {displayLocation}
            </div>
          )}
        </div>
        <ExecutionStatusBadge status={executionStatus} />
      </div>
      {nextStep && (
        <div className="mt-3 flex items-center gap-1.5 rounded-xl bg-slate-50 px-3 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Nächster Schritt:
          </span>
          <span className="text-[12px] font-medium text-slate-700">
            {nextStep}
          </span>
        </div>
      )}
    </div>
  )
}

export default function WorkerAssignedJobsSection({ jobs }: Props) {
  return (
    <CraftsmanSectionCard
      eyebrow="Meine Jobs"
      title="Zugewiesene Aufträge"
      subtitle="Aktive Jobs, für die du eingeteilt bist."
    >
      <div className="space-y-3">
        {jobs.length === 0 ? (
          <div className="rounded-[22px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)]">
            <div className="text-[15px] font-semibold text-slate-900">
              Keine aktiven Jobs
            </div>
            <div className="mt-1 text-[13px] text-slate-500">
              Sobald dir Jobs zugewiesen werden, erscheinen sie hier.
            </div>
          </div>
        ) : (
          jobs.map((job) => <JobRow key={job.id} job={job} />)
        )}
      </div>
    </CraftsmanSectionCard>
  )
}
