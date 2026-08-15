import { supabase } from '../../supabase'
import {
  recordPersistenceFailure,
  enqueuePendingMutation,
  getPendingMutations,
  isServerSideError,
  isDuplicateKeyError,
} from '../../persistence'
import { logBreadcrumb, logError, logInfo, logWarning } from '../../observability'
import type { Job, IntakeContext } from '../types'
import { JobStatusCasConflictError } from './JobRepository'
import type { JobRepository, JobUpdateOptions } from './JobRepository'

type Listener = () => void

/**
 * Shape of a `jobs` row as returned by Supabase `select('*')`.
 *
 * Contains ALL columns the live table may return — including seed columns and
 * any migration-added columns.  Fields that exist only in some environments
 * are optional so `rowToJob` gracefully falls back to defaults when they are
 * absent.
 */
interface JobRow {
  // --- Seed columns (always present in every environment) ---
  id: string
  title: string
  description: string
  status: string
  provider_id?: string | null
  created_at?: string | null
  updated_at?: string | null
  // --- Migration-added columns (may not be present in the live table) ---
  // Included here so `rowToJob` can read them when they exist.
  // Fields marked optional (?:) are safe to read — they simply resolve to
  // `undefined` when the column is absent from the SELECT result.
  project_id?: string
  customer?: string
  location?: string
  date_label?: string
  payment_state?: string
  documentation_status?: string
  assigned_member_ids?: unknown
  notes?: unknown
  photo_count?: number | null
  intake_context?: IntakeContext | null
  proposal_timing_note?: string | null
  proposal_sent_at?: number | null
  proposal_accepted_at?: number | null
  work_completed_at?: number | null
  work_marked_complete_at?: number | null
  work_confirmed_complete_at?: number | null
  payment_released_at?: number | null
  customer_user_id?: string | null
  craftsman_user_id?: string | null
  source_conversation_id?: string | null
  // --- Dispute column (migration 20240200000000) ---
  dispute_status?: string | null
  // --- Job operations columns (migration 20260325000003) ---
  work_started_at?: number | null
  funding_requested_at?: number | null
  source_offer_id?: string | null
  // --- Commercial attribution column (migration 20260409000004) ---
  commercial_origin?: string | null
  // --- Attribution status columns (migration 20260410000002) ---
  attribution_status?: string | null
  attribution_retry_count?: number | null
  attribution_last_retry_at?: string | null
  // --- Job kind column (migration 20260412000005 — Paket 2) ---
  job_kind?: string | null
}

/**
 * Write-path payload for Supabase INSERT / UPDATE.
 *
 * Contains ALL truth-critical Job columns that must survive reload.
 * Matches the live public.jobs schema defined across these migrations:
 *   Seed schema                  : id, title, description, status, provider_id
 *   Migration 20240101000000     : project_id, customer, location, date_label,
 *                                  payment_state, documentation_status,
 *                                  assigned_member_ids, notes, photo_count,
 *                                  intake_context, proposal_timing_note,
 *                                  proposal_sent_at, proposal_accepted_at,
 *                                  payment_released_at, craftsman_user_id
 *   Migration 20240200000000     : dispute_status
 *   Migration 20240900000000     : customer_user_id
 *   Migration 20260317000012     : source_conversation_id
 *   Migration 20260325000003     : source_offer_id, work_started_at,
 *                                  funding_requested_at
 *   Migration 20260325000006     : work_completed_at
 *   Migration 20260409000004     : commercial_origin
 *   Migration 20260412000005     : job_kind (Paket 2)
 *   Migration 20260501000001     : work_marked_complete_at,
 *                                  work_confirmed_complete_at (Block 7.2.1b)
 *
 * Fields NOT persisted (client-side only):
 *   amount      – canonical price lives in the Offer entity
 *   activities  – session-only in-memory log, rebuilt each session
 *
 * craftsmanUserId is now persisted in its own column (craftsman_user_id)
 * and is no longer synthesised from provider_id on hydration.
 */
interface JobWriteRow {
  id: string
  title: string
  description: string
  status: string
  provider_id: string | null
  customer_user_id: string | null
  craftsman_user_id: string | null
  source_offer_id: string | null
  work_completed_at: number | null
  work_marked_complete_at: number | null
  work_confirmed_complete_at: number | null
  project_id: string
  customer: string
  location: string
  date_label: string
  payment_state: string
  documentation_status: string
  assigned_member_ids: unknown
  notes: unknown
  photo_count: number
  intake_context: IntakeContext | null
  proposal_timing_note: string | null
  proposal_sent_at: number | null
  proposal_accepted_at: number | null
  payment_released_at: number | null
  dispute_status: string | null
  source_conversation_id: string | null
  commercial_origin: string | null
  attribution_status: string | null
  job_kind: string | null
}

