/**
 * Offer domain types.
 *
 * An Offer (Kostenvoranschlag / KV) is a first-class commercial artifact that
 * a craftsman creates from within a conversation thread.  It is the single
 * source of truth for scope, price, exclusions, assumptions, and conditions
 * of a proposed engagement.
 *
 * Offers live as first-class domain entities backed by Supabase — they are
 * not embedded in messages or jobs.
 *
 * Status lifecycle:
 *   draft → sent → accepted | declined | expired | superseded | cancelled
 *
 * On acceptance of a BINDING offer, exactly one Job is created (or reused if
 * already linked), and the `createdJobId` field is populated.
 *
 * SNAPSHOT IMMUTABILITY:
 *   Once an Offer has been sent (status = `pending`), its price and scope
 *   fields must not be silently overwritten.  To revise a sent offer, use
 *   supersedeOfferWorkflow — this marks the old offer as `superseded` and
 *   creates a new version.  For commercial changes after Job acceptance, use
 *   ChangeOrders.
 *
 * DOCUMENT TYPE (Paket 1):
 *   `documentType` is the leading commercial typing field from Paket 1 onwards.
 *   It replaces `offerMode` as the authoritative classification of what kind
 *   of pre-execution commercial document this Offer is.
 *   See `commercialDocumentPolicy.ts` for per-type policy rules.
 */

import type { CurrencyCode } from '../shared/coreTypes'

// ── OfferDocumentType ─────────────────────────────────────────────────────────

/**
 * Leading commercial typing for pre-execution Offer documents (Paket 1).
 *
 * 'estimate'      — Unverbindliche Schätzung / Richtpreis.
 *                   No payment corridor. Job created for tracking only.
 *
 * 'cost_estimate' — Kostenvoranschlag.
 *                   Concrete commercial document, but NOT the binding commitment.
 *                   No escrow, no payment. Creates a tracking job on acknowledgement.
 *
 * 'binding_offer' — Verbindliches Angebot.
 *                   The ONLY type that opens the standard escrow/payment/execution corridor.
 *                   Acceptance creates a standard Job + EscrowPlan + Invoice.
 *
 * 'diagnosis'     — Diagnose-Einsatz.
 *                   Own paid diagnostic engagement. Not estimate, not binding offer.
 *                   Has its own instant-payment path with 5 % platform fee.
 *                   No standard escrow, no project execution corridor.
 *
 * INVARIANT: payment gating (`isQuotePaymentReady`) uses this field as
 *   primary check via `commercialDocumentPolicy.documentTypeAllowsPayment()`.
 *   `offerMode` is only consulted as legacy fallback for pre-Paket-1 offers.
 */
export type OfferDocumentType = 'estimate' | 'cost_estimate' | 'binding_offer' | 'diagnosis'

// ── OfferContextType ──────────────────────────────────────────────────────────

/**
 * Context type for a pre-execution commercial document.
 *
 * 'conversation' — Standard: Offer is part of a message thread.
 * 'inquiry'      — Offer derived from an incoming inquiry.
 * 'project'      — Offer bound directly to a project.
 */
export type OfferContextType = 'conversation' | 'inquiry' | 'project'

// ── OfferMode ────────────────────────────────────────────────────────────────

/**
 * @deprecated Use `OfferDocumentType` / `documentType` instead (Paket 1).
 *
 * Legacy commercial binding level. Retained for backward compatibility.
 * Mapping: 'binding' → 'binding_offer', 'estimate' → 'estimate'.
 * New code must use `documentType`. `offerMode` is only written for
 * backward-compatible reads.
 *
 * 'binding'  — Verbindliches Angebot. Acceptance creates a Job and unlocks payment.
 * 'estimate' — Unverbindliche Schätzung. Carries commercial context but no payment.
 */
export type OfferMode = 'binding' | 'estimate'

// ── Status ───────────────────────────────────────────────────────────────────

export type OfferStatus =
  | 'draft'
  | 'pending'      // sent to customer, awaiting decision
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'superseded'
  | 'cancelled'

// ── QUOTE-STALE ──────────────────────────────────────────────────────────────

