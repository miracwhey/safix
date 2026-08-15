import { supabase } from '../../supabase'
import { recordPersistenceFailure, enqueuePendingMutation, hasPendingMutationForEntity, getPendingMutations, isServerSideError, isDuplicateKeyError } from '../../persistence'
import { logBreadcrumb, logError, logInfo, logWarning } from '../../observability'
import type { ProjectTimelineEventType, ProjectTimelineSignal } from '../types'
import type { TimelineRepository } from './TimelineRepository'

type Listener = () => void

interface TimelineSignalRow {
  id: string
  job_id: string
  type: string
  occurred_at: number
  entity_id?: string | null
}

function rowToSignal(row: TimelineSignalRow): ProjectTimelineSignal {
  return {
    id: row.id,
    jobId: row.job_id,
    type: row.type as ProjectTimelineEventType,
    occurredAt: row.occurred_at,
    ...(row.entity_id != null ? { entityId: row.entity_id } : {}),
  }
}

function signalToRow(signal: ProjectTimelineSignal): TimelineSignalRow {
  return {
    id: signal.id,
    job_id: signal.jobId,
    type: signal.type,
    occurred_at: signal.occurredAt,
    ...(signal.entityId != null ? { entity_id: signal.entityId } : {}),
  }
}

export class SupabaseTimelineRepository implements TimelineRepository {
  private signals: ProjectTimelineSignal[] = []
  private readonly listeners = new Set<Listener>()
  private _hydrated = false
  private currentUid: string | null = null
  private _initPromise: Promise<void> | null = null
  private _loadGeneration = 0
  private realtimeChannel: ReturnType<typeof supabase.channel> | null = null
  private isRealtimeConnected = false
  private reconnectAttempts = 0
  private authUnsubscribe: (() => void) | null = null
  private realtimeGeneration = 0
  private readonly MAX_RECONNECT_ATTEMPTS = 5
  private readonly RECONNECT_DELAY = 3000

