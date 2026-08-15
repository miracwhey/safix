import type { AnalyticsEvent, MarketplaceMetrics } from './analyticsTypes'

/**
 * Pure selector functions that derive marketplace metrics from analytics events.
 *
 * All functions are side-effect-free and operate on an array of events.
 */

export function countByEventType(
  events: AnalyticsEvent[],
  eventType: AnalyticsEvent['eventType']
): number {
  return events.filter((e) => e.eventType === eventType).length
}

export function getJobsCreated(events: AnalyticsEvent[]): number {
  return countByEventType(events, 'job_created')
}

export function getJobsCompleted(events: AnalyticsEvent[]): number {
  return countByEventType(events, 'job_completed')
}

export function getCompletionRate(events: AnalyticsEvent[]): number {
  const created = getJobsCreated(events)
  if (created === 0) return 0
  return getJobsCompleted(events) / created
}

export function getProposalsSent(events: AnalyticsEvent[]): number {
  return countByEventType(events, 'proposal_sent')
}

export function getProposalsAccepted(events: AnalyticsEvent[]): number {
  return countByEventType(events, 'proposal_accepted')
}

export function getRatingsSubmitted(events: AnalyticsEvent[]): number {
  return countByEventType(events, 'rating_submitted')
}

export function getAverageRatingFromEvents(events: AnalyticsEvent[]): number {
  const ratingEvents = events.filter((e) => e.eventType === 'rating_submitted')
  if (ratingEvents.length === 0) return 0

  const total = ratingEvents.reduce((sum, e) => {
    const score = (e.metadata?.ratingScore as number) ?? 0
    return sum + score
  }, 0)

  return total / ratingEvents.length
}

export function getPaymentsCreated(events: AnalyticsEvent[]): number {
  return countByEventType(events, 'payment_created')
}

export function getPaymentsReleased(events: AnalyticsEvent[]): number {
  return countByEventType(events, 'payment_released')
}

export function getPaymentsRefunded(events: AnalyticsEvent[]): number {
  return countByEventType(events, 'payment_refunded')
}

// ── Supply-side selectors ─────────────────────────────────────────────────────

export function getOnboardingCompleted(events: AnalyticsEvent[]): number {
  return countByEventType(events, 'onboarding_completed')
}

export function getProvidersDiscoveryReady(events: AnalyticsEvent[]): number {
  return countByEventType(events, 'provider_discovery_ready')
}

export function getPayoutReady(events: AnalyticsEvent[]): number {
  return countByEventType(events, 'payout_ready')
}

/**
 * Filters events to only those created within the last N days.
 */
export function filterEventsSince(events: AnalyticsEvent[], days: number): AnalyticsEvent[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  return events.filter((e) => e.createdAt >= cutoff)
}

/**
 * Derives a complete set of marketplace metrics from a list of analytics events.
 */
export function deriveMarketplaceMetrics(events: AnalyticsEvent[]): MarketplaceMetrics {
  return {
    jobsCreated: getJobsCreated(events),
    jobsCompleted: getJobsCompleted(events),
    completionRate: getCompletionRate(events),
    proposalsSent: getProposalsSent(events),
    proposalsAccepted: getProposalsAccepted(events),
    ratingsSubmitted: getRatingsSubmitted(events),
    averageRating: getAverageRatingFromEvents(events),
    paymentsCreated: getPaymentsCreated(events),
    paymentsReleased: getPaymentsReleased(events),
    paymentsRefunded: getPaymentsRefunded(events),
    onboardingCompleted: getOnboardingCompleted(events),
    providersDiscoveryReady: getProvidersDiscoveryReady(events),
    payoutReady: getPayoutReady(events),
  }
}