/**
 * Why a `pending` offer was marked stale by the Spatial Customer-Verify-Flow
 * (Block 3.9 · Implementation-Spec §4). The three VF-2 trigger reasons:
 *
 * 'measurement_changed'      — a wall/room dimension moved >5 % after the
 *                              offer was sent.
 * 'high_severity_pin_added'  — the customer added a new `severity='high'`
 *                              damage pin after the offer was sent.
 * 'layout_changed'           — a wall was deleted or a door/opening moved/added.
 *
 * Distinct from `superseded` (a fresh provider quote) and `expired` (time
 * lapse): the offer stays `pending`, only `isStale` flips.
 */
export type OfferStaleReason =
  | 'measurement_changed'
  | 'high_severity_pin_added'
  | 'layout_changed'

// ── Line Items ───────────────────────────────────────────────────────────────

/**
 * A single cost line within a quote.
 */
export type QuoteLineItem = {
  id: string
  label: string
  /** 'labor' | 'material' | 'other' */
  category: 'labor' | 'material' | 'other'
  /** Net amount in minor units (cents) */
  netAmount: number
  /** Quantity — defaults to 1 */
  quantity: number
  /** Optional unit label (e.g. 'Stk', 'm²', 'Std') */
  unit?: string
}

// ── Spatial Offer Metadata (C-10) ─────────────────────────────────────────────

/**
 * Per-line-item richness that the canonical `QuoteLineItem` cannot express.
 * Populated by `createOfferFromSpatialQuote` from the BoM-Tab items: every
 * auto-derived item carries the scene-graph `nodeId` it was generated from;
 * manual items carry only `source: 'manual'`.
 *
 * Required by:
 *   - Edit-Override (future): re-derive an auto item after a scene update.
 *   - VF-2 Stale-Diff: identify which line items reference a changed node.
 */
export type SpatialOfferLineItemMeta = {
  /** Matches `QuoteLineItem.id` for the same line. */
  lineItemId: string
  /** Scene-graph node anchor — populated for `source === 'auto'` items. */
  nodeId?: string
  /** `auto` = derived from scan geometry; `manual` = user-added in BoM-Tab. */
  source: 'auto' | 'manual'
}

/**
 * Spatial-Offer metadata persisted in `offers.spatial_metadata jsonb`.
 * Only present on offers created via `create_spatial_offer` RPC.
 */
export type SpatialOfferMetadata = {
  /** Per-line-item scene-anchor + source info. */
  lineItems?: SpatialOfferLineItemMeta[]
  /**
   * Render-ready aufmaß snapshot — lets the Offer-PDF draw the floor-plan +
   * measurement table without re-loading the scene. Captured at offer-create
   * time. Optional (older offers + non-spatial offers carry none).
   */
  aufmass?: SpatialAufmassSnapshot
  /** Free-form extension slot — unknown values pass through round-trip. */
  [key: string]: unknown
}

// ── Spatial Aufmaß snapshot (Offer-PDF enrichment) ─────────────────────────────

/** One measured surface / edge in the aufmaß snapshot embedded on the offer. */
export type SpatialAufmassMeasurement = {
  /** Display label, e.g. the wall name / "Bodenfläche" / "Sockelleiste". */
  label: string
  kind: 'wall' | 'floor' | 'skirting'
  /** Measurement unit for the row. */
  unit: 'm2' | 'lfm'
  /**
   * Measured net value — net m² for walls (gross − openings), area for floor,
   * length for skirting. This is the as-measured geometry; the billed quantity
   * on the offer line item may differ if the craftsman overrode it (Übermessung).
   */
  value: number
  /** Wall only — the gross / openings figures behind the net `value`. */
  grossM2?: number
  openingsM2?: number
}

/**
 * Compact, render-ready aufmaß the offer carries so its PDF can show the
 * floor-plan + measurement table WITHOUT re-loading the scene. Persisted on
 * `spatial_metadata.aufmass` (free-form jsonb slot — no migration). The polygon
 * is the normalised 0–100 plan ring (jsPDF draws it as vector lines).
 */
export type SpatialAufmassSnapshot = {
  /** Normalised 0–100 floor outline ring (from `computeBomPlan`). */
  floorPolygon: { xPct: number; yPct: number }[]
  /** Cached room metrics. */
  areaM2: number
  volumeM3: number
  ceilingHeightM: number
  wallCount: number
  perimeterM: number
  /** Per-surface measurement rows for the table. */
  measurements: SpatialAufmassMeasurement[]
}

// ── Core Offer ───────────────────────────────────────────────────────────────

