/**
 * Dispute lifecycle status — matches the production `disputes_status_check`
 * CHECK constraint exactly. Lifecycle states only; the operator decision and
 * the booking outcome are tracked in separate fields (`decision`,
 * `resolutionType`).
 */
export type DisputeStatus =
  | 'open'
  | 'under_review'
  | 'customer_waiting'
  | 'provider_waiting'
  | 'resolved'
  | 'closed'
  | 'cancelled'

/**
 * Operator-issued decision token. Set on resolution alongside `resolutionType`.
 * `null`/undefined while the dispute is still active.
 */
export type DisputeDecision =
  | 'release'
  | 'refund'
  | 'split'
  | 'reject'

/**
 * Booking-level resolution outcome. Mirrors the production
 * `disputes.resolution_type` CHECK constraint. Required when `decision` is set.
 */
export type ResolutionType =
  | 'release_full'
  | 'release_partial'
  | 'refund_full'
  | 'refund_partial'
  | 'split'
  | 'rejected'

/**
 * Tracks whether the financial action required by a dispute decision has
 * actually completed.  Separates "decision truth" from "execution truth":
 *
 * - `pending`  — decision is recorded but the payment/provider action has not
 *                yet succeeded.  Downstream must NOT treat the dispute as fully
 *                resolved; retry is explicitly allowed.
 * - `settled`  — the required payment/provider action completed successfully.
 *                The dispute is truly final.
 *
 * Only meaningful on terminal disputes (`resolved`, `closed`, `cancelled`).
 * Reject is persisted as `decision='reject'` + `settlement_status='settled'`
 * because no money has to move beyond the unchanged escrow release.
 */
export type SettlementStatus = 'pending' | 'settled'

export type DisputeReason =
  | 'work_quality'
  | 'scope_conflict'
  | 'delay'
  | 'payment_conflict'
  | 'other'

export type EvidenceType = 'photo' | 'document' | 'description' | 'other'

export type DisputeEvidence = {
  id: string
  disputeId: string
  jobId: string
  type: EvidenceType
  description: string
  url?: string
  /** ISO 8601 timestamptz string — aligned with the production DB contract. */
  submittedAt: string
  submittedBy: string
}

/**
 * Snapshot of the dispute context at the moment the dispute was opened.
 *
 * PURPOSE
 * -------
 * Many fields from Job and Payment change after a dispute is opened
 * (payment state transitions, job edits). This snapshot freezes the values
 * that matter for reviewing the dispute later — without duplicating entire
 * domain objects or creating a second source of truth.
 *
 * REFERENCE vs SNAPSHOT
 * ----------------------
 * - IDs (`sourceConversationId`, `sourceOfferId`) are stored as references.
 *   The underlying entities are stable enough to query at review time.
 * - Values that change (`paymentStateAtOpen`, `paymentTotalAmount`, job title
 *   and description, parties) are snapshotted because they will differ by the
 *   time the dispute is resolved.
 *
 * WHAT IS NOT HERE
 * -----------------
 * - No message copies — query via `sourceConversationId`
 * - No timeline event copies — query via `jobId` on the immutable timeline
 * - No ledger copies — query via `jobId`/`paymentId`
 * - No offer object copy — query via `sourceOfferId`
 */
export type DisputeContextSnapshot = {
  /** Job title at the moment the dispute was opened. */
  jobTitle: string
  /** Job description at the moment the dispute was opened. */
  jobDescription: string
  /** Craftsman's auth user ID, as recorded on the job at open time. */
  craftsmanUserId: string | null
  /** Customer's auth user ID, as recorded on the job at open time. */
  customerUserId: string | null
  /**
   * Reference to the source conversation thread for this job.
   * Use this to query message history via getConversationById / getMessagesByConversationId.
   * Null when the job was not created from a message thread.
   */
  sourceConversationId: string | null
  /**
   * Reference to the originating offer for this job.
   * Use this to query agreed price / scope via getOfferById.
   * Null when the job was not created from an offer.
   */
  sourceOfferId: string | null
  /**
   * Payment state BEFORE the disputed transition.
   * This is the meaningful state — e.g. 'release_pending' means the
   * customer had already requested release before the dispute was raised.
   * Null when no payment existed at dispute open time.
   */
  paymentStateAtOpen: string | null
  /**
   * Gross payment amount in EUR at dispute open time.
   * Null when no payment existed at dispute open time.
   */
  paymentTotalAmount: number | null
  /** ISO 8601 timestamptz string when this snapshot was taken. */
  snapshotAt: string
}

