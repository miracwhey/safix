import { supabase } from '../../supabase'
import { recordPersistenceFailure, enqueuePendingMutation, hasPendingMutationForEntity, getPendingMutations, isServerSideError, isDuplicateKeyError } from '../../persistence'
import { logBreadcrumb, logError, logInfo, logWarning } from '../../observability'
import type { JobSchedule, SchedulingStatus } from '../types'
import type { ScheduleRepository } from './ScheduleRepository'

type Listener = () => void

interface ScheduleRow {
  id: string
  job_id: string
  scheduled_start: number
  scheduled_end: number
  execution_window: number
  scheduling_status: string
  created_at: number
  updated_at: number
}

function rowToSchedule(row: ScheduleRow): JobSchedule {
  return {
    id: row.id,
    jobId: row.job_id,
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    executionWindow: row.execution_window,
    schedulingStatus: row.scheduling_status as SchedulingStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function scheduleToRow(schedule: JobSchedule): ScheduleRow {
  return {
    id: schedule.id,
    job_id: schedule.jobId,
    scheduled_start: schedule.scheduledStart,
    scheduled_end: schedule.scheduledEnd,
    execution_window: schedule.executionWindow,
    scheduling_status: schedule.schedulingStatus,
    created_at: schedule.createdAt,
    updated_at: schedule.updatedAt,
  }
}

/**
 * Supabase-backed implementation of the ScheduleRepository interface.
 *
 * Uses a local in-memory cache to serve synchronous reads, keeping
 * the reactive subscription model intact while all writes are also
 * persisted to the `schedules` table asynchronously.
 *
 * Bootstrap sequence:
 * 1. Construct the repository.
 * 2. Register it via `setScheduleRepository()`.
 * 3. Await `initializeScheduleRepository()` (or `repo.initialize()` directly)
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
 *   and UPDATE events on the `schedules` table.  INSERT rows are deduplicated
 *   by ID (prevents double-display after optimistic writes).  UPDATE rows
 *   replace the existing cache entry so schedule status changes from the
 *   other party appear without a manual reload.
 */
export class SupabaseScheduleRepository implements ScheduleRepository {
  private schedules: JobSchedule[] = []
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
        this.schedules = []
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

  private async fetchSchedulesFromDatabase(): Promise<JobSchedule[]> {
    const { data, error } = await supabase
      .from('schedules')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500)
    if (error) throw error
    return ((data ?? []) as ScheduleRow[]).map(rowToSchedule)
  }

  private async loadForUser(uid: string, generationSnapshot: number): Promise<void> {
    this.currentUid = uid
    const schedules = await this.fetchSchedulesFromDatabase()
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    this.schedules = schedules
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
    this.schedules = []
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
   * Subscribes to INSERT and UPDATE events on the `schedules` table via Supabase Realtime.
   *
   * INSERT deduplication: if the arriving schedule ID already exists in the local cache
   * (inserted optimistically by this client) we silently drop it.
   *
   * UPDATE merge: replaces the existing cache entry by ID so that scheduling status
   * changes from the other party (e.g. craftsman starting execution) appear without
   * a manual reload.  If the schedule is not yet in cache, it is added.
   *
   * RLS on the Supabase side scopes the channel to schedules visible to this user.
   */
  private startRealtimeSubscription(uid: string, fromReconnection = false): void {
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
    }
    const generation = ++this.realtimeGeneration
    this.realtimeChannel = supabase
      .channel(`fixup-schedules-${uid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'schedules' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as ScheduleRow
          if (this.schedules.some((s) => s.id === row.id)) return
          this.schedules = [rowToSchedule(row), ...this.schedules]
          this.notify()
          logInfo('schedule.realtime_inserted', { scheduleId: row.id, jobId: row.job_id })
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'schedules' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as ScheduleRow
          const exists = this.schedules.some((s) => s.id === row.id)
          if (exists) {
            this.schedules = this.schedules.map((s) => (s.id === row.id ? rowToSchedule(row) : s))
          } else {
            this.schedules = [rowToSchedule(row), ...this.schedules]
          }
          this.notify()
          logInfo('schedule.realtime_updated', { scheduleId: row.id, jobId: row.job_id, status: row.scheduling_status })
        },
      )
      .subscribe((status) => {
        if (generation !== this.realtimeGeneration) return
        if (status === 'SUBSCRIBED') {
          this.isRealtimeConnected = true
          this.reconnectAttempts = 0
          logInfo('schedule.realtime_connected', { userId: uid })
          if (fromReconnection) void this.fallbackRefresh(uid)
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.isRealtimeConnected = false
          logBreadcrumb(
            'repository.schedules.realtime_disconnected',
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
      const freshSchedules = await this.fetchSchedulesFromDatabase()
      this.schedules = freshSchedules
      this.notify()
      logInfo('schedule.fallback_refresh_completed', { userId: uid })
    } catch (error) {
      logError('repository.schedules.fallback_refresh_error', error as Error, { userId: uid })
    }
  }

  private attemptReconnection(uid: string): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logWarning(
        'repository.schedules.realtime_reconnect_exhausted',
        { userId: uid, attempts: this.reconnectAttempts },
      )
      return
    }

    this.reconnectAttempts++
    logInfo('schedule.realtime_reconnect_attempt', {
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

  getAll(): JobSchedule[] {
    return [...this.schedules]
  }

  getById(id: string): JobSchedule | undefined {
    return this.schedules.find((s) => s.id === id)
  }

  getByJobId(jobId: string): JobSchedule | undefined {
    return this.schedules.find((s) => s.jobId === jobId)
  }

  private hydrateFromQueue(uid: string): void {
    const pending = getPendingMutations()
    for (const m of pending) {
      if (m.table !== 'schedules' || m.operation !== 'insert') continue
      if (m.userId && m.userId !== uid) continue
      if (this.schedules.some((s) => s.id === m.entityId)) continue
      try {
        const schedule = rowToSchedule(m.payload as unknown as ScheduleRow)
        this.schedules = [schedule, ...this.schedules]
      } catch { /* malformed payload */ }
    }
  }

  add(schedule: JobSchedule): void {
    this.schedules = [schedule, ...this.schedules]
    this.notify()

    // If a pending mutation already exists for this entity, the original write is
    // queued for replay — skip the duplicate write to preserve retry count.
    if (hasPendingMutationForEntity('schedules', schedule.id)) {
      logInfo('repository.schedules.add_skipped_pending', { entityId: schedule.id })
      return
    }

    supabase
      .from('schedules')
      .insert(scheduleToRow(schedule))
      .then(({ error }) => {
        if (error) {
          if (isServerSideError(error)) {
            this.schedules = this.schedules.filter((s) => s.id !== schedule.id)
            this.notify()
            if (isDuplicateKeyError(error)) {
              void supabase.from('schedules').select('*').eq('id', schedule.id).single().then(({ data }) => {
                if (data) {
                  this.schedules = [rowToSchedule(data as ScheduleRow), ...this.schedules]
                  this.notify()
                }
              })
              return
            }
            logError('repository.schedules.add_failed', error, { entityId: schedule.id })
            recordPersistenceFailure({ domain: 'schedules', operation: 'add', entityId: schedule.id, error, occurredAt: Date.now() })
            return
          }
          logError('repository.schedules.add_failed', error, { entityId: schedule.id })
          recordPersistenceFailure({ domain: 'schedules', operation: 'add', entityId: schedule.id, error, occurredAt: Date.now() })
          enqueuePendingMutation({
            operation: 'insert',
            table: 'schedules',
            payload: scheduleToRow(schedule) as unknown as Record<string, unknown>,
            domain: 'schedules',
            entityId: schedule.id,
          })
        }
      })
  }

  updateStatus(id: string, nextStatus: SchedulingStatus): void {
    let updated: JobSchedule | undefined
    this.schedules = this.schedules.map((s) => {
      if (s.id !== id) return s
      updated = { ...s, schedulingStatus: nextStatus, updatedAt: Date.now() }
      return updated
    })
    this.notify()
    if (updated) {
      const snapshot = updated
      supabase
        .from('schedules')
        .update(scheduleToRow(snapshot))
        .eq('id', id)
        .then(({ error }) => {
          if (error) {
            logError('repository.schedules.update_failed', error, { entityId: id })
            recordPersistenceFailure({ domain: 'schedules', operation: 'update', entityId: id, error, occurredAt: Date.now() })
            enqueuePendingMutation({
              operation: 'update',
              table: 'schedules',
              payload: scheduleToRow(snapshot) as unknown as Record<string, unknown>,
              domain: 'schedules',
              entityId: id,
            })
          }
        })
    }
  }

  replace(schedule: JobSchedule): void {
    this.schedules = this.schedules.map((s) =>
      s.id === schedule.id ? schedule : s
    )
    this.notify()
    supabase
      .from('schedules')
      .update(scheduleToRow(schedule))
      .eq('id', schedule.id)
      .then(({ error }) => {
        if (error) {
          logError('repository.schedules.replace_failed', error, { entityId: schedule.id })
          recordPersistenceFailure({ domain: 'schedules', operation: 'update', entityId: schedule.id, error, occurredAt: Date.now() })
          enqueuePendingMutation({
            operation: 'update',
            table: 'schedules',
            payload: scheduleToRow(schedule) as unknown as Record<string, unknown>,
            domain: 'schedules',
            entityId: schedule.id,
          })
        }
      })
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
