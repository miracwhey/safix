/**
 * Thread Artifact Types
 *
 * Formal separation of the two distinct artifact families that can coexist
 * in a single conversation thread:
 *
 * A. ProjectArtifact — a real customer-created project card that is attached
 *    to the thread.  Reload-stable: persists as long as the backing Project
 *    entity exists.  When the full entity isn't loaded yet, the card renders
 *    from snapshot display data stored in the artifact record itself.
 *
 * B. OfferPaymentArtifact — the craftsman offer / payment lifecycle card.
 *    Progresses through: draft → sent → accepted → payment_due.
 *    When the full offer entity isn't loaded yet, the card renders from
 *    snapshot display data stored in the artifact record itself.
 *    Never conflated with the project card.
 *
 * Both artifact types can appear simultaneously in the same thread.
 */

import type { Project } from '../projects'
import type { Offer, OfferDocumentType } from '../offers/types'
import type { PaymentState } from '../shared/coreTypes'
import type { PersistenceStatus } from './threadArtifactTruthTrace'
import type { ChangeOrder, ChangeOrderStatus } from '../changeOrders/types'
import type { Invoice, InvoiceStatus } from '../invoices/types'

// ── Snapshot display data ─────────────────────────────────────────────────
// Minimal denormalized display data stored in the artifact record itself.
// Used to render a stable card immediately without depending on secondary
// repo hydration.  The full entity (if available) enriches the card but
// is never required for basic visibility.

export type ProjectSnapshot = {
  title: string
  status: string
  summary?: string
  projectId: string
  /** Trade category for compact card display. */
  category?: string
  /** Location for compact card display. */
  location?: string
  /** Budget range for compact card display. */
  requestedBudget?: string
  /** Timing preference for compact card display. */
  requestedTiming?: string
}

export type OfferSnapshot = {
  price: string
  summary?: string
  phaseLabel: string
  offerId: string
  /** Commercial document type — 'binding_offer' | 'estimate' | 'diagnosis' (Paket 4b) */
  documentType?: OfferDocumentType
  /** Offer version at send time (Paket 4b) */
  version?: number
  /** ISO-8601 validity date (Paket 4b) */
  validUntil?: string
}

// ── Project Artifact ──────────────────────────────────────────────────────

export type ProjectArtifact = {
  kind: 'project'
  /** Unique artifact record ID — stable across reloads, unique per send. */
  artifactId: string
  /** The real, persisted project entity (null if not yet loaded). */
  project: Project | null
  /** Snapshot display data — always available when artifact record exists. */
  snapshot: ProjectSnapshot | null
  /** Whether this project was attached by the customer (builder-origin). */
  isCustomerCreated: boolean
  /**
   * Whether this project is the active operational project for the thread.
   * Only one project can be active at a time.  The active project is used
   * by operational flows (offer, payment, job linkage).
   */
  isActiveProject: boolean
  /**
   * Whether this project artifact is confirmed from persisted remote state.
   * 'confirmed' = sourceProjectId is set and resolves to a real project row.
   * 'unconfirmed' = found via fallback (message attachments / projectId).
   * 'missing' = no conversation or no project link at all.
   */
  persistenceStatus: PersistenceStatus
  /**
   * Unix timestamp (ms) when this project artifact was created / sent.
   * Used to interleave the project-send event chronologically within
   * the chat message timeline.
   */
  createdAt: number
}

// ── Offer / Payment Artifact ──────────────────────────────────────────────

export type OfferPaymentPhase =
  | 'draft'
  | 'sent'
  | 'accepted'
  | 'payment_due'
  | 'diagnosis_payment_due'
  | 'declined'

export type OfferPaymentArtifact = {
  kind: 'offer_payment'
  /** Current lifecycle phase of this artifact. */
  phase: OfferPaymentPhase
  /** The underlying Offer entity (null if not yet loaded). */
  offer: Offer | null
  /** Snapshot display data — always available when artifact record exists. */
  snapshot: OfferSnapshot | null
  /** The linked job ID, populated after acceptance. */
  jobId: string | null
  /** Payment state from the linked job, populated after acceptance. */
  paymentState: PaymentState | null
  /**
   * Commercial document type (Paket 4b).
   * Resolved from offer entity (authoritative) or snapshot (fallback).
   * Defaults to 'binding_offer' for pre-Paket-1 data.
   */
  documentType: OfferDocumentType
  /**
   * Whether this offer artifact is confirmed from persisted remote state.
   * 'confirmed' = at least one offer row exists in the store for this conversation.
   * 'missing' = no offer rows found.
   */
  persistenceStatus: PersistenceStatus
  /**
   * Unix timestamp (ms) when this offer artifact was created / sent.
   * Used to interleave the quote-send event chronologically within
   * the chat message timeline.
   */
  createdAt: number
}

// ── Funding Step Artifact ─────────────────────────────────────────────────

export type FundingStepPhase =
  | 'sent'               // Provider sent the funding card
  | 'funding_started'    // Customer opened the funding flow
  | 'funding_initiated'  // Stripe payment initiated
  | 'funded'             // Funding confirmed
  | 'funding_failed'     // Funding failed (retryable)
  | 'cancelled'          // Funding cancelled
  | 'expired'            // Funding expired

/**
 * Funding step phases where the funding card is an active call-to-action
 * (the customer can still interact with the funding flow).
 *
 * Used by:
 * - threadArtifactSelectors.ts: offer-funding reconciliation + superseded muting
 *   (when funding is in an active-CTA phase the offer card stays in the
 *   chronological stream but is muted; the legacy ThreadArtifactCards top-layer
 *   is no longer mounted in MessageThreadScreen).
 */
