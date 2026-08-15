/**
 * Onboarding Selectors
 *
 * Pure functions that derive the craftsman onboarding progress from a
 * CraftsmanBusinessProfile and a ProviderPayoutAccount.
 *
 * Onboarding stages (in order):
 *   1. business_identity – company name, handle, city/location
 *   2. trades_services   – ≥1 trade category selected
 *   3. profile_trust     – avatar + bio uploaded
 *   4. payout_setup      – Stripe Connect payout readiness
 *   5. activation        – public visibility / ready for discovery
 *
 * Visibility / Discovery rule:
 *   A craftsman becomes discoverable once profile basics are complete
 *   (stages 1–3 + activation). Stripe/payout (stage 4) is NOT required
 *   for visibility or for sending quotes/funding requests — it is only
 *   required for receiving payouts and completing release flows.
 */

import type { CraftsmanBusinessProfile } from '../craftsman/types'
import type { ProviderPayoutAccount } from '../payout/types'
import { derivePayoutReadinessStatus } from '../payout/selectors'

// ── Stage IDs & status ───────────────────────────────────────────────────────

export type OnboardingStageId =
  | 'business_identity'
  | 'trades_services'
  | 'profile_trust'
  | 'payout_setup'
  | 'activation'

/** complete = done; next = first incomplete (call-to-action); incomplete = not yet reachable */
export type OnboardingStepStatus = 'complete' | 'next' | 'incomplete'

// ── Data shapes ──────────────────────────────────────────────────────────────

export type OnboardingStep = {
  /** Stable identifier for the step. */
  id: OnboardingStageId
  /** Human-readable step label (German). */
  title: string
  /** Short description of what is required. */
  description: string
  /** Derived status of this step. */
  status: OnboardingStepStatus
  /** Route to navigate to when the user wants to complete this step. */
  navigationPath: string
}

export type OnboardingProgress = {
  /** Ordered list of all onboarding steps with status. */
  steps: OnboardingStep[]
  /** Number of steps with status === 'complete'. */
  completedCount: number
  /** Total number of steps. */
  totalCount: number
  /** Percentage of completed steps (0–100). */
  completionPercent: number
  /** True when all steps are complete. */
  isComplete: boolean
  /** First step that still needs to be completed, or null when done. */
  nextStep: OnboardingStep | null
  /**
   * True when the provider cannot appear in customer discovery yet.
   * Blocked until profile basics (business_identity, trades_services,
   * profile_trust) and activation are done. Stripe/payout is NOT required
   * for discovery.
   */
  isDiscoveryBlocked: boolean
  /**
   * True when the provider's profile basics are complete and the craftsman
   * can appear in customer discovery — independent of payout/Stripe status.
   */
  isProfileReady: boolean
  /**
   * True when Stripe Connect is fully set up and the craftsman can receive
   * payouts and complete release flows. NOT required for sending quotes
   * or triggering funding requests.
   */
  isPayoutReady: boolean
}

// ── Static step definitions ──────────────────────────────────────────────────

const STEP_META: Record<
  OnboardingStageId,
  { title: string; description: string; navigationPath: string }
> = {
  business_identity: {
    title: 'Betriebsprofil',
    description: 'Unternehmensname, Handle und Standort eintragen',
    navigationPath: '/onboarding/craftsman-profile',
  },
  trades_services: {
    title: 'Gewerke & Leistungen',
    description: 'Mindestens eine Gewerkkategorie auswählen',
    navigationPath: '/onboarding/craftsman-profile',
  },
  profile_trust: {
    title: 'Profilbild & Bio',
    description: 'Profilfoto und kurze Vorstellung hochladen',
    navigationPath: '/craftsman/profile',
  },
  payout_setup: {
    title: 'Zahlungseinrichtung',
    description: 'Stripe Connect für Auszahlungen aktivieren',
    navigationPath: '/craftsman/finance',
  },
  activation: {
    title: 'Profil aktivieren',
    description: 'Profil öffentlich sichtbar machen',
    navigationPath: '/onboarding/craftsman-profile',
  },
}

/** Ordered list of all onboarding stages. */
const STAGE_ORDER: OnboardingStageId[] = [
  'business_identity',
  'trades_services',
  'profile_trust',
  'payout_setup',
  'activation',
]

// ── Per-step completion checks ───────────────────────────────────────────────

function isBusinessIdentityComplete(profile: CraftsmanBusinessProfile): boolean {
  return (
    !!(profile.businessName ?? '').trim() &&
    !!(profile.handle ?? '').trim() &&
    !!(profile.location ?? '').trim()
  )
}

function isTradesServicesComplete(profile: CraftsmanBusinessProfile): boolean {
  return profile.tradeCategories.length > 0
}

