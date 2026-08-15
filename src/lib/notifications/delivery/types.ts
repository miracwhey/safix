/**
 * Notification delivery types.
 *
 * These types describe the payload sent from client-side workflows to the
 * server-side /api/send-notification-email endpoint, and the result returned.
 */

/**
 * Runtime-checkable list of all valid notification delivery types.
 * Used for server-side input validation in the API handler and as the
 * single source of truth for the `NotificationDeliveryType` union.
 */
export const VALID_DELIVERY_TYPES = [
  'proposal_received',
  'schedule_created',
  'schedule_updated',
  'work_completed',
  'payment_release_requested',
  'dispute_opened',
  'dispute_evidence_requested',
  // Block 3 — payment/payout trust corridor
  'escrow_locked',
  'payment_released',
  'payout_handoff_initiated',
  'payout_completed',
  'payout_failed',
  // Block P · Run 2 — T+80 dispute-default-cut (provisional default refund)
  'dispute_default_refund_applied',
] as const

export type NotificationDeliveryType = typeof VALID_DELIVERY_TYPES[number]

export type NotificationDeliveryRecipientRole = 'customer' | 'craftsman'

export type NotificationDeliveryPayload = {
  type: NotificationDeliveryType
  jobId: string
  recipientUserId: string
  recipientRole: NotificationDeliveryRecipientRole
  /** Optional context for richer email content */
  context?: Record<string, unknown>
}

export type DeliveryResult = {
  success: boolean
  error?: string
}
