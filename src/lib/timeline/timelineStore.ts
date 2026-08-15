import { getTimelineRepository } from './repository'
import type { ProjectTimelineEventType, ProjectTimelineSignal } from './types'

type Listener = () => void

export function subscribeTimeline(listener: Listener): () => void {
  return getTimelineRepository().subscribe(listener)
}

export function getTimelineSignals(): ProjectTimelineSignal[] {
  return getTimelineRepository().getAll()
}

export function getTimelineSignalsForJob(jobId: string): ProjectTimelineSignal[] {
  return getTimelineRepository().getForJob(jobId)
}

export function hasTimelineEventOfType(
  jobId: string,
  type: ProjectTimelineEventType
): boolean {
  return getTimelineRepository().hasEventOfType(jobId, type)
}

export function isTimelineRepositoryHydrated(): boolean {
  return getTimelineRepository().isHydrated()
}
