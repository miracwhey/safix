/**
 * Trust & Safety Selectors
 *
 * Pure functions that derive trust status and risk flags for providers and
 * customers from raw signal inputs.
 *
 * Design principles:
 *   - All functions are pure (no side effects, no store reads).
 *   - Thresholds are defined as named constants for easy tuning.
 *   - Trust decisions made here are the single source of truth across all
 *     surfaces: discovery, payouts, operator dashboard.
 */

import type {
  ProviderTrustInput,
  ProviderTrustFlag,
  ProviderTrustFlagKind,
  ProviderTrustStatus,
  ProviderTrustAssessment,
  CustomerRiskInput,
  CustomerRiskFlag,
  CustomerRiskStatus,
  CustomerRiskAssessment,
} from './trustTypes'
import { logInfo } from '../observability'

// ── Thresholds ────────────────────────────────────────────────────────────────

/** Minimum number of ratings required before the reputation signal is considered reliable. */
const REPUTATION_MIN_RATINGS = 3

/** Average rating below this threshold (with sufficient data) triggers a watch flag. */
const REPUTATION_WATCH_THRESHOLD = 3.0

/** Average rating below this threshold (with sufficient data) triggers a restricted status. */
const REPUTATION_RESTRICTED_THRESHOLD = 2.5

/** Open dispute count at or above this number triggers a watch flag. */
const DISPUTES_WATCH_THRESHOLD = 1

/** Open dispute count at or above this number triggers a restricted status. */
const DISPUTES_RESTRICTED_THRESHOLD = 3

/** Customer dispute count at or above this number triggers an elevated risk flag. */
const CUSTOMER_DISPUTES_ELEVATED_THRESHOLD = 2

/** Customer dispute count at or above this number triggers a high risk flag. */
const CUSTOMER_DISPUTES_HIGH_THRESHOLD = 4

/** Dispute-to-job ratio at or above this value triggers a high dispute rate flag. */
const CUSTOMER_DISPUTE_RATE_HIGH_THRESHOLD = 0.5

// ── Provider trust helpers ────────────────────────────────────────────────────

function makeProviderFlag(
  kind: ProviderTrustFlagKind,
  label: string,
  severity: ProviderTrustFlag['severity']
): ProviderTrustFlag {
  return { kind, label, severity }
}

/**
 * Derives the list of active trust flags for a provider from raw signals.
 * Pure function — no side effects.
 */
export function deriveProviderTrustFlags(
  input: ProviderTrustInput
): ProviderTrustFlag[] {
  const flags: ProviderTrustFlag[] = []

  // Reputation flag: only meaningful when enough ratings exist
  if (input.ratingCount >= REPUTATION_MIN_RATINGS) {
    if (input.averageRating < REPUTATION_RESTRICTED_THRESHOLD) {
      flags.push(
        makeProviderFlag(
          'low_reputation',
          `Niedrige Bewertung (Ø ${input.averageRating.toFixed(1)}) – Sichtbarkeit eingeschränkt`,
          'high'
        )
      )
    } else if (input.averageRating < REPUTATION_WATCH_THRESHOLD) {
      flags.push(
        makeProviderFlag(
          'low_reputation',
          `Bewertung unter Durchschnitt (Ø ${input.averageRating.toFixed(1)})`,
          'medium'
        )
      )
    }
  }

  // Payout flag
  if (!input.payoutReady) {
    flags.push(
      makeProviderFlag(
        'payout_not_ready',
        'Auszahlung noch nicht eingerichtet',
        'medium'
      )
    )
  }

  // Dispute flag
  if (input.openDisputeCount >= DISPUTES_RESTRICTED_THRESHOLD) {
    flags.push(
      makeProviderFlag(
        'repeated_disputes',
        `${input.openDisputeCount} offene Streitfälle – Einschränkungen aktiv`,
        'high'
      )
    )
  } else if (input.openDisputeCount >= DISPUTES_WATCH_THRESHOLD) {
    flags.push(
      makeProviderFlag(
        'repeated_disputes',
        `${input.openDisputeCount} offener Streitfall`,
        'medium'
      )
    )
  }

  // Incomplete onboarding flag
  if (!input.onboardingCompleted) {
    flags.push(
      makeProviderFlag(
        'incomplete_onboarding',
        'Onboarding noch nicht abgeschlossen',
        'low'
      )
    )
  }

  return flags
}

/**
 * Derives the overall trust status for a provider from their flags.
 *
 * Enforcement rule:
 *   - 'restricted' if any flag has severity 'high'
 *   - 'watch'      if any flag has severity 'medium'
 *   - 'trusted'    otherwise
 *
 * Pure function — no side effects.
 */
export function deriveProviderTrustStatus(
  flags: ProviderTrustFlag[]
): ProviderTrustStatus {
  if (flags.some((f) => f.severity === 'high')) return 'restricted'
  if (flags.some((f) => f.severity === 'medium')) return 'watch'
  return 'trusted'
}

/**
 * Derives the full trust assessment for a provider.
 *
 * This is the primary entry point for all provider trust decisions.
 * Pure function — no side effects.
 */
export function deriveProviderTrustAssessment(
  input: ProviderTrustInput
): ProviderTrustAssessment {
  const flags = deriveProviderTrustFlags(input)
  const status = deriveProviderTrustStatus(flags)

  const isDiscoveryBlocked = status === 'restricted'
  // Payout is restricted when provider is in 'restricted' status OR has a payout flag
  const isPayoutRestricted =
    status === 'restricted' ||
    flags.some((f) => f.kind === 'payout_not_ready')

  return {
    providerUserId: input.providerUserId,
    status,
    flags,
    isDiscoveryBlocked,
    isPayoutRestricted,
  }
}

