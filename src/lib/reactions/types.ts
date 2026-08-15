import type { ProjectTimelineEventType } from '../timeline'
import type { EntityId } from '../shared/coreTypes'

/**
 * Groups related timeline event types into broad domain areas.
 * Allows reaction subscribers to filter by area of interest.
 */
export type ReactionCategory =
  | 'job'
  | 'payment'
  | 'dispute'
  | 'scheduling'
  | 'media'

/**
 * A reaction event is a lightweight, category-tagged signal derived from
 * an important domain transition.  It carries just enough context for
 * invalidation, refresh, or derived-state logic without exposing internal
 * domain detail.
 */
export type DomainReactionEvent = {
  id: string
  jobId: EntityId
  type: ProjectTimelineEventType
  category: ReactionCategory
  occurredAt: number
}

/**
 * A handler that receives domain reaction events.
 */
export type ReactionHandler = (event: DomainReactionEvent) => void
