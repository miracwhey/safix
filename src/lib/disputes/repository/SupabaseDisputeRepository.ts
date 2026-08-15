import { supabase } from '../../supabase'
import { recordPersistenceFailure } from '../../persistence'
import { logBreadcrumb, logError, logInfo, logWarning } from '../../observability'
import { isValidUUID } from '../../shared/generateUUID'
import type {
  Dispute,
  DisputeContextSnapshot,
  DisputeDecision,
  DisputeEvidence,
  DisputeReason,
  DisputeStatus,
  ResolutionType,
  SettlementStatus,
  SplitProposal,
  SplitProposalStatus,
} from '../types'
import type { DisputeRepository } from './DisputeRepository'

type Listener = () => void

// ─── Production row contract ──────────────────────────────────────────────────
// Matches the `public.disputes` schema as deployed against production
// (Block 5.5b audit, 2026-04-28). Columns absent from the DB (`title`,
// top-level `evidence`) are NOT part of this contract — UI-only fields like
// `title` and the `DisputeEvidence[]` array are stored inside `metadata` jsonb.
//
// Timestamps are exchanged as ISO `timestamptz` strings; the domain `Dispute`
// keeps them as epoch-ms numbers for compatibility with the in-memory layer
// and existing selectors. Conversion happens in `rowToDispute` /
// `disputeToRow`.

interface DisputeMetadata {
  /** UI-display title for the dispute. Persisted in metadata, not its own column. */
  title?: string
  /** Evidence array. Persisted in metadata; the production schema has no `evidence` column. */
  evidence?: DisputeEvidence[]
  /** Pass-through bag for any other server-side metadata fields the RPC layer adds. */
  [key: string]: unknown
}

interface DisputeRow {
  id: string
  job_id: string
  payment_id: string | null
  project_id: string | null
  opened_by_profile_id: string | null
  customer_profile_id: string | null
  provider_id: string | null
  status: string
  reason: string
  description: string
  resolution_type: string | null
  resolution_note: string | null
  refund_amount: number
  release_amount: number
  provider_award_amount: number
  customer_refund_amount: number
  split_ratio: number | null
  settlement_status: string | null
  raised_by: string | null
  decision: string | null
  metadata: DisputeMetadata | null
  context_snapshot: DisputeContextSnapshot | null
  opened_at: string
  resolved_at: string | null
  closed_at: string | null
  created_at: string
  updated_at: string
}

const ACTIVE_DISPUTE_STATUSES: DisputeStatus[] = [
  'open',
  'under_review',
  'customer_waiting',
  'provider_waiting',
]

const TERMINAL_DISPUTE_STATUSES: ReadonlySet<DisputeStatus> = new Set([
  'resolved',
  'closed',
  'cancelled',
])

/**
 * A resolved dispute can receive exactly one safe realtime follow-up: the
 * financial settlement completing. All decision fields must remain identical
 * and the server timestamp must not move backwards, so a delayed/replayed row
 * cannot revise a terminal decision in the local cache.
 */
function isTerminalSettlementCompletion(current: Dispute, incoming: Dispute): boolean {
  return current.status === incoming.status
    && current.settlementStatus === 'pending'
    && incoming.settlementStatus === 'settled'
    && current.decision === incoming.decision
    && current.resolutionType === incoming.resolutionType
    && current.splitRatio === incoming.splitRatio
    && current.resolvedAt === incoming.resolvedAt
    && incoming.updatedAt >= current.updatedAt
}

function rowToDispute(row: DisputeRow): Dispute {
  const meta: DisputeMetadata = (row.metadata ?? {}) as DisputeMetadata
  const evidence = Array.isArray(meta.evidence) ? (meta.evidence as DisputeEvidence[]) : undefined
  const title = typeof meta.title === 'string' ? meta.title : ''

  // opened_at is the canonical "when did the dispute begin" timestamp; created_at
  // tracks row creation. Domain `createdAt` aligns with the dispute lifecycle, so
  // prefer opened_at and fall back to created_at when opened_at is unexpectedly
  // null (e.g. legacy rows pre-Block 5.5b).
  const createdAtIso = row.opened_at ?? row.created_at
  if (createdAtIso == null) {
    throw new Error(`dispute_row_invalid_timestamps: id=${row.id} (opened_at + created_at both null)`)
  }

  return {
    id: row.id,
    jobId: row.job_id,
    status: row.status as DisputeStatus,
    reason: row.reason as DisputeReason,
    title,
    description: row.description,
    createdAt: createdAtIso,
    updatedAt: row.updated_at ?? createdAtIso,
    ...(row.payment_id != null && { paymentId: row.payment_id }),
    ...(row.raised_by != null && { raisedBy: row.raised_by }),
    ...(row.decision != null && { decision: row.decision as DisputeDecision }),
    ...(row.resolution_type != null && { resolutionType: row.resolution_type as ResolutionType }),
    ...(row.split_ratio != null && { splitRatio: row.split_ratio }),
    ...(row.settlement_status != null && { settlementStatus: row.settlement_status as SettlementStatus }),
    ...(row.resolved_at != null && { resolvedAt: row.resolved_at }),
    ...(evidence != null && { evidence }),
    ...(row.context_snapshot != null && { contextSnapshot: row.context_snapshot }),
  }
}

