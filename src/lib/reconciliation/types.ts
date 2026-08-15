/**
 * Reconciliation read-model types (N13.1 foundation).
 *
 * INTENT
 * ------
 * This module defines the aggregated view that the user-facing reconciliation
 * surfaces consume — both the profile center (`/profile/disputes`) and the
 * embedded job tab (`/jobs/:jobId?focus=dispute`). The aggregation reuses
 * existing dispute, payment, and timeline truth without introducing a second
 * source of truth.
 *
 * BOUNDARIES
 * ----------
 * - No mutation surface — reconciliation views are read-only. Writes flow
 *   through existing dispute / media services.
 * - No counterparty PII — fields visible to one party are filtered for the
 *   other party's data (handled in the selector layer, not here).
 * - Counterparty evidence is deliberately stubbed at `[]` until N13.OPS
 *   delivers the operator-share workflow.
 */

import type {
  Dispute,
  DisputeContextSnapshot,
  DisputeDecision,
  DisputeEvidence,
  DisputeStatus,
  ResolutionType,
  SettlementStatus,
} from '../disputes/types'

/**
 * Reconciliation roles map onto the existing `DisputeRole` plus an explicit
 * separation between authoring and viewing perspectives. Operators have
 * their own surface (N13.OPS) and are not consumers of this read-model.
 */
export type ReconciliationRole = 'customer' | 'craftsman'

/**
 * Source of a timeline entry as visible to a party. Maps from the underlying
 * `dispute_status_history.source` plus enriched markers for own vs. system
 * events. Counterparty events are exposed only when neutralised by the
 * operator (until then, suppressed entirely in the selector).
 */
export type ReconciliationTimelineSource = 'you' | 'system' | 'operator' | 'stripe'

export type ReconciliationTimelineItem = {
  id: string
  source: ReconciliationTimelineSource
  /** ISO 8601 timestamp when the event occurred. */
  occurredAt: string
  title: string
  /** Free-text body. Already PII-redacted when not authored by the viewer. */
  body?: string
  /** Author quote — only present for own-statement events. */
  quote?: string
}

export type ReconciliationEvidenceKind = 'image' | 'document' | 'audio' | 'other'

export type ReconciliationEvidenceItem = {
  id: string
  kind: ReconciliationEvidenceKind
  name: string
  /** ISO 8601 upload timestamp. */
  uploadedAt: string
  /** Bytes; null when the underlying record does not surface size. */
  sizeBytes: number | null
  /** True when this is the viewer's own evidence. */
  ownedByViewer: boolean
  /** Underlying media record id (for opening / preview). */
  mediaId: string
}

export type ReconciliationStripeEvent = {
  /** Stripe event id (`evt_...`) for traceability. */
  id: string
  /** ISO 8601 of `processed_at`. */
  occurredAt: string
  /** Stripe event type or canonical alias (`payout.paused`, `decision.split_60_40`). */
  type: string
  /** Display amount in EUR. Null when not applicable (e.g. status-only events). */
  amountEur: number | null
  /** Outcome of webhook processing (`reconciled` / `skipped` / etc.). */
  outcome?: string
}

export type ReconciliationDeadline = {
  /** ISO 8601 deadline timestamp. */
  dueAt: string
  /** True when `dueAt` is in the past. */
  breached: boolean
  /** Human-readable bucket: 'today' | 'soon' | 'later' for UI urgency. */
  urgency: 'overdue' | 'today' | 'soon' | 'later'
}

export type ReconciliationDecision = {
  decision: DisputeDecision
  resolutionType?: ResolutionType
  splitRatio?: number
  settlementStatus?: SettlementStatus
  /** Operator-authored rationale text. PII-redacted for the opposite party. */
  rationale?: string
  /** ISO 8601 timestamp the decision was finalised. */
  decidedAt?: string
}

export type ReconciliationActionId =
  | 'submit_statement'
  | 'upload_evidence'
  | 'export_case'
  | 'open_full_center'
  | 'view_only'

/**
 * Operator-authored comment surfaced on a dispute. Populated from
 * `disputes.metadata.operator_comments` (jsonb array) — written by the
 * Operator-Center (N13.OPS), visible to both parties as a separate
 * timeline-adjacent block.
 *
 * The body is rendered verbatim to both parties — operators are
 * trusted to phrase things neutrally. PII redaction is intentionally
 * NOT applied here (operator content is the canonical "official"
 * voice; redacting would change its meaning).
 */
export type ReconciliationOperatorComment = {
  id: string
  /** Free-text body, rendered as authored. */
  body: string
  /** ISO 8601 timestamp when the comment was written. */
  writtenAt: string
}

