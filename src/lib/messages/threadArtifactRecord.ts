/**
 * Thread Artifact Record — First-Class Persisted Model
 *
 * Canonical persisted row that owns a business artifact for a conversation.
 * This replaces the old split-brain approach of deriving artifacts from
 * multiple competing repositories at read time.
 *
 * Each record binds one business entity (project, offer, or payment phase)
 * to exactly one conversation, making artifact visibility reload-stable
 * because the linkage itself is persisted — not inferred.
 *
 * artifact_type:
 *   'project'        — customer project card
 *   'offer'          — craftsman offer card
 *   'payment_phase'  — payment lifecycle state (post-acceptance)
 *   'funding_step'   — provider-requested funding card (escrow deposit)
 *   'change_order'   — Nachtrag / change order card (append-only, multiple per conversation)
 *   'invoice'        — Rechnung card (append-only, keyed to invoice id)
 */

export type ArtifactType = 'project' | 'offer' | 'payment_phase' | 'funding_step' | 'change_order' | 'invoice'

export type ThreadArtifactRecord = {
  /** Unique row ID. */
  id: string
  /** Owning conversation — the thread this artifact belongs to. */
  conversationId: string
  /** What kind of business card this record represents. */
  artifactType: ArtifactType

  // ── Business entity references ──────────────────────────────────────
  // Exactly one reference is populated per artifact type.

  /** Canonical project ID (for artifactType='project'). */
  projectId?: string
  /** Canonical offer ID (for artifactType='offer'). */
  offerId?: string
  /** Canonical job ID (for artifactType='payment_phase' or post-acceptance). */
  jobId?: string
  /** Canonical funding request ID (for artifactType='funding_step'). */
  fundingRequestId?: string
  /** Canonical escrow plan ID (for artifactType='funding_step'). */
  escrowPlanId?: string
  /** Canonical ChangeOrder ID (for artifactType='change_order'). */
  changeOrderId?: string
  /** Canonical Invoice ID (for artifactType='invoice'). */
  invoiceId?: string

  // ── State ───────────────────────────────────────────────────────────

  /** Offer lifecycle phase: 'sent' | 'accepted' | 'payment_due' | 'declined'. */
  phase?: string

  // ── Snapshot display data ───────────────────────────────────────────
  // Minimal denormalized display fields persisted at write time.
  // Cards render from these fields immediately — no secondary repo lookup
  // required for basic visibility.  Secondary repos may enrich the card
  // but are never required to make it appear.

  /** Display title (project title or offer summary). */
  snapshotTitle?: string
  /** Status or category label for display. */
  snapshotStatus?: string
  /** Price / amount label (offer/payment). */
  snapshotPrice?: string
  /** Short description or summary text. */
  snapshotSummary?: string
  /** Trade category for compact card display (project artifacts). */
  snapshotCategory?: string
  /** Work location for compact card display (project artifacts). */
  snapshotLocation?: string
  /** Budget range for compact card display (project artifacts). */
  snapshotBudget?: string
  /** Timing preference for compact card display (project artifacts). */
  snapshotTiming?: string
  /** Phase label for display (e.g. 'Angebot liegt vor', 'Anzahlung fällig'). */
  snapshotPhaseLabel?: string
  /**
   * Commercial document type snapshot (Paket 4b).
   * 'binding_offer' | 'estimate' | 'diagnosis'
   * Persisted at write time so the card can show the correct type label
   * without waiting for the Offer entity to hydrate.
   */
  snapshotDocumentType?: string
  /**
   * Offer version at send time (Paket 4b).
   * Persisted at write time for compact version badge display.
   */
  snapshotVersion?: number
  /**
   * Offer validity date (ISO-8601, e.g. '2026-04-30') (Paket 4b).
   * Persisted at write time so the card can show expiry status without
   * the full Offer entity.
   */
  snapshotValidUntil?: string

  // ── Participant scope ───────────────────────────────────────────────

  /** Customer user ID — scopes visibility to the correct customer. */
  customerUserId?: string
  /** Craftsman user ID — scopes visibility to the correct craftsman. */
  craftsmanUserId?: string

  // ── Timestamps ──────────────────────────────────────────────────────

  createdAt: number
  updatedAt: number

  // ── Optimistic concurrency ───────────────────────────────────────────
  // Incremented on every successful DB UPDATE. Used by the repository for
  // CAS (Compare-And-Swap) to detect concurrent writes. Callers must not
  // set this — the repository manages it internally.
  version?: number
}

/**
 * Repository interface for first-class thread artifact records.
 */
export interface ThreadArtifactRepository {
  /** All records for a conversation. */
  getByConversationId(conversationId: string): ThreadArtifactRecord[]
  /** Single record by conversation + type (returns first match). */
  getByConversationAndType(
    conversationId: string,
    type: ArtifactType
  ): ThreadArtifactRecord | undefined
  /** Insert or update (keyed by record id). Returns a Promise that resolves when the write is confirmed (or rejects on failure). */
  upsert(record: ThreadArtifactRecord): Promise<void>
  /** Append-only insert. Always creates a new record (no dedup). Used for multi-send project artifacts. */
  insert(record: ThreadArtifactRecord): Promise<void>
  /** All records (mainly for testing). */
  getAll(): ThreadArtifactRecord[]
  /** Subscribe to changes in the artifact cache. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void
}