function metadataFromDispute(dispute: Dispute, base: DisputeMetadata = {}): DisputeMetadata {
  // Title and evidence are UI-domain fields without their own column — they
  // ride inside metadata. Spread `base` first so server-side metadata keys
  // (audit trails added by RPCs etc.) survive a client-side write.
  return {
    ...base,
    title: dispute.title,
    evidence: dispute.evidence ?? [],
  }
}

function disputeToInsertRow(dispute: Dispute): DisputeRow {
  // Used by `add()` only — full row insert. Numeric amount columns are
  // NOT NULL with default 0 in the DB, so we mirror that locally.
  return {
    id: dispute.id,
    job_id: dispute.jobId,
    payment_id: dispute.paymentId ?? null,
    project_id: null,
    opened_by_profile_id: dispute.raisedBy ?? null,
    customer_profile_id: dispute.contextSnapshot?.customerUserId ?? null,
    provider_id: dispute.contextSnapshot?.craftsmanUserId ?? null,
    status: dispute.status,
    reason: dispute.reason,
    description: dispute.description,
    resolution_type: dispute.resolutionType ?? null,
    resolution_note: null,
    refund_amount: 0,
    release_amount: 0,
    provider_award_amount: 0,
    customer_refund_amount: 0,
    split_ratio: dispute.splitRatio ?? null,
    settlement_status: dispute.settlementStatus ?? null,
    raised_by: dispute.raisedBy ?? null,
    decision: dispute.decision ?? null,
    metadata: metadataFromDispute(dispute),
    context_snapshot: dispute.contextSnapshot ?? null,
    opened_at: dispute.createdAt,
    resolved_at: dispute.resolvedAt ?? null,
    closed_at: null,
    created_at: dispute.createdAt,
    updated_at: dispute.updatedAt,
  }
}

function buildUpdatePatch(prev: Dispute, next: Dispute): Partial<DisputeRow> {
  // Field-by-field diff so we never null a column we did not intend to touch.
  const patch: Partial<DisputeRow> = {}
  if (prev.status !== next.status) patch.status = next.status
  if (prev.decision !== next.decision) patch.decision = next.decision ?? null
  if (prev.resolutionType !== next.resolutionType) {
    patch.resolution_type = next.resolutionType ?? null
  }
  if (prev.splitRatio !== next.splitRatio) patch.split_ratio = next.splitRatio ?? null
  if (prev.settlementStatus !== next.settlementStatus) {
    patch.settlement_status = next.settlementStatus ?? null
  }
  if (prev.reason !== next.reason) patch.reason = next.reason
  if (prev.description !== next.description) patch.description = next.description
  if (prev.paymentId !== next.paymentId) patch.payment_id = next.paymentId ?? null
  if (prev.raisedBy !== next.raisedBy) patch.raised_by = next.raisedBy ?? null
  if (prev.resolvedAt !== next.resolvedAt) {
    patch.resolved_at = next.resolvedAt ?? null
  }
  if (prev.contextSnapshot !== next.contextSnapshot) {
    patch.context_snapshot = next.contextSnapshot ?? null
  }
  // updated_at only when something else moved; otherwise the patch is empty
  // and `update()` skips the network call.
  if (Object.keys(patch).length > 0 || prev.updatedAt !== next.updatedAt) {
    patch.updated_at = next.updatedAt
  }
  return patch
}

function metadataNeedsRewrite(prev: Dispute, next: Dispute): boolean {
  if (prev.title !== next.title) return true
  const prevEvidence = prev.evidence ?? []
  const nextEvidence = next.evidence ?? []
  if (prevEvidence.length !== nextEvidence.length) return true
  for (let i = 0; i < prevEvidence.length; i += 1) {
    if (prevEvidence[i] !== nextEvidence[i]) return true
  }
  return false
}

// ─── Consensus-split proposal row contract (P4 Teil B) ────────────────────────
// Maps `public.dispute_split_proposals` (uuid PK, numeric proposed_ratio,
// timestamptz columns) to the domain `SplitProposal`. The RPCs return this row
// as JSONB; numeric columns may arrive as a string, so `proposed_ratio` is
// coerced with `Number()`.
interface SplitProposalRow {
  id: string
  dispute_id: string
  job_id: string
  proposed_by: string
  proposed_ratio: number | string
  status: string
  confirmed_by: string | null
  proposal_round: number
  created_at: string
  updated_at: string
}

function splitProposalRowToDomain(row: SplitProposalRow): SplitProposal {
  return {
    id: row.id,
    disputeId: row.dispute_id,
    jobId: row.job_id,
    proposedBy: row.proposed_by,
    proposedRatio: Number(row.proposed_ratio),
    status: row.status as SplitProposalStatus,
    proposalRound: row.proposal_round,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.confirmed_by != null && { confirmedBy: row.confirmed_by }),
  }
}

