/**
 * Supplementary Payment Request — Domain Types
 *
 * A SupplementaryPaymentRequest is created when a ChangeOrder (Nachtrag) is
 * accepted but the original payment amounts are already locked (deposit paid or
 * beyond).  It represents the additional payment obligation that arises from
 * the accepted cost delta.
 *
 * INVARIANTS:
 *   - Exactly one SupplementaryPaymentRequest per accepted ChangeOrder (idempotent).
 *   - The request is the canonical record for "additional amount owed after lock".
 *   - The original Payment record is never silently mutated; it remains authoritative
 *     for the base amount.  The supplementary request carries the delta truth.
 *   - ChangeOrder remains the causal origin — the request does not exist without it.
 *
 * Status machine:
 *   pending → funding_initiated → funded → released      (platform Stripe path)
 *   pending → acknowledged → funding_initiated → funded → released
 *   pending → acknowledged → paid                        (manual off-platform, V1 path)
 *   pending | acknowledged → waived                      (craftsman waives)
 *
 * Terminal statuses: released, paid, waived.
 * Note: `funded` is NOT terminal — it means money collected but not yet transferred
 * to the craftsman. `released` means the Stripe Transfer was created.
 */

import type { EntityId, TimestampMs } from '../../shared/coreTypes.js'

// ── Status ────────────────────────────────────────────────────────────────────

export type SupplementaryPaymentStatus =
  | 'pending'            // Created; customer not yet informed / acknowledged
  | 'acknowledged'       // Customer has confirmed they are aware of the obligation
  | 'funding_initiated'  // Stripe PaymentIntent created; awaiting payment completion
  | 'funded'             // Stripe payment completed; awaiting transfer to craftsman
  | 'released'           // Net amount transferred to craftsman's Stripe Connect account
  | 'paid'               // Craftsman confirmed receiving the additional payment (manual/off-platform)
  | 'waived'             // Craftsman chose to waive this supplementary amount

// ── Entity ────────────────────────────────────────────────────────────────────

export type SupplementaryPaymentRequest = {
  id: EntityId
  /**
   * The ChangeOrder that triggered this supplementary payment need.
   * Always set; a supplementary request without a ChangeOrder is invalid.
   */
  changeOrderId: EntityId
  /** The Job this supplementary request is linked to (via ChangeOrder). */
  jobId: EntityId
  /**
   * The original locked Payment record.
   * Its amounts are the base; this request carries the delta on top.
   */
  originalPaymentId: EntityId
  /** Supabase user_id of the customer who owes the supplementary amount. */
  customerUserId: string
  /** Supabase user_id of the craftsman who is owed the amount. */
  craftsmanUserId: string
  /**
   * Additional amount in cents (minor units).
   * Derived from ChangeOrder.grossTotal at creation time.
   * Always positive (cost increases only; reductions do not create
   * supplementary payment requests — they reduce the remaining balance).
   */
  amountCents: number
  /** ISO 4217 currency code — always 'EUR' in V1. */
  currency: string
  /** Current lifecycle status. */
  status: SupplementaryPaymentStatus
  /** Unix timestamp (ms) when the customer acknowledged the obligation. */
  acknowledgedAt?: TimestampMs
  /** Unix timestamp (ms) when Stripe PaymentIntent was created. */
  fundingInitiatedAt?: TimestampMs
  /** Unix timestamp (ms) when Stripe payment completed successfully. */
  fundedAt?: TimestampMs
  /** Unix timestamp (ms) when net amount was transferred to craftsman's Connect account. */
  releasedAt?: TimestampMs
  /** Unix timestamp (ms) when the craftsman confirmed payment received (manual path). */
  paidAt?: TimestampMs
  /** Unix timestamp (ms) when the craftsman waived the additional amount. */
  waivedAt?: TimestampMs
  /**
   * External payment reference (Stripe PaymentIntent ID).
   * Populated when initiate-supplementary-funding creates a PI.
   */
  externalRef?: string
  /**
   * External payout reference (Stripe Transfer ID).
   * Populated when the net amount is transferred to the craftsman's Connect account.
   */
  externalPayoutRef?: string
  createdAt: TimestampMs
  updatedAt: TimestampMs
}
