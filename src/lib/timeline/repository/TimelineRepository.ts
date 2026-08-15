import type { ProjectTimelineEventType, ProjectTimelineSignal } from '../types'

export interface TimelineRepository {
  initialize(): Promise<void>
  isHydrated(): boolean
  getAll(): ProjectTimelineSignal[]
  getForJob(jobId: string): ProjectTimelineSignal[]
  hasEventOfType(jobId: string, type: ProjectTimelineEventType): boolean
  add(signal: ProjectTimelineSignal): void
  subscribe(listener: () => void): () => void
  notify(): void
}
