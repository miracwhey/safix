import { supabase } from '../../supabase'
import { recordPersistenceFailure } from '../../persistence'
import { logError } from '../../observability'
import { ConflictError } from '../ConflictError'
import type {
  ArtifactType,
  ThreadArtifactRecord,
  ThreadArtifactRepository,
} from '../threadArtifactRecord'

/**
 * Shape of a `thread_artifacts` row as stored in the Supabase database.
 * Managed by migration 20260323000002_thread_artifacts.sql (base) and
 * 20260323000003_thread_artifacts_snapshot.sql (snapshot hardening).
 */
interface ThreadArtifactRow {
  id: string
  conversation_id: string
  artifact_type: string
  project_id: string | null
  offer_id: string | null
  job_id: string | null
  funding_request_id: string | null
  escrow_plan_id: string | null
  change_order_id: string | null
  invoice_id: string | null
  phase: string | null
  snapshot_title: string | null
  snapshot_status: string | null
  snapshot_price: string | null
  snapshot_summary: string | null
  snapshot_category: string | null
  snapshot_location: string | null
  snapshot_budget: string | null
  snapshot_timing: string | null
  snapshot_phase_label: string | null
  snapshot_document_type: string | null
  snapshot_version: number | null
  snapshot_valid_until: string | null
  customer_user_id: string | null
  craftsman_user_id: string | null
  created_at: number
  updated_at: number
  version: number
}

function rowToRecord(row: ThreadArtifactRow): ThreadArtifactRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    artifactType: row.artifact_type as ArtifactType,
    ...(row.project_id != null && { projectId: row.project_id }),
    ...(row.offer_id != null && { offerId: row.offer_id }),
    ...(row.job_id != null && { jobId: row.job_id }),
    ...(row.funding_request_id != null && { fundingRequestId: row.funding_request_id }),
    ...(row.escrow_plan_id != null && { escrowPlanId: row.escrow_plan_id }),
    ...(row.change_order_id != null && { changeOrderId: row.change_order_id }),
    ...(row.invoice_id != null && { invoiceId: row.invoice_id }),
    ...(row.phase != null && { phase: row.phase }),
    ...(row.snapshot_title != null && { snapshotTitle: row.snapshot_title }),
    ...(row.snapshot_status != null && { snapshotStatus: row.snapshot_status }),
    ...(row.snapshot_price != null && { snapshotPrice: row.snapshot_price }),
    ...(row.snapshot_summary != null && { snapshotSummary: row.snapshot_summary }),
    ...(row.snapshot_category != null && { snapshotCategory: row.snapshot_category }),
    ...(row.snapshot_location != null && { snapshotLocation: row.snapshot_location }),
    ...(row.snapshot_budget != null && { snapshotBudget: row.snapshot_budget }),
    ...(row.snapshot_timing != null && { snapshotTiming: row.snapshot_timing }),
    ...(row.snapshot_phase_label != null && { snapshotPhaseLabel: row.snapshot_phase_label }),
    ...(row.snapshot_document_type != null && { snapshotDocumentType: row.snapshot_document_type }),
    ...(row.snapshot_version != null && { snapshotVersion: row.snapshot_version }),
    ...(row.snapshot_valid_until != null && { snapshotValidUntil: row.snapshot_valid_until }),
    ...(row.customer_user_id != null && { customerUserId: row.customer_user_id }),
    ...(row.craftsman_user_id != null && { craftsmanUserId: row.craftsman_user_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  }
}

