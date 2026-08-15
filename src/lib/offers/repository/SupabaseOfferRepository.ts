import { supabase } from '../../supabase'
import { recordPersistenceFailure } from '../../persistence'
import { logError } from '../../observability'
import type {
  Offer,
  OfferMode,
  OfferDocumentType,
  OfferContextType,
  OfferStaleReason,
  SpatialOfferMetadata,
} from '../types'
import type {
  CreateSpatialOfferRpcInput,
  OfferRepository,
} from './OfferRepository'
import {
  resolveEffectiveDocumentType,
  documentTypeToLegacyOfferMode,
} from '../commercialDocumentPolicy'

type Listener = () => void

/**
 * Shape of an `offers` row as stored in the Supabase database.
 * Managed by migration 20260319000001_offers_table.sql
 * Extended by migration 20260324000001_offers_quote_domain.sql
 * Extended by migration 20260411000005_offers_offer_mode.sql
 * Extended by migration 20260412000002_offers_block31_fields.sql (offerRef, snapshots, vatIncluded, evidenceMediaIds)
 * Extended by migration 20260412000003_offers_offer_ref.sql (offer_ref)
 * Extended by migration 20260412000004_offers_document_type.sql (document_type, context_type) — Paket 1
 * Extended by migration 20260412000005_offers_source_diagnosis_id.sql (source_diagnosis_id) — Paket 4d
 */
interface OfferRow {
  id: string
  /**
   * Nullable since migration 20260523120055 (Spatial C-10) — Spatial-Quotes
   * may exist without a conversation anchor. All non-spatial offers carry
   * a non-null `conversation_id` (enforced at the workflow layer, not the
   * column).
   */
  conversation_id: string | null
  customer_user_id: string
  craftsman_user_id: string
  price: string
  description: string | null
  timing_note: string | null
  status: string
  created_at: number
  updated_at: number
  accepted_at: number | null
  declined_at: number | null
  created_job_id: string | null
  /** Optional column (migration 20260321000012) */
  sent_at?: number | null

  // ── Extended quote domain columns (migration 20260324000001) ──────────
  project_id?: string | null
  currency?: string | null
  gross_total?: number | null
  net_total?: number | null
  vat_amount?: number | null
  vat_rate?: number | null
  labor_cost?: number | null
  material_cost?: number | null
  other_cost?: number | null
  scope_summary?: string | null
  scope_included?: string | null
  scope_excluded?: string | null
  assumptions?: string | null
  payment_terms?: string | null
  valid_until?: string | null
  cancellation_terms?: string | null
  escrow_required?: boolean | null
  project_title_snapshot?: string | null
  customer_description_snapshot?: string | null
  location_snapshot?: string | null
  notes?: string | null
  version?: number | null
  locked_at?: number | null
  line_items?: unknown | null  // JSON array or string — parsed in rowToOffer

  /**
   * @deprecated Legacy column (migration 20260411000005).
   * Retained for backward compat — new code uses document_type.
   */
  offer_mode?: string | null

  /** Human-readable reference (migration 20260412000003). */
  offer_ref?: string | null

  // ── Block 3.1 fields (migration 20260412000002) ───────────────────────
  craftsman_name_snapshot?: string | null
  vat_included?: boolean | null
  evidence_media_ids?: string | null  // JSON array stored as TEXT

  /**
   * Leading commercial document type (migration 20260412000004 — Paket 1).
   * NULL for rows before Paket 1; resolved via resolveEffectiveDocumentType().
   * Values: 'estimate' | 'cost_estimate' | 'binding_offer' | 'diagnosis'
   */
  document_type?: string | null

  /**
   * Context type (migration 20260412000004 — Paket 1).
   * NULL for pre-Paket-1 rows; treated as 'conversation'.
   */
  context_type?: string | null

  /**
   * ID of the diagnosis offer this binding_offer was created from (migration 20260412000005 — Paket 4d).
   * NULL for all offers not created as a follow-up to a diagnosis.
   */
  source_diagnosis_id?: string | null

  // ── QUOTE-STALE columns (migration 20260520120041 — Spatial Verify Block 3.9) ──
  /** Scan basis significantly changed after send (VF-2). Defaults false. */
  is_stale?: boolean | null
  /** Why stale — measurement_changed | high_severity_pin_added | layout_changed. */
  stale_reason?: string | null
  /**
   * ISO-8601 timestamp the offer was marked stale — the DB column is
   * `timestamptz` (migration 20260520120041). The offer domain carries
   * `staleMarkedAt` as unix-ms; the conversion happens at the
   * `offerToRow` / `rowToOffer` boundary so PostgREST never receives a bare
   * integer (which Postgres will not coerce into a timestamptz).
   */
  stale_marked_at?: string | null
  /** spatial_scenes.id whose change triggered the stale flag. */
  stale_source_scene_id?: string | null

