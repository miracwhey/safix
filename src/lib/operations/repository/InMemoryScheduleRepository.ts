import type { JobSchedule, SchedulingStatus } from '../types'
import type { ScheduleRepository } from './ScheduleRepository'

type Listener = () => void

export class InMemoryScheduleRepository implements ScheduleRepository {
  private schedules: JobSchedule[] = []
  private readonly listeners = new Set<Listener>()

  async initialize(): Promise<void> {
    // In-memory schedule repository starts empty; schedules are created dynamically at runtime
  }

  isHydrated(): boolean {
    return true
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): JobSchedule[] {
    return [...this.schedules]
  }

  getById(id: string): JobSchedule | undefined {
    return this.schedules.find((s) => s.id === id)
  }

  getByJobId(jobId: string): JobSchedule | undefined {
    return this.schedules.find((s) => s.jobId === jobId)
  }

  add(schedule: JobSchedule): void {
    this.schedules = [schedule, ...this.schedules]
    this.notify()
  }

  updateStatus(id: string, nextStatus: SchedulingStatus): void {
    this.schedules = this.schedules.map((s) => {
      if (s.id !== id) return s

      return { ...s, schedulingStatus: nextStatus, updatedAt: Date.now() }
    })
    this.notify()
  }

  replace(schedule: JobSchedule): void {
    this.schedules = this.schedules.map((s) =>
      s.id === schedule.id ? schedule : s
    )
    this.notify()
  }
}
