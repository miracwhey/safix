/**
 * Payment Gating Rules — Product Decision Matrix
 *
 * Defines the canonical gating rules for what a provider/customer CAN and
 * CANNOT do based on provider Stripe Connect readiness.
 *
 * NON-NEGOTIABLE RULES:
 *   Without Stripe Connect completed, a provider MAY:
 *     - be visible, receive requests, chat, send quotes
 *     - trigger/send the funding request card
 *
 *   Without Stripe Connect completed, a provider may NOT:
 *     - receive payout
 *     - complete payout-relevant release flow
 *     - appear payout-ready
 *
 *   A customer MAY always:
 *     - accept a quote
 *     - see funding request / readiness
 *     - proceed into the funding flow (platform-side collection)
 *
 * The app MUST clearly distinguish:
 *     - funding allowed
 *     - payout blocked
 *     - release blocked due to payout readiness
 *
 * Do NOT collapse these into one vague "payments not set up" state.
 */

import type { ProviderPayoutAccount } from './types'
import { deriveProviderPaymentReadiness } from './providerPaymentReadiness'

// ── Gating Result Types ───────────────────────────────────────────────────

export type GatingDecision = {
  /** Whether the action is allowed. */
  allowed: boolean
  /** Machine-readable reason code when blocked. */
  reason: GatingReason | null
  /** Human-readable explanation (German). */
  explanation: string
}

export type GatingReason =
  | 'allowed'
  | 'payout_not_ready'
  | 'charges_not_enabled'
  | 'no_stripe_account'
  | 'payout_blocked'

// ── Provider Operational Capabilities (NOT gated by Stripe) ───────────────

/**
 * Provider can always receive requests, regardless of Stripe Connect status.
 */
export function canProviderReceiveRequests(_account: ProviderPayoutAccount | null): GatingDecision {
  return { allowed: true, reason: null, explanation: 'Anfragen empfangen — keine Stripe-Einrichtung erforderlich.' }
}

/**
 * Provider can always chat, regardless of Stripe Connect status.
 */
export function canProviderChat(_account: ProviderPayoutAccount | null): GatingDecision {
  return { allowed: true, reason: null, explanation: 'Chat verfügbar — keine Stripe-Einrichtung erforderlich.' }
}

/**
 * Provider can always send quotes, regardless of Stripe Connect status.
 * This is a NON-NEGOTIABLE product rule.
 */
export function canProviderSendQuote(_account: ProviderPayoutAccount | null): GatingDecision {
  return { allowed: true, reason: null, explanation: 'Angebot senden — keine Stripe-Einrichtung erforderlich.' }
}

/**
 * Provider can always view jobs, regardless of Stripe Connect status.
 */
export function canProviderViewJobs(_account: ProviderPayoutAccount | null): GatingDecision {
  return { allowed: true, reason: null, explanation: 'Aufträge anzeigen — keine Stripe-Einrichtung erforderlich.' }
}

/**
 * Provider can always trigger/send the funding step card,
 * regardless of Stripe Connect status.
 */
export function canProviderTriggerFundingStep(_account: ProviderPayoutAccount | null): GatingDecision {
  return { allowed: true, reason: null, explanation: 'Zahlungsaufforderung senden — keine Stripe-Einrichtung erforderlich.' }
}

// ── Customer Capabilities (NOT gated by provider Stripe) ──────────────────

/**
 * Customer can always accept a quote, regardless of provider Stripe status.
 */
export function canCustomerAcceptQuote(_providerAccount: ProviderPayoutAccount | null): GatingDecision {
  return { allowed: true, reason: null, explanation: 'Angebot annehmen — immer möglich.' }
}

/**
 * Customer can always see the funding request and proceed into the
 * funding flow. Funding is platform-side collection.
 */
export function canCustomerFund(_providerAccount: ProviderPayoutAccount | null): GatingDecision {
  return { allowed: true, reason: null, explanation: 'Zahlung — immer möglich (Plattform-Einzug).' }
}

// ── Payout-Gated Capabilities (BLOCKED without Stripe Connect) ────────────

/**
 * Provider can only receive payout when fully payout-ready.
 */
export function canProviderReceivePayout(account: ProviderPayoutAccount | null): GatingDecision {
  const readiness = deriveProviderPaymentReadiness(account)
  if (readiness.isPayoutReady) {
    return { allowed: true, reason: null, explanation: 'Auszahlung möglich — Stripe-Konto vollständig eingerichtet.' }
  }

  return {
    allowed: false,
    reason: readiness.blockingReason?.code === 'payout_blocked' ? 'payout_blocked' : 'payout_not_ready',
    explanation: readiness.blockingReason?.message ?? 'Auszahlung nicht möglich — Stripe-Einrichtung unvollständig.',
  }
}

/**
 * Release completion is blocked when provider cannot receive payout.
 * This prevents funds from being released to a provider who cannot receive them.
 */
export function canCompleteRelease(account: ProviderPayoutAccount | null): GatingDecision {
  const readiness = deriveProviderPaymentReadiness(account)
  if (readiness.isPayoutReady) {
    return { allowed: true, reason: null, explanation: 'Freigabe möglich — Auszahlungskonto bereit.' }
  }

  return {
    allowed: false,
    reason: readiness.blockingReason?.code === 'payout_blocked' ? 'payout_blocked' : 'payout_not_ready',
    explanation: 'Freigabe blockiert — Auszahlungskonto des Betriebs ist nicht bereit. Auszahlung erst nach vollständiger Stripe-Einrichtung.',
  }
}

// ── Composite State Summary ───────────────────────────────────────────────

export type PaymentGatingSummary = {
  /** Funding is always allowed (platform-side collection). */
  fundingAllowed: boolean
  /** Payout is blocked when provider Stripe Connect is incomplete. */
  payoutBlocked: boolean
  /** Release is blocked when provider cannot receive payout. */
  releaseBlocked: boolean
  /** The specific payout blocking reason, or null. */
  payoutBlockReason: GatingDecision | null
  /** The specific release blocking reason, or null. */
  releaseBlockReason: GatingDecision | null
}

/**
 * Returns a composite summary of gating states.
 *
 * The app must clearly distinguish:
 *   - funding allowed
 *   - payout blocked
 *   - release blocked due to payout readiness
 *
 * NOT one vague "payments not set up" state.
 */
export function derivePaymentGatingSummary(
  providerAccount: ProviderPayoutAccount | null
): PaymentGatingSummary {
  const payoutDecision = canProviderReceivePayout(providerAccount)
  const releaseDecision = canCompleteRelease(providerAccount)

  return {
    fundingAllowed: true,
    payoutBlocked: !payoutDecision.allowed,
    releaseBlocked: !releaseDecision.allowed,
    payoutBlockReason: payoutDecision.allowed ? null : payoutDecision,
    releaseBlockReason: releaseDecision.allowed ? null : releaseDecision,
  }
}