/**
 * Supabase-backed implementation of the DisputeRepository interface.
 *
 * Uses a local in-memory cache to serve synchronous reads, keeping the
 * reactive subscription model intact while all writes also persist to the
 * `disputes` table.
 *
 * Bootstrap sequence:
 * 1. Construct the repository.
 * 2. Register it via `setDisputeRepository()`.
 * 3. Await `initializeDisputeRepository()` (or `repo.initialize()` directly)
 *    to load the initial dataset from Supabase before the UI first renders.
 *
 * Write path (optimistic + rollback):
 * - All write methods update the local cache and notify subscribers
 *   immediately so the UI stays responsive.
 * - The corresponding Supabase mutation is awaited.  On failure the
 *   optimistic cache update is rolled back, the error is logged, and the
 *   error is re-thrown to the caller so no downstream logic proceeds on
 *   false local truth.
 *
 * Realtime path:
 * - After initial load, a Supabase Realtime channel subscribes to INSERT
 *   and UPDATE events on the `disputes` table.  INSERT rows are deduplicated
 *   by ID.  UPDATE rows replace the existing cache entry so status/decision
 *   changes driven by the other party or by operator resolution appear
 *   without a manual reload.
 *
 * Block 5.5b note: this file maps to the production schema, but the operator
 * RPC + open_dispute_atomic signatures are still being aligned in Block 5.6.
 * Until that migration ships, the production runtime path remains gated —
 * see the `// REQUIRES 5.6 MIGRATION` markers below.
 */
export class SupabaseDisputeRepository implements DisputeRepository {
  private disputes: Dispute[] = []
  private authUnsubscribe: (() => void) | null = null
  private readonly listeners = new Set<Listener>()
  private _hydrated = false
  private currentUid: string | null = null
  private _initPromise: Promise<void> | null = null
  private _loadGeneration = 0
  /** Active Supabase Realtime channel, or null when not subscribed. */
  private realtimeChannel: ReturnType<typeof supabase.channel> | null = null
  /** Track whether realtime is connected. */
  private isRealtimeConnected = false
  /** Track reconnection attempts to prevent infinite retry spam. */
  private reconnectAttempts = 0
  /** Maximum reconnection attempts before giving up. */
  private readonly MAX_RECONNECT_ATTEMPTS = 5
  /** Delay between reconnection attempts (ms). */
  private readonly RECONNECT_DELAY = 3000
  /** Generation counter — incremented on every new channel to invalidate stale subscribe callbacks. */
  private realtimeGeneration = 0

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
        this.ensureAuthListener()
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

  reset(): void {
    this._initPromise = null
    this._loadGeneration++
  }

  prepareForResync(): void {
    this._initPromise = null
    this._loadGeneration++
  }

  private async fetchDisputesFromDatabase(): Promise<Dispute[]> {
    const { data, error } = await supabase
      .from('disputes')
      .select('*')
      .order('opened_at', { ascending: false })
      .limit(100)
    if (error) throw error
    return ((data ?? []) as DisputeRow[]).map(rowToDispute)
  }

  private async loadForUser(uid: string, generationSnapshot: number): Promise<void> {
    this.currentUid = uid
    const disputes = await this.fetchDisputesFromDatabase()
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    this.disputes = disputes
    this.notify()
    this.startRealtimeSubscription(uid)
  }

