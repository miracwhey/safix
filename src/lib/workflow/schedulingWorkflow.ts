import { getJobById, updateJobStatus } from '../jobs/service'
import { assertJobWorkerOrOwner } from '../auth/rbacGuards'
import {
  addSchedule,
  createJobSchedule,
  getScheduleByJobId,
  replaceSchedule,
  updateScheduleStatus,
} from '../operations'
import type { JobSchedule } from '../operations'
import { addTimelineEvent, createTimelineEvent } from '../timeline/timelineService'
import { logInfo, logWarning } from '../observability'
import {
  sendScheduleCreatedEmail,
  sendScheduleUpdatedEmail,
} from '../notifications/delivery'

const DEFAULT_EXECUTION_WINDOW_MS = 2 * 60 * 60 * 1000 // 2 hours

export async function scheduleJob(params: {
  jobId: string
  scheduledStart: number
  scheduledEnd: number
}): Promise<JobSchedule | undefined> {
  const job = getJobById(params.jobId)
  if (!job) {
    logWarning('workflow.scheduling.entity_missing', { jobId: params.jobId })
    return undefined
  }
  assertJobWorkerOrOwner(job)

  const existing = getScheduleByJobId(params.jobId)
  if (existing) return existing

  const schedule = createJobSchedule(params)
  addSchedule(schedule)

  // Advance job status to 'scheduled' when the first schedule is created.
  // Applies to both new (inquiry) and booked (offer-accepted) jobs.
  if (job.status === 'new' || job.status === 'booked') {
    await updateJobStatus(params.jobId, 'scheduled')
  }

  addTimelineEvent(
    createTimelineEvent({ jobId: params.jobId, type: 'job_scheduled' })
  )

  sendScheduleCreatedEmail(params.jobId, job.customerUserId, { jobTitle: job.title })

  logInfo('workflow.scheduling.scheduled', { jobId: params.jobId, scheduleId: schedule.id })

  return schedule
}

export async function updateSchedule(
  params: {
    jobId: string
    scheduledStart: number
    scheduledEnd: number
  },
  opts?: { silent?: boolean },
): Promise<JobSchedule | undefined> {
  const job = getJobById(params.jobId)
  if (!job) {
    logWarning('workflow.scheduling.entity_missing', { jobId: params.jobId })
    return undefined
  }
  assertJobWorkerOrOwner(job)

  const existing = getScheduleByJobId(params.jobId)
  if (!existing) return scheduleJob(params)

  const executionWindow = Math.round(
    (params.scheduledEnd - params.scheduledStart) / 60_000
  )

  const updated: JobSchedule = {
    ...existing,
    scheduledStart: params.scheduledStart,
    scheduledEnd: params.scheduledEnd,
    executionWindow,
    updatedAt: Date.now(),
  }

  replaceSchedule(updated)

  // `silent` lets the canonical reschedule path move an existing schedule
  // without emitting the minor-adjustment `schedule_updated` event + "Zeitplan
  // aktualisiert" email. A reschedule emits its own `schedule_rescheduled`
  // event, so firing both double-logs the Auftragsverlauf and sends the
  // customer a mislabeled notification the prior rescheduleJob never sent.
  if (!opts?.silent) {
    addTimelineEvent(
      createTimelineEvent({ jobId: params.jobId, type: 'schedule_updated' })
    )

    sendScheduleUpdatedEmail(params.jobId, job.customerUserId, { jobTitle: job.title })
  }

  return updated
}

export function markExecutionStarted(jobId: string): JobSchedule | undefined {
  const schedule = getScheduleByJobId(jobId)
  if (!schedule) {
    logWarning('workflow.scheduling.entity_missing', { jobId, operation: 'markExecutionStarted' })
    return undefined
  }
  if (schedule.schedulingStatus === 'execution_started') return schedule

  updateScheduleStatus(schedule.id, 'execution_started')

  addTimelineEvent(
    createTimelineEvent({ jobId, type: 'execution_started' })
  )

  logInfo('workflow.scheduling.execution_started', { jobId, scheduleId: schedule.id })

  return getScheduleByJobId(jobId)
}

export function markExecutionCompleted(jobId: string): JobSchedule | undefined {
  const schedule = getScheduleByJobId(jobId)
  if (!schedule) return undefined
  if (schedule.schedulingStatus === 'execution_completed') return schedule

  updateScheduleStatus(schedule.id, 'execution_completed')

  addTimelineEvent(
    createTimelineEvent({ jobId, type: 'execution_completed' })
  )

  logInfo('workflow.scheduling.execution_completed', { jobId, scheduleId: schedule.id })

  return getScheduleByJobId(jobId)
}

