/**
 * Pure state-machine helpers for Stripe webhook reconciliation.
 *
 * Extracted from the webhook handler to enable unit testing without
 * requiring HTTP, Stripe SDK, or Supabase.
 *
 * Delegates to the unified provider recovery transition rules defined in
 * _providerRecoveryTransitions.ts — the single source of truth for which
 * payment states may be advanced by a provider-authoritative event.
 */

import {
  PROVIDER_RECOVERY_TO_RELEASED,
  PROVIDER_RECOVERY_TO_REFUNDED,
  isValidProviderRecoveryTransition,
  type ProviderRecoveryTarget,
} from './_providerRecoveryTransitions.js'

export type ReconcileTarget = ProviderRecoveryTarget

/**
 * States from which a payment may be reconciled to 'released'.
 * Re-exported from the unified provider recovery module for backward compat.
 */
export const STATES_ALLOWING_RELEASE = PROVIDER_RECOVERY_TO_RELEASED

/**
 * States from which a payment may be reconciled to 'refunded'.
 * Re-exported from the unified provider recovery module for backward compat.
 */
export const STATES_ALLOWING_REFUND = PROVIDER_RECOVERY_TO_REFUNDED

/**
 * Returns true when transitioning from `currentState` to `targetState` is
 * permitted by the provider-authoritative recovery model.
 *
 * Guards against invalid transitions such as:
 *   released  → deposit_paid   (terminal state may not regress)
 *   refunded  → released       (terminal state may not change)
 *   deposit_required → refunded (no funds held — misleading terminal state)
 */
export function isValidWebhookTransition(
  currentState: string,
  targetState: ReconcileTarget,
): boolean {
  return isValidProviderRecoveryTransition(currentState, targetState)
}
