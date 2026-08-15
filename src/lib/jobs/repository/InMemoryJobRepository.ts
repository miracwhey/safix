import { jobsMock } from '../mockData'
import type { Job } from '../types'
import { JobStatusCasConflictError } from './JobRepository'
import type { JobRepository, JobUpdateOptions } from './JobRepository'

type Listener = () => void

export class InMemoryJobRepository implements JobRepository {
  private jobs: Job[]
  private readonly listeners = new Set<Listener>()

  constructor(initialData: Job[] = [...jobsMock]) {
    this.jobs = initialData
  }

  async initialize(): Promise<void> {
    // In-memory data is already loaded from mock data at construction time
  }

  isHydrated(): boolean {
    // In-memory repos are always hydrated — data is available at construction
    return true
  }

  notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): Job[] {
    return [...this.jobs]
  }

  getById(id: string): Job | undefined {
    return this.jobs.find((job) => job.id === id)
  }

  saveAll(jobs: Job[]): void {
    this.jobs = jobs
    this.notify()
  }

  async add(job: Job): Promise<void> {
    this.jobs = [...this.jobs, job]
    this.notify()
  }

  async remove(jobId: string): Promise<void> {
    this.jobs = this.jobs.filter((j) => j.id !== jobId)
    this.notify()
  }

  async update(
    jobId: string,
    updater: (job: Job) => Job,
    options?: JobUpdateOptions,
  ): Promise<void> {
    // CAS parity with SupabaseJobRepository: a stale expectedStatus throws
    // without mutating the store or notifying subscribers.
    if (options?.expectedStatus !== undefined) {
      const existing = this.jobs.find((job) => job.id === jobId)
      if (existing && existing.status !== options.expectedStatus) {
        throw new JobStatusCasConflictError(jobId, options.expectedStatus)
      }
    }
    this.jobs = this.jobs.map((job) => (job.id === jobId ? updater(job) : job))
    this.notify()
  }

  async reassignAssignedMember(
    jobId: string,
    fromMemberId: string,
    toMemberId: string,
  ): Promise<Job> {
    const existing = this.jobs.find((j) => j.id === jobId)
    if (!existing) throw new Error(`Job not found: ${jobId}`)
    const current = existing.assignedMemberIds
    let next: string[]
    if (current.includes(toMemberId)) {
      next = current.filter((id) => id !== fromMemberId)
    } else if (current.includes(fromMemberId)) {
      next = [...current.filter((id) => id !== fromMemberId), toMemberId]
    } else {
      next = [...current, toMemberId]
    }
    const updated: Job = { ...existing, assignedMemberIds: next }
    this.jobs = this.jobs.map((j) => (j.id === jobId ? updated : j))
    this.notify()
    return updated
  }

  reset(): void {
    this.jobs = [...jobsMock]
    this.notify()
  }
}