/**
 * Safely coerce a JSONB column value to a typed array.
 * Supabase may return arrays, JSON-stringified arrays, or null/undefined
 * depending on how the column was serialised on the server side.
 */
function toArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed as T[]
    } catch {
      // fall through
    }
  }
  return []
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id ?? '',
    projectId: row.project_id ?? '',
    title: row.title ?? '',
    customer: row.customer ?? '',
    location: row.location ?? '',
    dateLabel: row.date_label ?? 'Termin offen',
    status: (row.status ?? 'new') as Job['status'],
    // amount is a client-side-only field; not persisted to the DB.
    // The live public.jobs table has no 'amount' column — the agreed price
    // is the canonical property of the Offer, not the Job.  The in-memory
    // amount is populated by the workflow that creates/loads the job.
    amount: String((row as unknown as Record<string, unknown>).amount ?? ''),
    description: row.description ?? '',
    paymentState: (row.payment_state ?? 'deposit_required') as Job['paymentState'],
    documentationStatus: row.documentation_status ?? 'Noch keine Dokumentation',
    assignedMemberIds: toArray<string>(row.assigned_member_ids),
    notes: toArray<string>(row.notes),
    photoCount: row.photo_count ?? 0,
    // activities is a client-side-only field; not persisted to the DB.
    // The live public.jobs table has no 'activities' column — the in-memory
    // log is rebuilt from scratch on each session.
    activities: [],
    ...(row.intake_context != null && { intakeContext: row.intake_context }),
    ...(row.proposal_timing_note != null && { proposalTimingNote: row.proposal_timing_note }),
    ...(row.proposal_sent_at != null && { proposalSentAt: row.proposal_sent_at }),
    ...(row.proposal_accepted_at != null && { proposalAcceptedAt: row.proposal_accepted_at }),
    ...(row.work_completed_at != null && { workCompletedAt: row.work_completed_at }),
    ...(row.work_marked_complete_at != null && {
      workMarkedCompleteAt: row.work_marked_complete_at,
    }),
    ...(row.work_confirmed_complete_at != null && {
      workConfirmedCompleteAt: row.work_confirmed_complete_at,
    }),
    ...(row.payment_released_at != null && { paymentReleasedAt: row.payment_released_at }),
    // Map provider_id (the canonical FK column) to providerId.
    ...(row.provider_id != null && {
      providerId: row.provider_id as string,
    }),
    // craftsmanUserId is the auth user ID — persisted in its own column.
    // Legacy rows with null craftsman_user_id are left as undefined
    // (no fallback to provider_id, which is a providers.id UUID, not an
    // auth user_id — using it would create a false identity).
    ...(row.craftsman_user_id != null && { craftsmanUserId: row.craftsman_user_id }),
    ...(row.customer_user_id != null && { customerUserId: row.customer_user_id }),
    ...(row.source_conversation_id != null && { sourceConversationId: row.source_conversation_id }),
    ...(row.source_offer_id != null && { sourceOfferId: row.source_offer_id }),
    ...(row.dispute_status != null && { disputeStatus: row.dispute_status as Job['disputeStatus'] }),
    ...(row.commercial_origin != null && {
      commercialOrigin: row.commercial_origin as Job['commercialOrigin'],
    }),
    ...(row.attribution_status != null && {
      attributionStatus: row.attribution_status as Job['attributionStatus'],
    }),
    // Job kind (Paket 2): absent on legacy jobs → treated as 'standard' at guard layer
    ...(row.job_kind != null && { jobKind: row.job_kind as Job['jobKind'] }),
  }
}

/**
 * Build the DB-write payload for a Job.
 *
 * Contains ALL truth-critical columns from the live public.jobs table.
 * Client-side-only fields (amount, activities) are excluded — amount is
 * the canonical property of the Offer, and activities are a session-only
 * in-memory log.
 */