  // ── Spatial Canonical C-10 columns (migration 20260523120055) ────────────
  /**
   * `spatial_scenes.id` whose BoM produced this offer. Set by the
   * `create_spatial_offer` RPC. NULL for non-spatial offers. Distinct from
   * `stale_source_scene_id` — semantics are disjoint.
   */
  source_spatial_scene_id?: string | null
  /**
   * BoM-item richness (nodeId scene-anchors + source=auto|manual). Stored as
   * `jsonb`; PostgREST returns it as a parsed object (no JSON.parse needed
   * on the read side). May be `null` for non-spatial offers or absent on
   * pre-C-10 rows.
   */
  spatial_metadata?: SpatialOfferMetadata | null
  /** Storage URL of the generated offer PDF (C10.8). */
  pdf_url?: string | null
}

function rowToOffer(row: OfferRow): Offer {
  // Resolve leading commercial document type (Paket 1).
  // Primary: document_type column. Fallback: derive from offer_mode.
  const documentType = resolveEffectiveDocumentType(
    row.document_type as OfferDocumentType | null,
    row.offer_mode
  )

  return {
    id: row.id,
    // Nullable since C-10 — Spatial-Quotes may carry NULL here.
    conversationId: row.conversation_id,
    customerUserId: row.customer_user_id,
    craftsmanUserId: row.craftsman_user_id,
    price: row.price,
    ...(row.description != null && { description: row.description }),
    ...(row.timing_note != null && { timingNote: row.timing_note }),
    status: row.status as Offer['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at ?? row.created_at,
    ...(row.accepted_at != null && { acceptedAt: row.accepted_at }),
    ...(row.declined_at != null && { declinedAt: row.declined_at }),
    ...(row.created_job_id != null && { createdJobId: row.created_job_id }),
    // Extended quote domain fields
    ...(row.project_id != null && { projectId: row.project_id }),
    ...(row.currency != null && { currency: row.currency as Offer['currency'] }),
    ...(row.gross_total != null && { grossTotal: row.gross_total }),
    ...(row.net_total != null && { netTotal: row.net_total }),
    ...(row.vat_amount != null && { vatAmount: row.vat_amount }),
    ...(row.vat_rate != null && { vatRate: row.vat_rate }),
    ...(row.labor_cost != null && { laborCost: row.labor_cost }),
    ...(row.material_cost != null && { materialCost: row.material_cost }),
    ...(row.other_cost != null && { otherCost: row.other_cost }),
    ...(row.scope_summary != null && { scopeSummary: row.scope_summary }),
    ...(row.scope_included != null && { scopeIncluded: row.scope_included }),
    ...(row.scope_excluded != null && { scopeExcluded: row.scope_excluded }),
    ...(row.assumptions != null && { assumptions: row.assumptions }),
    ...(row.payment_terms != null && { paymentTerms: row.payment_terms }),
    ...(row.valid_until != null && { validUntil: row.valid_until }),
    ...(row.cancellation_terms != null && { cancellationTerms: row.cancellation_terms }),
    ...(row.escrow_required != null && { escrowRequired: row.escrow_required }),
    ...(row.project_title_snapshot != null && { projectTitleSnapshot: row.project_title_snapshot }),
    ...(row.customer_description_snapshot != null && { customerDescriptionSnapshot: row.customer_description_snapshot }),
    ...(row.location_snapshot != null && { locationSnapshot: row.location_snapshot }),
    ...(row.notes != null && { notes: row.notes }),
    ...(row.version != null && { version: row.version }),
    ...(row.locked_at != null && { lockedAt: row.locked_at }),
    ...(row.line_items != null && (() => {
      try {
        const raw = row.line_items
        const items = typeof raw === 'string' ? JSON.parse(raw) : raw
        return Array.isArray(items) ? { lineItems: items } : {}
      } catch { return {} }
    })()),
    // Block 3.1 fields
    ...(row.offer_ref != null && { offerRef: row.offer_ref }),
    ...(row.craftsman_name_snapshot != null && { craftsmanNameSnapshot: row.craftsman_name_snapshot }),
    ...(row.vat_included != null && { vatIncluded: row.vat_included }),
    ...(row.evidence_media_ids != null && (() => {
      try {
        const raw = row.evidence_media_ids
        const items = typeof raw === 'string' ? JSON.parse(raw) : raw
        return Array.isArray(items) ? { evidenceMediaIds: items } : {}
      } catch { return {} }
    })()),
    // Leading commercial document type (Paket 1)
    documentType,
    // Context type — default 'conversation' for pre-Paket-1 rows
    contextType: (row.context_type as OfferContextType | null) ?? 'conversation',
    // Legacy offerMode — derived from documentType for consistency on read
    offerMode: documentTypeToLegacyOfferMode(documentType) as OfferMode,
    // Follow-up reference (Paket 4d)
    ...(row.source_diagnosis_id != null && { sourceDiagnosisId: row.source_diagnosis_id }),
    // QUOTE-STALE (Spatial Verify Block 3.9). `is_stale` defaults false; the
    // reason/timestamp/scene are only meaningful when the flag is set.
    // `stale_marked_at` is a `timestamptz` in the DB — parse the ISO string
    // back into the unix-ms the offer domain (`Offer.staleMarkedAt`) uses.
    isStale: row.is_stale === true,
    ...(row.stale_reason != null && { staleReason: row.stale_reason as OfferStaleReason }),
    ...(row.stale_marked_at != null && (() => {
      const ms = Date.parse(row.stale_marked_at)
      return Number.isFinite(ms) ? { staleMarkedAt: ms } : {}
    })()),
    ...(row.stale_source_scene_id != null && { staleSourceSceneId: row.stale_source_scene_id }),
    // ── Spatial C-10 fields ────────────────────────────────────────────────
    ...(row.source_spatial_scene_id != null && { sourceSpatialSceneId: row.source_spatial_scene_id }),
    ...(row.spatial_metadata != null && { spatialMetadata: row.spatial_metadata }),
    ...(row.pdf_url != null && { pdfUrl: row.pdf_url }),
  }
}

/**
 * Convert the offer domain's unix-ms `staleMarkedAt` to the ISO-8601 string the
 * `offers.stale_marked_at` `timestamptz` column expects. Returns `null` for a
 * non-stale offer (or a missing / non-finite timestamp) so the DB
 * `offers_stale_consistency_chk` constraint holds. A bare integer would fail
 * Postgres's int→timestamptz coercion — every QUOTE-STALE write must go through
 * this boundary.
 */
function staleMarkedAtToIso(offer: Offer): string | null {
  if (offer.isStale !== true) return null
  const ms = offer.staleMarkedAt
  if (ms == null || !Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

function offerToRow(offer: Offer): OfferRow {
  // Derive document type — primary from offer.documentType, fallback from offerMode
  const documentType = offer.documentType ?? (
    offer.offerMode === 'estimate' ? 'estimate' : 'binding_offer'
  ) as OfferDocumentType
  const legacyOfferMode = documentTypeToLegacyOfferMode(documentType)

  return {
    id: offer.id,
    // Nullable since C-10 — Spatial-Quotes write NULL here when no
    // conversation anchor exists; the DB column was made nullable in
    // migration 20260523120055.
    conversation_id: offer.conversationId,
    customer_user_id: offer.customerUserId,
    craftsman_user_id: offer.craftsmanUserId,
    price: offer.price,
    description: offer.description ?? null,
    timing_note: offer.timingNote ?? null,
    status: offer.status,
    created_at: offer.createdAt,
    updated_at: offer.updatedAt,
    sent_at: offer.sentAt,
    accepted_at: offer.acceptedAt ?? null,
    declined_at: offer.declinedAt ?? null,
    created_job_id: offer.createdJobId ?? null,
    project_id: offer.projectId ?? null,
    currency: offer.currency ?? null,
    gross_total: offer.grossTotal ?? null,
    net_total: offer.netTotal ?? null,
    vat_amount: offer.vatAmount ?? null,
    vat_rate: offer.vatRate ?? null,
    labor_cost: offer.laborCost ?? null,
    material_cost: offer.materialCost ?? null,
    other_cost: offer.otherCost ?? null,
    scope_summary: offer.scopeSummary ?? null,
    scope_included: offer.scopeIncluded ?? null,
    scope_excluded: offer.scopeExcluded ?? null,
    assumptions: offer.assumptions ?? null,
    payment_terms: offer.paymentTerms ?? null,
    valid_until: offer.validUntil ?? null,
    cancellation_terms: offer.cancellationTerms ?? null,
    escrow_required: offer.escrowRequired ?? null,
    project_title_snapshot: offer.projectTitleSnapshot ?? null,
    customer_description_snapshot: offer.customerDescriptionSnapshot ?? null,
    location_snapshot: offer.locationSnapshot ?? null,
    notes: offer.notes ?? null,
    version: offer.version ?? null,
    locked_at: offer.lockedAt ?? null,
    line_items: offer.lineItems ? JSON.stringify(offer.lineItems) : null,
    // Legacy compat: write offer_mode derived from documentType
    offer_mode: legacyOfferMode,
    // Block 3.1 fields
    offer_ref: offer.offerRef ?? null,
    craftsman_name_snapshot: offer.craftsmanNameSnapshot ?? null,
    vat_included: offer.vatIncluded ?? null,
    evidence_media_ids: offer.evidenceMediaIds ? JSON.stringify(offer.evidenceMediaIds) : null,
    // Paket 1: write document_type as leading field
    document_type: documentType,
    context_type: offer.contextType ?? 'conversation',
    // Paket 4d: follow-up reference
    source_diagnosis_id: offer.sourceDiagnosisId ?? null,
    // QUOTE-STALE (Spatial Verify Block 3.9). The DB CHECK requires reason +
    // timestamp to be NULL unless is_stale is true — mirror that here so a
    // non-stale offer never carries an orphan reason. `stale_marked_at` is a
    // `timestamptz`: convert the offer domain's unix-ms `staleMarkedAt` to an
    // ISO-8601 string so PostgREST sends a value Postgres accepts (a bare
    // integer would fail the int→timestamptz coercion). The
    // `offers_stale_consistency_chk` constraint still holds — when is_stale is
    // true the ISO string is non-NULL, when false all three columns are NULL.
    is_stale: offer.isStale === true,
    stale_reason: offer.isStale === true ? offer.staleReason ?? null : null,
    stale_marked_at: staleMarkedAtToIso(offer),
    stale_source_scene_id: offer.isStale === true ? offer.staleSourceSceneId ?? null : null,
    // ── Spatial C-10 ────────────────────────────────────────────────────────
    // For Spatial-Quotes the canonical write path is `create_spatial_offer`
    // (RPC, SECURITY DEFINER). When `add()` / `update()` are called on a
    // Spatial-Offer we still round-trip these columns so optimistic local
    // updates stay consistent with the server view.
    source_spatial_scene_id: offer.sourceSpatialSceneId ?? null,
    spatial_metadata: offer.spatialMetadata ?? null,
    pdf_url: offer.pdfUrl ?? null,
  }
}

/**
 * Supabase-backed implementation of the OfferRepository interface.
 *
 * Write path: optimistic local update → async Supabase mutation.
 * Failures are logged and recorded in the persistence error store.
 */
export class SupabaseOfferRepository implements OfferRepository {
  private offers: Offer[] = []
  private authUnsubscribe: (() => void) | null = null
  private readonly listeners = new Set<Listener>()
  private _hydrated = false
  private currentUid: string | null = null
  private _initPromise: Promise<void> | null = null
  private _loadGeneration = 0

  async initialize(): Promise<void> {
    if (this._initPromise) return this._initPromise
    const generation = ++this._loadGeneration
    const p: Promise<void> = (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (generation !== this._loadGeneration) return
      if (!session?.user) {
        this.resetState()
        this._hydrated = true
        this.notify()
        return
      }
      await this.loadForUser(session.user.id, generation)
      this._hydrated = true
      this.notify()
      this.ensureAuthListener()
    })()
    this._initPromise = p
    void p.then(
      () => { if (this._initPromise === p) this._initPromise = null },
      () => { if (this._initPromise === p) this._initPromise = null },
    )
    return p
  }

  isHydrated(): boolean {
    return this._hydrated
  }

  private async loadForUser(uid: string, generationSnapshot: number): Promise<void> {
    this.currentUid = uid
    const { data, error } = await supabase
      .from('offers')
      .select('*')
      .or(`craftsman_user_id.eq.${uid},customer_user_id.eq.${uid}`)
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) throw error
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    this.offers = (data as OfferRow[]).map(rowToOffer)
    this.notify()
  }

  private resetState(): void {
    this._initPromise = null
    this.currentUid = null
    this.offers = []
    this.notify()
  }

  private ensureAuthListener(): void {
    if (this.authUnsubscribe) return
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      const uid = session?.user?.id
      if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && uid && (uid !== this.currentUid || !this._hydrated)) {
        void this.loadForUser(uid, this._loadGeneration)
      }
      if (event === 'SIGNED_OUT') {
        this.currentUid = null
        this.resetState()
      }
    })
    this.authUnsubscribe = subscription?.unsubscribe
      ? subscription.unsubscribe.bind(subscription)
      : null
  }

  notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): Offer[] {
    return [...this.offers]
  }

  getById(id: string): Offer | undefined {
    return this.offers.find((o) => o.id === id)
  }

  getByConversationId(conversationId: string): Offer[] {
    return this.offers.filter((o) => o.conversationId === conversationId)
  }

  findBySpatialScene(sceneId: string): Offer | undefined {
    // Most-recent first — matches the loadForUser order. Pending offers
    // surface before terminal ones for the typical "show me the active
    // Spatial-Offer" use case.
    return this.offers.find((o) => o.sourceSpatialSceneId === sceneId)
  }

  async add(offer: Offer): Promise<void> {
    this.offers = [...this.offers, offer]
    this.notify()
    const { error } = await supabase.from('offers').insert(offerToRow(offer))
    if (error) {
      this.offers = this.offers.filter((o) => o.id !== offer.id)
      this.notify()
      logError('repository.offers.add_failed', error, { entityId: offer.id })
      recordPersistenceFailure({ domain: 'offers', operation: 'add', entityId: offer.id, error, occurredAt: Date.now() })
      throw error
    }
  }

  async update(offerId: string, updater: (offer: Offer) => Offer): Promise<void> {
    const previous = this.offers.find((o) => o.id === offerId)
    this.offers = this.offers.map((o) => (o.id === offerId ? updater(o) : o))
    this.notify()
    const updated = this.offers.find((o) => o.id === offerId)
    if (updated) {
      const { error } = await supabase
        .from('offers')
        .update(offerToRow(updated))
        .eq('id', offerId)
      if (error) {
        if (previous) {
          this.offers = this.offers.map((o) => (o.id === offerId ? previous : o))
          this.notify()
        }
        logError('repository.offers.update_failed', error, { entityId: offerId })
        recordPersistenceFailure({ domain: 'offers', operation: 'update', entityId: offerId, error, occurredAt: Date.now() })
        throw error
      }
    }
  }

  async createViaSpatialQuoteRpc(input: CreateSpatialOfferRpcInput): Promise<Offer> {
    // RPC call. Errors from server-side guards (28000 auth, 22023 input,
    // 42501 RBAC / Pro-Gate) are surfaced as-is via supabase-js; the caller
    // workflow maps them into the typed result.
    const { data, error } = await supabase.rpc('create_spatial_offer', {
      p_id: input.id,
      p_scene_id: input.sceneId,
      p_document_type: input.documentType,
      p_price: input.price,
      p_net_total: input.netTotal,
      p_gross_total: input.grossTotal,
      p_vat_amount: input.vatAmount,
      p_vat_rate: input.vatRate,
      p_currency: input.currency ?? 'EUR',
      p_line_items: input.lineItems ?? [],
      p_spatial_metadata: input.spatialMetadata ?? {},
      p_description: input.description ?? null,
      p_conversation_id: input.conversationId ?? null,
    })
    if (error) {
      logError('repository.offers.create_spatial_offer_failed', error, {
        entityId: input.id,
        sceneId: input.sceneId,
      })
      recordPersistenceFailure({
        domain: 'offers',
        operation: 'create_spatial_offer',
        entityId: input.id,
        error,
        occurredAt: Date.now(),
      })
      throw error
    }

    // RPC returns the inserted (or idempotent-existing) row. PostgREST returns
    // a single composite row for `RETURNS public.offers` — supabase-js exposes
    // it as the `data` object directly (not wrapped in an array).
    const row = data as OfferRow
    if (row == null || row.id == null) {
      const empty = new Error(
        'create_spatial_offer returned empty row — RPC contract violation'
      )
      logError('repository.offers.create_spatial_offer_empty', empty, { entityId: input.id })
      throw empty
    }

    const created = rowToOffer(row)

    // Update local cache so subscribers see the new offer immediately. If a
    // row with the same id is already present (idempotent retry), replace it.
    const existingIdx = this.offers.findIndex((o) => o.id === created.id)
    if (existingIdx >= 0) {
      const next = [...this.offers]
      next[existingIdx] = created
      this.offers = next
    } else {
      this.offers = [created, ...this.offers]
    }
    this.notify()

    return created
  }

  reset(): void {
    this.resetState()
  }

  prepareForResync(): void {
    this._initPromise = null
    this._loadGeneration++
  }
}
