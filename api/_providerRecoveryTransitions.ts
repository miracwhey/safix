/**
 * Unified provider-authoritative recovery transitions.
 *
 * When Stripe (or any external payment provider) reports a terminal state
 * (succeeded, canceled, refunded), it is the canonical truth.  The SaFix
 * internal payment state must converge to that truth via a forward-only
 * recovery transition.
 *
 * These transitions are intentionally broader than the normal client-side
 * state machine (stateMachine.ts → allowedTransitions), because provider-
 * authoritative recovery may need to skip intermediate states that the app
 * missed (e.g. work_in_progress → released when Stripe already captured).
 *
 * SINGLE SOURCE OF TRUTH
 * ----------------------
 * This module is the ONLY place that defines which payment states may be
 * advanced to a provider-confirmed terminal state during:
 *   - Stripe webhook reconciliation  (api/stripe-webhook.ts)
 *   - Server-side cron reconciliation (api/_serverReconciliation.ts)
 *   - Client-side reconciliation      (deriveReconciliationStatus.ts)
 *   - Any future operator/recovery path
 *
 * Do NOT duplicate these sets elsewhere.  Import from here.
 *
 * DESIGN RULES
 * ------------
 * 1. Only non-terminal states may be advanced.  Terminal states (released,
 *    refunded) are never moved by recovery — they are already final.
 *
 * 2. 'deposit_required' is excluded from refund recovery.  If Stripe cancels
 *    a PaymentIntent that was never funded (SaFix still at deposit_required),
 *    there is nothing to refund.  The webhook logs this and skips.
 *
 * 3. 'work_in_progress' is included in both sets.  In normal flow this state
 *    requires an explicit release_pending step, but if provider truth is ahead
 *    (e.g. dashboard capture or delayed webhook), recovery must converge.
 *
 * 4. 'none' is excluded from all recovery transitions.  It is the initial
 *    state before any payment entity exists.
 *
 * 5. 'disputed' is excluded from all recovery transitions — a disputed payment
 *    may only be exited through the dispute-resolution workflow
 *    (stateMachine.ts: disputed → refunded/released), never by
 *    provider-authoritative auto-recovery.  A Stripe capture or refund landing
 *    while a dispute is open must surface as 'invalid_transition' /
 *    'inconsistent' for operator review instead of silently overriding the
 *    running dispute.
 */

/**
 * Non-terminal payment states from which provider-authoritative recovery
 * may advance the payment to 'released' (Stripe status: succeeded / captured).
 */
export const PROVIDER_RECOVERY_TO_RELEASED = new Set([
  'deposit_paid',
  'in_escrow',
  'work_in_progress',
  'release_pending',
])

/**
 * Non-terminal payment states from which provider-authoritative recovery
 * may advance the payment to 'refunded' (Stripe status: canceled / refunded).
 *
 * Excludes 'deposit_required': no funds were ever held, so 'refunded' would
 * be a misleading terminal state.
 */
export const PROVIDER_RECOVERY_TO_REFUNDED = new Set([
  'deposit_paid',
  'in_escrow',
  'work_in_progress',
  'release_pending',
])

export type ProviderRecoveryTarget = 'released' | 'refunded'

/**
 * Returns true when transitioning from `currentState` to `targetState` is
 * permitted by the provider-authoritative recovery model.
 *
 * This replaces both the webhook-specific STATES_ALLOWING_* sets and the
 * client-side canTransition() check for Stripe-driven recovery paths.
 */
export function isValidProviderRecoveryTransition(
  currentState: string,
  targetState: ProviderRecoveryTarget,
): boolean {
  if (targetState === 'released') return PROVIDER_RECOVERY_TO_RELEASED.has(currentState)
  if (targetState === 'refunded') return PROVIDER_RECOVERY_TO_REFUNDED.has(currentState)
  return false
}