function jobToRow(job: Job): JobWriteRow {
  return {
    id: job.id,
    title: job.title,
    description: job.description,
    status: job.status,
    provider_id: job.providerId ?? null,
    customer_user_id: job.customerUserId ?? null,
    craftsman_user_id: job.craftsmanUserId ?? null,
    source_offer_id: job.sourceOfferId ?? null,
    work_completed_at: job.workCompletedAt ?? null,
    work_marked_complete_at: job.workMarkedCompleteAt ?? null,
    work_confirmed_complete_at: job.workConfirmedCompleteAt ?? null,
    project_id: job.projectId,
    customer: job.customer,
    location: job.location,
    date_label: job.dateLabel,
    payment_state: job.paymentState,
    documentation_status: job.documentationStatus,
    assigned_member_ids: job.assignedMemberIds,
    notes: job.notes,
    photo_count: job.photoCount,
    intake_context: job.intakeContext ?? null,
    proposal_timing_note: job.proposalTimingNote ?? null,
    proposal_sent_at: job.proposalSentAt ?? null,
    proposal_accepted_at: job.proposalAcceptedAt ?? null,
    payment_released_at: job.paymentReleasedAt ?? null,
    dispute_status: job.disputeStatus ?? null,
    source_conversation_id: job.sourceConversationId ?? null,
    commercial_origin: job.commercialOrigin ?? null,
    attribution_status: job.attributionStatus ?? 'pending',
    job_kind: job.jobKind ?? null,
  }
}

/**
 * Supabase-backed implementation of the JobRepository interface.
 *
 * Uses a local in-memory cache to serve synchronous reads, keeping
 * the reactive subscription model intact while all writes are also
 * persisted to the `jobs` table.
 *
 * Bootstrap sequence:
 * 1. Construct the repository.
 * 2. Register it via `setJobRepository()`.
 * 3. Await `initializeJobRepository()` (or `repo.initialize()` directly) to
 *    load the initial dataset from Supabase before the UI first renders.
 *
 * Write path (optimistic with rollback):
 * - `add()` / `update()` update the local cache and notify subscribers
 *   immediately so the UI stays responsive.
 * - The corresponding Supabase mutation is awaited.
 * - On failure, the optimistic cache change is rolled back, subscribers
 *   are re-notified, and the error is thrown so callers can handle it.
 *
 * Offline draft semantics:
 * - add() only queues on transient/network failures. Server-side conflicts
 *   (23505 duplicate key, other 23xxx/42xxx) are never queued — the flush
 *   path replays with upsert and would otherwise overwrite an existing job.
 * - loadForUser() hydrates queued draft inserts from the local
 *   pending-mutation store so jobs remain visible after app restart even
 *   when the DB row has not been written yet.
 *
 * Realtime path:
 * - After initial load, a Supabase Realtime channel subscribes to INSERT
 *   and UPDATE events on the `jobs` table.  Incoming INSERT rows are
 *   deduplicated by ID.  UPDATE rows replace the existing cache entry so
 *   status/payment-state changes from the other party (customer or craftsman)
 *   appear without a manual reload.
 */
export class SupabaseJobRepository implements JobRepository {
  private jobs: Job[] = []
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