export async function scheduleJobWithDefaults(jobId: string): Promise<JobSchedule | undefined> {
  const job = getJobById(jobId)
  if (!job) return undefined

  const existing = getScheduleByJobId(jobId)
  if (existing) return existing

  const now = Date.now()
  return scheduleJob({
    jobId,
    scheduledStart: now,
    scheduledEnd: now + DEFAULT_EXECUTION_WINDOW_MS,
  })
}

export function cancelSchedule(jobId: string): JobSchedule | undefined {
  const job = getJobById(jobId)
  if (!job) return undefined
  assertJobWorkerOrOwner(job)

  const schedule = getScheduleByJobId(jobId)
  if (!schedule) return undefined
  if (schedule.schedulingStatus === 'cancelled') return schedule

  updateScheduleStatus(schedule.id, 'cancelled')

  addTimelineEvent(
    createTimelineEvent({ jobId, type: 'schedule_cancelled' })
  )

  logInfo('workflow.scheduling.cancelled', { jobId, scheduleId: schedule.id })

  return getScheduleByJobId(jobId)
}

/**
 * Emits the dedicated `schedule_rescheduled` timeline event. Extracted so the
 * canonical reschedule path (performCanonicalScheduleSave, which ALSO moves the
 * CalendarEntry) can preserve the distinct reschedule semantic without the
 * calendar-blind JobSchedule-only write below.
 */
export function markScheduleRescheduled(jobId: string): void {
  addTimelineEvent(createTimelineEvent({ jobId, type: 'schedule_rescheduled' }))
}

/**
 * @deprecated Updates only the JobSchedule — it does NOT move the CalendarEntry,
 * so calling it directly drifts the planning grid / Operations board off the new
 * day (the appointment shows on two days at once). Reschedule entry points must
 * use `performCanonicalScheduleSave` (atomic JobSchedule + CalendarEntry) and
 * then `markScheduleRescheduled` instead.
 *
 * Reschedules an existing job to a new time window. Unlike `updateSchedule`,
 * which is used for minor time adjustments, `rescheduleJob` represents an
 * explicit reschedule decision and emits a dedicated `schedule_rescheduled`
 * timeline event. Returns undefined when no schedule exists for the job.
 */
export function rescheduleJob(params: {
  jobId: string
  scheduledStart: number
  scheduledEnd: number
}): JobSchedule | undefined {
  const job = getJobById(params.jobId)
  if (!job) return undefined
  assertJobWorkerOrOwner(job)

  const existing = getScheduleByJobId(params.jobId)
  if (!existing) return undefined
  if (
    existing.schedulingStatus === 'cancelled' ||
    existing.schedulingStatus === 'execution_completed'
  ) {
    return existing
  }

  const executionWindow = Math.round(
    (params.scheduledEnd - params.scheduledStart) / 60_000
  )

  const updated: JobSchedule = {
    ...existing,
    scheduledStart: params.scheduledStart,
    scheduledEnd: params.scheduledEnd,
    executionWindow,
    schedulingStatus: 'scheduled',
    updatedAt: Date.now(),
  }

  replaceSchedule(updated)

  markScheduleRescheduled(params.jobId)

  return updated
}

/**
 * Marks an existing schedule as confirmed by emitting a `schedule_confirmed`
 * timeline event. The scheduling status remains `'scheduled'` — confirmation
 * is a soft acknowledgement that the appointment is agreed upon by both parties.
 * Returns undefined when no schedule exists for the job.
 */
export function confirmSchedule(jobId: string): JobSchedule | undefined {
  const job = getJobById(jobId)
  if (!job) return undefined
  assertJobWorkerOrOwner(job)

  const schedule = getScheduleByJobId(jobId)
  if (!schedule) return undefined

  // Only schedules with status 'scheduled' can be confirmed. Cancelled,
  // started, and completed schedules are returned as-is without an event.
  if (
    schedule.schedulingStatus === 'cancelled' ||
    schedule.schedulingStatus === 'execution_started' ||
    schedule.schedulingStatus === 'execution_completed'
  ) {
    return schedule
  }

  addTimelineEvent(
    createTimelineEvent({ jobId, type: 'schedule_confirmed' })
  )

  return schedule
}
