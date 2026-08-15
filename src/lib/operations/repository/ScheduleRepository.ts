import type { JobSchedule, SchedulingStatus } from '../types'

export interface ScheduleRepository {
  initialize(): Promise<void>
  isHydrated(): boolean
  getAll(): JobSchedule[]
  getById(id: string): JobSchedule | undefined
  getByJobId(jobId: string): JobSchedule | undefined
  add(schedule: JobSchedule): void
  updateStatus(id: string, nextStatus: SchedulingStatus): void
  replace(schedule: JobSchedule): void
  subscribe(listener: () => void): () => void
}
