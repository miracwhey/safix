import type { Payment } from '../types.js'
import type { PaymentState } from '../types.js'
import type { StripePaymentSnapshot, ReconciliationResult } from './types.js'

/**
 * Provider-authoritative recovery transition sets.
 *
 * These are intentionally broader than the normal client-side state machine
 * (stateMachine.ts) because provider truth may be ahead of DB truth — the
 * recovery path must be able to skip intermediate states.
 *
 * Mirrors the canonical sets in api/_providerRecoveryTransitions.ts.
 * Inlined here to avoid a cross-module import from src/ → api/.
 *
 * 'disputed' is deliberately excluded: a disputed payment may only be exited
 * through the dispute-resolution workflow (stateMachine.ts), never by
 * provider-authoritative auto-recovery.  disputed × succeeded/canceled falls
 * into the 'inconsistent' branch below (manual review required).
 */
const PROVIDER_RECOVERY_TO_RELEASED = new Set([
  'deposit_paid',
  'in_escrow',
  'work_in_progress',
  'release_pending',
])

const PROVIDER_RECOVERY_TO_REFUNDED = new Set([
  'deposit_paid',
  'in_escrow',
  'work_in_progress',
  'release_pending',
])

function canRecoverTo(from: string, to: 'released' | 'refunded'): boolean {
  if (to === 'released') return PROVIDER_RECOVERY_TO_RELEASED.has(from)
  if (to === 'refunded') return PROVIDER_RECOVERY_TO_REFUNDED.has(from)
  return false
}

/**
 * Maps a Stripe PaymentIntent status to the closest SaFix PaymentState.
 *
 * Stripe statuses:
 * - requires_payment_method: initial, payment not yet submitted
 * - requires_confirmation: customer action needed
 * - requires_action: 3DS / redirect required
 * - processing: payment being processed
 * - requires_capture: funds authorized, waiting capture (our manual hold state)
 * - succeeded: captured / released
 * - canceled: cancelled by user or system
 *
 * Mapping rules:
 * - requires_capture → 'deposit_paid' (funds on hold, DB should be at least deposit_paid)
 * - succeeded → 'released' (Stripe captured = payment released in SaFix)
 * - canceled → 'refunded' (Stripe cancelled = refunded in SaFix)
 * - anything else → null (no direct mapping, cannot recommend)
 */
export function stripeStatusToPaymentState(stripeStatus: string): PaymentState | null {
  switch (stripeStatus) {
    case 'requires_capture':
      return 'deposit_paid'
    case 'succeeded':
      return 'released'
    case 'canceled':
      return 'refunded'
    default:
      return null
  }
}

/**
 * Pure function: compares DB payment state vs Stripe snapshot and derives
 * a reconciliation result.
 *
 * Does NOT mutate state. Does NOT call Stripe. Does NOT log.
 */
export function derivePaymentReconciliationStatus(
  payment: Payment,
  stripe: StripePaymentSnapshot,
): ReconciliationResult {
  const reconciledAt = new Date().toISOString()
  const recommendedState = stripeStatusToPaymentState(stripe.stripeStatus)

  // Already in a terminal state that matches Stripe
  if (
    (payment.state === 'released' && stripe.stripeStatus === 'succeeded') ||
    (payment.state === 'refunded' && stripe.stripeStatus === 'canceled')
  ) {
    return {
      paymentId: payment.id,
      jobId: payment.jobId,
      status: 'aligned',
      dbState: payment.state,
      note: `DB state '${payment.state}' matches Stripe status '${stripe.stripeStatus}'.`,
      reconciledAt,
    }
  }

  // DB is already in the recommended state
  if (recommendedState !== null && payment.state === recommendedState) {
    return {
      paymentId: payment.id,
      jobId: payment.jobId,
      status: 'aligned',
      dbState: payment.state,
      note: `DB state '${payment.state}' is already consistent with Stripe status '${stripe.stripeStatus}'.`,
      reconciledAt,
    }
  }

  // DB is terminal but Stripe says something different — cannot auto-recover
  if (payment.state === 'released' || payment.state === 'refunded') {
    return {
      paymentId: payment.id,
      jobId: payment.jobId,
      status: 'inconsistent',
      dbState: payment.state,
      note: `DB state '${payment.state}' is terminal but Stripe reports '${stripe.stripeStatus}'. Manual review required.`,
      reconciledAt,
    }
  }

  // Stripe says requires_capture but DB is still at deposit_required
  // → DB missed the deposit_paid transition
  if (stripe.stripeStatus === 'requires_capture' && payment.state === 'deposit_required') {
    return {
      paymentId: payment.id,
      jobId: payment.jobId,
      status: 'recoverable',
      dbState: payment.state,
      recommendedState: 'deposit_paid',
      note: `DB is at 'deposit_required' but Stripe reports 'requires_capture'. Can safely advance to 'deposit_paid'.`,
      reconciledAt,
    }
  }

  // Stripe says succeeded (released) and DB has a valid recovery path to released
  if (stripe.stripeStatus === 'succeeded' && recommendedState === 'released') {
    if (canRecoverTo(payment.state, 'released')) {
      return {
        paymentId: payment.id,
        jobId: payment.jobId,
        status: 'recoverable',
        dbState: payment.state,
        recommendedState: 'released',
        note: `DB is at '${payment.state}' but Stripe reports 'succeeded'. Can safely advance to 'released'.`,
        reconciledAt,
      }
    }
    // DB is not in a state that can directly transition to released
    return {
      paymentId: payment.id,
      jobId: payment.jobId,
      status: 'inconsistent',
      dbState: payment.state,
      note: `DB is at '${payment.state}' but Stripe reports 'succeeded'. Cannot directly transition to 'released' — manual review required.`,
      reconciledAt,
    }
  }

  // Stripe says canceled (refunded) and DB has a valid recovery path to refunded
  if (stripe.stripeStatus === 'canceled' && recommendedState === 'refunded') {
    if (canRecoverTo(payment.state, 'refunded')) {
      return {
        paymentId: payment.id,
        jobId: payment.jobId,
        status: 'recoverable',
        dbState: payment.state,
        recommendedState: 'refunded',
        note: `DB is at '${payment.state}' but Stripe reports 'canceled'. Can safely advance to 'refunded'.`,
        reconciledAt,
      }
    }
    return {
      paymentId: payment.id,
      jobId: payment.jobId,
      status: 'inconsistent',
      dbState: payment.state,
      note: `DB is at '${payment.state}' but Stripe reports 'canceled'. Cannot directly transition to 'refunded' — manual review required.`,
      reconciledAt,
    }
  }

  // No clear Stripe→DB mapping available
  return {
    paymentId: payment.id,
    jobId: payment.jobId,
    status: 'inconsistent',
    dbState: payment.state,
    note: `DB is at '${payment.state}' but Stripe reports '${stripe.stripeStatus}'. No safe auto-recovery path.`,
    reconciledAt,
  }
}
