import type { PaymentState } from '../types.js'

/**
 * Stripe-side snapshot of a payment's reality.
 * Sourced from a Stripe PaymentIntent object.
 */
export type StripePaymentSnapshot = {
  paymentIntentId: string
  /** Stripe PaymentIntent status string */
  stripeStatus: string
  /** Amount in minor units (cents) */
  amountCapturable?: number
  amountReceived?: number
  currency?: string
  /** ISO timestamp of last Stripe update */
  stripeUpdatedAt?: string
}

/**
 * Result of comparing DB payment state to Stripe reality.
 *
 * - aligned: DB and Stripe are consistent, no action needed
 * - recoverable: DB is behind Stripe; a safe state advance is available
 * - inconsistent: Mismatch is detected but cannot be auto-resolved safely
 * - no_provider_ref: Payment has no providerRef (Stripe not involved yet)
 * - not_found: Payment not found in DB
 */
export type ReconciliationStatus =
  | 'aligned'
  | 'recoverable'
  | 'inconsistent'
  | 'no_provider_ref'
  | 'not_found'

export type ReconciliationResult = {
  paymentId: string
  jobId: string
  status: ReconciliationStatus
  /** Current DB state */
  dbState: PaymentState
  /** Stripe-derived recommended state if status === 'recoverable' */
  recommendedState?: PaymentState
  /** Human-readable note about what was found/done */
  note: string
  /** ISO timestamp of when reconciliation ran */
  reconciledAt: string
}