export type Offer = {
  id: string
  /**
   * Conversation anchor for the offer. NULL since Spatial C-10 — Spatial-
   * Quotes are anchored to scene + job and may exist without an inquiry-
   * thread. All non-spatial offers (created via `createOfferWorkflow`) carry
   * a non-null conversationId; the null case is restricted to offers with
   * `sourceSpatialSceneId !== undefined`. Use the `isSpatialOffer` helper
   * to discriminate.
   */
  conversationId: string | null
  /** Optional project ID this quote relates to. */
  projectId?: string
  customerUserId: string
  craftsmanUserId: string

  // ── Commercial Document Typing (Paket 1) ────────────────────────────────
  /**
   * Leading commercial document type (Paket 1+).
   *
   * Authoritative classification for pre-execution commercial documents.
   * Use `getDocumentTypePolicy(documentType)` to derive per-type policy rules.
   * Defaults to 'binding_offer' for all existing offers without this field.
   */
  documentType?: OfferDocumentType

  /**
   * Context type for this commercial document.
   * Defaults to 'conversation' for all existing offers.
   * The actual context anchor is `conversationId`.
   */
  contextType?: OfferContextType

  // ── Commercial identity ─────────────────────────────────────────────────
  /**
   * Human-readable offer reference (e.g. 'KV-2026-A3F2B1C9').
   * Generated at creation time. Displayed to both parties.
   */
  offerRef?: string

  /**
   * @deprecated Use `documentType` (Paket 1).
   *
   * Legacy commercial binding level. Retained for backward compatibility.
   * Derived from `documentType` on write. New logic must use `documentType`.
   */
  offerMode?: OfferMode

  // ── Price Structure ──────────────────────────────────────────────────────
  /** Required human-readable gross price (e.g. "1.500 €"). */
  price: string
  /** ISO 4217 currency code — defaults to 'EUR'. */
  currency?: CurrencyCode
  /** Gross total in minor units (cents). */
  grossTotal?: number
  /** Net total in minor units (cents). */
  netTotal?: number
  /** VAT amount in minor units (cents). */
  vatAmount?: number
  /** VAT rate as a percentage (e.g. 19). */
  vatRate?: number
  /** Labor cost subtotal in minor units. */
  laborCost?: number
  /** Material cost subtotal in minor units. */
  materialCost?: number
  /** Other costs subtotal in minor units. */
  otherCost?: number
  /** Optional structured line items. */
  lineItems?: QuoteLineItem[]

  // ── Scope & Exclusions ───────────────────────────────────────────────────
  /** Optional scope / work description (backward-compat, general text). */
  description?: string
  /** Concise summary of what the quote covers. */
  scopeSummary?: string
  /** Detailed list of what IS included. */
  scopeIncluded?: string
  /** Detailed list of what is NOT included. */
  scopeExcluded?: string
  /** Assumptions / prerequisites that underpin the quote. */
  assumptions?: string

  // ── Conditions ───────────────────────────────────────────────────────────
  /**
   * Optional execution conditions / special terms.
   * NOT a substitute for the platform escrow model. Rendered as "Sonderbedingungen"
   * when present. Never a required field — the platform 25/75 escrow is the primary
   * payment truth for binding_offer; diagnosis has its own payment path.
   */
  paymentTerms?: string
  /** Offer valid until (ISO-8601 date string, e.g. "2026-04-15"). */
  validUntil?: string
  /** Cancellation terms / policy. */
  cancellationTerms?: string
  /** Whether SaFix escrow / payment safety is required. */
  escrowRequired?: boolean

  // ── Scheduling ───────────────────────────────────────────────────────────
  /** Optional scheduling / availability note */
  timingNote?: string

  // ── Snapshots — frozen at send time ──────────────────────────────────────
  /**
   * Snapshot fields freeze the commercial context at the moment the offer
   * is sent. They are read-only after send and survive project/conversation
   * changes without silently altering the offer.
   */
  /** Project title at time of offer creation. */
  projectTitleSnapshot?: string
  /** Original customer description at time of offer creation. */
  customerDescriptionSnapshot?: string
  /** Work location at time of offer creation. */
  locationSnapshot?: string
  /**
   * Craftsman's display name / business name at offer creation time.
   * Populated automatically from conversation.craftsmanName.
   */
  craftsmanNameSnapshot?: string

  // ── Evidence / Attachment references ────────────────────────────────────
  /**
   * IDs of media artifacts from the conversation that the craftsman used as
   * the basis for this offer. References, not copies.
   */
  evidenceMediaIds?: string[]

  // ── VAT / price clarity ──────────────────────────────────────────────────
  /**
   * Whether the stated price/grossTotal is inclusive of VAT.
   * - true (default): price is brutto (VAT included)
   * - false: price is netto (VAT to be added on top)
   */
  vatIncluded?: boolean

  // ── Follow-up reference (Paket 4d) ──────────────────────────────────────
  /**
   * ID of the diagnosis offer this binding_offer was created from (Paket 4d).
   * Set when a craftsman creates a follow-up binding_offer after completing a
   * diagnosis. Provides audit trail: diagnosis → follow-up offer.
   * Does NOT transfer diagnosis semantics — this is a new, independent offer
   * with its own acceptance path, payment corridor, and job lifecycle.
   */
  sourceDiagnosisId?: string

  // ── QUOTE-STALE (Spatial Verify-Flow · Block 3.9 · Implementation-Spec §4) ──
  /**
   * The scan basis of this offer was significantly changed by the customer
   * AFTER the offer was sent (VF-2 threshold: >5 % in any dimension OR a new
   * `severity='high'` pin). The offer stays formally `pending` — the customer
   * could still accept it — but the provider should re-quote against the
   * current scan. Only `pending` offers are ever marked stale.
   * Defaults to `false` for every existing offer without this field.
   */
  isStale?: boolean
  /**
   * Why the offer was marked stale — one of the three VF-2 trigger reasons.
   * Set iff `isStale === true`.
   */
  staleReason?: OfferStaleReason
  /** Unix timestamp (ms) the offer was marked stale. Set iff `isStale === true`. */
  staleMarkedAt?: number
  /**
   * `spatial_scenes.id` whose customer-verify change triggered the stale flag.
   * Audit trail + provider diff-link. Set iff `isStale === true`.
   */
  staleSourceSceneId?: string

  // ── Spatial Canonical (C-10) ────────────────────────────────────────────
  /**
   * `spatial_scenes.id` whose BoM produced this offer. Set by the
   * `create_spatial_offer` RPC on Spatial-Quote-Send. NULL for all non-
   * spatial offers. Distinct from `staleSourceSceneId` (VF-2 stale-trigger
   * source); semantics are disjoint — an offer may carry both.
   */
  sourceSpatialSceneId?: string
  /**
   * BoM-item richness (nodeId scene-anchors + source=auto|manual per line
   * item) that QuoteLineItem cannot express. Only present on Spatial-Offers.
   */
  spatialMetadata?: SpatialOfferMetadata
  /**
   * Storage URL of the generated offer PDF (C10.8). NULL until the PDF
   * generator runs (auto on offer-create + on-demand). Consumers must null-
   * guard.
   */
  pdfUrl?: string

  // ── Optional notes ───────────────────────────────────────────────────────
  /** Free-text internal notes (visible to craftsman only). */
  notes?: string

  // ── State & Versioning ───────────────────────────────────────────────────
  status: OfferStatus
  /** Quote version — starts at 1, incremented on supersede. */
  version?: number
  /** Unix timestamp (ms) when the offer was actually sent */
  sentAt: number
  createdAt: number
  updatedAt: number
  /** Unix timestamp (ms) of when the customer accepted the offer */
  acceptedAt?: number
  /** Unix timestamp (ms) of when the customer declined the offer */
  declinedAt?: number
  /** Unix timestamp (ms) of when the offer was locked (e.g. for payment). */
  lockedAt?: number
  /** ID of the job created on acceptance — links offer to job */
  createdJobId?: string
}

// ── Type Guards ──────────────────────────────────────────────────────────────

/**
 * Discriminator for offers created via the Spatial C-10 path
 * (`create_spatial_offer` RPC, scene + BoM-anchored). Spatial-Offers may
 * have a NULL `conversationId` and always carry `sourceSpatialSceneId`.
 *
 * Use this guard before branching into spatial-aware UI/workflows —
 * conversation-anchored workflows (acceptOffer, declineOffer, etc.) must
 * either branch out or null-handle these offers.
 */
export function isSpatialOffer(
  offer: Offer
): offer is Offer & { sourceSpatialSceneId: string } {
  return typeof offer.sourceSpatialSceneId === 'string' && offer.sourceSpatialSceneId.length > 0
}
