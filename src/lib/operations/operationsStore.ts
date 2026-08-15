import type { JobSchedule, SchedulingStatus } from './types'
import { getScheduleRepository } from './repository'
import { generateUUID } from '../shared/generateUUID'

export function subscribeOperations(listener: () => void): () => void {
  return getScheduleRepository().subscribe(listener)
}

export function isScheduleRepositoryHydrated(): boolean {
  return getScheduleRepository().isHydrated()
}

export function getSchedules(): JobSchedule[] {
  return getScheduleRepository().getAll()
}

export function getScheduleById(id: string): JobSchedule | undefined {
  return getScheduleRepository().getById(id)
}

export function getScheduleByJobId(jobId: string): JobSchedule | undefined {
  return getScheduleRepository().getByJobId(jobId)
}

export function addSchedule(schedule: JobSchedule): void {
  getScheduleRepository().add(schedule)
}

export function updateScheduleStatus(
  id: string,
  nextStatus: SchedulingStatus
): void {
  getScheduleRepository().updateStatus(id, nextStatus)
}

export function replaceSchedule(updated: JobSchedule): void {
  getScheduleRepository().replace(updated)
}

export function createJobSchedule(params: {
  jobId: string
  scheduledStart: number
  scheduledEnd: number
}): JobSchedule {
  const now = Date.now()
  const executionWindow = Math.round(
    (params.scheduledEnd - params.scheduledStart) / 60_000
  )

  return {
    id: generateUUID(),
    jobId: params.jobId,
    scheduledStart: params.scheduledStart,
    scheduledEnd: params.scheduledEnd,
    executionWindow,
    schedulingStatus: 'scheduled',
    createdAt: now,
    updatedAt: now,
  }
}