  private resetState(): void {
    this._initPromise = null
    this.realtimeGeneration++
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
      this.realtimeChannel = null
    }
    this.currentUid = null
    this.disputes = []
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
        this.resetState()
      }
    })
    this.authUnsubscribe = subscription?.unsubscribe
      ? subscription.unsubscribe.bind(subscription)
      : null
  }

  /**
   * Subscribes to INSERT and UPDATE events on the `disputes` table via Supabase Realtime.
   *
   * INSERT deduplication: if the arriving dispute ID already exists in the local cache
   * (inserted optimistically by this client) we silently drop it.
   *
   * UPDATE merge: replaces the existing cache entry by ID so that operator status
   * transitions (open → under_review → resolved_*) and decision changes appear
   * without a manual reload.  If the dispute is not yet in the local cache, it is
   * added — handles the case where the other party opens a dispute while this user
   * has the job detail screen open.
   */
  private startRealtimeSubscription(uid: string, fromReconnection = false): void {
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
    }
    const generation = ++this.realtimeGeneration
    this.realtimeChannel = supabase
      .channel(`fixup-disputes-${uid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'disputes' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as DisputeRow
          if (this.disputes.some((d) => d.id === row.id)) return
          this.disputes = [rowToDispute(row), ...this.disputes]
          this.notify()
          logInfo('dispute.realtime_inserted', { disputeId: row.id, jobId: row.job_id })
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'disputes' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as DisputeRow
          const current = this.disputes.find((d) => d.id === row.id)
          const incoming = rowToDispute(row)
          // Terminal guard: resolved/closed/cancelled disputes must not be
          // overwritten by stale or replayed realtime events. The one allowed
          // transition is settlement_status pending -> settled with unchanged
          // decision truth, emitted after the payment action succeeds.
          if (
            current
            && TERMINAL_DISPUTE_STATUSES.has(current.status)
            && !isTerminalSettlementCompletion(current, incoming)
          ) return
          if (current) {
            this.disputes = this.disputes.map((d) => (d.id === row.id ? incoming : d))
          } else {
            this.disputes = [incoming, ...this.disputes]
          }
          this.notify()
          logInfo('dispute.realtime_updated', { disputeId: row.id, jobId: row.job_id, status: row.status })
        },
      )
      .subscribe((status) => {
        if (generation !== this.realtimeGeneration) return
        if (status === 'SUBSCRIBED') {
          this.isRealtimeConnected = true
          this.reconnectAttempts = 0
          logInfo('dispute.realtime_connected', { userId: uid })
          if (fromReconnection) void this.fallbackRefresh(uid)
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.isRealtimeConnected = false
          logBreadcrumb(
            'repository.disputes.realtime_disconnected',
            'warning',
            { userId: uid, status },
          )
          void this.fallbackRefresh(uid)
          this.attemptReconnection(uid)
        }
      })
  }

  /**
   * Fallback refresh: re-fetches all disputes from the database when realtime fails.
   */
  private async fallbackRefresh(uid: string): Promise<void> {
    try {
      const freshDisputes = await this.fetchDisputesFromDatabase()
      this.disputes = freshDisputes
      this.notify()
      logInfo('dispute.fallback_refresh_completed', { userId: uid })
    } catch (error) {
      logError('repository.disputes.fallback_refresh_error', error as Error, { userId: uid })
    }
  }

  /**
   * Attempt to reconnect the realtime subscription with exponential backoff.
   */
  private attemptReconnection(uid: string): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logWarning(
        'repository.disputes.realtime_reconnect_exhausted',
        { userId: uid, attempts: this.reconnectAttempts },
      )
      return
    }

    this.reconnectAttempts++
    logInfo('dispute.realtime_reconnect_attempt', {
      userId: uid,
      attempt: this.reconnectAttempts,
      maxAttempts: this.MAX_RECONNECT_ATTEMPTS,
    })

    setTimeout(() => {
      if (!this.isRealtimeConnected && this.currentUid === uid) {
        this.startRealtimeSubscription(uid, true)
      }
    }, this.RECONNECT_DELAY * this.reconnectAttempts)
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): Dispute[] {
    return [...this.disputes]
  }

  getById(disputeId: string): Dispute | undefined {
    return this.disputes.find((dispute) => dispute.id === disputeId)
  }

  getByJobId(jobId: string): Dispute | undefined {
    return this.disputes.find((dispute) => dispute.jobId === jobId)
  }

  getDisputesByJob(jobId: string): Dispute[] {
    return this.disputes.filter((dispute) => dispute.jobId === jobId)
  }

  /**
   * Best-effort audit trail write.
   *
   * The primary dispute mutation (`add` / `update`) is always awaited, rolled
   * back on failure, and re-thrown — only this audit row is fire-and-forget so
   * a transient failure does not cascade into a user-facing dispute error.
   *
   * Schema: matches `dispute_status_history` (Block 5.5b production):
   *   previous_status text NULL, next_status text NOT NULL,
   *   source ('client'|'server'|'webhook'|'system'|'admin'),
   *   metadata jsonb DEFAULT '{}', note text NULL, created_at DEFAULT now().
   *
   * Operator-driven transitions DO NOT call this: the operator RPC writes the
   * history row server-side. RLS / RPC hardening for client-driven writes
   * lands in Block 5.6.
   */
  private writeStatusHistory(
    dispute: Dispute,
    previousStatus: DisputeStatus | null,
    nextStatus: DisputeStatus,
    options: { note?: string | null; metadata?: Record<string, unknown> } = {},
  ): void {
    supabase
      .from('dispute_status_history')
      .insert({
        dispute_id: dispute.id,
        job_id: dispute.jobId,
        previous_status: previousStatus,
        next_status: nextStatus,
        source: 'client',
        note: options.note ?? null,
        metadata: options.metadata ?? {},
        created_at: new Date().toISOString(),
      })
      .then(({ error }) => {
        if (error) {
          logError('repository.disputes.history_failed', error, {
            entityId: dispute.id,
            previousStatus,
            nextStatus,
          })
          recordPersistenceFailure({
            domain: 'disputes/history',
            operation: 'history',
            entityId: dispute.id,
            error,
            occurredAt: Date.now(),
          })
        }
      })
  }

  async add(dispute: Dispute): Promise<void> {
    // UUID guard: the `disputes.id` column is `uuid` in production. Reject
    // synthetic/legacy IDs at the boundary instead of silently normalising
    // them — a normalisation would mask the upstream domain bug.
    if (!isValidUUID(dispute.id)) {
      const err = new Error(
        `dispute_id_not_uuid: refusing to insert dispute with non-UUID id=${dispute.id}`,
      )
      logError('repository.disputes.invalid_id', err, { entityId: dispute.id, jobId: dispute.jobId })
      throw err
    }

    this.disputes = [dispute, ...this.disputes]
    this.notify()
    const { error } = await supabase
      .from('disputes')
      .insert(disputeToInsertRow(dispute))
    if (error) {
      this.disputes = this.disputes.filter((d) => d.id !== dispute.id)
      this.notify()
      logError('repository.disputes.add_failed', error, { entityId: dispute.id, jobId: dispute.jobId })
      recordPersistenceFailure({ domain: 'disputes', operation: 'add', entityId: dispute.id, error, occurredAt: Date.now() })
      throw error
    }
    // Initial entry in the audit trail (previous_status = NULL).
    this.writeStatusHistory(dispute, null, dispute.status)
  }

  async update(disputeId: string, updater: (dispute: Dispute) => Dispute): Promise<void> {
    const previous = this.disputes.find((d) => d.id === disputeId)
    if (!previous) return
    const updated = updater(previous)
    this.disputes = this.disputes.map((dispute) =>
      dispute.id === disputeId ? updated : dispute,
    )
    this.notify()

    const patch = buildUpdatePatch(previous, updated)
    const needsMetadataRewrite = metadataNeedsRewrite(previous, updated)
    if (Object.keys(patch).length === 0 && !needsMetadataRewrite) return

    try {
      if (needsMetadataRewrite) {
        // Read-merge-write so concurrent server writes (e.g. RPC-added audit
        // keys) are not blown away by the client patch.
        const { data: metaRow, error: fetchErr } = await supabase
          .from('disputes')
          .select('metadata')
          .eq('id', disputeId)
          .maybeSingle()
        if (fetchErr) throw fetchErr
        const serverMeta = ((metaRow as { metadata: DisputeMetadata | null } | null)?.metadata ?? {}) as DisputeMetadata
        ;(patch as DisputeRow).metadata = metadataFromDispute(updated, serverMeta)
      }

      const { error } = await supabase
        .from('disputes')
        .update(patch)
        .eq('id', disputeId)
      if (error) throw error
    } catch (error) {
      this.disputes = this.disputes.map((d) => (d.id === disputeId ? previous : d))
      this.notify()
      logError('repository.disputes.update_failed', error as Error, { entityId: disputeId })
      recordPersistenceFailure({
        domain: 'disputes',
        operation: 'update',
        entityId: disputeId,
        error: error as Error,
        occurredAt: Date.now(),
      })
      throw error
    }

    if (previous.status !== updated.status) {
      this.writeStatusHistory(updated, previous.status, updated.status)
    }
  }

  /**
   * Applies a dispute committed by the `open_dispute_atomic` RPC into the
   * local cache without issuing a second INSERT to Supabase.  The RPC owns
   * both the row write AND the initial history entry, so this method
   * deliberately does NOT call `writeStatusHistory`.
   */
  applyFromRpc(dispute: Dispute): void {
    const exists = this.disputes.some((d) => d.id === dispute.id)
    if (exists) {
      this.disputes = this.disputes.map((d) => (d.id === dispute.id ? dispute : d))
    } else {
      this.disputes = [dispute, ...this.disputes]
    }
    this.notify()
  }

  /**
   * Calls the `open_dispute_atomic` RPC and applies the result to the local cache.
   *
   * REQUIRES 5.6 MIGRATION: the live RPC signature is still the legacy
   * (text + bigint) shape from Block 5.5a.  Block 5.6 replaces it with a
   * uuid + timestamptz + jsonb signature; the args below already match that
   * target shape, so the call is a no-op until the new RPC ships.
   */
  async openDisputeAtomic(dispute: Dispute): Promise<Dispute> {
    const cached = this.getByJobId(dispute.jobId)
    if (cached) return cached

    if (!isValidUUID(dispute.id)) {
      const err = new Error(
        `dispute_id_not_uuid: refusing to open dispute with non-UUID id=${dispute.id}`,
      )
      logError('repository.disputes.invalid_id', err, { entityId: dispute.id, jobId: dispute.jobId })
      throw err
    }

    const args = {
      p_dispute_id: dispute.id,
      p_job_id: dispute.jobId,
      p_payment_id: dispute.paymentId ?? null,
      p_reason: dispute.reason,
      p_description: dispute.description,
      p_raised_by: dispute.raisedBy ?? null,
      p_metadata: metadataFromDispute(dispute),
      p_context_snapshot: dispute.contextSnapshot ?? null,
      p_opened_at: dispute.createdAt,
    }

    const { error } = await (supabase as unknown as {
      rpc: (
        fn: string,
        params: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { code: string; message: string } | null }>
    }).rpc('open_dispute_atomic', args)

    if (error) {
      if (error.code === '23505') {
        const existing = this.getByJobId(dispute.jobId)
        if (existing) return existing
        const { data } = await supabase
          .from('disputes')
          .select('*')
          .eq('job_id', dispute.jobId)
          .in('status', ACTIVE_DISPUTE_STATUSES)
          .order('opened_at', { ascending: false })
          .limit(1)
          .single()
        if (data) {
          const fetched = rowToDispute(data as DisputeRow)
          this.applyFromRpc(fetched)
          return fetched
        }
        throw new Error(`active dispute exists for job ${dispute.jobId} but could not be fetched from database`)
      }
      logError('repository.disputes.open_atomic_failed', error as unknown as Error, {
        entityId: dispute.id,
        jobId: dispute.jobId,
      })
      recordPersistenceFailure({
        domain: 'disputes',
        operation: 'open_atomic',
        entityId: dispute.id,
        error: error as unknown as Error,
        occurredAt: Date.now(),
      })
      throw error
    }

    this.applyFromRpc(dispute)
    return dispute
  }

  /**
   * H24: party statement submit via SECURITY DEFINER RPC. The RPC owns the
   * disputes UPDATE (sentinel-gated trigger), the dispute_status_history row
   * (source='client') AND the jobs.dispute_status mirror — so this method
   * MUST NOT call writeStatusHistory (double history row otherwise).
   */
  async partySubmitStatement(disputeId: string, evidence: DisputeEvidence): Promise<Dispute> {
    const { data, error } = await (supabase as unknown as {
      rpc: (
        name: string,
        params: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>
    }).rpc('party_submit_dispute_statement', {
      p_dispute_id: disputeId,
      p_evidence: evidence,
    })

    if (error) {
      logError('repository.disputes.party_statement_failed', error as unknown as Error, {
        entityId: disputeId,
        code: error.code ?? null,
      })
      recordPersistenceFailure({
        domain: 'disputes',
        operation: 'update',
        entityId: disputeId,
        error: error as unknown as Error,
        occurredAt: Date.now(),
      })
      throw error
    }

    if (!data || typeof data !== 'object') {
      const err = new Error(
        `party_statement_empty_result: RPC returned no data for dispute ${disputeId}`,
      )
      logError('repository.disputes.party_statement_empty', err, { entityId: disputeId })
      throw err
    }

    const dispute = rowToDispute(data as DisputeRow)
    const exists = this.disputes.some((d) => d.id === dispute.id)
    this.disputes = exists
      ? this.disputes.map((d) => (d.id === dispute.id ? dispute : d))
      : [dispute, ...this.disputes]
    this.notify()
    logInfo('dispute.party_statement_applied', { disputeId, status: dispute.status })
    return dispute
  }

  restartRealtimeIfDead(options?: { force?: boolean }): void {
    if (!this.currentUid) return
    // force: pessimistic restart after a real background stay — the socket
    // can be dead while isRealtimeConnected still reads true (iOS zombie).
    if (!options?.force && this.isRealtimeConnected) return
    this.isRealtimeConnected = false
    this.reconnectAttempts = 0
    this.startRealtimeSubscription(this.currentUid, true)
  }

  // ── Operator transitions ──────────────────────────────────────────────────
  // Each method calls a SECURITY DEFINER RPC that re-verifies the caller is
  // an operator (profiles.is_operator = true), validates the from-status,
  // applies the update, writes dispute_status_history with source='admin' /
  // 'system', and mirrors the lifecycle status onto jobs.dispute_status. The
  // RPC returns the updated dispute row as JSONB so we can refresh the local
  // cache without waiting for a realtime echo.
  //
  // RLS / trigger contract: the disputes_status_change_guard trigger blocks
  // any non-operator status mutation that bypasses these RPCs (e.g. a raw
  // supabase.from('disputes').update({status:...}) call).
  //
  // REQUIRES 5.6 MIGRATION: the names below are the Block 5.6 target names —
  // the production functions today still use the Block 5.5a names. The names
  // are aligned here so the App-Layer is wired against the final RPC contract
  // before 5.6 lands.

  /**
   * Resolves the dispute id for an operator RPC call.
   *
   * Operator workflows take a `jobId` (UI affordance) but the RPC contract
   * requires `p_dispute_id uuid`. We resolve via the local cache; if the
   * dispute is not cached we surface a hard error rather than a phantom
   * call so the UI cannot accidentally drive the wrong row.
   */
  private resolveOperatorDisputeId(jobId: string): string {
    const cached = this.getByJobId(jobId)
    if (!cached) {
      throw new Error(`dispute_not_found: no cached dispute for job ${jobId}`)
    }
    return cached.id
  }

  private async callOperatorDisputeRpc(
    fn: string,
    jobId: string,
    extraArgs: Record<string, unknown> = {},
  ): Promise<Dispute> {
    const disputeId = this.resolveOperatorDisputeId(jobId)
    const args = { p_dispute_id: disputeId, ...extraArgs }

    const { data, error } = await (supabase as unknown as {
      rpc: (
        name: string,
        params: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>
    }).rpc(fn, args)

    if (error) {
      logError('repository.disputes.operator_rpc_failed', error as unknown as Error, {
        rpc: fn,
        jobId,
        disputeId,
        code: error.code ?? null,
      })
      recordPersistenceFailure({
        domain: 'disputes',
        operation: fn as unknown as 'update',
        entityId: disputeId,
        error: error as unknown as Error,
        occurredAt: Date.now(),
      })
      throw error
    }

    if (!data || typeof data !== 'object') {
      const err = new Error(`operator_rpc_empty_result: ${fn} returned no data for dispute ${disputeId}`)
      logError('repository.disputes.operator_rpc_empty', err, { rpc: fn, jobId, disputeId })
      throw err
    }

    const dispute = rowToDispute(data as DisputeRow)
    // The RPC already wrote audit history server-side, so we MUST NOT call
    // writeStatusHistory here.
    const exists = this.disputes.some((d) => d.id === dispute.id)
    if (exists) {
      this.disputes = this.disputes.map((d) => (d.id === dispute.id ? dispute : d))
    } else {
      this.disputes = [dispute, ...this.disputes]
    }
    this.notify()
    logInfo('dispute.operator_rpc_applied', { rpc: fn, jobId, disputeId, status: dispute.status })
    return dispute
  }

  async operatorRequestCustomerEvidence(jobId: string): Promise<Dispute> {
    return this.callOperatorDisputeRpc('operator_request_customer_evidence_dispute', jobId)
  }

  async operatorRequestProviderEvidence(jobId: string): Promise<Dispute> {
    return this.callOperatorDisputeRpc('operator_request_provider_evidence_dispute', jobId)
  }

  async operatorMarkUnderReview(jobId: string): Promise<Dispute> {
    return this.callOperatorDisputeRpc('operator_mark_dispute_under_review', jobId)
  }

  async operatorResolveRelease(jobId: string): Promise<Dispute> {
    return this.callOperatorDisputeRpc('operator_resolve_dispute_release', jobId)
  }

  async operatorResolveRefund(jobId: string): Promise<Dispute> {
    return this.callOperatorDisputeRpc('operator_resolve_dispute_refund', jobId)
  }

  async operatorResolveSplit(jobId: string, splitRatio: number): Promise<Dispute> {
    return this.callOperatorDisputeRpc(
      'operator_resolve_dispute_split',
      jobId,
      { p_split_ratio: splitRatio },
    )
  }

  async operatorReject(jobId: string): Promise<Dispute> {
    return this.callOperatorDisputeRpc('operator_reject_dispute', jobId)
  }

  // ── Consensus-split proposal flow (P4 Teil B) ─────────────────────────────
  // propose / confirm / reject route through SECURITY DEFINER RPCs that enforce
  // ALL authorization + state guards in the database against auth.uid()
  // (party-of-dispute, proposer-cannot-confirm, ratio bounds, single pending
  // proposal, dispute-not-resolved). The trigger that normally blocks status
  // mutations is bypassed inside the RPC via a transaction-local sentinel GUC.
  // Mirrors the operator-RPC error handling above; the RPCs own all DB writes
  // and audit history, so these methods never call writeStatusHistory.

  async proposeSplit(disputeId: string, ratio: number): Promise<SplitProposal> {
    const { data, error } = await (supabase as unknown as {
      rpc: (
        name: string,
        params: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>
    }).rpc('propose_split_atomic', {
      p_dispute_id: disputeId,
      p_ratio: ratio,
    })

    if (error) {
      logError('repository.disputes.propose_split_failed', error as unknown as Error, {
        entityId: disputeId,
        code: error.code ?? null,
      })
      recordPersistenceFailure({
        domain: 'disputes',
        operation: 'update',
        entityId: disputeId,
        error: error as unknown as Error,
        occurredAt: Date.now(),
      })
      throw error
    }

    if (!data || typeof data !== 'object') {
      const err = new Error(
        `propose_split_empty_result: RPC returned no data for dispute ${disputeId}`,
      )
      logError('repository.disputes.propose_split_empty', err, { entityId: disputeId })
      throw err
    }

    const proposal = splitProposalRowToDomain(data as SplitProposalRow)
    logInfo('dispute.split_proposed', {
      disputeId,
      proposalId: proposal.id,
      proposalRound: proposal.proposalRound,
    })
    return proposal
  }

  async confirmSplitProposal(proposalId: string): Promise<Dispute> {
    const { data, error } = await (supabase as unknown as {
      rpc: (
        name: string,
        params: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>
    }).rpc('confirm_split_proposal', {
      p_proposal_id: proposalId,
    })

    if (error) {
      logError('repository.disputes.confirm_split_failed', error as unknown as Error, {
        entityId: proposalId,
        code: error.code ?? null,
      })
      recordPersistenceFailure({
        domain: 'disputes',
        operation: 'update',
        entityId: proposalId,
        error: error as unknown as Error,
        occurredAt: Date.now(),
      })
      throw error
    }

    if (!data || typeof data !== 'object') {
      const err = new Error(
        `confirm_split_empty_result: RPC returned no data for proposal ${proposalId}`,
      )
      logError('repository.disputes.confirm_split_empty', err, { entityId: proposalId })
      throw err
    }

    // confirm_split_proposal returns the resolved DISPUTE row. Refresh the
    // local cache so the UI reflects the split resolution without waiting for
    // the realtime echo. The RPC already wrote audit history server-side.
    const dispute = rowToDispute(data as DisputeRow)
    const exists = this.disputes.some((d) => d.id === dispute.id)
    this.disputes = exists
      ? this.disputes.map((d) => (d.id === dispute.id ? dispute : d))
      : [dispute, ...this.disputes]
    this.notify()
    logInfo('dispute.split_confirmed', {
      proposalId,
      disputeId: dispute.id,
      status: dispute.status,
    })
    return dispute
  }

  async settleSplitConsensus(disputeId: string): Promise<Dispute> {
    // SECURITY DEFINER RPC: re-verifies the caller is a party of the dispute,
    // arms the settle-scoped sentinel GUC so the disputes_status_change_guard
    // trigger admits the settlement write, and flips settlement_status
    // pending→settled (idempotent). A plain PostgREST UPDATE (settleDispute) is
    // rejected here for a party with SQLSTATE 42501 — only operators pass the
    // trigger's operator branch.
    const { data, error } = await (supabase as unknown as {
      rpc: (
        name: string,
        params: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>
    }).rpc('settle_consensus_split', {
      p_dispute_id: disputeId,
    })

    if (error) {
      logError('repository.disputes.settle_consensus_failed', error as unknown as Error, {
        entityId: disputeId,
        code: error.code ?? null,
      })
      recordPersistenceFailure({
        domain: 'disputes',
        operation: 'update',
        entityId: disputeId,
        error: error as unknown as Error,
        occurredAt: Date.now(),
      })
      throw error
    }

    if (!data || typeof data !== 'object') {
      const err = new Error(
        `settle_consensus_empty_result: RPC returned no data for dispute ${disputeId}`,
      )
      logError('repository.disputes.settle_consensus_empty', err, { entityId: disputeId })
      throw err
    }

    // settle_consensus_split returns the settled DISPUTE row. Map it with the
    // same rowToDispute mapper confirmSplitProposal uses and refresh the local
    // cache via applyFromRpc so synchronous reads observe settlement_status=
    // 'settled' without waiting for the realtime echo. The RPC owns the DB write
    // and audit history, so this must NOT call writeStatusHistory.
    const dispute = rowToDispute(data as DisputeRow)
    this.applyFromRpc(dispute)
    logInfo('dispute.split_settled', { disputeId: dispute.id, status: dispute.status })
    return dispute
  }

  async rejectSplitProposal(proposalId: string): Promise<SplitProposal> {
    const { data, error } = await (supabase as unknown as {
      rpc: (
        name: string,
        params: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>
    }).rpc('reject_split_proposal', {
      p_proposal_id: proposalId,
    })

    if (error) {
      logError('repository.disputes.reject_split_failed', error as unknown as Error, {
        entityId: proposalId,
        code: error.code ?? null,
      })
      recordPersistenceFailure({
        domain: 'disputes',
        operation: 'update',
        entityId: proposalId,
        error: error as unknown as Error,
        occurredAt: Date.now(),
      })
      throw error
    }

    if (!data || typeof data !== 'object') {
      const err = new Error(
        `reject_split_empty_result: RPC returned no data for proposal ${proposalId}`,
      )
      logError('repository.disputes.reject_split_empty', err, { entityId: proposalId })
      throw err
    }

    const proposal = splitProposalRowToDomain(data as SplitProposalRow)
    logInfo('dispute.split_rejected', { proposalId, disputeId: proposal.disputeId })
    return proposal
  }

  async getActiveProposal(disputeId: string): Promise<SplitProposal | undefined> {
    const { data, error } = await supabase
      .from('dispute_split_proposals')
      .select(
        'id, dispute_id, job_id, proposed_by, proposed_ratio, status, confirmed_by, proposal_round, created_at, updated_at',
      )
      .eq('dispute_id', disputeId)
      .eq('status', 'pending')
      .maybeSingle()

    if (error) {
      logError('repository.disputes.get_active_proposal_failed', error, { entityId: disputeId })
      throw error
    }

    return data ? splitProposalRowToDomain(data as unknown as SplitProposalRow) : undefined
  }

  async getDisputeForProposal(proposalId: string): Promise<Dispute | undefined> {
    // Step 1 — map proposal → dispute_id. RLS dsp_select_own admits a party of
    // the parent dispute, so a confirming party can always read this row.
    const { data: proposalRow, error: proposalErr } = await supabase
      .from('dispute_split_proposals')
      .select('dispute_id')
      .eq('id', proposalId)
      .maybeSingle()

    if (proposalErr) {
      logError('repository.disputes.dispute_for_proposal_lookup_failed', proposalErr, {
        entityId: proposalId,
      })
      throw proposalErr
    }

    const disputeId = (proposalRow as { dispute_id?: string } | null)?.dispute_id
    if (!disputeId) return undefined

    // Step 2 — prefer the local cache: it carries the freshest state, including
    // settlementStatus='settled' written by settleDispute after a successful
    // money leg (so the retry path can short-circuit an already-settled dispute).
    const cached = this.getById(disputeId)
    if (cached) return cached

    // Fall back to a direct row read when the dispute is not cached (e.g. a
    // cross-device retry on a fresh session before the dispute list reloaded).
    const { data: disputeRow, error: disputeErr } = await supabase
      .from('disputes')
      .select('*')
      .eq('id', disputeId)
      .maybeSingle()

    if (disputeErr) {
      logError('repository.disputes.dispute_for_proposal_fetch_failed', disputeErr, {
        entityId: proposalId,
        disputeId,
      })
      throw disputeErr
    }

    if (!disputeRow) return undefined

    const dispute = rowToDispute(disputeRow as DisputeRow)
    // Refresh the cache so subsequent synchronous reads (getDisputeByJobId) in
    // the settlement flow observe the resolved dispute.
    this.applyFromRpc(dispute)
    return dispute
  }
}