/**
 * Enforcement rule: Determines whether a provider is trusted for discovery.
 *
 * Uses the lightweight signals available on a DiscoveryProvider to make
 * a fast trust decision at the discovery layer.
 *
 * A provider is NOT trusted for discovery when:
 *   - They have a statistically significant low reputation (rating < 2.5 with ≥ 3 ratings)
 *
 * This function is intentionally narrow — it covers only the signals available
 * at the discovery layer without requiring additional store lookups.
 *
 * NOTE: This function is used by deriveTrustScorePenalty to drive ranking
 * penalties rather than hard blocking. isDiscoveryVisible no longer gates
 * on this signal directly.
 *
 * Pure function — no side effects.
 */
export function isProviderTrustedForDiscovery(provider: {
  rating: number | null
  ratingCount: number
}): boolean {
  if (
    provider.ratingCount >= REPUTATION_MIN_RATINGS &&
    provider.rating !== null &&
    provider.rating < REPUTATION_RESTRICTED_THRESHOLD
  ) {
    return false
  }
  return true
}

/**
 * Derives a score penalty multiplier for a provider based on trust signals
 * available in the discovery layer (rating + ratingCount).
 *
 * This is the enforcement mechanism for trust in discovery: instead of hard-
 * blocking providers, low-trust providers receive a lower composite score so
 * they rank below better-trusted providers.
 *
 * Multipliers:
 *   - 1.0  trusted  — no penalty applied
 *   - 0.8  watch    — slight penalty (avg rating 2.5–3.0 with ≥ 3 ratings)
 *   - 0.5  restricted — strong penalty (avg rating < 2.5 with ≥ 3 ratings)
 *
 * Pure function — no side effects.
 */
export function deriveTrustScorePenalty(provider: {
  rating: number | null
  ratingCount: number
}): number {
  if (provider.ratingCount < REPUTATION_MIN_RATINGS || provider.rating === null) {
    return 1.0 // insufficient data — no penalty
  }
  if (provider.rating < REPUTATION_RESTRICTED_THRESHOLD) return 0.5
  if (provider.rating < REPUTATION_WATCH_THRESHOLD) return 0.8
  return 1.0
}

/**
 * Emits an observability event when a provider's discovery score is penalized
 * due to trust status. Call this when the trust penalty is applied in scoring.
 */
export function emitTrustDiscoveryPenalizedEvent(
  providerUserId: string,
  trustStatus: ProviderTrustStatus,
  penaltyApplied: number
): void {
  logInfo('trust.discovery_penalized', { providerUserId, trustStatus, penaltyApplied })
}

/**
 * Emits an observability event when a provider is blocked from discovery
 * due to trust status.
 * @deprecated Trust enforcement now uses ranking penalties instead of hard
 *   blocks. Use emitTrustDiscoveryPenalizedEvent instead.
 */
export function emitTrustDiscoveryBlockedEvent(
  providerUserId: string,
  reason: string
): void {
  logInfo('trust.discovery_blocked', { providerUserId, reason })
}

/**
 * Emits an observability event when a provider is flagged for trust reasons.
 */
export function emitTrustProviderFlaggedEvent(
  providerUserId: string,
  flags: ProviderTrustFlag[]
): void {
  logInfo('trust.provider_flagged', {
    providerUserId,
    flagCount: flags.length,
    flagKinds: flags.map((f) => f.kind),
  })
}

/**
 * Emits an observability event when payout is restricted due to trust.
 */
export function emitTrustPayoutRestrictedEvent(
  providerUserId: string,
  reason: string
): void {
  logInfo('trust.payout_restricted', { providerUserId, reason })
}

// ── Customer risk helpers ─────────────────────────────────────────────────────

/**
 * Derives the list of active risk flags for a customer.
 * Pure function — no side effects.
 */
export function deriveCustomerRiskFlags(
  input: CustomerRiskInput
): CustomerRiskFlag[] {
  const flags: CustomerRiskFlag[] = []

  if (input.totalDisputesRaised >= CUSTOMER_DISPUTES_ELEVATED_THRESHOLD) {
    flags.push({
      kind: 'repeated_disputes',
      label: `${input.totalDisputesRaised} Streitfälle eröffnet`,
    })
  }

  if (
    input.totalJobsCompleted > 0 &&
    input.totalDisputesRaised / input.totalJobsCompleted >= CUSTOMER_DISPUTE_RATE_HIGH_THRESHOLD
  ) {
    flags.push({
      kind: 'high_dispute_rate',
      label: 'Überdurchschnittliche Streitfallquote',
    })
  }

  return flags
}

/**
 * Derives the overall risk status for a customer.
 * Pure function — no side effects.
 */
export function deriveCustomerRiskStatus(
  flags: CustomerRiskFlag[],
  input: CustomerRiskInput
): CustomerRiskStatus {
  if (input.totalDisputesRaised >= CUSTOMER_DISPUTES_HIGH_THRESHOLD) return 'high'
  if (flags.length > 0) return 'elevated'
  return 'normal'
}

/**
 * Derives the full risk assessment for a customer.
 * Pure function — no side effects.
 */
export function deriveCustomerRiskAssessment(
  input: CustomerRiskInput
): CustomerRiskAssessment {
  const flags = deriveCustomerRiskFlags(input)
  const status = deriveCustomerRiskStatus(flags, input)

  return {
    customerUserId: input.customerUserId,
    status,
    flags,
  }
}

/**
 * Emits an observability event when a customer risk is detected.
 */
export function emitTrustCustomerRiskDetectedEvent(
  customerUserId: string,
  status: CustomerRiskStatus,
  flags: CustomerRiskFlag[]
): void {
  logInfo('trust.customer_risk_detected', {
    customerUserId,
    status,
    flagCount: flags.length,
    flagKinds: flags.map((f) => f.kind),
  })
}
