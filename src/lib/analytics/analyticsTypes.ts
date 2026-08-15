/**
 * Analytics event types and domain entities.
 *
 * Events are append-only marketplace signals recorded for operational insight
 * and pilot evaluation.
 */

export type AnalyticsEventType =
  | 'job_created'
  | 'proposal_sent'
  | 'proposal_accepted'
  | 'job_started'
  | 'job_completed'
  | 'rating_submitted'
  | 'payment_created'
  | 'payment_released'
  | 'payment_refunded'
  | 'onboarding_completed'
  | 'provider_discovery_ready'
  | 'payout_ready'
  | 'trust_provider_flagged'
  | 'trust_discovery_blocked'
  | 'trust_payout_restricted'
  | 'trust_customer_risk_detected'
  | 'media_upload_started'
  | 'media_upload_succeeded'
  | 'media_upload_failed'
  | 'media_viewed_profile'
  | 'media_viewed_project'
  | 'media_viewed_dispute'
  | 'media_project_uploaded'
  | 'offer_created'
  | 'offer_accepted'
  | 'offer_declined'
  | 'offer_superseded'
  | 'project_cancelled'
  | 'case_closed'
  | 'funding_requested'
  | 'funding_entry_started'
  | 'work_started_recorded'
  | 'work_completed_recorded'
  | 'tranche_released'
  | 'release_blocked'
  // ── Lifecycle / funnel events (recorded via `track()`, keyed by user) ──
  | 'app_open'
  | 'signup'
  | 'inquiry_created'

export type AnalyticsEntityType =
  | 'job'
  | 'payment'
  | 'rating'
  | 'provider'
  | 'media'
  | 'offer'
  | 'project'
  | 'funding_request'
  // Lifecycle/funnel events are keyed by the acting user, not a domain entity.
  | 'user'

export type AnalyticsEvent = {
  eventId: string
  eventType: AnalyticsEventType
  entityType: AnalyticsEntityType
  entityId: string
  actorUserId?: string
  metadata?: Record<string, unknown>
  createdAt: number // unix ms
}

export type MarketplaceMetrics = {
  jobsCreated: number
  jobsCompleted: number
  completionRate: number
  proposalsSent: number
  proposalsAccepted: number
  ratingsSubmitted: number
  averageRating: number
  paymentsCreated: number
  paymentsReleased: number
  paymentsRefunded: number
  // Supply-side metrics
  onboardingCompleted: number
  providersDiscoveryReady: number
  payoutReady: number
}