export type Dispute = {
  id: string
  jobId: string
  /** Payment ID this dispute is associated with (if known at open time) */
  paymentId?: string
  /** User ID of whoever raised the dispute */
  raisedBy?: string
  status: DisputeStatus
  /** Final decision recorded when the dispute is resolved */
  decision?: DisputeDecision
  /**
   * Booking-level resolution outcome (release_full, refund_partial, …).
   * Set in lockstep with `decision` when the dispute is resolved.
   */
  resolutionType?: ResolutionType
  /**
   * For split decisions: the fraction [0.0–1.0] of the total escrow amount
   * that is released to the craftsman. The remainder is refunded to the customer.
   * E.g. splitRatio = 0.7 → 70 % craftsman, 30 % customer.
   */
  splitRatio?: number
  /**
   * Tracks whether the financial action required by the dispute decision has
   * actually been executed.  Only set on terminal disputes (status='resolved').
   * `undefined` for non-terminal disputes (backward-compatible).
   */
  settlementStatus?: SettlementStatus
  reason: DisputeReason
  title: string
  description: string
  /** ISO 8601 timestamptz string. Mirrors the `disputes.opened_at` column. */
  createdAt: string
  /** ISO 8601 timestamptz string. */
  updatedAt: string
  /** ISO 8601 timestamptz string when the dispute was resolved, if at all. */
  resolvedAt?: string
  evidence?: DisputeEvidence[]
  /**
   * Snapshot of the job and payment context captured at the moment the dispute
   * was opened. Freezes values that will change during the lifecycle (payment
   * state, job title, parties). Undefined for disputes opened before Block 6.1.
   */
  contextSnapshot?: DisputeContextSnapshot
}

/**
 * Lifecycle status of a single consensus-split proposal row
 * (`public.dispute_split_proposals.status`). Matches the production CHECK
 * constraint exactly.
 *
 * - `pending`     — awaiting confirmation by the OTHER party. At most one
 *                   pending proposal may exist per dispute at a time.
 * - `accepted`    — the other party confirmed; the dispute is resolved as
 *                   `decision='split'` with this proposal's ratio.
 * - `rejected`    — the other party declined this proposal.
 * - `superseded`  — a newer proposal replaced this still-pending one (the
 *                   proposer or other party countered with a different ratio).
 */
export type SplitProposalStatus = 'pending' | 'accepted' | 'rejected' | 'superseded'

/**
 * A single consensus-split proposal — the P4 Teil B mechanism that lets the two
 * dispute parties agree a split ratio between themselves without an operator
 * decision. One row of `public.dispute_split_proposals`.
 *
 * All writes go exclusively through the SECURITY DEFINER RPCs
 * (`propose_split_atomic`, `confirm_split_proposal`, `reject_split_proposal`),
 * which enforce party membership, proposer-cannot-confirm, ratio bounds, and
 * the single-pending-proposal invariant in the database. The TS layer never
 * writes this table directly.
 */
export type SplitProposal = {
  id: string
  disputeId: string
  jobId: string
  /** Auth user ID of the party who created the proposal. */
  proposedBy: string
  /**
   * Fraction [0.0–1.0] of the total escrow released to the craftsman if this
   * proposal is accepted; the remainder is refunded to the customer. Mirrors
   * the semantics of `Dispute.splitRatio`.
   */
  proposedRatio: number
  status: SplitProposalStatus
  /** Auth user ID of the party who confirmed the proposal, once accepted. */
  confirmedBy?: string
  /** 1-based round counter — increments each time a new proposal supersedes a pending one. */
  proposalRound: number
  /** ISO 8601 timestamptz string. */
  createdAt: string
  /** ISO 8601 timestamptz string. */
  updatedAt: string
}
