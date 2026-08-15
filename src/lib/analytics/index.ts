export type {
  AnalyticsEvent,
  AnalyticsEventType,
  AnalyticsEntityType,
  MarketplaceMetrics,
} from './analyticsTypes'

export {
  recordAnalyticsEvent,
  recordAnalyticsEventOnce,
  getAnalyticsEvents,
  getAnalyticsEventsByType,
  getAnalyticsEventsSince,
  subscribeAnalyticsEvents,
} from './analyticsService'

export {
  countByEventType,
  getJobsCreated,
  getJobsCompleted,
  getCompletionRate,
  getProposalsSent,
  getProposalsAccepted,
  getRatingsSubmitted,
  getAverageRatingFromEvents,
  getPaymentsCreated,
  getPaymentsReleased,
  getPaymentsRefunded,
  getOnboardingCompleted,
  getProvidersDiscoveryReady,
  getPayoutReady,
  filterEventsSince,
  deriveMarketplaceMetrics,
} from './analyticsSelectors'

export type { AnalyticsRepository } from './repository'
export {
  getAnalyticsRepository,
  setAnalyticsRepository,
  initializeAnalyticsRepository,
  InMemoryAnalyticsRepository,
  SupabaseAnalyticsRepository,
} from './repository'

// NOTE: `track` is intentionally NOT re-exported here — it imports ../session,
// and re-exporting it would pull session.ts's onAuthStateChange module-load
// side-effect into every analytics-barrel consumer (crashes offline tests).
// Session-aware callers import it from './analytics/track' directly.
export { isoWeek } from './cohortWeek'

export {
  distinctActors,
  deriveFunnel,
  getUserFunnel,
} from './funnelSelectors'
export type { FunnelStageCounts, UserFunnelStages } from './funnelSelectors'
