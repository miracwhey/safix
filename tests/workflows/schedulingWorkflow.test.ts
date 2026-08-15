import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installSessionForJobOwner } from '../helpers/mockSession'
import {
  scheduleJob,
  updateSchedule,
  rescheduleJob,
  confirmSchedule,
  cancelSchedule,
  markExecutionStarted,
  markExecutionCompleted,
  scheduleJobWithDefaults,
} from '../../src/lib/workflow/schedulingWorkflow'
import { getScheduleByJobId } from '../../src/lib/operations'
import { getJobById } from '../../src/lib/jobs'
import { getTimelineSignalsForJob } from '../../src/lib/timeline'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import type { Job } from '../../src/lib/jobs/types'

const BASE_START = 1_700_000_000_000
const BASE_END = BASE_START + 2 * 60 * 60 * 1000 // +2 hours

const SCHED_OWNER_ID = 'sched-wf-owner'

/** Seed a job at a specific status */
async function seedJob(id: string, status: Job['status'] = 'new'): Promise<Job> {
  const job: Job = {
    id,
    projectId: `project-${id}`,
    title: `Test Job ${id}`,
    customer: 'Test Customer',
    location: 'Test Location',
    dateLabel: 'Today',
    status,
    amount: '500 €',
    description: 'Test job',
    paymentState: 'deposit_required',
    documentationStatus: '0 Fotos',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: SCHED_OWNER_ID,
  }
  await getJobRepository().add(job)
  return job
}

