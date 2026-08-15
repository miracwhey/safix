import { getTimelineRepository } from './repository'
import { isTimelineRepositoryHydrated } from './timelineStore'
import { logWarning } from '../observability'
import { generateUUID } from '../shared/generateUUID'
import type { ProjectTimelineEventType, ProjectTimelineSignal } from './types'

export function createTimelineEvent(params: {
  jobId: string
  type: ProjectTimelineEventType
  occurredAt?: number
  entityId?: string | null
}): ProjectTimelineSignal {
  const occurredAt = params.occurredAt ?? Date.now()

  return {
    id: generateUUID(),
    jobId: params.jobId,
    type: params.type,
    occurredAt,
    ...(params.entityId != null ? { entityId: params.entityId } : {}),
  }
}

export function addTimelineEvent(event: ProjectTimelineSignal): void {
  if (!isTimelineRepositoryHydrated()) {
    logWarning('timeline.add.skipped_unhydrated', { jobId: event.jobId, type: event.type })
    return
  }
  getTimelineRepository().add(event)
}

export function ensureTimelineEvent(params: {
  jobId: string
  type: ProjectTimelineEventType
  occurredAt?: number
  entityId?: string | null
}): void {
  if (!isTimelineRepositoryHydrated()) {
    logWarning('timeline.ensure.skipped_unhydrated', { jobId: params.jobId, type: params.type })
    return
  }
  if (getTimelineRepository().hasEventOfType(params.jobId, params.type)) return

  addTimelineEvent(createTimelineEvent(params))
}