export type ReconciliationView = {
  /** Underlying dispute UUID — internal use only, never rendered as ID to users. */
  disputeId: string
  /** Public-facing case number (Aktenzeichen). */
  aktenzeichen: string
  /** Job UUID — used for navigation back to job detail. */
  jobId: string
  /** Viewer role — selectors filter the view content accordingly. */
  role: ReconciliationRole
  /** Lifecycle status as authored. */
  status: DisputeStatus
  /** Localised label for `status` (re-used from the disputes domain). */
  statusLabel: string
  /** Localised, role-aware next-step guidance. */
  nextStepLabel: string
  /** Frozen context snapshot taken at dispute open time (Block 6.1). */
  snapshot: DisputeContextSnapshot | null
  /** True when the dispute was opened before the snapshot field landed. */
  snapshotMissing: boolean
  /** Filtered timeline — own + system + operator events; never raw counterparty. */
  timeline: ReconciliationTimelineItem[]
  /** Viewer's own evidence uploads. */
  ownEvidence: ReconciliationEvidenceItem[]
  /**
   * Counterparty evidence that the operator has explicitly shared with the
   * viewer. STUB in N13.1 — always empty until N13.OPS delivers the share
   * workflow. Selector intentionally returns `[]`.
   */
  sharedCounterpartyEvidence: ReconciliationEvidenceItem[]
  /** Stripe events relevant to the dispute. */
  stripeTimeline: ReconciliationStripeEvent[]
  /**
   * Operator-authored comments visible to both parties. Sourced from
   * `disputes.metadata.operator_comments`. Empty when no operator has
   * written anything yet. (N13.OPS.)
   */
  operatorComments: ReconciliationOperatorComment[]
  /** Statement deadline — present only while the lifecycle is `*_waiting`. */
  deadline: ReconciliationDeadline | null
  /** Decision details — present only on terminal disputes. */
  decision: ReconciliationDecision | null
  /** Actions the viewer is allowed to take in this state. */
  availableActions: ReconciliationActionId[]
  /** Underlying dispute object — escape hatch for components that need raw fields. */
  dispute: Dispute
}

export type ReconciliationListItem = {
  disputeId: string
  aktenzeichen: string
  jobId: string
  /** Job title at dispute open time (from snapshot when available, fallback to job repo). */
  jobTitle: string
  /** Status label for the badge. */
  status: DisputeStatus
  statusLabel: string
  /** Localised description summary — 1 short sentence. */
  summary: string
  /** Total escrow amount in EUR; null when no payment was attached. */
  amountEur: number | null
  /** ISO 8601 of the most recent visible activity. */
  updatedAt: string
  /** ISO 8601 of opening. */
  createdAt: string
  /** ISO 8601 of resolution; null when active. */
  resolvedAt: string | null
  /** Statement deadline when the lifecycle is `*_waiting`. */
  deadline: ReconciliationDeadline | null
  /** True when the viewer must act (waiting state targeting their role). */
  requiresAction: boolean
  /** UI urgency classification — drives card border + badge. */
  urgencyLevel: 'critical' | 'elevated' | 'normal'
  /** Decision summary for resolved entries — null otherwise. */
  decisionSummary: string | null
  /** Refunded amount in EUR for resolved entries — null otherwise. */
  refundedAmountEur: number | null
}

export type ReconciliationListBuckets = {
  active: ReconciliationListItem[]
  resolved: ReconciliationListItem[]
  counts: {
    active: number
    awaitingViewer: number
    resolved: number
  }
}

/**
 * Inputs passed to selectors. Repositories stay pluggable so the read-model
 * is testable with in-memory builders.
 */
export type ReconciliationSelectorInput = {
  dispute: Dispute
  role: ReconciliationRole
  /** History rows from `dispute_status_history` (already RLS-filtered). */
  history: ReadonlyArray<ReconciliationHistoryRow>
  /** Media uploads attached to the dispute (already RLS-filtered). */
  media: ReadonlyArray<ReconciliationMediaRow>
  /** Stripe webhook events relevant to the dispute's payment intent. */
  stripeEvents: ReadonlyArray<ReconciliationStripeRow>
  /** Counterparty display info for PII redaction. */
  counterparty?: {
    displayName?: string
    emails?: ReadonlyArray<string>
  }
  /** Author display name for own-event rendering. */
  viewer?: {
    userId: string
    displayName?: string
  }
  /** ISO 8601 reference time. Defaults to `Date.now()` at call time. */
  nowMs?: number
  /** Statement deadline derivation — provided by caller (typically the dispute response selector). */
  statementDeadlineAt?: string | null
}

export type ReconciliationHistoryRow = {
  id: string
  disputeId: string
  previousStatus: DisputeStatus | null
  nextStatus: DisputeStatus
  /** Originating actor: 'client' | 'admin' | 'system'. */
  source: 'client' | 'admin' | 'system'
  /** Author user id when `source = 'client'`. */
  actorUserId: string | null
  /** Free-text note. PII-redacted in selectors when not authored by viewer. */
  note: string | null
  /** ISO 8601 timestamp. */
  createdAt: string
}

export type ReconciliationMediaRow = {
  id: string
  ownerUserId: string
  mediaRole: string
  mediaType: 'image' | 'video' | 'document' | 'audio' | string
  fileName: string
  sizeBytes: number | null
  createdAt: string
  /** Whether the operator has marked this artefact as shared with the opposite party. */
  sharedWithCounterparty?: boolean
}

export type ReconciliationStripeRow = {
  eventId: string
  eventType: string
  paymentIntentId: string | null
  outcome: string | null
  amountEur: number | null
  processedAt: string
}

/**
 * Re-export for convenience — consumers should be able to import all
 * reconciliation types from a single module.
 */
export type {
  Dispute,
  DisputeContextSnapshot,
  DisputeDecision,
  DisputeEvidence,
  DisputeStatus,
  ResolutionType,
  SettlementStatus,
}
