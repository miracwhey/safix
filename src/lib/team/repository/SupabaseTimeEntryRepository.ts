import { supabase } from '../../supabase'
import { logBreadcrumb, logError, logInfo, logWarning } from '../../observability'
import type { TimeEntry, TimeEntryKind, TimeEntryStatus } from '../timeEntryTypes'
import {
  TimeEntryActiveConflictError,
  TimeEntryNotFoundError,
  type TimeEntryCreateInput,
  type TimeEntryRepository,
  type TimeEntryUpdatePatch,
} from './TimeEntryRepository'

type Listener = () => void

interface TimeEntryRow {
  id: string
  provider_id: string
  member_id: string
  kind: TimeEntryKind
  job_id: string | null
  started_at: string
  ended_at: string | null
  duration_minutes: number | null
  note: string | null
  status: TimeEntryStatus
  rejected_reason: string | null
  rejected_by: string | null
  rejected_at: string | null
  created_at: string
  updated_at: string
}

function rowToEntry(row: TimeEntryRow): TimeEntry {
  return {
    id: row.id,
    providerId: row.provider_id,
    memberId: row.member_id,
    kind: row.kind,
    jobId: row.job_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMinutes: row.duration_minutes,
    note: row.note,
    status: row.status,
    rejectedReason: row.rejected_reason,
    rejectedBy: row.rejected_by,
    rejectedAt: row.rejected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * How far back to hydrate closed entries on initial load.
 *
 * The hub computes weekly Soll/Ist for the current calendar week, but the
 * worker may see their own running totals over a longer horizon. 14 days
 * keeps the payload bounded while comfortably covering the previous and
 * current week.
 */
const HYDRATION_WINDOW_DAYS = 14

/**
 * Supabase-backed implementation of TimeEntryRepository.
 *
 * Mirrors SupabaseCalendarRepository's lifecycle:
 *   - loadForUser() pulls visible rows on initialize / sign-in / token refresh
 *   - startRealtimeSubscription() subscribes to INSERT/UPDATE/DELETE on
 *     `public.time_entries` (RLS gates which events arrive)
 *   - reactive listeners are notified after each cache mutation
 *
 * REPLICA IDENTITY FULL was set in the time_entries migration so that DELETE
 * events carry the full pre-image — required for our cache eviction logic
 * (matched on row.id from the OLD record).
 */
export class SupabaseTimeEntryRepository implements TimeEntryRepository {
  private entries: TimeEntry[] = []
  private readonly listeners = new Set<Listener>()
  private _hydrated = false
  private _initPromise: Promise<void> | null = null
  private _loadGeneration = 0
  private currentUid: string | null = null
  private authUnsubscribe: (() => void) | null = null
  private realtimeChannel: ReturnType<typeof supabase.channel> | null = null
  private realtimeGeneration = 0
  private isRealtimeConnected = false
  private reconnectAttempts = 0
  private readonly MAX_RECONNECT_ATTEMPTS = 5
  private readonly RECONNECT_DELAY = 3000

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
      if (generation !== this._loadGeneration) return
      this._hydrated = true
      this.notify()
      this.ensureAuthListener()
      this.startRealtimeSubscription(session.user.id)
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
    const sinceIso = new Date(Date.now() - HYDRATION_WINDOW_DAYS * 86400_000).toISOString()
    const { data, error } = await supabase
      .from('time_entries')
      .select('*')
      .or(`status.eq.active,started_at.gte.${sinceIso}`)
      .order('started_at', { ascending: false })
      .limit(500)
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    if (error) {
      logError('repository.timeEntries.load_failed', error, { uid })
      throw error
    }
    const rows = (data ?? []) as TimeEntryRow[]
    this.entries = rows.map(rowToEntry)
    this.notify()
  }

  private resetState(): void {
    this._initPromise = null
    // Reset hydration flag so consumers see the loading state while
    // re-initialization completes after sign-out or reset.
    this._hydrated = false
    this.realtimeGeneration++
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
      this.realtimeChannel = null
    }
    this.isRealtimeConnected = false
    this.reconnectAttempts = 0
    this.currentUid = null
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
        const gen = ++this._loadGeneration
        void this.loadForUser(uid, gen).then(() => {
          if (gen !== this._loadGeneration) return
          if (!this._hydrated) {
            this._hydrated = true
            this.notify()
          }
          this.startRealtimeSubscription(uid)
        }).catch((err) => {
          logError('repository.timeEntries.reload_failed', err, { uid })
        })
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
   * Subscribes to INSERT, UPDATE, DELETE events on `time_entries`.
   *
   * INSERT dedup: skip rows already present locally (optimistic write
   * round-trip).
   *
   * UPDATE merge: replace by id; if missing, insert. Workers / owners may
   * receive updates for rows they did not have cached yet.
   *
   * DELETE eviction: drop by id from the OLD record. Requires REPLICA
   * IDENTITY FULL on the table (set in migration).
   */
  private startRealtimeSubscription(uid: string, fromReconnection = false): void {
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
    }
    const generation = ++this.realtimeGeneration
    this.realtimeChannel = supabase
      .channel(`fixup-time-entries-${uid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'time_entries' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as TimeEntryRow
          if (this.entries.some((e) => e.id === row.id)) return
          this.entries = [rowToEntry(row), ...this.entries]
          this.notify()
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'time_entries' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as TimeEntryRow
          const exists = this.entries.some((e) => e.id === row.id)
          if (exists) {
            this.entries = this.entries.map((e) => (e.id === row.id ? rowToEntry(row) : e))
          } else {
            this.entries = [rowToEntry(row), ...this.entries]
          }
          this.notify()
        },
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'time_entries' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.old as Partial<TimeEntryRow>
          if (!row.id) return
          this.entries = this.entries.filter((e) => e.id !== row.id)
          this.notify()
        },
      )
      .subscribe((status) => {
        if (generation !== this.realtimeGeneration) return
        if (status === 'SUBSCRIBED') {
          this.isRealtimeConnected = true
          this.reconnectAttempts = 0
          logInfo('repository.timeEntries.realtime_subscribed', { uid })
          if (fromReconnection) void this.fallbackRefresh(uid)
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.isRealtimeConnected = false
          logBreadcrumb(
            'repository.timeEntries.realtime_disconnected',
            'warning',
            { uid, status },
          )
          void this.fallbackRefresh(uid)
          this.attemptReconnection(uid)
        }
      })
  }

  private async fallbackRefresh(uid: string): Promise<void> {
    try {
      const generation = ++this._loadGeneration
      await this.loadForUser(uid, generation)
      // Guarantee hydration after a successful fallback load. initialize()
      // may have returned early (generation mismatch) before setting
      // _hydrated — fallbackRefresh is the recovery path that fills that gap.
      if (generation === this._loadGeneration && !this._hydrated) {
        this._hydrated = true
        this.notify()
      }
      logInfo('repository.timeEntries.fallback_refresh_completed', { uid })
    } catch (error) {
      logError('repository.timeEntries.fallback_refresh_error', error as Error, { uid })
    }
  }

  private attemptReconnection(uid: string): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logWarning(
        'repository.timeEntries.realtime_reconnect_exhausted',
        { uid, attempts: this.reconnectAttempts },
      )
      return
    }
    this.reconnectAttempts++
    logInfo('repository.timeEntries.realtime_reconnect_attempt', {
      uid,
      attempt: this.reconnectAttempts,
      maxAttempts: this.MAX_RECONNECT_ATTEMPTS,
    })
    setTimeout(() => {
      if (!this.isRealtimeConnected && this.currentUid === uid) {
        this.startRealtimeSubscription(uid, true)
      }
    }, this.RECONNECT_DELAY * this.reconnectAttempts)
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

  private notify(): void {
    this.listeners.forEach((l) => l())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): TimeEntry[] {
    return [...this.entries]
  }

  getById(id: string): TimeEntry | undefined {
    return this.entries.find((e) => e.id === id)
  }

  async create(input: TimeEntryCreateInput): Promise<TimeEntry> {
    if (input.kind === 'job' && !input.jobId) {
      throw new Error('TimeEntry: kind="job" requires jobId')
    }
    if (input.kind === 'day' && input.jobId) {
      throw new Error('TimeEntry: kind="day" must not have jobId')
    }

    const insertRow = {
      provider_id: input.providerId,
      member_id: input.memberId,
      kind: input.kind,
      job_id: input.jobId,
      started_at: input.startedAt,
      note: input.note ?? null,
      status: 'active' as const,
    }

    const { data, error } = await supabase
      .from('time_entries')
      .insert(insertRow)
      .select()
      .single()

    if (error) {
      // Postgres unique_violation on time_entries_active_{day,job}_unique
      const code = (error as { code?: string }).code
      if (code === '23505') {
        throw new TimeEntryActiveConflictError(input.kind)
      }
      logError('repository.timeEntries.create_failed', error, { memberId: input.memberId, kind: input.kind })
      throw error
    }

    const entry = rowToEntry(data as TimeEntryRow)
    // Realtime channel will also deliver this INSERT — dedup is handled there.
    if (!this.entries.some((e) => e.id === entry.id)) {
      this.entries = [entry, ...this.entries]
      this.notify()
    }
    return entry
  }

  async update(id: string, patch: TimeEntryUpdatePatch): Promise<TimeEntry> {
    const updateRow: Record<string, unknown> = {}
    if (patch.status !== undefined) updateRow.status = patch.status
    if (patch.endedAt !== undefined) updateRow.ended_at = patch.endedAt
    if (patch.durationMinutes !== undefined) updateRow.duration_minutes = patch.durationMinutes
    if (patch.note !== undefined) updateRow.note = patch.note
    if (patch.rejectedReason !== undefined) updateRow.rejected_reason = patch.rejectedReason
    if (patch.rejectedBy !== undefined) updateRow.rejected_by = patch.rejectedBy

    const { data, error } = await supabase
      .from('time_entries')
      .update(updateRow)
      .eq('id', id)
      .select()
      .maybeSingle()

    if (error) {
      logError('repository.timeEntries.update_failed', error, { id })
      throw error
    }
    if (!data) {
      throw new TimeEntryNotFoundError(id)
    }
    const entry = rowToEntry(data as TimeEntryRow)
    this.entries = this.entries.map((e) => (e.id === id ? entry : e))
    this.notify()
    return entry
  }

  reset(): void {
    this.resetState()
  }

  prepareForResync(): void {
    this._initPromise = null
    this._loadGeneration++
  }
}
