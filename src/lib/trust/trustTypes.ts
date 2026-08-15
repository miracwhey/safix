/**
 * Trust & Safety Types
 *
 * Structured type definitions for provider and customer trust signals.
 * These types drive trust selectors, operator visibility, and enforcement rules.
 */

// ── Provider Trust ───────────────────────────────────────────────────────────

/**
 * The overall trust classification for a provider.
 *
 * - trusted:    No significant trust flags. Fully eligible for discovery and payouts.
 * - watch:      Minor concerns detected. Provider is still discoverable but flagged.
 * - restricted: Serious trust signals present. Discovery is blocked.
 */
export type ProviderTrustStatus = 'trusted' | 'watch' | 'restricted'

/**
 * Individual trust flag kinds for providers.
 */
export type ProviderTrustFlagKind =
  | 'low_reputation'       // Average rating is below the acceptable threshold
  | 'payout_not_ready'     // Provider has not completed payout setup
  | 'repeated_disputes'    // Provider has multiple open or recent disputes
  | 'incomplete_onboarding' // Onboarding not fully completed

/**
 * A single structured trust flag for a provider.
 */
export type ProviderTrustFlag = {
  kind: ProviderTrustFlagKind
  label: string
  severity: 'low' | 'medium' | 'high'
}

/**
 * Input signals needed to derive provider trust flags.
 * All fields are optional so callers can provide what they have.
 */
export type ProviderTrustInput = {
  providerUserId: string
  /** Average rating (0 when none). */
  averageRating: number
  /** Total number of ratings submitted. */
  ratingCount: number
  /** Whether payout account is ready. */
  payoutReady: boolean
  /** Whether onboarding has been fully completed. */
  onboardingCompleted: boolean
  /** Number of open (unresolved) disputes. */
  openDisputeCount: number
  /** Total number of disputes ever raised against this provider. */
  totalDisputeCount: number
  /** Total number of completed jobs. */
  completedJobsCount: number
}

// ── Customer Risk ────────────────────────────────────────────────────────────

/**
 * The overall risk classification for a customer.
 *
 * - normal:   No concerning patterns detected.
 * - elevated: Some patterns detected; monitor activity.
 * - high:     Multiple risk signals; may need operator review.
 */
export type CustomerRiskStatus = 'normal' | 'elevated' | 'high'

/**
 * Individual risk flag kinds for customers.
 */
export type CustomerRiskFlagKind =
  | 'repeated_disputes'    // Customer has opened multiple disputes
  | 'high_dispute_rate'    // Dispute-to-job ratio is above threshold

/**
 * A single structured risk flag for a customer.
 */
export type CustomerRiskFlag = {
  kind: CustomerRiskFlagKind
  label: string
}

/**
 * Input signals needed to derive customer risk status.
 */
export type CustomerRiskInput = {
  customerUserId: string
  /** Total number of disputes raised by this customer. */
  totalDisputesRaised: number
  /** Number of open (unresolved) disputes raised by this customer. */
  openDisputesRaised: number
  /** Total number of completed jobs this customer has had. */
  totalJobsCompleted: number
}

// ── Derived outputs ──────────────────────────────────────────────────────────

/**
 * Full derived trust assessment for a provider.
 */
export type ProviderTrustAssessment = {
  providerUserId: string
  status: ProviderTrustStatus
  flags: ProviderTrustFlag[]
  /** True when the provider is blocked from appearing in discovery due to trust. */
  isDiscoveryBlocked: boolean
  /** True when payout eligibility is restricted due to trust flags. */
  isPayoutRestricted: boolean
}

/**
 * Full derived risk assessment for a customer.
 */
export type CustomerRiskAssessment = {
  customerUserId: string
  status: CustomerRiskStatus
  flags: CustomerRiskFlag[]
}