  async initialize(): Promise<void> {
    if (this._initPromise) return this._initPromise
    const generation = ++this._loadGeneration
    const p: Promise<void> = (async () => {
      // Register auth listener first so that a loadForUser() failure (network
      // error) still leaves a self-heal path: the listener fires on the next
      // TOKEN_REFRESHED or SIGNED_IN and retries the load.
      this.ensureAuthListener()
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (generation !== this._loadGeneration) return
      if (!session?.user) {
        this.currentUid = null
        this.signals = []
        this._hydrated = true
        this.notify()
        return
      }
      await this.loadForUser(session.user.id, generation)
      this._hydrated = true
      this.notify()
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

  notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private async fetchFromDatabase(): Promise<ProjectTimelineSignal[]> {
    const { data, error } = await supabase
      .from('timeline_signals')
      .select('*')
      .order('occurred_at', { ascending: true })
      .limit(500)
    if (error) throw error
    return ((data ?? []) as TimelineSignalRow[]).map(rowToSignal)
  }

  private async loadForUser(uid: string, generationSnapshot: number): Promise<void> {
    this.currentUid = uid
    const signals = await this.fetchFromDatabase()
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    this.signals = signals
    this.hydrateFromQueue(uid)
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
    this.signals = []
    this.notify()
  }

  private ensureAuthListener(): void {
    if (this.authUnsubscribe) return
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      const uid = session?.user?.id
      if (
        (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') &&
        uid &&
        (uid !== this.currentUid || !this._hydrated)
      ) {
        void this.loadForUser(uid, this._loadGeneration).then(() => {
          this._hydrated = true
          this.notify()
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

  private startRealtimeSubscription(uid: string, fromReconnection = false): void {
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
    }
    const generation = ++this.realtimeGeneration
    this.realtimeChannel = supabase
      .channel(`fixup-timeline-${uid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'timeline_signals' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as TimelineSignalRow
          if (this.signals.some((s) => s.id === row.id)) return
          this.signals = [...this.signals, rowToSignal(row)].sort(
            (a, b) => a.occurredAt - b.occurredAt,
          )
          this.notify()
          logInfo('timeline.realtime_inserted', {
            signalId: row.id,
            jobId: row.job_id,
            type: row.type,
          })
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'timeline_signals' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as TimelineSignalRow
          const exists = this.signals.some((s) => s.id === row.id)
          if (exists) {
            this.signals = this.signals.map((s) =>
              s.id === row.id ? rowToSignal(row) : s,
            )
          } else {
            this.signals = [...this.signals, rowToSignal(row)].sort(
              (a, b) => a.occurredAt - b.occurredAt,
            )
          }
          this.notify()
          logInfo('timeline.realtime_updated', { signalId: row.id, jobId: row.job_id })
        },
      )
      .subscribe((status) => {
        if (generation !== this.realtimeGeneration) return
        if (status === 'SUBSCRIBED') {
          this.isRealtimeConnected = true
          this.reconnectAttempts = 0
          logInfo('timeline.realtime_connected', { userId: uid })
          if (fromReconnection) void this.fallbackRefresh()
        } else if (
          status === 'CHANNEL_ERROR' ||
          status === 'TIMED_OUT' ||
          status === 'CLOSED'
        ) {
          this.isRealtimeConnected = false
          logBreadcrumb(
            'repository.timeline.realtime_disconnected',
            'warning',
            { userId: uid, status },
          )
          void this.fallbackRefresh()
          this.attemptReconnection(uid)
        }
      })
  }

  private async fallbackRefresh(): Promise<void> {
    const snapshotUid = this.currentUid
    const snapshotGeneration = this._loadGeneration
    try {
      const signals = await this.fetchFromDatabase()
      if (this.currentUid !== snapshotUid || this._loadGeneration !== snapshotGeneration) return
      this.signals = signals
      this.notify()
      logInfo('timeline.fallback_refresh_completed', {})
    } catch (error) {
      logError('repository.timeline.fallback_refresh_error', error as Error, {})
    }
  }

  private attemptReconnection(uid: string): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logWarning(
        'repository.timeline.realtime_reconnect_exhausted',
        { userId: uid, attempts: this.reconnectAttempts },
      )
      return
    }
    this.reconnectAttempts++
    setTimeout(() => {
      if (!this.isRealtimeConnected && this.currentUid === uid) {
        this.startRealtimeSubscription(uid, true)
      }
    }, this.RECONNECT_DELAY * this.reconnectAttempts)
  }

  getAll(): ProjectTimelineSignal[] {
    return [...this.signals]
  }

  getForJob(jobId: string): ProjectTimelineSignal[] {
    return this.signals
      .filter((signal) => signal.jobId === jobId)
      .sort((a, b) => a.occurredAt - b.occurredAt)
  }

  hasEventOfType(jobId: string, type: ProjectTimelineEventType): boolean {
    return this.signals.some(
      (signal) => signal.jobId === jobId && signal.type === type,
    )
  }

  private hydrateFromQueue(uid: string): void {
    const pending = getPendingMutations()
    for (const m of pending) {
      if (m.table !== 'timeline_signals' || m.operation !== 'insert') continue
      if (m.userId && m.userId !== uid) continue
      if (this.signals.some((s) => s.id === m.entityId)) continue
      try {
        const signal = rowToSignal(m.payload as unknown as TimelineSignalRow)
        this.signals = [...this.signals, signal].sort((a, b) => a.occurredAt - b.occurredAt)
      } catch { /* malformed payload */ }
    }
  }

  add(signal: ProjectTimelineSignal): void {
    if (this.signals.some((s) => s.id === signal.id)) return
    this.signals = [...this.signals, signal].sort(
      (a, b) => a.occurredAt - b.occurredAt,
    )
    this.notify()

    // If a pending mutation already exists for this entity (e.g. this signal was
    // offline-created and its write is already queued), skip the direct write to
    // avoid resetting the retry counter and duplicating the failure record.
    if (hasPendingMutationForEntity('timeline_signals', signal.id)) {
      logInfo('repository.timeline.add_skipped_pending', { entityId: signal.id })
      return
    }

    supabase
      .from('timeline_signals')
      .insert(signalToRow(signal))
      .then(({ error }) => {
        if (error) {
          if (isServerSideError(error)) {
            this.signals = this.signals.filter((s) => s.id !== signal.id)
            this.notify()
            if (isDuplicateKeyError(error)) {
              void supabase.from('timeline_signals').select('*').eq('id', signal.id).single().then(({ data }) => {
                if (data) {
                  this.signals = [...this.signals, rowToSignal(data as TimelineSignalRow)].sort((a, b) => a.occurredAt - b.occurredAt)
                  this.notify()
                }
              })
              return
            }
            logError('repository.timeline.add_failed', error, { entityId: signal.id, jobId: signal.jobId, type: signal.type })
            recordPersistenceFailure({ domain: 'timeline', operation: 'add', entityId: signal.id, error, occurredAt: Date.now() })
            return
          }
          logError('repository.timeline.add_failed', error, {
            entityId: signal.id,
            jobId: signal.jobId,
            type: signal.type,
          })
          recordPersistenceFailure({
            domain: 'timeline',
            operation: 'add',
            entityId: signal.id,
            error,
            occurredAt: Date.now(),
          })
          enqueuePendingMutation({
            operation: 'insert',
            table: 'timeline_signals',
            payload: signalToRow(signal) as unknown as Record<string, unknown>,
            domain: 'timeline',
            entityId: signal.id,
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
