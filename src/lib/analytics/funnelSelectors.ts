import type { AnalyticsEvent, AnalyticsEventType } from './analyticsTypes'

/**
 * Pure per-user funnel selectors over the lifecycle events emitted by `track()`
 * (app_open → signup → inquiry_created → … → first payment). Side-effect-free.
 *
 * The transaction-lifecycle selectors in analyticsSelectors.ts count raw event
 * volume; these count DISTINCT ACTORS per stage, which is what a conversion
 * funnel needs (one user who opens the app twice is one app_open actor).
 */

/** Distinct actorUserIds that emitted at least one event of `eventType`. */
export function distinctActors(events: AnalyticsEvent[], eventType: AnalyticsEventType): number {
  const actors = new Set<string>()
  for (const e of events) {
    if (e.eventType === eventType && e.actorUserId) actors.add(e.actorUserId)
  }
  return actors.size
}

export type FunnelStageCounts = {
  /** Distinct actors who opened the app (excludes anonymous pre-login opens). */
  appOpens: number
  signups: number
  inquiriesCreated: number
  firstPayments: number
}

/**
 * Top-of-funnel conversion snapshot: distinct actors at each lifecycle stage.
 * `firstPayments` reuses the existing transaction event `payment_created`.
 */
export function deriveFunnel(events: AnalyticsEvent[]): FunnelStageCounts {
  return {
    appOpens: distinctActors(events, 'app_open'),
    signups: distinctActors(events, 'signup'),
    inquiriesCreated: distinctActors(events, 'inquiry_created'),
    firstPayments: distinctActors(events, 'payment_created'),
  }
}

export type UserFunnelStages = {
  appOpenedAt?: number
  signedUpAt?: number
  firstInquiryAt?: number
  firstPaymentAt?: number
  cohortWeek?: string
  role?: string
}

/**
 * The lifecycle timeline for a single user — earliest timestamp per stage plus
 * the stamped cohort/role. Drives per-user funnel inspection and cohort
 * retention grouping (group users by `cohortWeek`).
 */
export function getUserFunnel(events: AnalyticsEvent[], userId: string): UserFunnelStages {
  const stages: UserFunnelStages = {}
  const earliest = (current: number | undefined, next: number): number =>
    current === undefined ? next : Math.min(current, next)

  for (const e of events) {
    if (e.actorUserId !== userId) continue
    if (typeof e.metadata?.cohortWeek === 'string') stages.cohortWeek = e.metadata.cohortWeek
    if (typeof e.metadata?.role === 'string') stages.role = e.metadata.role
    switch (e.eventType) {
      case 'app_open':
        stages.appOpenedAt = earliest(stages.appOpenedAt, e.createdAt)
        break
      case 'signup':
        stages.signedUpAt = earliest(stages.signedUpAt, e.createdAt)
        break
      case 'inquiry_created':
        stages.firstInquiryAt = earliest(stages.firstInquiryAt, e.createdAt)
        break
      case 'payment_created':
        stages.firstPaymentAt = earliest(stages.firstPaymentAt, e.createdAt)
        break
    }
  }
  return stages
}
