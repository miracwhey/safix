/**
 * ChangeOrder (Nachtrag) domain types.
 *
 * A ChangeOrder is the canonical commercial document for a scope or price
 * change to an existing Job.  It is a first-class domain object, not a
 * loose note, chat message, or UI card.
 *
 * Structural intent:
 *   - A ChangeOrder is similar to an Offer (Angebot) in structure:
 *     it carries a commercial proposition (price, description) and a lifecycle.
 *   - A ChangeOrder differs from an Offer in scope:
 *     an Offer creates a Job; a ChangeOrder modifies an existing Job.
 *   - A ChangeOrder references both the Job it modifies and the original
 *     accepted Offer that the Job was based on, so the delta is always
 *     computable: ChangeOrder.grossTotal - sourceOffer.grossTotal = Δ cost.
 *
 * Lifecycle:
 *   draft → pending → accepted → (Job amount updated, payment amended)
 *                  ↘ declined
 *                  ↘ cancelled
 *
 * INVARIANTS:
 *   - ChangeOrder.jobId → Job.id is the canonical reference direction.
 *   - ChangeOrder.sourceOfferId → Offer.id links back to the original commercial basis.
 *   - A Job may have multiple ChangeOrders (sequential or parallel).
 *   - Only accepted ChangeOrders affect the canonical payment amount.
 *   - Timeline / thread do not own ChangeOrder truth.
 */

import type { EntityId, TimestampMs, CurrencyCode } from '../shared/coreTypes'

// ── Status ───────────────────────────────────────────────────────────────────

export type ChangeOrderStatus =
  | 'draft'      // Created but not yet sent to customer
  | 'pending'    // Sent to customer, awaiting decision
  | 'accepted'   // Customer accepted — job amount and payment are updated
  | 'declined'   // Customer declined — no change to job
  | 'cancelled'  // Withdrawn by craftsman before customer decision

// ── Core Entity ───────────────────────────────────────────────────────────────

export type ChangeOrder = {
  id: EntityId
  /**
   * The Job this ChangeOrder modifies.
   * Always set; a ChangeOrder without a Job reference is invalid.
   */
  jobId: EntityId
  /**
   * The accepted Offer that was the original commercial basis for the Job.
   * Used to compute the cost delta: ChangeOrder.grossTotal - sourceOffer.grossTotal.
   */
  sourceOfferId?: EntityId
  /** Supabase auth.users UUID of the craftsman proposing the change. */
  craftsmanUserId: string
  /** Supabase auth.users UUID of the customer receiving the change proposal. */
  customerUserId: string

  // ── Commercial Terms ─────────────────────────────────────────────────────
  /**
   * Human-readable description of what changed and why.
   * E.g. "Mehrarbeit wegen unerwarteter Feuchtigkeitsschäden hinter Fliesen."
   */
  description: string
  /** Required human-readable price string for the change (e.g. "450 €"). */
  price: string
  /** ISO 4217 currency code — defaults to 'EUR'. */
  currency?: CurrencyCode
  /** Gross total in minor units (cents). */
  grossTotal?: number
  /** Net total in minor units (cents). */
  netTotal?: number
  /** VAT rate as a percentage (e.g. 19). */
  vatRate?: number

  // ── State & Timestamps ───────────────────────────────────────────────────
  status: ChangeOrderStatus
  /** Unix timestamp (ms) when the ChangeOrder was sent to the customer. */
  sentAt?: TimestampMs
  /** Unix timestamp (ms) when the customer accepted the ChangeOrder. */
  acceptedAt?: TimestampMs
  /** Unix timestamp (ms) when the customer declined the ChangeOrder. */
  declinedAt?: TimestampMs
  createdAt: TimestampMs
  updatedAt: TimestampMs
}