describe('Scheduling Workflow', () => {
  beforeEach(() => {
    setupCleanRepositories()
    installSessionForJobOwner({ craftsmanUserId: SCHED_OWNER_ID })
  })

  // ---------------------------------------------------------------------------
  // scheduleJob
  // ---------------------------------------------------------------------------
  describe('scheduleJob', () => {
    it('creates a new schedule for a job', async () => {
      await seedJob('job-s1')

      const schedule = await scheduleJob({
        jobId: 'job-s1',
        scheduledStart: BASE_START,
        scheduledEnd: BASE_END,
      })

      expect(schedule).toBeDefined()
      expect(schedule!.jobId).toBe('job-s1')
      expect(schedule!.scheduledStart).toBe(BASE_START)
      expect(schedule!.scheduledEnd).toBe(BASE_END)
      expect(schedule!.schedulingStatus).toBe('scheduled')
    })

    it('advances a new job status to scheduled', async () => {
      await seedJob('job-s2', 'new')

      await scheduleJob({ jobId: 'job-s2', scheduledStart: BASE_START, scheduledEnd: BASE_END })

      const job = getJobById('job-s2')
      expect(job?.status).toBe('scheduled')
    })

    it('does not advance job status when job is not in new', async () => {
      await seedJob('job-s3', 'in_progress')

      await scheduleJob({ jobId: 'job-s3', scheduledStart: BASE_START, scheduledEnd: BASE_END })

      const job = getJobById('job-s3')
      expect(job?.status).toBe('in_progress')
    })

    it('emits a job_scheduled timeline event', async () => {
      await seedJob('job-s4')

      await scheduleJob({ jobId: 'job-s4', scheduledStart: BASE_START, scheduledEnd: BASE_END })

      const signals = getTimelineSignalsForJob('job-s4')
      expect(signals.some((s) => s.type === 'job_scheduled')).toBe(true)
    })

    it('returns the existing schedule without creating a duplicate', async () => {
      await seedJob('job-s5')

      const first = await scheduleJob({ jobId: 'job-s5', scheduledStart: BASE_START, scheduledEnd: BASE_END })
      const second = await scheduleJob({ jobId: 'job-s5', scheduledStart: BASE_START + 1000, scheduledEnd: BASE_END + 1000 })

      expect(second!.id).toBe(first!.id)
      expect(second!.scheduledStart).toBe(BASE_START)
    })

    it('returns undefined when the job does not exist', async () => {
      const result = await scheduleJob({ jobId: 'no-such-job', scheduledStart: BASE_START, scheduledEnd: BASE_END })
      expect(result).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // updateSchedule
  // ---------------------------------------------------------------------------
  describe('updateSchedule', () => {
    it('updates the time window of an existing schedule', async () => {
      await seedJob('job-u1')
      await scheduleJob({ jobId: 'job-u1', scheduledStart: BASE_START, scheduledEnd: BASE_END })

      const newEnd = BASE_END + 30 * 60 * 1000
      const updated = await updateSchedule({ jobId: 'job-u1', scheduledStart: BASE_START, scheduledEnd: newEnd })

      expect(updated!.scheduledEnd).toBe(newEnd)
    })

    it('recalculates executionWindow in minutes', async () => {
      await seedJob('job-u2')
      await scheduleJob({ jobId: 'job-u2', scheduledStart: BASE_START, scheduledEnd: BASE_END })

      const twoHalfHoursEnd = BASE_START + 150 * 60 * 1000
      const updated = await updateSchedule({ jobId: 'job-u2', scheduledStart: BASE_START, scheduledEnd: twoHalfHoursEnd })

      expect(updated!.executionWindow).toBe(150)
    })

    it('emits a schedule_updated timeline event', async () => {
      await seedJob('job-u3')
      await scheduleJob({ jobId: 'job-u3', scheduledStart: BASE_START, scheduledEnd: BASE_END })
      await updateSchedule({ jobId: 'job-u3', scheduledStart: BASE_START, scheduledEnd: BASE_END + 1000 })

      const signals = getTimelineSignalsForJob('job-u3')
      expect(signals.some((s) => s.type === 'schedule_updated')).toBe(true)
    })

    it('does NOT emit schedule_updated when silent (B2: reschedule path)', async () => {
      await seedJob('job-u5')
      await scheduleJob({ jobId: 'job-u5', scheduledStart: BASE_START, scheduledEnd: BASE_END })
      await updateSchedule(
        { jobId: 'job-u5', scheduledStart: BASE_START, scheduledEnd: BASE_END + 1000 },
        { silent: true },
      )

      const signals = getTimelineSignalsForJob('job-u5')
      // The reschedule entry point emits schedule_rescheduled itself; updateSchedule
      // must stay silent so the Auftragsverlauf isn't double-logged.
      expect(signals.some((s) => s.type === 'schedule_updated')).toBe(false)
    })

    it('creates a new schedule via scheduleJob when none exists', async () => {
      await seedJob('job-u4')

      const result = await updateSchedule({ jobId: 'job-u4', scheduledStart: BASE_START, scheduledEnd: BASE_END })

      expect(result).toBeDefined()
      expect(result!.schedulingStatus).toBe('scheduled')
    })
  })

  // ---------------------------------------------------------------------------
  // rescheduleJob
  // ---------------------------------------------------------------------------
  describe('rescheduleJob', () => {
    it('updates the schedule times and resets status to scheduled', async () => {
      await seedJob('job-r1')
      await scheduleJob({ jobId: 'job-r1', scheduledStart: BASE_START, scheduledEnd: BASE_END })

      const newStart = BASE_START + 24 * 60 * 60 * 1000
      const newEnd = newStart + 2 * 60 * 60 * 1000
      const rescheduled = rescheduleJob({ jobId: 'job-r1', scheduledStart: newStart, scheduledEnd: newEnd })

      expect(rescheduled!.scheduledStart).toBe(newStart)
      expect(rescheduled!.schedulingStatus).toBe('scheduled')
    })

    it('emits a schedule_rescheduled timeline event', async () => {
      await seedJob('job-r2')
      await scheduleJob({ jobId: 'job-r2', scheduledStart: BASE_START, scheduledEnd: BASE_END })
      rescheduleJob({ jobId: 'job-r2', scheduledStart: BASE_START + 1000, scheduledEnd: BASE_END + 1000 })

      const signals = getTimelineSignalsForJob('job-r2')
      expect(signals.some((s) => s.type === 'schedule_rescheduled')).toBe(true)
    })

    it('returns undefined when no schedule exists for the job', async () => {
      await seedJob('job-r3')

      const result = rescheduleJob({ jobId: 'job-r3', scheduledStart: BASE_START, scheduledEnd: BASE_END })

      expect(result).toBeUndefined()
    })

    it('returns the existing schedule without rescheduling when cancelled', async () => {
      await seedJob('job-r4')
      await scheduleJob({ jobId: 'job-r4', scheduledStart: BASE_START, scheduledEnd: BASE_END })
      cancelSchedule('job-r4')

      const result = rescheduleJob({ jobId: 'job-r4', scheduledStart: BASE_START + 1000, scheduledEnd: BASE_END + 1000 })

      expect(result!.schedulingStatus).toBe('cancelled')
      expect(result!.scheduledStart).toBe(BASE_START)
    })
  })

  // ---------------------------------------------------------------------------
  // confirmSchedule
  // ---------------------------------------------------------------------------
  describe('confirmSchedule', () => {
    it('emits a schedule_confirmed timeline event for a scheduled job', async () => {
      await seedJob('job-c1')
      await scheduleJob({ jobId: 'job-c1', scheduledStart: BASE_START, scheduledEnd: BASE_END })
      confirmSchedule('job-c1')

      const signals = getTimelineSignalsForJob('job-c1')
      expect(signals.some((s) => s.type === 'schedule_confirmed')).toBe(true)
    })

    it('returns undefined when no schedule exists', async () => {
      await seedJob('job-c2')

      const result = confirmSchedule('job-c2')
      expect(result).toBeUndefined()
    })

    it('does not emit a confirmation event for a cancelled schedule', async () => {
      await seedJob('job-c3')
      await scheduleJob({ jobId: 'job-c3', scheduledStart: BASE_START, scheduledEnd: BASE_END })
      cancelSchedule('job-c3')
      confirmSchedule('job-c3')

      const signals = getTimelineSignalsForJob('job-c3')
      expect(signals.some((s) => s.type === 'schedule_confirmed')).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // cancelSchedule
  // ---------------------------------------------------------------------------
  describe('cancelSchedule', () => {
    it('sets schedulingStatus to cancelled', async () => {
      await seedJob('job-x1')
      await scheduleJob({ jobId: 'job-x1', scheduledStart: BASE_START, scheduledEnd: BASE_END })

      cancelSchedule('job-x1')

      const schedule = getScheduleByJobId('job-x1')
      expect(schedule!.schedulingStatus).toBe('cancelled')
    })

    it('emits a schedule_cancelled timeline event', async () => {
      await seedJob('job-x2')
      await scheduleJob({ jobId: 'job-x2', scheduledStart: BASE_START, scheduledEnd: BASE_END })
      cancelSchedule('job-x2')

      const signals = getTimelineSignalsForJob('job-x2')
      expect(signals.some((s) => s.type === 'schedule_cancelled')).toBe(true)
    })

    it('returns undefined when no schedule exists', async () => {
      await seedJob('job-x3')

      const result = cancelSchedule('job-x3')
      expect(result).toBeUndefined()
    })

    it('is idempotent: does not emit duplicate events on repeated cancellation', async () => {
      await seedJob('job-x4')
      await scheduleJob({ jobId: 'job-x4', scheduledStart: BASE_START, scheduledEnd: BASE_END })
      cancelSchedule('job-x4')
      cancelSchedule('job-x4')

      const signals = getTimelineSignalsForJob('job-x4').filter((s) => s.type === 'schedule_cancelled')
      expect(signals.length).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // markExecutionStarted
  // ---------------------------------------------------------------------------
  describe('markExecutionStarted', () => {
    it('sets schedulingStatus to execution_started', async () => {
      await seedJob('job-e1')
      await scheduleJob({ jobId: 'job-e1', scheduledStart: BASE_START, scheduledEnd: BASE_END })

      markExecutionStarted('job-e1')

      const schedule = getScheduleByJobId('job-e1')
      expect(schedule!.schedulingStatus).toBe('execution_started')
    })

    it('emits an execution_started timeline event', async () => {
      await seedJob('job-e2')
      await scheduleJob({ jobId: 'job-e2', scheduledStart: BASE_START, scheduledEnd: BASE_END })
      markExecutionStarted('job-e2')

      const signals = getTimelineSignalsForJob('job-e2')
      expect(signals.some((s) => s.type === 'execution_started')).toBe(true)
    })

    it('returns undefined when no schedule exists', async () => {
      await seedJob('job-e3')

      const result = markExecutionStarted('job-e3')
      expect(result).toBeUndefined()
    })

    it('is idempotent when already in execution_started', async () => {
      await seedJob('job-e4')
      await scheduleJob({ jobId: 'job-e4', scheduledStart: BASE_START, scheduledEnd: BASE_END })
      markExecutionStarted('job-e4')
      markExecutionStarted('job-e4')

      const signals = getTimelineSignalsForJob('job-e4').filter((s) => s.type === 'execution_started')
      expect(signals.length).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // markExecutionCompleted
  // ---------------------------------------------------------------------------
  describe('markExecutionCompleted', () => {
    it('sets schedulingStatus to execution_completed', async () => {
      await seedJob('job-ec1')
      await scheduleJob({ jobId: 'job-ec1', scheduledStart: BASE_START, scheduledEnd: BASE_END })
      markExecutionStarted('job-ec1')

      markExecutionCompleted('job-ec1')

      const schedule = getScheduleByJobId('job-ec1')
      expect(schedule!.schedulingStatus).toBe('execution_completed')
    })

    it('emits an execution_completed timeline event', async () => {
      await seedJob('job-ec2')
      await scheduleJob({ jobId: 'job-ec2', scheduledStart: BASE_START, scheduledEnd: BASE_END })
      markExecutionStarted('job-ec2')
      markExecutionCompleted('job-ec2')

      const signals = getTimelineSignalsForJob('job-ec2')
      expect(signals.some((s) => s.type === 'execution_completed')).toBe(true)
    })

    it('returns undefined when no schedule exists', async () => {
      await seedJob('job-ec3')

      const result = markExecutionCompleted('job-ec3')
      expect(result).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // scheduleJobWithDefaults
  // ---------------------------------------------------------------------------
  describe('scheduleJobWithDefaults', () => {
    it('creates a schedule with a 2-hour execution window by default', async () => {
      await seedJob('job-d1')

      const schedule = await scheduleJobWithDefaults('job-d1')

      expect(schedule).toBeDefined()
      const windowMs = schedule!.scheduledEnd - schedule!.scheduledStart
      expect(windowMs).toBe(2 * 60 * 60 * 1000)
    })

    it('returns undefined when the job does not exist', async () => {
      const result = await scheduleJobWithDefaults('no-such-job')
      expect(result).toBeUndefined()
    })

    it('returns the existing schedule without creating a duplicate', async () => {
      await seedJob('job-d2')
      const first = await scheduleJobWithDefaults('job-d2')
      const second = await scheduleJobWithDefaults('job-d2')

      expect(second!.id).toBe(first!.id)
    })
  })
})
