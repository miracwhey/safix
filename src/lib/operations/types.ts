export type SchedulingStatus =
  | 'scheduled'
  | 'execution_started'
  | 'execution_completed'
  | 'cancelled'

export type JobSchedule = {
  id: string
  jobId: string
  scheduledStart: number
  scheduledEnd: number
  executionWindow: number
  schedulingStatus: SchedulingStatus
  createdAt: number
  updatedAt: number
}
