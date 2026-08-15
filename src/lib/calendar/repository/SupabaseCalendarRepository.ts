import { supabase } from '../../supabase'
import { recordPersistenceFailure, enqueuePendingMutation, hasPendingMutationForEntity, getPendingMutations, isServerSideError, isDuplicateKeyError } from '../../persistence'
import { logBreadcrumb, logError, logInfo, logWarning } from '../../observability'
import type { CalendarEntry, CalendarEntryStatus } from '../calendarTypes'
import type { CalendarRepository, CalendarWriteOpts } from './CalendarRepository'

type Listener = () => void

interface CalendarEntryRow {
  id: string
  job_id: string | null
  // `kind` column does not exist in the DB schema — derived client-side from job_id presence
  provider_id: string | null
  title: string
  description: string
  customer_name: string
  location: string
  date_label: string
  date_key: string
  starts_at_label: string
  ends_at_label: string
  assigned_member_ids: string[]
  status: string
  created_at: number
  updated_at: number
}

function rowToEntry(row: CalendarEntryRow): CalendarEntry {
  return {
    id: row.id,
    jobId: row.job_id ?? undefined,
    kind: (row.job_id == null ? 'custom' : 'job') as CalendarEntry['kind'],
    providerId: row.provider_id ?? undefined,
    title: row.title,
    description: row.description ?? '',
    customerName: row.customer_name,
    location: row.location,
    dateLabel: row.date_label,
    dateKey: row.date_key,
    startsAtLabel: row.starts_at_label,
    endsAtLabel: row.ends_at_label,
    assignedMemberIds: row.assigned_member_ids,
    status: row.status as CalendarEntryStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function entryToRow(entry: CalendarEntry): CalendarEntryRow {
  return {
    id: entry.id,
    job_id: entry.jobId ?? null,
    // `kind` is not persisted — the DB has no `kind` column; it is derived from job_id on read
    provider_id: entry.providerId ?? null,
    title: entry.title,
    description: entry.description,
    customer_name: entry.customerName,
    location: entry.location,
    date_label: entry.dateLabel,
    date_key: entry.dateKey,
    starts_at_label: entry.startsAtLabel,
    ends_at_label: entry.endsAtLabel,
    assigned_member_ids: entry.assignedMemberIds,
    status: entry.status,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
  }
}

/**
 * Supabase-backed implementation of the CalendarRepository interface.
 *
 * Uses a local in-memory cache to serve synchronous reads, keeping
 * the reactive subscription model intact while all writes are also
 * persisted to the `calendar_entries` table asynchronously.
 *
 * Bootstrap sequence:
 * 1. Construct the repository.
 * 2. Register it via `setCalendarRepository()`.
 * 3. Await `initializeCalendarRepository()` (or `repo.initialize()` directly)
 *    to load the initial dataset from Supabase before the UI first renders.
 *
 * Write path (optimistic):
 * - All write methods update the local cache and notify subscribers
 *   immediately so the UI stays responsive.
 * - The corresponding Supabase mutation is fired in the background.
 *   Failures are logged via `recordPersistenceFailure`.
 *
 * Realtime path:
 * - After initial load, a Supabase Realtime channel subscribes to INSERT
 *   and UPDATE events on the `calendar_entries` table.  INSERT rows are
 *   deduplicated by ID (prevents double-display after optimistic writes).
 *   UPDATE rows replace the existing cache entry so assignment and schedule
 *   changes from team members appear without a manual reload.
 */
export class SupabaseCalendarRepository implements CalendarRepository {
  private entries: CalendarEntry[] = []
  private authUnsubscribe: (() => void) | null = null
  private readonly listeners = new Set<Listener>()
  private _hydrated = false
  private currentUid: string | null = null
  private currentProviderId: string | null = null
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
  /**
   * Promises for the supabase write portion of every in-flight add() / replace().
   *
   * Subscribers (CraftsmanDashboardScreen, CraftsmanOperationsScreen) call
   * `syncCalendarEntriesForJobs` synchronously when JobRepository notifies
   * during `initializeJobRepository(true)`.  Each `replace()` call kicks off
   * an async supabase update.  If `clearPersistenceFailures` runs at the end
   * of `resyncRepositories` BEFORE that update settles, a permanent-kind
   * failure recorded post-clear re-shows the SyncStatusBar — the user sees
   * the same banner reappear immediately and reads the retry as a no-op.
   *
   * Tracking the write promises here lets `resyncRepositories` await
   * `drainInFlightWrites()` after the cache reload but before the failure
   * clear, so the banner reflects the real post-recovery state.
   */
  private inFlightWrites = new Set<Promise<unknown>>()

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

  async initialize(): Promise<void> {
    if (this._initPromise) return this._initPromise
    const generation = ++this._loadGeneration
    const p: Promise<void> = (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (generation !== this._loadGeneration) return
      if (!session?.user) {
        this.entries = []
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

  private async resolveProviderId(uid: string): Promise<string | null> {
    // Owner path: resolve via providers table (the user owns a company)
    const { data: providerRow } = await supabase
      .from('providers')
      .select('id')
      .eq('profile_id', uid)
      .maybeSingle()
    let providerId = (providerRow?.id as string | null) ?? null

    // Worker path: resolve company via team_members membership
    if (!providerId) {
      const { data: memberRow } = await supabase
        .from('team_members')
        .select('provider_id')
        .eq('profile_id', uid)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle()
      providerId = (memberRow?.provider_id as string | null) ?? null
    }

    return providerId
  }

  private async fetchCalendarEntriesFromDatabase(providerId: string): Promise<CalendarEntry[]> {
    const { data, error } = await supabase
      .from('calendar_entries')
      .select('*')
      .eq('provider_id', providerId)
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) throw error
    return ((data ?? []) as CalendarEntryRow[]).map(rowToEntry)
  }

  private async loadForUser(uid: string, generationSnapshot: number): Promise<void> {
    this.currentUid = uid
    const providerId = await this.resolveProviderId(uid)
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    this.currentProviderId = providerId
    if (!providerId) {
      // No company scope — calendar entries are not accessible to unscoped users
      this.entries = []
      this.notify()
      return
    }
    const entries = await this.fetchCalendarEntriesFromDatabase(providerId)
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    this.entries = entries
    this.hydrateFromQueue(uid)
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
    this.currentProviderId = null
    this.entries = []
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
   * Subscribes to INSERT and UPDATE events on the `calendar_entries` table via Supabase Realtime.
   *
   * INSERT deduplication: if the arriving entry ID already exists in the local cache
   * (inserted optimistically by this client) we silently drop it.
   *
   * UPDATE merge: replaces the existing cache entry by ID so that team assignment or
   * schedule changes from the other party appear without a manual reload.
   * If the entry is not yet in cache, it is added.
   *
   * RLS on the Supabase side scopes the channel to calendar entries visible to this
   * provider — no additional client-side ownership check required.
   */
  private startRealtimeSubscription(uid: string, fromReconnection = false): void {
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
    }
    const generation = ++this.realtimeGeneration
    this.realtimeChannel = supabase
      .channel(`fixup-calendar-${uid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'calendar_entries' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as CalendarEntryRow
          if (this.entries.some((e) => e.id === row.id)) return
          this.entries = [rowToEntry(row), ...this.entries]
          this.notify()
          logInfo('calendar.realtime_inserted', { entryId: row.id })
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'calendar_entries' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as CalendarEntryRow
          const exists = this.entries.some((e) => e.id === row.id)
          if (exists) {
            this.entries = this.entries.map((e) => (e.id === row.id ? rowToEntry(row) : e))
          } else {
            this.entries = [rowToEntry(row), ...this.entries]
          }
          this.notify()
          logInfo('calendar.realtime_updated', { entryId: row.id })
        },
      )
      .subscribe((status) => {
        if (generation !== this.realtimeGeneration) return
        if (status === 'SUBSCRIBED') {
          this.isRealtimeConnected = true
          this.reconnectAttempts = 0
          logInfo('calendar.realtime_connected', { userId: uid })
          if (fromReconnection) void this.fallbackRefresh(uid)
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.isRealtimeConnected = false
          logBreadcrumb(
            'repository.calendar.realtime_disconnected',
            'warning',
            { userId: uid, status },
          )
          void this.fallbackRefresh(uid)
          this.attemptReconnection(uid)
        }
      })
  }

  private async fallbackRefresh(uid: string): Promise<void> {
    try {
      if (!this.currentProviderId) return
      const freshEntries = await this.fetchCalendarEntriesFromDatabase(this.currentProviderId)
      this.entries = freshEntries
      this.notify()
      logInfo('calendar.fallback_refresh_completed', { userId: uid })
    } catch (error) {
      logError('repository.calendar.fallback_refresh_error', error as Error, { userId: uid })
    }
  }

  private attemptReconnection(uid: string): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logWarning(
        'repository.calendar.realtime_reconnect_exhausted',
        { userId: uid, attempts: this.reconnectAttempts },
      )
      return
    }

    this.reconnectAttempts++
    logInfo('calendar.realtime_reconnect_attempt', {
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

  getAll(): CalendarEntry[] {
    return [...this.entries]
  }

  getById(id: string): CalendarEntry | undefined {
    return this.entries.find((entry) => entry.id === id)
  }

  getByJobId(jobId: string): CalendarEntry | undefined {
    return this.entries.find((entry) => entry.jobId === jobId)
  }

  private hydrateFromQueue(uid: string): void {
    const pending = getPendingMutations()
    for (const m of pending) {
      if (m.table !== 'calendar_entries' || m.operation !== 'insert') continue
      if (m.userId && m.userId !== uid) continue
      if (this.entries.some((e) => e.id === m.entityId)) continue
      try {
        const entry = rowToEntry(m.payload as unknown as CalendarEntryRow)
        this.entries = [entry, ...this.entries]
      } catch { /* malformed payload */ }
    }
  }

  /**
   * Wraps a supabase write builder so the underlying promise can be awaited
   * via `drainInFlightWrites`.  Cleanup runs in `.finally()` regardless of
   * whether the write resolved or rejected.  Accepts any PromiseLike (the
   * supabase Postgrest builder is thenable but not a real Promise).
   */
  private trackInFlight<T>(work: PromiseLike<T>): Promise<T> {
    const p = Promise.resolve(work)
    this.inFlightWrites.add(p)
    void p.finally(() => { this.inFlightWrites.delete(p) })
    return p
  }

  /**
   * Awaits every in-flight supabase write started by add() / replace() and is
   * still pending.  Bounded by `maxWaitMs` so a hung network connection cannot
   * block resyncRepositories indefinitely.
   *
   * Promises are settled-awaited (no rejection escapes this method) — the
   * recordPersistenceFailure path inside add() / replace() is what surfaces
   * write errors.  This method's only contract is "give the writes a chance
   * to record their failure before the caller proceeds".
   */
  async drainInFlightWrites(maxWaitMs = 5_000): Promise<void> {
    if (this.inFlightWrites.size === 0) return
    const promises = [...this.inFlightWrites]
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((resolve) => setTimeout(resolve, maxWaitMs)),
    ])
  }

  async add(entry: CalendarEntry, opts?: CalendarWriteOpts): Promise<void> {
    // Custom calendar entries (kind: 'custom') are created by addCustomCalendarEntry()
    // whose callers never pass providerId. Without provider_id the INSERT fails the
    // calendar_entries_owner_insert RLS check (42501): the policy requires
    // (provider_id IS NOT NULL AND owner) OR (provider_id IS NULL AND job_id owned).
    // Custom entries satisfy neither — injecting from this.currentProviderId (set
    // during initialize()) satisfies the owner path without touching callers.
    const resolved: CalendarEntry =
      !entry.providerId && this.currentProviderId
        ? { ...entry, providerId: this.currentProviderId }
        : entry

    this.entries = [resolved, ...this.entries]
    this.notify()

    // If a pending mutation already exists for this entity, the original write is
    // already queued for replay by flushPendingMutations. Firing a second Supabase
    // write would duplicate the failure record and reset the retry counter.
    // The optimistic local add above is sufficient — the queue handles persistence.
    if (hasPendingMutationForEntity('calendar_entries', resolved.id)) {
      logInfo('repository.calendar.add_skipped_pending', { entityId: resolved.id })
      return
    }

    // Defense-in-depth: custom (non-job) user-initiated entries must carry a
    // resolved provider_id before reaching Supabase. If provider_id is still null
    // here (repository not yet hydrated, or user has no provider scope) sending
    // the INSERT would produce a 42501 server-side rejection and a false
    // persistence-failure record. Revert the optimistic add and abort — no
    // Supabase round-trip, no 42501, no SyncStatusBar failure loop.
    // Passive projection writes skip this guard: their provider scope comes from
    // the job→jobs.provider_id contract and is handled separately.
    if (!resolved.providerId && !resolved.jobId && !opts?.passive) {
      this.entries = this.entries.filter((e) => e.id !== resolved.id)
      this.notify()
      logError('repository.calendar.add_no_provider', new Error('provider_id not resolved'), { entityId: resolved.id })
      throw new Error('calendar/add: provider_id not resolved — repository not yet hydrated for this account')
    }

    const { error } = await this.trackInFlight(
      supabase.from('calendar_entries').insert(entryToRow(resolved)),
    )
    if (error) {
      if (isServerSideError(error)) {
        // Revert the optimistic insert — the server rejected it structurally
        // (RLS WITH CHECK, NOT NULL, FK). Keep the local cache consistent with
        // the DB so the next syncCalendarEntriesForJobs call starts from truth.
        this.entries = this.entries.filter((e) => e.id !== resolved.id)
        this.notify()
        if (isDuplicateKeyError(error)) {
          const { data } = await supabase.from('calendar_entries').select('*').eq('id', resolved.id).single()
          if (data) {
            this.entries = [rowToEntry(data as CalendarEntryRow), ...this.entries]
            this.notify()
          }
          return
        }
        logError('repository.calendar.add_failed', error, { entityId: resolved.id, passive: opts?.passive ?? false })
        if (!opts?.passive) {
          recordPersistenceFailure({ domain: 'calendar', operation: 'add', entityId: resolved.id, error, occurredAt: Date.now() })
          throw error
        }
        // passive: log already done above; no banner, no enqueue
        return
      }
      logError('repository.calendar.add_failed', error, { entityId: resolved.id, passive: opts?.passive ?? false })
      if (!opts?.passive) {
        recordPersistenceFailure({ domain: 'calendar', operation: 'add', entityId: resolved.id, error, occurredAt: Date.now() })
        enqueuePendingMutation({
          operation: 'insert',
          table: 'calendar_entries',
          payload: entryToRow(resolved) as unknown as Record<string, unknown>,
          domain: 'calendar',
          entityId: resolved.id,
        })
        throw error
      }
      // passive transient: optimistic entry stays in local cache (consistent with
      // the non-passive transient path); removed on next initializeCalendarRepository.
    }
  }

  async replace(entry: CalendarEntry, opts?: CalendarWriteOpts): Promise<void> {
    this.entries = this.entries.map((e) => (e.id === entry.id ? entry : e))
    this.notify()

    // Pre-flight guard: if a pending mutation already exists for this entity,
    // the original write is queued for replay.  Firing a second Supabase write
    // would duplicate the failure record and reset the retry counter — and on
    // mobile resume, where syncCalendarEntriesForJobs() can fire from multiple
    // tab-mounted screens within the same tick, this is the path that produced
    // duplicate "Calendar – N Änderungen" banners.  The local cache update
    // above is sufficient — the queue handles persistence.
    if (hasPendingMutationForEntity('calendar_entries', entry.id)) {
      logInfo('repository.calendar.update_skipped_pending', { entityId: entry.id })
      return
    }

    const { error } = await this.trackInFlight(
      supabase
        .from('calendar_entries')
        .update(entryToRow(entry))
        .eq('id', entry.id),
    )
    if (error) {
      // Server-side error (Postgres class 23 / 42, PGRST3xx, etc.):
      //   The DB rejected the write for a structural reason — schema mismatch,
      //   RLS deny, FK violation, NOT NULL violation.  Queuing for replay
      //   would reproduce the same rejection and trap the user behind a
      //   permanent banner that no retry can clear.  Match the add() path:
      //   record + throw, no enqueue.
      if (isServerSideError(error)) {
        logError('repository.calendar.update_failed_server', error, { entityId: entry.id, passive: opts?.passive ?? false })
        // passive projection (e.g. syncCalendarEntriesForJobs member reconcile):
        // log only — the local cache is already updated and the next load
        // re-derives; never escalate to the SyncStatusBar banner.
        if (opts?.passive) return
        recordPersistenceFailure({ domain: 'calendar', operation: 'update', entityId: entry.id, error, occurredAt: Date.now() })
        throw error
      }
      // Network / transient: the row may yet land in the DB once connectivity
      // is restored.  Enqueue for background replay via flushPendingMutations.
      logError('repository.calendar.update_failed', error, { entityId: entry.id, passive: opts?.passive ?? false })
      if (opts?.passive) return
      recordPersistenceFailure({ domain: 'calendar', operation: 'update', entityId: entry.id, error, occurredAt: Date.now() })
      enqueuePendingMutation({
        operation: 'update',
        table: 'calendar_entries',
        payload: entryToRow(entry) as unknown as Record<string, unknown>,
        domain: 'calendar',
        entityId: entry.id,
      })
      throw error
    }
  }

  async updateStatus(id: string, status: CalendarEntryStatus, opts?: CalendarWriteOpts): Promise<void> {
    this.entries = this.entries.map((e) =>
      e.id === id ? { ...e, status, updatedAt: Date.now() } : e,
    )
    this.notify()

    if (hasPendingMutationForEntity('calendar_entries', id)) {
      logInfo('repository.calendar.updateStatus_skipped_pending', { entityId: id })
      return
    }

    const now = Date.now()
    const { error } = await this.trackInFlight(
      supabase
        .from('calendar_entries')
        .update({ status, updated_at: now })
        .eq('id', id),
    )
    if (error) {
      if (isServerSideError(error)) {
        logError('repository.calendar.updateStatus_failed_server', error, { entityId: id, passive: opts?.passive ?? false })
        if (!opts?.passive) {
          recordPersistenceFailure({ domain: 'calendar', operation: 'update', entityId: id, error, occurredAt: Date.now() })
          throw error
        }
        // passive: optimistic status update already applied; DB is stale but no
        // banner. On next resync the stale DB value is reloaded and the next
        // syncCalendarEntriesForJobs call retries once (also passive, no banner).
        return
      }
      logError('repository.calendar.updateStatus_failed', error, { entityId: id, passive: opts?.passive ?? false })
      if (!opts?.passive) {
        recordPersistenceFailure({ domain: 'calendar', operation: 'update', entityId: id, error, occurredAt: Date.now() })
        enqueuePendingMutation({
          operation: 'update',
          table: 'calendar_entries',
          payload: { id, status, updated_at: now } as unknown as Record<string, unknown>,
          domain: 'calendar',
          entityId: id,
        })
        throw error
      }
      // passive transient: optimistic update applied; retry on next resync cycle.
    }
  }

  async updateScheduling(
    id: string,
    scheduling: { dateKey: string; startsAtLabel: string; endsAtLabel: string },
    opts?: CalendarWriteOpts,
  ): Promise<void> {
    const now = Date.now()
    this.entries = this.entries.map((e) =>
      e.id === id
        ? {
            ...e,
            dateKey: scheduling.dateKey,
            startsAtLabel: scheduling.startsAtLabel,
            endsAtLabel: scheduling.endsAtLabel,
            updatedAt: now,
          }
        : e,
    )
    this.notify()

    if (hasPendingMutationForEntity('calendar_entries', id)) {
      logInfo('repository.calendar.updateScheduling_skipped_pending', { entityId: id })
      return
    }

    const payload = {
      date_key: scheduling.dateKey,
      starts_at_label: scheduling.startsAtLabel,
      ends_at_label: scheduling.endsAtLabel,
      updated_at: now,
    }

    const { error } = await this.trackInFlight(
      supabase
        .from('calendar_entries')
        .update(payload)
        .eq('id', id),
    )
    if (error) {
      if (isServerSideError(error)) {
        logError('repository.calendar.updateScheduling_failed_server', error, {
          entityId: id,
          passive: opts?.passive ?? false,
        })
        if (!opts?.passive) {
          recordPersistenceFailure({
            domain: 'calendar',
            operation: 'update',
            entityId: id,
            error,
            occurredAt: Date.now(),
          })
          throw error
        }
        return
      }
      logError('repository.calendar.updateScheduling_failed', error, {
        entityId: id,
        passive: opts?.passive ?? false,
      })
      if (!opts?.passive) {
        recordPersistenceFailure({
          domain: 'calendar',
          operation: 'update',
          entityId: id,
          error,
          occurredAt: Date.now(),
        })
        enqueuePendingMutation({
          operation: 'update',
          table: 'calendar_entries',
          payload: { id, ...payload } as unknown as Record<string, unknown>,
          domain: 'calendar',
          entityId: id,
        })
        throw error
      }
    }
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
