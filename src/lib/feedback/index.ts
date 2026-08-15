export type { JobFeedback } from './types'

export {
  subscribeFeedback,
  getFeedbackByJobId,
  getFeedbackByCraftsmanId,
  isFeedbackHydrated,
} from './feedbackStore'

export {
  submitJobFeedback,
} from './feedbackService'

export {
  getWouldHireAgainCount,
  getTotalFeedbackCount,
  deriveWouldHireAgainRate,
} from './feedbackSelectors'

export type { FeedbackRepository } from './repository'
export {
  InMemoryFeedbackRepository,
  SupabaseFeedbackRepository,
  getFeedbackRepository,
  setFeedbackRepository,
  initializeFeedbackRepository,
} from './repository'
