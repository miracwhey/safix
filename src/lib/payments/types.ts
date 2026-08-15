import type {
  EntityId,
  PaymentState as CorePaymentState,
  TimestampMs,
} from '../shared/coreTypes.js'

export type PaymentState = CorePaymentState

export type PaymentAmounts = {
  totalAmount: number
  depositAmount: number
  finalAmount: number
}

export type Payment = {
  id: EntityId
  jobId: EntityId
  /** Synthetic project identifier linked to the job. */
  projectId?: EntityId
  /** Supabase user_id of the customer who owns the job. */
  customerUserId?: string
  /** Supabase user_id of the craftsman executing the job. */
  craftsmanUserId?: string
  /** Offer ID that created this payment/job path, when applicable. */
  offerId?: string
  state: PaymentState
  amounts: PaymentAmounts
  providerRef?: string
  /**
   * PaymentIntent client_secret from the payment provider.
   * Used by the customer-facing deposit card to complete payment
   * via Stripe.js / Payment Element.  Never exposed beyond the
   * customer's own session.
   */
  clientSecret?: string
  /**
   * Actual EUR amount confirmed refunded by Stripe (charge.amount_refunded / 100).
   * NULL until the payment reaches 'refunded' state.
   * Distinguishes partial from full refunds; full refunds equal totalAmount.
   */
  refundedAmount?: number
  createdAt: TimestampMs
  updatedAt: TimestampMs
}
