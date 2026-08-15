import { describe, it, expect } from 'vitest'
import type { AnalyticsEvent } from '../../src/lib/analytics/analyticsTypes'
import {
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
} from '../../src/lib/analytics/analyticsSelectors'

function makeEvent(
  eventType: AnalyticsEvent['eventType'],
  overrides: Partial<AnalyticsEvent> = {}
): AnalyticsEvent {
  return {
    eventId: overrides.eventId ?? crypto.randomUUID(),
    eventType,
    entityType: overrides.entityType ?? 'job',
    entityId: overrides.entityId ?? 'entity-1',
    actorUserId: overrides.actorUserId,
    metadata: overrides.metadata,
    createdAt: overrides.createdAt ?? Date.now(),
  }
}

describe('analyticsSelectors', () => {
  describe('countByEventType', () => {
    it('returns 0 for empty events', () => {
      expect(countByEventType([], 'job_created')).toBe(0)
    })

    it('counts matching events', () => {
      const events = [
        makeEvent('job_created'),
        makeEvent('job_completed'),
        makeEvent('job_created'),
      ]
      expect(countByEventType(events, 'job_created')).toBe(2)
    })
  })

  describe('getJobsCreated / getJobsCompleted', () => {
    it('returns correct counts', () => {
      const events = [
        makeEvent('job_created'),
        makeEvent('job_created'),
        makeEvent('job_completed'),
      ]
      expect(getJobsCreated(events)).toBe(2)
      expect(getJobsCompleted(events)).toBe(1)
    })
  })

  describe('getCompletionRate', () => {
    it('returns 0 when no jobs created', () => {
      expect(getCompletionRate([])).toBe(0)
    })

    it('computes correct ratio', () => {
      const events = [
        makeEvent('job_created'),
        makeEvent('job_created'),
        makeEvent('job_created'),
        makeEvent('job_created'),
        makeEvent('job_completed'),
        makeEvent('job_completed'),
      ]
      expect(getCompletionRate(events)).toBe(0.5)
    })

    it('returns 1 when all created jobs are completed', () => {
      const events = [
        makeEvent('job_created'),
        makeEvent('job_completed'),
      ]
      expect(getCompletionRate(events)).toBe(1)
    })
  })

  describe('getProposalsSent / getProposalsAccepted', () => {
    it('counts proposal events', () => {
      const events = [
        makeEvent('proposal_sent'),
        makeEvent('proposal_sent'),
        makeEvent('proposal_accepted'),
      ]
      expect(getProposalsSent(events)).toBe(2)
      expect(getProposalsAccepted(events)).toBe(1)
    })
  })

  describe('getRatingsSubmitted', () => {
    it('counts rating submissions', () => {
      const events = [
        makeEvent('rating_submitted'),
        makeEvent('rating_submitted'),
        makeEvent('job_created'),
      ]
      expect(getRatingsSubmitted(events)).toBe(2)
    })
  })

  describe('getAverageRatingFromEvents', () => {
    it('returns 0 when no ratings', () => {
      expect(getAverageRatingFromEvents([])).toBe(0)
    })

    it('computes average from metadata.ratingScore', () => {
      const events = [
        makeEvent('rating_submitted', { metadata: { ratingScore: 5 } }),
        makeEvent('rating_submitted', { metadata: { ratingScore: 3 } }),
        makeEvent('rating_submitted', { metadata: { ratingScore: 4 } }),
      ]
      expect(getAverageRatingFromEvents(events)).toBe(4)
    })

    it('handles missing ratingScore gracefully', () => {
      const events = [
        makeEvent('rating_submitted', { metadata: { ratingScore: 5 } }),
        makeEvent('rating_submitted', { metadata: {} }),
      ]
      expect(getAverageRatingFromEvents(events)).toBe(2.5)
    })
  })

  describe('payment selectors', () => {
    it('counts payment events', () => {
      const events = [
        makeEvent('payment_created'),
        makeEvent('payment_released'),
        makeEvent('payment_released'),
        makeEvent('payment_refunded'),
      ]
      expect(getPaymentsCreated(events)).toBe(1)
      expect(getPaymentsReleased(events)).toBe(2)
      expect(getPaymentsRefunded(events)).toBe(1)
    })
  })

  describe('supply-side selectors', () => {
    it('counts onboarding_completed events', () => {
      const events = [
        makeEvent('onboarding_completed', { entityType: 'provider' }),
        makeEvent('onboarding_completed', { entityType: 'provider' }),
        makeEvent('job_created'),
      ]
      expect(getOnboardingCompleted(events)).toBe(2)
    })

    it('counts provider_discovery_ready events', () => {
      const events = [
        makeEvent('provider_discovery_ready', { entityType: 'provider' }),
        makeEvent('job_created'),
      ]
      expect(getProvidersDiscoveryReady(events)).toBe(1)
    })

    it('counts payout_ready events', () => {
      const events = [
        makeEvent('payout_ready', { entityType: 'provider' }),
        makeEvent('payout_ready', { entityType: 'provider' }),
        makeEvent('payout_ready', { entityType: 'provider' }),
      ]
      expect(getPayoutReady(events)).toBe(3)
    })

    it('returns 0 for empty events', () => {
      expect(getOnboardingCompleted([])).toBe(0)
      expect(getProvidersDiscoveryReady([])).toBe(0)
      expect(getPayoutReady([])).toBe(0)
    })
  })

  describe('filterEventsSince', () => {
    it('filters by days', () => {
      const now = Date.now()
      const oneDayAgo = now - 1 * 24 * 60 * 60 * 1000
      const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000
      const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000

      const events = [
        makeEvent('job_created', { createdAt: now }),
        makeEvent('job_created', { createdAt: oneDayAgo }),
        makeEvent('job_created', { createdAt: threeDaysAgo }),
        makeEvent('job_created', { createdAt: eightDaysAgo }),
      ]

      expect(filterEventsSince(events, 7)).toHaveLength(3)
      expect(filterEventsSince(events, 2)).toHaveLength(2)
      expect(filterEventsSince(events, 30)).toHaveLength(4)
    })
  })

  describe('deriveMarketplaceMetrics', () => {
    it('returns zeroed metrics for empty events', () => {
      const metrics = deriveMarketplaceMetrics([])
      expect(metrics.jobsCreated).toBe(0)
      expect(metrics.jobsCompleted).toBe(0)
      expect(metrics.completionRate).toBe(0)
      expect(metrics.proposalsSent).toBe(0)
      expect(metrics.proposalsAccepted).toBe(0)
      expect(metrics.ratingsSubmitted).toBe(0)
      expect(metrics.averageRating).toBe(0)
      expect(metrics.paymentsCreated).toBe(0)
      expect(metrics.paymentsReleased).toBe(0)
      expect(metrics.paymentsRefunded).toBe(0)
      expect(metrics.onboardingCompleted).toBe(0)
      expect(metrics.providersDiscoveryReady).toBe(0)
      expect(metrics.payoutReady).toBe(0)
    })

    it('computes all metrics correctly', () => {
      const events: AnalyticsEvent[] = [
        makeEvent('job_created'),
        makeEvent('job_created'),
        makeEvent('job_completed'),
        makeEvent('proposal_sent'),
        makeEvent('proposal_accepted'),
        makeEvent('rating_submitted', { metadata: { ratingScore: 4 } }),
        makeEvent('rating_submitted', { metadata: { ratingScore: 5 } }),
        makeEvent('payment_created'),
        makeEvent('payment_released'),
        makeEvent('payment_refunded'),
        makeEvent('onboarding_completed', { entityType: 'provider' }),
        makeEvent('onboarding_completed', { entityType: 'provider' }),
        makeEvent('provider_discovery_ready', { entityType: 'provider' }),
        makeEvent('payout_ready', { entityType: 'provider' }),
      ]

      const metrics = deriveMarketplaceMetrics(events)
      expect(metrics.jobsCreated).toBe(2)
      expect(metrics.jobsCompleted).toBe(1)
      expect(metrics.completionRate).toBe(0.5)
      expect(metrics.proposalsSent).toBe(1)
      expect(metrics.proposalsAccepted).toBe(1)
      expect(metrics.ratingsSubmitted).toBe(2)
      expect(metrics.averageRating).toBe(4.5)
      expect(metrics.paymentsCreated).toBe(1)
      expect(metrics.paymentsReleased).toBe(1)
      expect(metrics.paymentsRefunded).toBe(1)
      expect(metrics.onboardingCompleted).toBe(2)
      expect(metrics.providersDiscoveryReady).toBe(1)
      expect(metrics.payoutReady).toBe(1)
    })
  })
})
