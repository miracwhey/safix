import { getWouldHireAgainCount, getTotalFeedbackCount } from '../feedback'

/**
 * A single, consistent projection of all provider trust signals.
 *
 * Every surface that needs to render or score a provider's trust state
 * should derive it through `deriveProviderTrustProjection` so the
 * same thresholds and labels are applied everywhere.
 */
export interface ProviderTrustProjection {
  /** Number of successfully completed (payment-released) jobs. */
  completedJobsCount: number
  /** Number of customers who said they would hire this provider again. */
  wouldHireAgainCount: number
  /** Total feedback submissions for this provider. */
  totalFeedbackCount: number
  /** Whether the provider has at least one platform-backed completion. */
  hasPlatformBackedCompletion: boolean
  /** Trust badge descriptors ready for display. */
  badges: TrustBadge[]
}

export interface TrustBadge {
  kind: TrustBadgeKind
  label: string
  icon: string
}

export type TrustBadgeKind =
  | 'completed_jobs'
  | 'would_hire_again'
  | 'platform_backed'

/**
 * Input signals needed to derive a provider's trust projection.
 *
 * These can originate from either a real craftsman profile (Supabase)
 * or an explore provider card already carrying the raw counts.
 */
export interface TrustProjectionInput {
  craftsmanUserId: string
  completedJobsCount?: number
  /**
   * When provided, bypasses the feedback store lookup.
   * Useful when the caller has already resolved the count (e.g. from a
   * pre-built ExploreProviderCard).
   */
  wouldHireAgainCount?: number
}

/**
 * Derives a consistent trust projection for a provider.
 *
 * This is the single source of truth for provider trust signals.
 * All discovery surfaces, profile cards, and matching selectors
 * should consume this projection instead of assembling trust
 * signals ad-hoc.
 */
export function deriveProviderTrustProjection(
  input: TrustProjectionInput
): ProviderTrustProjection {
  const completedJobsCount = input.completedJobsCount ?? 0
  const wouldHireAgainCount =
    input.wouldHireAgainCount ?? getWouldHireAgainCount(input.craftsmanUserId)
  const totalFeedbackCount = getTotalFeedbackCount(input.craftsmanUserId)
  const hasPlatformBackedCompletion = completedJobsCount > 0

  const badges: TrustBadge[] = []

  if (completedJobsCount > 0) {
    badges.push({
      kind: 'completed_jobs',
      label: `${completedJobsCount} ${completedJobsCount === 1 ? 'Projekt' : 'Projekte'} auf SaFix abgeschlossen`,
      icon: '✅',
    })
  }

  if (wouldHireAgainCount > 0) {
    badges.push({
      kind: 'would_hire_again',
      label: `${wouldHireAgainCount}× ${wouldHireAgainCount === 1 ? 'Kunde würde wieder buchen' : 'Kunden würden wieder buchen'}`,
      icon: '👍',
    })
  }

  if (hasPlatformBackedCompletion) {
    badges.push({
      kind: 'platform_backed',
      label: 'Plattformbestätigt über SaFix',
      icon: '🏅',
    })
  }

  return {
    completedJobsCount,
    wouldHireAgainCount,
    totalFeedbackCount,
    hasPlatformBackedCompletion,
    badges,
  }
}
