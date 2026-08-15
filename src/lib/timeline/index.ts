export type {
  ProjectTimelineEvent,
  ProjectTimelineEventType,
  ProjectTimelineSignal,
  TimelineEventAccent,
} from './types'

export {
  subscribeTimeline,
  getTimelineSignals,
  getTimelineSignalsForJob,
  hasTimelineEventOfType,
  isTimelineRepositoryHydrated,
} from './timelineStore'

export {
  addTimelineEvent,
  createTimelineEvent,
  ensureTimelineEvent,
} from './timelineService'

export {
  buildProjectTimeline,
  getTimelineEventAccent,
  getTimelineEventLabel,
  mapSignalToTimelineEvent,
} from './timelineSelectors'

export type { TimelineNavTarget } from './timelineNavigation'
export {
  getCraftsmanTimelineNavTarget,
  getCraftsmanJobNavTarget,
  getCustomerTimelineNavTarget,
} from './timelineNavigation'

export type { TimelineRepository } from './repository'
export { getTimelineRepository, setTimelineRepository, initializeTimelineRepository, SupabaseTimelineRepository } from './repository'
