/**
 * Provider Payment Readiness — Unified Readiness Model
 *
 * Combines provider profile readiness with Stripe Connect payout readiness
 * into a single queryable model that surfaces structured blocking/warning
 * reasons for all app surfaces.
 *
 * Key distinctions (non-negotiable product rule):
 *   - Operational readiness (quote sending, chat, requests) does NOT require Stripe Connect
 *   - Payout readiness (receiving released money) DOES require full Stripe Connect
 *
 * This module is the single source of truth for "is this provider payment-ready?"
 * and "what specific capability is missing?"
 */

import type { ProviderPayoutAccount, PayoutReadinessStatus } from './types'
import { derivePayoutReadinessStatus } from './selectors'

// ── Readiness Assessment ──────────────────────────────────────────────────

export type ProviderPaymentReadiness = {
  /** Does this provider have a Stripe Connect account created? */
  hasStripeAccount: boolean
  /** Is Stripe Connect onboarding complete? */
  isOnboardingComplete: boolean
  /** Are charges enabled on the Stripe Connect account? */
  chargesEnabled: boolean
  /** Are payouts enabled on the Stripe Connect account? */
  payoutsEnabled: boolean
  /** Can a charge be collected from a customer for this provider? Requires charges_enabled only. */
  isPaymentReady: boolean
  /** Can the provider receive released payout funds? Requires charges_enabled AND payouts_enabled. */
  isPayoutReady: boolean
  /** Derived payout readiness status label. */
  payoutStatus: PayoutReadinessStatus
  /** Structured list of unresolved requirements. */
  missingRequirements: string[]
  /** Warning/blocking reason the UI should display, or null if fully ready. */
  blockingReason: ProviderBlockingReason | null
}

export type ProviderBlockingReason = {
  /** Machine-readable code for UI branching. */
  code: ProviderBlockingCode
  /** Human-readable explanation (German). */
  message: string
  /** What severity level should the UI show? */
  severity: 'info' | 'warning' | 'error'
}

export type ProviderBlockingCode =
  | 'no_stripe_account'
  | 'onboarding_incomplete'
  | 'charges_disabled'
  | 'payouts_disabled'
  | 'payout_blocked'

// ── Core Derivation ───────────────────────────────────────────────────────

/**
 * Derives a comprehensive payment readiness assessment from a provider's
 * payout account state.
 *
 * When account is null, the provider has no Stripe Connect account at all.
 * Operational capabilities (sending quotes, chatting, receiving requests)
 * are NEVER gated by this readiness — only payout/release flows are.
 */
export function deriveProviderPaymentReadiness(
  account: ProviderPayoutAccount | null
): ProviderPaymentReadiness {
  const payoutStatus = derivePayoutReadinessStatus(account)

  if (!account || !account.stripeConnectAccountId) {
    return {
      hasStripeAccount: false,
      isOnboardingComplete: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      isPaymentReady: false,
      isPayoutReady: false,
      payoutStatus,
      missingRequirements: ['Stripe-Konto erstellen', 'Onboarding abschließen'],
      blockingReason: {
        code: 'no_stripe_account',
        message: 'Kein Auszahlungskonto verknüpft. Bitte richte dein Stripe-Konto ein, um Auszahlungen zu erhalten.',
        severity: 'warning',
      },
    }
  }

  const missingRequirements: string[] = []
  if (!account.chargesEnabled) missingRequirements.push('Zahlungsannahme aktivieren')
  if (!account.payoutsEnabled) missingRequirements.push('Auszahlungen aktivieren')
  if (account.onboardingStatus !== 'onboarding_complete') {
    missingRequirements.push('Onboarding abschließen')
  }
  if (account.requirementsDue) {
    missingRequirements.push(...account.requirementsDue.split(',').map((r) => r.trim()).filter(Boolean))
  }

  const isOnboardingComplete = account.onboardingStatus === 'onboarding_complete'
  const chargesEnabled = account.chargesEnabled
  const payoutsEnabled = account.payoutsEnabled
  // isPaymentReady: can a charge be collected from a customer? Requires charges_enabled.
  // isPayoutReady:  can the provider receive released funds? Requires both flags.
  // Note: the payment initiation APIs (create-escrow, initiate-funding) enforce
  // the full gate (both flags) independently — they do not read isPaymentReady.
  const isPaymentReady = chargesEnabled
  const isPayoutReady = chargesEnabled && payoutsEnabled

  let blockingReason: ProviderBlockingReason | null = null
  if (account.onboardingStatus === 'payout_blocked') {
    blockingReason = {
      code: 'payout_blocked',
      message: 'Auszahlungen sind gesperrt. Bitte kontaktiere den Support oder prüfe dein Stripe-Konto.',
      severity: 'error',
    }
  } else if (!isPayoutReady) {
    if (account.onboardingStatus === 'pending_verification') {
      blockingReason = {
        code: 'onboarding_incomplete',
        message: 'Verifizierung läuft — deine Daten werden von Stripe geprüft. Dies dauert in der Regel 1–2 Werktage.',
        severity: 'info',
      }
    } else if (!chargesEnabled && !payoutsEnabled) {
      blockingReason = {
        code: 'onboarding_incomplete',
        message: 'Stripe-Onboarding nicht abgeschlossen. Bitte schließe die Einrichtung ab, um Auszahlungen zu erhalten.',
        severity: 'warning',
      }
    } else if (!chargesEnabled) {
      blockingReason = {
        code: 'charges_disabled',
        message: 'Zahlungsannahme noch nicht aktiviert. Bitte schließe das Stripe-Onboarding ab.',
        severity: 'warning',
      }
    } else if (!payoutsEnabled) {
      blockingReason = {
        code: 'payouts_disabled',
        message: 'Auszahlungen noch nicht aktiviert. Bitte schließe die Stripe-Einrichtung ab.',
        severity: 'warning',
      }
    }
  }

  return {
    hasStripeAccount: true,
    isOnboardingComplete,
    chargesEnabled,
    payoutsEnabled,
    isPaymentReady,
    isPayoutReady,
    payoutStatus,
    missingRequirements,
    blockingReason,
  }
}

/**
 * Convenience: is the provider fully payout-ready?
 * Equivalent to `deriveProviderPaymentReadiness(account).isPayoutReady`.
 */
export function isProviderPayoutReady(account: ProviderPayoutAccount | null): boolean {
  return deriveProviderPaymentReadiness(account).isPayoutReady
}