export const FUNDING_ACTIVE_CTA_PHASES: ReadonlySet<string> = new Set<string>([
  'sent', 'funding_started', 'funding_initiated',
])

export type FundingStepSnapshot = {
  amount: string
  fundingRequestId: string
  escrowPlanId: string
  phaseLabel: string
}

// ── ChangeOrder (Nachtrag) Artifact ───────────────────────────────────────

export type ChangeOrderSnapshot = {
  changeOrderId: string
  /** Formatted delta amount (e.g. "+450,00 €"). */
  deltaAmount: string
  /** Short description of the change. */
  description: string
  /** Human-readable phase label (e.g. 'Nachtrag liegt vor'). */
  phaseLabel: string
}

export type ChangeOrderArtifact = {
  kind: 'change_order'
  /** Unique artifact record ID — stable across reloads. */
  artifactId: string
  /** The canonical ChangeOrder entity (null if not yet loaded). */
  changeOrder: ChangeOrder | null
  /** Snapshot display data — always available when artifact record exists. */
  snapshot: ChangeOrderSnapshot | null
  /** Current status derived from the live entity (or stored phase). */
  status: ChangeOrderStatus
  /** Job ID for routing to detail screen. */
  jobId: string
  /** Whether this artifact is confirmed from persisted remote state. */
  persistenceStatus: PersistenceStatus
  /** Unix timestamp (ms) when this artifact was created. */
  createdAt: number
}

export type FundingStepArtifact = {
  kind: 'funding_step'
  /** Current funding phase. */
  phase: FundingStepPhase
  /** Funding request ID this card is tied to. */
  fundingRequestId: string
  /** Escrow plan ID this card is tied to. */
  escrowPlanId: string
  /** Job ID for routing. */
  jobId: string
  /**
   * Canonical customer-facing project ID for direct navigation.
   * Persisted on the artifact record at creation time so navigation
   * does not depend on job/project store hydration timing.
   */
  projectId: string
  /** Source offer ID for audit trail. */
  sourceOfferId: string
  /** Amount to fund (formatted string). */
  amount: string
  /** Snapshot display data. */
  snapshot: FundingStepSnapshot | null
  /** Whether this artifact is confirmed from persisted remote state. */
  persistenceStatus: PersistenceStatus
  /** Unix timestamp (ms) when this artifact was created. */
  createdAt: number
}

// ── Invoice (Rechnung) Artifact ───────────────────────────────────────────

export type InvoiceSnapshot = {
  invoiceId: string
  /** Formatted gross amount (e.g. "1.234,56 €"). */
  amount: string
  /** Invoice number for the subline (may be '' before issuance). */
  invoiceNumber: string
  /** Human-readable phase label (e.g. 'Rechnung versendet'). */
  phaseLabel: string
}

export type InvoiceArtifact = {
  kind: 'invoice'
  /** Unique artifact record ID — stable across reloads. */
  artifactId: string
  /** The canonical Invoice entity (null if not yet loaded). */
  invoice: Invoice | null
  /** Snapshot display data — always available when artifact record exists. */
  snapshot: InvoiceSnapshot | null
  /** Current status derived from the live entity (or stored phase). */
  status: InvoiceStatus
  /** Job ID for routing / context. */
  jobId: string
  /** Whether this artifact is confirmed from persisted remote state. */
  persistenceStatus: PersistenceStatus
  /** Unix timestamp (ms) when this artifact was created. */
  createdAt: number
}

// ── Union ─────────────────────────────────────────────────────────────────

export type ThreadArtifact = ProjectArtifact | OfferPaymentArtifact | FundingStepArtifact | ChangeOrderArtifact | InvoiceArtifact

export type ThreadArtifacts = {
  /**
   * All project cards sent in this thread, ordered by creation time.
   * Multiple project cards may coexist in one thread (append-only model).
   */
  projectArtifacts: ProjectArtifact[]
  /**
   * First project artifact (convenience, backward-compat).
   * Null when no project cards have been sent.
   */
  projectArtifact: ProjectArtifact | null
  /** Craftsman offer / payment card — null when no offer exists. */
  offerPaymentArtifact: OfferPaymentArtifact | null
  /** Funding step card — null when no funding request has been sent in this thread. */
  fundingStepArtifact: FundingStepArtifact | null
  /**
   * All ChangeOrder (Nachtrag) artifacts sent in this thread, ordered by creation time.
   * Multiple ChangeOrders may coexist in one thread (append-only model).
   */
  changeOrderArtifacts: ChangeOrderArtifact[]
  /**
   * All Invoice (Rechnung) artifacts sent in this thread, ordered by creation time.
   * Multiple invoices may coexist in one thread (append-only model, keyed to invoice id).
   */
  invoiceArtifacts: InvoiceArtifact[]
  /**
   * True when the offer card has been superseded by a funding step
   * (active CTA phase or funded confirmation) for the same canonical
   * context (jobId).  The UI should suppress the offer card from the
   * persistent context area — the funding card is the dominant
   * action/confirmation surface and showing both would create competing
   * representations for the same business context.
   */
  offerFundingSuperseded: boolean
  /**
   * True when a thread_artifacts record with a projectId exists but the
   * project entity has not been loaded into the project repository yet
   * AND no snapshot is available for immediate rendering.
   * The UI should render a stable loading placeholder instead of hiding
   * the card entirely.
   */
  pendingProjectArtifact: boolean
  /**
   * True when a thread_artifacts record with an offerId exists but the
   * offer entity has not been loaded into the offer repository yet
   * AND no snapshot is available for immediate rendering.
   * The UI should render a stable loading placeholder instead of hiding
   * the card entirely.
   */
  pendingOfferArtifact: boolean
  /** True when a funding step artifact record exists but hasn't loaded yet. */
  pendingFundingArtifact: boolean
}