function isProfileTrustComplete(profile: CraftsmanBusinessProfile): boolean {
  return !!(profile.avatarUrl ?? '').trim() && !!(profile.bio ?? '').trim()
}

function isPayoutSetupComplete(payoutAccount: ProviderPayoutAccount | null): boolean {
  return derivePayoutReadinessStatus(payoutAccount) === 'payout_ready'
}

function isActivationComplete(
  profile: CraftsmanBusinessProfile,
): boolean {
  return (
    profile.onboardingCompleted &&
    isBusinessIdentityComplete(profile) &&
    isTradesServicesComplete(profile) &&
    isProfileTrustComplete(profile)
  )
}

/** Builds a completion map for all stages. */
function buildCompletionMap(
  profile: CraftsmanBusinessProfile,
  payoutAccount: ProviderPayoutAccount | null,
): Map<OnboardingStageId, boolean> {
  return new Map<OnboardingStageId, boolean>([
    ['business_identity', isBusinessIdentityComplete(profile)],
    ['trades_services', isTradesServicesComplete(profile)],
    ['profile_trust', isProfileTrustComplete(profile)],
    ['payout_setup', isPayoutSetupComplete(payoutAccount)],
    ['activation', isActivationComplete(profile)],
  ])
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Derives a structured onboarding progress model.
 *
 * Pure function — reads from profile and payoutAccount only, no side effects.
 *
 * When `profile` is null, all steps are returned as incomplete (no-profile state).
 */
export function deriveOnboardingProgress(
  profile: CraftsmanBusinessProfile | null,
  payoutAccount: ProviderPayoutAccount | null,
): OnboardingProgress {
  if (!profile) {
    const steps: OnboardingStep[] = STAGE_ORDER.map((id, index) => ({
      id,
      ...STEP_META[id],
      status: index === 0 ? 'next' : 'incomplete',
    }))
    return {
      steps,
      completedCount: 0,
      totalCount: STAGE_ORDER.length,
      completionPercent: 0,
      isComplete: false,
      nextStep: steps[0] ?? null,
      isDiscoveryBlocked: true,
      isProfileReady: false,
      isPayoutReady: false,
    }
  }

  const completionMap = buildCompletionMap(profile, payoutAccount)

  let nextAssigned = false
  const steps: OnboardingStep[] = STAGE_ORDER.map((id): OnboardingStep => {
    const done = completionMap.get(id) ?? false
    let status: OnboardingStepStatus

    if (done) {
      status = 'complete'
    } else if (!nextAssigned) {
      status = 'next'
      nextAssigned = true
    } else {
      status = 'incomplete'
    }

    return { id, ...STEP_META[id], status }
  })

  const completedCount = steps.filter((s) => s.status === 'complete').length
  const totalCount = STAGE_ORDER.length
  const completionPercent = Math.round((completedCount / totalCount) * 100)
  const isComplete = completedCount === totalCount
  const nextStep = steps.find((s) => s.status === 'next') ?? null
  const profileReady = isActivationComplete(profile)
  const payoutReady = isPayoutSetupComplete(payoutAccount)
  const isDiscoveryBlocked = !profileReady

  return {
    steps,
    completedCount,
    totalCount,
    completionPercent,
    isComplete,
    nextStep,
    isDiscoveryBlocked,
    isProfileReady: profileReady,
    isPayoutReady: payoutReady,
  }
}

/**
 * Returns only the onboarding steps that are not yet complete.
 * Pure function.
 */
export function getMissingOnboardingSteps(
  profile: CraftsmanBusinessProfile | null,
  payoutAccount: ProviderPayoutAccount | null,
): OnboardingStep[] {
  return deriveOnboardingProgress(profile, payoutAccount).steps.filter(
    (s) => s.status !== 'complete',
  )
}

/**
 * Returns the first incomplete onboarding step (the recommended next action),
 * or null when the provider has completed all steps.
 * Pure function.
 */
export function getNextOnboardingStep(
  profile: CraftsmanBusinessProfile | null,
  payoutAccount: ProviderPayoutAccount | null,
): OnboardingStep | null {
  return deriveOnboardingProgress(profile, payoutAccount).nextStep
}

/**
 * Returns true when the provider's profile basics are complete and the
 * craftsman is eligible to appear in customer discovery.
 *
 * Stripe/payout readiness is NOT required for discovery — only for
 * payment-critical actions (sending paid offers, requesting deposits, etc.).
 *
 * Pure function.
 */
export function isProviderReadyForDiscovery(
  profile: CraftsmanBusinessProfile | null,
  payoutAccount: ProviderPayoutAccount | null,
): boolean {
  return !deriveOnboardingProgress(profile, payoutAccount).isDiscoveryBlocked
}