function recordToRow(record: ThreadArtifactRecord, version?: number): ThreadArtifactRow {
  return {
    id: record.id,
    conversation_id: record.conversationId,
    artifact_type: record.artifactType,
    project_id: record.projectId ?? null,
    offer_id: record.offerId ?? null,
    job_id: record.jobId ?? null,
    funding_request_id: record.fundingRequestId ?? null,
    escrow_plan_id: record.escrowPlanId ?? null,
    change_order_id: record.changeOrderId ?? null,
    invoice_id: record.invoiceId ?? null,
    phase: record.phase ?? null,
    snapshot_title: record.snapshotTitle ?? null,
    snapshot_status: record.snapshotStatus ?? null,
    snapshot_price: record.snapshotPrice ?? null,
    snapshot_summary: record.snapshotSummary ?? null,
    snapshot_category: record.snapshotCategory ?? null,
    snapshot_location: record.snapshotLocation ?? null,
    snapshot_budget: record.snapshotBudget ?? null,
    snapshot_timing: record.snapshotTiming ?? null,
    snapshot_phase_label: record.snapshotPhaseLabel ?? null,
    snapshot_document_type: record.snapshotDocumentType ?? null,
    snapshot_version: record.snapshotVersion ?? null,
    snapshot_valid_until: record.snapshotValidUntil ?? null,
    customer_user_id: record.customerUserId ?? null,
    craftsman_user_id: record.craftsmanUserId ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    version: version ?? record.version ?? 0,
  }
}

/**
 * Strips null values from a row payload before sending to PostgREST.
 *
 * Prevents "column not found" errors when the DB schema is behind the
 * code schema (columns from unapplied migrations).  PostgREST rejects
 * ANY column in the request body that doesn't exist in the table — even
 * if the value is null.  Omitting null columns is safe because:
 *   - INSERT: the column default (NULL) is used
 *   - UPSERT (UPDATE part): the old value is preserved
 *
 * Required columns (id, conversation_id, artifact_type, created_at,
 * updated_at) are always present and non-null, so they are never stripped.
 */
function stripNullColumns(
  row: ThreadArtifactRow
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (value != null) {
      result[key] = value
    }
  }
  return result
}

/**
 * Supabase-backed implementation of the ThreadArtifactRepository interface.
 *
 * Uses a local in-memory cache to serve synchronous reads, keeping the
 * reactive selector model intact.  All writes are persisted to the
 * `thread_artifacts` table via an awaited Supabase UPSERT — confirmed
 * persistence, not fire-and-forget.
 *
 * Write path:
 * - Optimistic local cache update (immediate, for UI responsiveness)
 * - Awaited Supabase UPSERT (canonical persistence confirmation)
 * - On Supabase failure: cache rolled back + error thrown to caller
 *   so workflows surface hard failures instead of silently showing
 *   cards that are not actually persisted.
 *
 * Bootstrap sequence:
 * 1. Construct the repository.
 * 2. Register it via setThreadArtifactRepository().
 * 3. Await initializeThreadArtifactRepository() to load initial data from
 *    Supabase before the UI first renders.
 *
 * Auth lifecycle:
 * - SIGNED_IN / TOKEN_REFRESHED: reload from Supabase for the new user.
 * - SIGNED_OUT: clear the local cache.
 */
export class SupabaseThreadArtifactRepository implements ThreadArtifactRepository {
  private records: ThreadArtifactRecord[] = []
  private authUnsubscribe: (() => void) | null = null
  private listeners: Set<() => void> = new Set()
  private currentUid: string | null = null
  private _hydrated = false
  private _initPromise: Promise<void> | null = null
  private _loadGeneration = 0

  /**
   * IDs of records that have been optimistically inserted but not yet
   * confirmed by the Supabase write.  If loadForUser() replaces the
   * cache while an insert is in-flight, it must preserve these records
   * so the UI does not lose them.
   */
  private pendingInsertIds: Set<string> = new Set()

