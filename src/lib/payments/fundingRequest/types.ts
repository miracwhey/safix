/**
 * Funding Request — Core Types
 *
 * Persistent object representing a funding request / payment card.
 * Created when a craftsman sends a funding request after an offer is accepted.
 *
 * This is NOT a loose UI card — it is a real persisted entity tied to:
 *   - source_offer_id (the accepted quote)
 *   - job_id (the created job)
 *   - escrow_plan_id (the escrow payment plan)
 *   - provider/customer user IDs
 *   - thread/conversation linkage
 *
 * The craftsman-side payment/funding card drives the customer into the
 * correct funding flow. This entity is the persistent basis for that card.
 */

import type { EntityId, TimestampMs } from '../../shared/coreTypes.js'

// ── Funding Request Status ────────────────────────────────────────────────

export type FundingRequestStatus =
  | 'created'           // Request object created
  | 'sent'              // Sent to customer (visible in thread)
  | 'funding_started'   // Customer started the funding flow
  | 'funding_initiated' // Stripe payment initiated, awaiting confirmation
  | 'funded'            // Customer completed funding (confirmed by server)
  | 'funding_failed'    // Funding attempt failed (retryable)
  | 'expired'           // Request expired without funding
  | 'cancelled'         // Request was cancelled

// ── Funding Request Type ──────────────────────────────────────────────────

export type FundingRequestType =
  | 'full_escrow'     // V1: customer funds 100% upfront into escrow

// ── Funding Request Entity ────────────────────────────────────────────────

export type FundingRequest = {
  /** Unique funding request identifier. */
  id: EntityId
  /** The accepted offer that this funding request derives from. */
  sourceOfferId: EntityId
  /** The job associated with this funding request. */
  jobId: EntityId
  /** The escrow payment plan this request funds. */
  escrowPlanId: EntityId
  /** Supabase user_id of the customer who must fund. */
  customerUserId: string
  /** Canonical providers.id (DB UUID) of the provider counterparty. Required by live schema. */
  providerId: string
  /** Supabase user_id of the provider who created the request. */
  providerUserId: string
  /** Type of funding request. */
  type: FundingRequestType
  /** Current lifecycle status. */
  status: FundingRequestStatus
  /** The amount to be funded (from the escrow plan). */
  amount: number
  /** Currency code. */
  currency: string
  /** Who created this request (always 'provider' in V1). */
  createdBy: 'provider' | 'system'
  /** Optional conversation/thread ID for message linkage. */
  conversationId?: string
  /** Optional message ID within the conversation. */
  messageId?: string
  /** Unix timestamp (ms) when the request was created. */
  createdAt: TimestampMs
  /** Unix timestamp (ms) of the last status change. */
  updatedAt: TimestampMs
  /** Unix timestamp (ms) when sent to customer. */
  sentAt?: TimestampMs
  /** Unix timestamp (ms) after which this request expires if not funded. */
  expiresAt?: TimestampMs
  /** Unix timestamp (ms) when funding was completed. */
  fundedAt?: TimestampMs
  /** External payment reference (e.g. Stripe PaymentIntent ID). */
  externalFundingRef?: string
  /** Idempotency key for the funding transaction. */
  fundingIdempotencyKey?: string
  /** Reason for failure (when status is 'funding_failed'). */
  failureReason?: string
}