  private async fetchJobsFromDatabase(uid: string): Promise<Job[]> {
    // Fetch jobs where the logged-in user is either the craftsman OR the customer.
    // provider_id stores the canonical providers.id (DB-generated UUID), not the
    // auth user ID.  We resolve providers.id first so the query matches correctly.
    // customer_user_id stores the auth user ID directly.
    let providerDbId: string | null = null
    try {
      const { data: providerRow } = await supabase
        .from('providers')
        .select('id')
        .eq('profile_id', uid)
        .maybeSingle()
      providerDbId = providerRow?.id ?? null
    } catch (err) {
      // Best-effort: if the providers lookup fails, query only by
      // customer_user_id (craftsman jobs won't appear until next success).
      logError('repository.jobs.provider_lookup_failed', err as Error, { uid })
    }

    // Workers have no providers row but are linked via team_members.
    // Resolve their company's provider_id so jobs for their provider are included.
    if (!providerDbId) {
      try {
        const { data: tmRow } = await supabase
          .from('team_members')
          .select('provider_id')
          .eq('profile_id', uid)
          .eq('is_active', true)
          .maybeSingle()
        providerDbId = tmRow?.provider_id ?? null
      } catch (err) {
        logError('repository.jobs.team_member_lookup_failed', err as Error, { uid })
      }
    }

    const filterParts: string[] = [`customer_user_id.eq.${uid}`]
    if (providerDbId) {
      filterParts.unshift(`provider_id.eq.${providerDbId}`)
    }

    const { data, error } = await supabase
      .from('jobs')
      .select('*')
      .or(filterParts.join(','))
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) throw error
    return (data as JobRow[]).map(rowToJob)
  }

  private async loadForUser(uid: string, generationSnapshot: number): Promise<void> {
    this.currentUid = uid
    const jobs = await this.fetchJobsFromDatabase(uid)
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    this.jobs = jobs
    this.hydrateFromQueue(uid)
    this.notify()
    this.startRealtimeSubscription(uid)
  }

  /**
   * Materializes queued job inserts into the local cache for the given user.
   *
   * Called after each DB load so that pending mutations not yet flushed to
   * Supabase are visible in the UI immediately after app restart.
   *
   * Cross-user mutations (userId present and ≠ uid) are skipped.
   * Malformed payloads are silently skipped so a corrupt queue entry cannot
   * crash the repository load.
   */
  private hydrateFromQueue(uid: string): void {
    const pending = getPendingMutations()
    for (const m of pending) {
      if (m.table !== 'jobs' || m.operation !== 'insert') continue
      if (m.userId && m.userId !== uid) continue
      if (this.jobs.some((j) => j.id === m.entityId)) continue
      try {
        const job = rowToJob(m.payload as unknown as JobRow)
        this.jobs = [job, ...this.jobs]
      } catch {
        // Malformed queue payload — skip without crashing.
      }
    }
  }

  private resetState(): void {
    this._initPromise = null
    this.realtimeGeneration++
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
      this.realtimeChannel = null
    }
    this.currentUid = null
    this.jobs = []
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
   * Subscribes to INSERT and UPDATE events on the `jobs` table via Supabase Realtime.
   *
   * INSERT deduplication: if the arriving job ID already exists in the local cache
   * (inserted optimistically by this client moments earlier) we silently drop it.
   *
   * UPDATE merge: replaces the existing cache entry by ID so that status, payment
   * state, and dispute state changes from the other party appear without a reload.
   * If the job is not in the local cache yet (e.g. newly assigned job), it is added.
   *
   * RLS on the Supabase side scopes the channel to jobs visible to this user —
   * no additional client-side ownership check is required beyond deduplication.
   */
  private startRealtimeSubscription(uid: string, fromReconnection = false): void {
    // Remove any previously active channel before creating a new one.
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
    }
    const generation = ++this.realtimeGeneration
    this.realtimeChannel = supabase
      .channel(`fixup-jobs-${uid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'jobs' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as JobRow
          if (this.jobs.some((j) => j.id === row.id)) return
          this.jobs = [...this.jobs, rowToJob(row)]
          this.notify()
          logInfo('job.realtime_inserted', { jobId: row.id })
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'jobs' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as JobRow
          const current = this.jobs.find((j) => j.id === row.id)
          // Terminal guard: completed/cancelled jobs must not be overwritten by
          // stale or delayed realtime events (e.g. webhook replay after page reload).
          if (current && (current.status === 'completed' || current.status === 'cancelled')) return
          const incoming = rowToJob(row)
          if (current) {
            // Preserve client-side-only fields that are not persisted to the DB.
            this.jobs = this.jobs.map((j) =>
              j.id === row.id
                ? { ...incoming, amount: j.amount, activities: j.activities }
                : j
            )
          } else {
            this.jobs = [...this.jobs, incoming]
          }
          this.notify()
          logInfo('job.realtime_updated', { jobId: row.id })
        },
      )
      .subscribe((status) => {
        if (generation !== this.realtimeGeneration) return
        if (status === 'SUBSCRIBED') {
          this.isRealtimeConnected = true
          this.reconnectAttempts = 0
          logInfo('job.realtime_connected', { userId: uid })
          if (fromReconnection) void this.fallbackRefresh(uid)
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.isRealtimeConnected = false
          logBreadcrumb(
            'repository.jobs.realtime_disconnected',
            'warning',
            { userId: uid, status },
          )
          void this.fallbackRefresh(uid)
          this.attemptReconnection(uid)
        }
      })
  }

  /**
   * Fallback refresh: re-fetches all jobs from the database when realtime fails.
   * Replaces the local cache with the fresh server state to ensure correctness.
   */
  private async fallbackRefresh(uid: string): Promise<void> {
    try {
      const freshJobs = await this.fetchJobsFromDatabase(uid)
      this.jobs = freshJobs
      this.notify()
      logInfo('job.fallback_refresh_completed', { userId: uid })
    } catch (error) {
      logError('repository.jobs.fallback_refresh_error', error as Error, { userId: uid })
    }
  }

  /**
   * Attempt to reconnect the realtime subscription with exponential backoff.
   */
  private attemptReconnection(uid: string): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logWarning(
        'repository.jobs.realtime_reconnect_exhausted',
        { userId: uid, attempts: this.reconnectAttempts },
      )
      return
    }

    this.reconnectAttempts++
    logInfo('job.realtime_reconnect_attempt', {
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

  notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): Job[] {
    return [...this.jobs]
  }

  getById(id: string): Job | undefined {
    return this.jobs.find((job) => job.id === id)
  }

  saveAll(jobs: Job[]): void {
    // Updates the local cache only. Callers should prefer add()/update() for
    // individual writes that also persist to Supabase.
    this.jobs = jobs
    this.notify()
  }

  async add(job: Job): Promise<void> {
    this.jobs = [...this.jobs, job]
    this.notify()
    const { error } = await supabase.from('jobs').insert(jobToRow(job))
    if (error) {
      if (isServerSideError(error)) {
        // Server rejected the INSERT for a structural reason — not a transient
        // network failure. Never queue: the flush path uses upsert and would
        // silently overwrite an existing job's status, payment_state, or amounts.
        this.jobs = this.jobs.filter((j) => j.id !== job.id)
        this.notify()

        if (isDuplicateKeyError(error)) {
          // 23505: the job already exists in Supabase (stale local cache).
          // Reload the DB-authoritative version so the cache reflects reality.
          const { data } = await supabase
            .from('jobs')
            .select('*')
            .eq('id', job.id)
            .single()
          if (data) {
            const existing = rowToJob(data as JobRow)
            if (!this.jobs.some((j) => j.id === existing.id)) {
              this.jobs = [existing, ...this.jobs]
              this.notify()
            }
          }
          return
        }

        logError('repository.jobs.add_conflict', error, { entityId: job.id })
        recordPersistenceFailure({ domain: 'jobs', operation: 'add', entityId: job.id, error, occurredAt: Date.now() })
        throw error
      }

      logError('repository.jobs.add_failed', error, { entityId: job.id })
      recordPersistenceFailure({ domain: 'jobs', operation: 'add', entityId: job.id, error, occurredAt: Date.now() })
      enqueuePendingMutation({
        operation: 'insert',
        table: 'jobs',
        payload: jobToRow(job) as unknown as Record<string, unknown>,
        domain: 'jobs',
        entityId: job.id,
      })
      throw error
    }
  }

  async remove(jobId: string): Promise<void> {
    const previous = this.jobs.find((j) => j.id === jobId)
    this.jobs = this.jobs.filter((j) => j.id !== jobId)
    this.notify()
    const { error } = await supabase.from('jobs').delete().eq('id', jobId)
    if (error) {
      // Rollback: restore the job so the cache stays consistent with the DB.
      if (previous) {
        this.jobs = [previous, ...this.jobs]
        this.notify()
      }
      logError('repository.jobs.remove_failed', error, { entityId: jobId })
      recordPersistenceFailure({ domain: 'jobs', operation: 'remove', entityId: jobId, error, occurredAt: Date.now() })
      throw error
    }
  }

  async reassignAssignedMember(
    jobId: string,
    fromMemberId: string,
    toMemberId: string,
  ): Promise<Job> {
    const previous = this.jobs.find((j) => j.id === jobId)
    if (!previous) {
      // No optimistic update possible — let the RPC return the canonical row
      // (or fail with job_not_found, which we surface as a thrown error).
    }

    // Optimistic local update — match the RPC semantics exactly.
    if (previous) {
      const current = previous.assignedMemberIds
      let next: string[]
      if (current.includes(toMemberId)) {
        next = current.filter((id) => id !== fromMemberId)
      } else if (current.includes(fromMemberId)) {
        next = [...current.filter((id) => id !== fromMemberId), toMemberId]
      } else {
        next = [...current, toMemberId]
      }
      const optimistic: Job = { ...previous, assignedMemberIds: next }
      this.jobs = this.jobs.map((j) => (j.id === jobId ? optimistic : j))
      this.notify()
    }

    const { data, error } = await supabase.rpc('reassign_job_member', {
      p_job_id: jobId,
      p_from: fromMemberId,
      p_to: toMemberId,
    })

    if (error) {
      // Rollback optimistic update.
      if (previous) {
        this.jobs = this.jobs.map((j) => (j.id === jobId ? previous : j))
        this.notify()
      }
      logError('repository.jobs.reassign_failed', error, { entityId: jobId, fromMemberId, toMemberId })
      throw error
    }

    const row = data as JobRow | null
    if (!row) {
      // RPC returned null — treat as not-found, rollback.
      if (previous) {
        this.jobs = this.jobs.map((j) => (j.id === jobId ? previous : j))
        this.notify()
      }
      throw new Error(`Job not found: ${jobId}`)
    }

    const canonical = rowToJob(row)
    this.jobs = this.jobs.some((j) => j.id === canonical.id)
      ? this.jobs.map((j) => (j.id === canonical.id ? canonical : j))
      : [...this.jobs, canonical]
    this.notify()
    return canonical
  }

  async update(
    jobId: string,
    updater: (job: Job) => Job,
    options?: JobUpdateOptions,
  ): Promise<void> {
    const previous = this.jobs.find((job) => job.id === jobId)
    this.jobs = this.jobs.map((job) => (job.id === jobId ? updater(job) : job))
    this.notify()
    const updated = this.jobs.find((job) => job.id === jobId)
    if (!updated) return

    const rollback = (): void => {
      if (previous) {
        this.jobs = this.jobs.map((j) => (j.id === jobId ? previous : j))
        this.notify()
      }
    }

    // Shared DB-error path (CAS and non-CAS): rollback optimistic update,
    // record + log, rethrow to the caller.
    //
    // `enqueueReplay` is true ONLY for non-CAS writes.  The offline queue
    // replays via a plain `update().eq('id', …)` — flushPendingMutations has
    // no notion of a status predicate — so a queued CAS write would replay
    // as a blind full-row write and bypass the compare-and-set the caller
    // asked for (JobRepository doc contract).  CAS callers are interactive:
    // the thrown error belongs to the UI and a user retry re-reads the
    // current status.  For non-CAS writes the queue UX stays: a DB-trigger
    // reject (e.g. 23514 from jobs_terminal_status_guard) replayed later is
    // classified `business-rejected` by classifyFailure and dropped
    // permanently by flushPendingMutations — no endless replay loop.
    const handleWriteError = (error: unknown, enqueueReplay: boolean): never => {
      rollback()
      logError('repository.jobs.update_failed', error, { entityId: jobId })
      recordPersistenceFailure({ domain: 'jobs', operation: 'update', entityId: jobId, error, occurredAt: Date.now() })
      if (enqueueReplay) {
        enqueuePendingMutation({
          operation: 'update',
          table: 'jobs',
          payload: jobToRow(updated) as unknown as Record<string, unknown>,
          domain: 'jobs',
          entityId: jobId,
        })
      }
      throw error
    }

    const expectedStatus = options?.expectedStatus
    if (expectedStatus !== undefined) {
      // Compare-and-set write (H12): the WHERE clause re-checks the status
      // the caller's pre-check was based on, so a stale local cache can
      // never clobber a row another writer (stripe-webhook, cron
      // reconciliation, second device) already moved on.  `.select('id')`
      // makes the match count observable — PostgREST returns zero rows when
      // the CAS predicate missed.
      const { data, error } = await supabase
        .from('jobs')
        .update(jobToRow(updated))
        .eq('id', jobId)
        .eq('status', expectedStatus)
        .select('id')
      // DB error on a CAS write: rollback + record + throw, but NEVER
      // enqueue — the replay path cannot carry the CAS predicate.
      if (error) handleWriteError(error, false)
      if ((data ?? []).length === 0) {
        // CAS conflict — the persisted status changed under us.  Roll back
        // the optimistic cache and surface to the caller.  Deliberately NOT
        // enqueued (a full-row replay would bypass the CAS and clobber the
        // newer row) and NOT recorded as a persistence failure (interactive
        // action — the error belongs to the UI, not the SyncStatusBar).
        rollback()
        const conflict = new JobStatusCasConflictError(jobId, expectedStatus)
        logError('repository.jobs.update_cas_conflict', conflict, {
          entityId: jobId,
          expectedStatus,
        })
        throw conflict
      }
      return
    }

    const { error } = await supabase
      .from('jobs')
      .update(jobToRow(updated))
      .eq('id', jobId)
    if (error) handleWriteError(error, true)
  }

  reset(): void {
    this.resetState()
  }

  prepareForResync(): void {
    this._initPromise = null
    this._loadGeneration++
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
}
