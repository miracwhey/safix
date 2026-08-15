import CraftsmanSectionCard from '../CraftsmanSectionCard'
import JobScheduleCard from './JobScheduleCard'
import JobTimelineCard from './JobTimelineCard'
import { getJobById } from '../../lib/jobs'
import { isJobOperational } from '../../lib/jobs/helpers'
import type { JobSchedule } from '../../lib/operations'
import type { ProjectTimelineEvent } from '../../lib/timeline'

type Props = {
  jobId: string
  schedule: JobSchedule | undefined
  timelineEvents: ProjectTimelineEvent[]
  onSchedule: () => void
  onConfirmSchedule: () => void
  onReschedule: () => void
  onCancelSchedule: () => void
  onMarkExecutionStarted: () => void
  onMarkExecutionCompleted: () => void
}

export default function JobLifecycleFlow({
  jobId,
  schedule,
  timelineEvents,
  onSchedule,
  onConfirmSchedule,
  onReschedule,
  onCancelSchedule,
  onMarkExecutionStarted,
  onMarkExecutionCompleted,
}: Props) {
  const job = getJobById(jobId)
  const showOperationalModules = job ? isJobOperational(job) : true
  const visibleTimeline = showOperationalModules ? timelineEvents : []

  return (
    <div className="space-y-4">
      {showOperationalModules ? (
        <>
          <JobScheduleCard
            schedule={schedule}
            onSchedule={onSchedule}
            onConfirmSchedule={onConfirmSchedule}
            onReschedule={onReschedule}
            onCancelSchedule={onCancelSchedule}
            onMarkExecutionStarted={onMarkExecutionStarted}
            onMarkExecutionCompleted={onMarkExecutionCompleted}
          />

          {visibleTimeline.length > 0 ? (
            <JobTimelineCard events={visibleTimeline} />
          ) : null}
        </>
      ) : (
        <CraftsmanSectionCard
          eyebrow="Workflow"
          title="Noch in Anfragephase"
          subtitle="Planung, Zahlungen und Timeline erscheinen, sobald ein Angebot angenommen wurde."
        />
      )}
    </div>
  )
}
