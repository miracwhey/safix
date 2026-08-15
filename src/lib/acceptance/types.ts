/**
 * Acceptance domain types.
 *
 * An Acceptance (Abnahme) is the canonical record of a customer's formal
 * decision to accept completed work.  It is a first-class domain object,
 * not a timestamp on the Job and not a UI card.
 *
 * Lifecycle:
 *   pending   — opened when the craftsman marks work complete; awaiting customer review
 *     → accepted  — customer confirms the completed work; authorizes payment release
 *     ↘ disputed  — customer opens a dispute instead of accepting
 *
 * An Acceptance is opened (status: 'pending') when the craftsman marks work complete
 * via `markWorkCompleteWorkflow`. The customer's confirmation transitions it to
 * 'accepted', which then authorizes payment release as a financial consequence.
 * Payment release must not create the Acceptance — it must react to it.
 *
 * It references the Job and optionally the Payment and the accepted Offer so
 * that the complete contractual chain is traceable:
 *
 *   Offer (Angebot) → Job (Auftrag) → Acceptance (Abnahme) → Payment (released)
 *
 * INVARIANTS:
 *   - Exactly one Acceptance per Job in terminal state (accepted / disputed).
 *   - Acceptance.jobId → Job.id is the canonical reference direction.
 *   - Job does not carry an acceptanceId — Acceptance owns the reference.
 *   - Timeline / thread are audit/communication layers; they do not own acceptance truth.
 */

import type { EntityId, TimestampMs } from '../shared/coreTypes'

// ── Status ───────────────────────────────────────────────────────────────────

export type AcceptanceStatus =
  | 'pending'   // Acceptance created but awaiting completion (transitional)
  | 'accepted'  // Customer confirmed work and released payment
  | 'disputed'  // Customer opened a dispute instead of accepting

// ── Core Entity ───────────────────────────────────────────────────────────────

export type Acceptance = {
  id: EntityId
  /** The job whose completion this acceptance decision relates to. */
  jobId: EntityId
  /**
   * The Payment record released (or disputed) as part of this acceptance.
   * Present after payment release; may be absent if acceptance is created
   * before payment state is fully synced.
   */
  paymentId?: EntityId
  /**
   * The Offer that was the commercial basis for this job.
   * Copied from job.sourceOfferId at acceptance creation time for traceability
   * without requiring a job lookup on every Acceptance read.
   */
  sourceOfferId?: EntityId
  /** The Supabase auth.users UUID of the customer who made this decision. */
  customerUserId: string
  status: AcceptanceStatus
  /**
   * Unix timestamp (ms) when the customer formally accepted the completed work.
   * Set when status transitions to 'accepted'.
   */
  acceptedAt?: TimestampMs
  /**
   * Unix timestamp (ms) when the acceptance deadline expires.
   * Set to createdAt + 72 hours when the acceptance is created at work completion.
   * After this deadline, the system auto-releases the final payment tranche
   * if the acceptance is still in 'pending' status.
   *
   * UTC-based, server-authoritative. Not derived in the frontend.
   */
  expiresAt?: TimestampMs
  /**
   * Optional notes or feedback provided by the customer at acceptance time.
   * Plain text; not a formal rating (ratings are a separate domain).
   */
  notes?: string
  /**
   * Block 7.2.1e — idempotency flags for the acceptance-reminder cron.
   * Keys: `customer_24h`, `customer_60h`, `worker_acceptance`,
   * `worker_auto_release`. Each flag is set to `true` after a successful
   * `notification_signals` insert so the next cron tick skips the row.
   *
   * Optional on the type so existing fixtures and the in-memory repository
   * stay backward compatible — the Supabase schema has a NOT NULL DEFAULT
   * `'{}'::jsonb` and hydrates as an empty object when no flag has fired.
   */
  remindersSent?: Record<string, boolean>
  createdAt: TimestampMs
  updatedAt: TimestampMs
}