  private notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async initialize(): Promise<void> {
    if (this._initPromise) return this._initPromise
    const generation = ++this._loadGeneration
    const p: Promise<void> = (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession()
        if (generation !== this._loadGeneration) return
        if (!session?.user) {
          this.resetState()
          this.ensureAuthListener()
          return
        }
        await this.loadForUser(session.user.id, generation)
        this.ensureAuthListener()
      } catch (error) {
        logError('repository.thread_artifacts.initialize_failed', error as Error, {})
        this.resetState()
        this.ensureAuthListener()
      }
    })()
    this._initPromise = p
    void p.then(
      () => { if (this._initPromise === p) this._initPromise = null },
      () => { if (this._initPromise === p) this._initPromise = null },
    )
    return p
  }

  private async loadForUser(uid: string, generationSnapshot: number): Promise<void> {
    this.currentUid = uid
    const { data, error } = await supabase
      .from('thread_artifacts')
      .select('*')
      .or(`craftsman_user_id.eq.${uid},customer_user_id.eq.${uid}`)
      .order('created_at', { ascending: false })
      .limit(500)

    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return

    if (error) {
      logError('repository.thread_artifacts.load_failed', error, { userId: uid })
      // Don't throw — allow app to continue with empty cache.
      // The selectors' read-only fallback paths will still show cards for
      // old threads while the Supabase connection is restored.
      this.records = []
      return
    }

    const loaded = ((data ?? []) as ThreadArtifactRow[]).map(rowToRecord)

    // Merge pending optimistic inserts that were not yet confirmed.
    // If loadForUser runs while an insert is in-flight, the Supabase
    // query may return before the INSERT completes, so the new record
    // won't be in the query results.  We must preserve those pending
    // records to avoid losing optimistic state.
    if (this.pendingInsertIds.size > 0) {
      const loadedIds = new Set(loaded.map((r) => r.id))
      for (const r of this.records) {
        if (this.pendingInsertIds.has(r.id) && !loadedIds.has(r.id)) {
          loaded.push(r)
        }
      }
    }

    this.records = loaded
    this._hydrated = true
    this.notify()
  }

  private resetState(): void {
    this._initPromise = null
    this._hydrated = false
    this.currentUid = null
    this.records = []
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

  // ── ThreadArtifactRepository interface ─────────────────────────────────

  getByConversationId(conversationId: string): ThreadArtifactRecord[] {
    return this.records.filter((r) => r.conversationId === conversationId)
  }

  getByConversationAndType(
    conversationId: string,
    type: ArtifactType
  ): ThreadArtifactRecord | undefined {
    return this.records.find(
      (r) => r.conversationId === conversationId && r.artifactType === type
    )
  }

  /**
   * Confirmed-persistence upsert.
   *
   * The local cache is updated first (optimistic), then the Supabase write
   * is awaited.  If the Supabase write fails the optimistic update is rolled
   * back so the cache never diverges from the confirmed persisted state, and
   * the error is thrown to the caller so the workflow can surface it in the UI.
   *
   * Matches by record id (primary key) so each artifact record can be
   * individually updated without colliding with append-only project sends.
   */
  async upsert(record: ThreadArtifactRecord): Promise<void> {
    const idx = this.records.findIndex((r) => r.id === record.id)
    const previous = idx >= 0 ? this.records[idx] : null

    // Version from cache (not from caller's record — caller may have stale version)
    const expectedVersion = previous?.version ?? 0
    const nextVersion = expectedVersion + 1

    // Optimistic local update with incremented version
    const recordWithVersion: ThreadArtifactRecord = { ...record, version: nextVersion }
    if (idx >= 0) {
      this.records[idx] = recordWithVersion
    } else {
      this.records.push(recordWithVersion)
    }
    this.notify()

    const rollback = () => {
      const rollbackIdx = this.records.findIndex((r) => r.id === record.id)
      if (previous !== null) {
        if (rollbackIdx >= 0) this.records[rollbackIdx] = previous
      } else {
        if (rollbackIdx >= 0) this.records.splice(rollbackIdx, 1)
      }
      this.notify()
    }

    if (idx >= 0) {
      // ── UPDATE with CAS: only succeeds if version matches expected ─────────
      const { data: updated, error } = await supabase
        .from('thread_artifacts')
        .update(stripNullColumns(recordToRow(recordWithVersion, nextVersion)))
        .eq('id', record.id)
        .eq('version', expectedVersion)
        .select('id')

      if (error) {
        rollback()
        logError('repository.thread_artifacts.update_failed', error, {
          entityId: record.id,
          conversationId: record.conversationId,
          artifactType: record.artifactType,
        })
        recordPersistenceFailure({
          domain: 'thread_artifacts',
          operation: 'update',
          entityId: record.id,
          error,
          occurredAt: Date.now(),
        })
        throw error
      }

      if (!updated || updated.length === 0) {
        // CAS failed: another writer incremented version first
        rollback()
        const conflictErr = new ConflictError(
          `Artifact ${record.id} was modified concurrently — version mismatch (expected ${expectedVersion})`
        )
        logError('repository.thread_artifacts.conflict', conflictErr, {
          entityId: record.id,
          conversationId: record.conversationId,
          expectedVersion,
        })
        throw conflictErr
      }
    } else {
      // ── INSERT (new record) ────────────────────────────────────────────────
      // Use nextVersion (= 1) so DB and cache agree — otherwise the next CAS
      // update finds version=0 in DB but expects version=1 from cache.
      const { error } = await supabase
        .from('thread_artifacts')
        .insert(stripNullColumns(recordToRow(recordWithVersion, nextVersion)))

      if (error) {
        rollback()
        logError('repository.thread_artifacts.insert_failed', error, {
          entityId: record.id,
          conversationId: record.conversationId,
          artifactType: record.artifactType,
        })
        recordPersistenceFailure({
          domain: 'thread_artifacts',
          operation: 'add',
          entityId: record.id,
          error,
          occurredAt: Date.now(),
        })
        throw error
      }
    }
  }

  /**
   * Append-only insert for multi-send project artifacts.
   *
   * Always creates a new row — no conflict resolution.  Uses the same
   * optimistic-cache + confirmed-persistence pattern as upsert, but
   * performs a plain INSERT instead of UPSERT.
   *
   * Pending-insert tracking prevents concurrent loadForUser calls
   * (triggered by auth token refresh) from overwriting the optimistic
   * record before the Supabase write confirms.
   */
  async insert(record: ThreadArtifactRecord): Promise<void> {
    // Track this record as pending so loadForUser preserves it
    this.pendingInsertIds.add(record.id)

    // Optimistic local update
    this.records.push(record)
    this.notify()

    // Await the Supabase write.
    // stripNullColumns prevents PostgREST "column not found" errors when
    // the DB schema is behind the code (unapplied migrations).
    const { error } = await supabase
      .from('thread_artifacts')
      .insert(stripNullColumns(recordToRow(record)))

    // Remove from pending set regardless of success/failure
    this.pendingInsertIds.delete(record.id)

    if (error) {
      // Roll back the optimistic insert
      const rollbackIdx = this.records.findIndex((r) => r.id === record.id)
      if (rollbackIdx >= 0) this.records.splice(rollbackIdx, 1)

      logError('repository.thread_artifacts.insert_failed', error, {
        entityId: record.id,
        conversationId: record.conversationId,
        artifactType: record.artifactType,
      })
      recordPersistenceFailure({
        domain: 'thread_artifacts',
        operation: 'add',
        entityId: record.id,
        error,
        occurredAt: Date.now(),
      })
      this.notify()
      throw error
    }

    // Post-confirmation notify: ensures subscribers see the confirmed
    // state even if a concurrent loadForUser replaced the cache while
    // the insert was in-flight.
    this.notify()
  }

  getAll(): ThreadArtifactRecord[] {
    return [...this.records]
  }

  /** Exposed for tests that need to inspect or manipulate internal state. */
  reset(): void {
    this.resetState()
  }

  prepareForResync(): void {
    this._initPromise = null
    this._loadGeneration++
  }
}
