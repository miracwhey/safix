/**
 * Escrow Payment Plan — Core Types
 *
 * Persistent payment plan model for SaFix V1 escrow:
 * - Customer funds 100% of accepted quote into escrow
 * - 25% released on work start (deposit_release)
 * - 75% released on work completion (final_release)
 *
 * These types are the persistent basis for the entire escrow lifecycle.
 * They survive reload, multi-device access, and webhook timing.
 */

import type { EntityId, TimestampMs, CurrencyCode } from '../../shared/coreTypes.js'

// ── Escrow Payment Plan Status ────────────────────────────────────────────

/**
 * Lifecycle states for an escrow payment plan.
 *
 * Forward-compatible: supports dispute, refund, and cancellation flows
 * that will be implemented in later packages.
 */
export type EscrowPlanStatus =
  | 'awaiting_customer_funding'
  | 'funding_initiated'
  | 'funded_in_escrow'
  | 'partially_released'
  | 'fully_released'
  | 'funding_failed'
  | 'disputed'
  | 'refunded'
  | 'cancelled'

// ── Escrow Tranche Status ─────────────────────────────────────────────────

/**
 * Lifecycle states for individual escrow tranches/installments.
 *
 * Forward-compatible: supports blocking, dispute holds, and refund
 * flows that will be implemented in later packages.
 */
export type EscrowTrancheStatus =
  | 'pending_funding'
  | 'funded'
  | 'locked'
  | 'eligible_for_release'
  | 'release_pending'
  | 'released'
  | 'blocked'
  | 'disputed'
  | 'refunded'
  | 'cancelled'

// ── Tranche Kind ──────────────────────────────────────────────────────────

/** V1 has exactly two release stages. */
export type EscrowTrancheKind = 'deposit_release' | 'final_release'

/** What event triggers release eligibility for a tranche. */
export type EscrowReleaseTrigger = 'work_started' | 'work_completed'

// ── Funding / Release Model Constants ─────────────────────────────────────

/** Customer pays 100% upfront into escrow. */
export type EscrowFundingMode = 'full_upfront_escrow'

/** V1 release model: 25% on work start, 75% on work completion. */
export type EscrowReleaseModel = 'start_25_completion_75'

// ── Execution Actor ───────────────────────────────────────────────────────

/** Who is authorized to trigger a given execution transition. */
export type EscrowActor = 'customer' | 'provider' | 'system'

// ── Escrow Payment Plan ───────────────────────────────────────────────────

/**
 * Persisted escrow payment plan, created when a quote is accepted.
 *
 * Links accepted quote → job → payment and serves as the single source
 * of truth for the contractual payment arrangement.
 */
export type EscrowPaymentPlan = {
  /** Unique plan identifier. */
  id: EntityId
  /** The accepted offer that created this plan (source of truth for amount). */
  sourceOfferId: EntityId
  /** The job created from the accepted offer. */
  jobId: EntityId
  /** Supabase user_id of the customer funding the escrow. */
  customerUserId: string
  /** providers.id (DB UUID) of the craftsman counterparty. */
  providerId: string
  /** Currency for all monetary values in this plan. */
  currency: CurrencyCode
  /** Total contract amount from the accepted quote (in minor units / euros). */
  totalAmount: number
  /** How the customer funds the escrow. */
  fundingMode: EscrowFundingMode
  /** How escrowed funds are released to the craftsman. */
  releaseModel: EscrowReleaseModel
  /** Current lifecycle status of the plan. */
  status: EscrowPlanStatus
  /** Unix timestamp (ms) when the plan was created. */
  createdAt: TimestampMs
  /** Unix timestamp (ms) of the last status or data change. */
  updatedAt: TimestampMs
  /** Unix timestamp (ms) when customer initiated funding (Stripe checkout, etc.). */
  fundingInitiatedAt?: TimestampMs
  /** Unix timestamp (ms) when full escrow funding was confirmed. */
  fundedAt?: TimestampMs
  /** External payment provider reference (e.g. Stripe PaymentIntent ID). */
  externalFundingRef?: string
  /** Idempotency key for the funding transaction. */
  fundingIdempotencyKey?: string
  /** Platform fee rate locked at funding time (e.g. 0.05 or 0.09). */
  platformFeeRate?: number
  /** Platform fee amount locked at funding time. */
  platformFeeAmount?: number
  /** Commercial origin snapshot from the job, locked at funding time. */
  commercialOrigin?: string
}

// ── Escrow Tranche / Installment ──────────────────────────────────────────

/**
 * A single release tranche/installment within an escrow payment plan.
 *
 * V1 creates exactly two tranches per plan:
 *   1. deposit_release  — 25% — released when work starts
 *   2. final_release    — 75% — released when work completes
 */
export type EscrowTranche = {
  /** Unique tranche identifier. */
  id: EntityId
  /** The escrow plan this tranche belongs to. */
  planId: EntityId
  /** What kind of release this tranche represents. */
  kind: EscrowTrancheKind
  /** Percentage of the total plan amount. */
  percentage: number
  /** Absolute amount for this tranche (in same units as plan totalAmount). */
  amount: number
  /** Event that makes this tranche eligible for release. */
  releaseTrigger: EscrowReleaseTrigger
  /** Current lifecycle status of this tranche. */
  status: EscrowTrancheStatus
  /** Unix timestamp (ms) when the tranche was created. */
  createdAt: TimestampMs
  /** Unix timestamp (ms) of the last status change. */
  updatedAt: TimestampMs
  /** Unix timestamp (ms) when the tranche became eligible for release. */
  eligibleAt?: TimestampMs
  /** Unix timestamp (ms) when funds were actually released. */
  releasedAt?: TimestampMs
  /** External release reference (e.g. Stripe Transfer ID). */
  externalReleaseRef?: string
  /**
   * Set when the Stripe Transfer recorded in externalReleaseRef was subsequently
   * reversed. Presence means money returned to the platform; the tranche must NOT
   * be counted as released until a new transfer is issued and recorded.
   */
  transferReversalRef?: string
  /** Who triggered the release eligibility (for audit trail). */
  triggeredBy?: EscrowActor
  /** Who performed the release action (for audit trail). */
  releasedBy?: EscrowActor
}
