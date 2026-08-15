import type { SchedulingStatus } from './types'
import { getSchedules, getScheduleByJobId } from './operationsStore'

export function getScheduleForJob(jobId: string) {
  return getScheduleByJobId(jobId)
}

export function getSchedulesByStatus(status: SchedulingStatus) {
  return getSchedules().filter((s) => s.schedulingStatus === status)
}

export function isJobScheduled(jobId: string): boolean {
  return getScheduleByJobId(jobId) !== undefined
}

export function isExecutionActive(jobId: string): boolean {
  const schedule = getScheduleByJobId(jobId)
  return schedule?.schedulingStatus === 'execution_started'
}

export function isExecutionCompleted(jobId: string): boolean {
  const schedule = getScheduleByJobId(jobId)
  return schedule?.schedulingStatus === 'execution_completed'
}
