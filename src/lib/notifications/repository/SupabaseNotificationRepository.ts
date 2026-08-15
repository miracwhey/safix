import { supabase } from '../../supabase'
import { recordPersistenceFailure, enqueuePendingMutation, hasPendingMutationForEntity, getPendingMutations, isServerSideError, isDuplicateKeyError } from '../../persistence'
import { logBreadcrumb, logError, logInfo, logWarning } from '../../observability'
import type { NotificationPriority, NotificationSignal } from '../types'
import type { ProjectTimelineEventType } from '../../timeline'
import type { NotificationRepository } from './NotificationRepository'

type Listener = () => void

interface NotificationSignalRow {
  id: string
  job_id: string
  type: string
  priority: string
  read: boolean
  occurred_at: number
  recipient_role: string
  // A.2 — inline-action meta (nullable in DB)
  entity_id?: string | null
  entity_type?: string | null
  action_type?: string | null
  role_target?: string | null
  expected_status?: string | null
  expires_at?: number | null
}

function rowToSignal(row: NotificationSignalRow): NotificationSignal {
  return {
    id: row.id,
    jobId: row.job_id,
    type: row.type as ProjectTimelineEventType,
    priority: row.priority as NotificationPriority,
    read: row.read,
    occurredAt: row.occurred_at,
    recipientRole: (row.recipient_role === 'customer' ? 'customer' : 'craftsman'),
    ...(row.entity_id != null && { entityId: row.entity_id }),
    ...(row.entity_type != null && { entityType: row.entity_type }),
    ...(row.action_type != null && { actionType: row.action_type }),
    ...(row.role_target != null && { roleTarget: row.role_target }),
    ...(row.expected_status != null && { expectedStatus: row.expected_status }),
    ...(row.expires_at != null && { expiresAt: row.expires_at }),
  }
}

function signalToRow(signal: NotificationSignal): NotificationSignalRow {
  return {
    id: signal.id,
    job_id: signal.jobId,
    type: signal.type,
    priority: signal.priority,
    read: signal.read,
    occurred_at: signal.occurredAt,
    recipient_role: signal.recipientRole,
    ...(signal.entityId !== undefined && { entity_id: signal.entityId }),
    ...(signal.entityType !== undefined && { entity_type: signal.entityType }),
    ...(signal.actionType !== undefined && { action_type: signal.actionType }),
    ...(signal.roleTarget !== undefined && { role_target: signal.roleTarget }),
    ...(signal.expectedStatus !== undefined && { expected_status: signal.expectedStatus }),
    ...(signal.expiresAt !== undefined && { expires_at: signal.expiresAt }),
  }
}

export class SupabaseNotificationRepository implements NotificationRepository {
  private signals: NotificationSignal[] = []
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

  private async fetchFromDatabase(): Promise<NotificationSignal[]> {
    const { data, error } = await supabase
      .from('notification_signals')
      .select('*')
      .order('occurred_at', { ascending: false })
      .limit(200)
    if (error) throw error
    return ((data ?? []) as NotificationSignalRow[]).map(rowToSignal)
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
      .channel(`fixup-notifications-${uid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notification_signals' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as NotificationSignalRow
          if (this.signals.some((s) => s.id === row.id)) return
          this.signals = [...this.signals, rowToSignal(row)].sort(
            (a, b) => b.occurredAt - a.occurredAt,
          )
          this.notify()
          logInfo('notifications.realtime_inserted', {
            signalId: row.id,
            jobId: row.job_id,
            type: row.type,
          })
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'notification_signals' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as NotificationSignalRow
          const exists = this.signals.some((s) => s.id === row.id)
          if (exists) {
            this.signals = this.signals.map((s) =>
              s.id === row.id ? rowToSignal(row) : s,
            )
          } else {
            this.signals = [...this.signals, rowToSignal(row)].sort(
              (a, b) => b.occurredAt - a.occurredAt,
            )
          }
          this.notify()
          logInfo('notifications.realtime_updated', { signalId: row.id, read: row.read })
        },
      )
      .subscribe((status) => {
        if (generation !== this.realtimeGeneration) return
        if (status === 'SUBSCRIBED') {
          this.isRealtimeConnected = true
          this.reconnectAttempts = 0
          logInfo('notifications.realtime_connected', { userId: uid })
          if (fromReconnection) void this.fallbackRefresh()
        } else if (
          status === 'CHANNEL_ERROR' ||
          status === 'TIMED_OUT' ||
          status === 'CLOSED'
        ) {
          this.isRealtimeConnected = false
          logBreadcrumb(
            'repository.notifications.realtime_disconnected',
            'warning',
            { userId: uid, status },
          )
          void this.fallbackRefresh()
          this.attemptReconnection(uid)
        }
      })
  }

  private async fallbackRefresh(): Promise<void> {
    try {
      this.signals = await this.fetchFromDatabase()
      this.notify()
      logInfo('notifications.fallback_refresh_completed', {})
    } catch (error) {
      logError('repository.notifications.fallback_refresh_error', error as Error, {})
    }
  }

  private attemptReconnection(uid: string): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logWarning(
        'repository.notifications.realtime_reconnect_exhausted',
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

  private hydrateFromQueue(uid: string): void {
    const pending = getPendingMutations()
    for (const m of pending) {
      if (m.table !== 'notification_signals' || m.operation !== 'insert') continue
      if (m.userId && m.userId !== uid) continue
      if (this.signals.some((s) => s.id === m.entityId)) continue
      try {
        const signal = rowToSignal(m.payload as unknown as NotificationSignalRow)
        this.signals = [...this.signals, signal].sort((a, b) => b.occurredAt - a.occurredAt)
      } catch { /* malformed payload */ }
    }
  }

  getAll(): NotificationSignal[] {
    return [...this.signals]
      .sort((a, b) => b.occurredAt - a.occurredAt)
      .map((s) => ({ ...s }))
  }

  getForJob(jobId: string): NotificationSignal[] {
    return this.signals
      .filter((signal) => signal.jobId === jobId)
      .sort((a, b) => a.occurredAt - b.occurredAt)
      .map((s) => ({ ...s }))
  }

  getUnread(): NotificationSignal[] {
    return this.signals.filter((signal) => !signal.read).map((s) => ({ ...s }))
  }

  hasSignal(id: string): boolean {
    return this.signals.some((s) => s.id === id)
  }

  add(signal: NotificationSignal): void {
    if (this.hasSignal(signal.id)) return
    this.signals = [...this.signals, signal].sort(
      (a, b) => b.occurredAt - a.occurredAt,
    )
    this.notify()

    // Pending guard: if a prior add() for this signal already failed and is
    // queued for replay, skip the write — the queue covers it.  Firing a
    // second insert would dedup the payload in enqueuePendingMutation and
    // corrupt the queued full-row payload with a partial one.
    if (hasPendingMutationForEntity('notification_signals', signal.id)) {
      logInfo('repository.notifications.add_skipped_pending', { entityId: signal.id })
      return
    }

    supabase
      .from('notification_signals')
      .insert(signalToRow(signal))
      .then(({ error }) => {
        if (error) {
          if (isServerSideError(error)) {
            this.signals = this.signals.filter((s) => s.id !== signal.id)
            this.notify()
            if (isDuplicateKeyError(error)) {
              void supabase.from('notification_signals').select('*').eq('id', signal.id).single().then(({ data }) => {
                if (data) {
                  this.signals = [...this.signals, rowToSignal(data as NotificationSignalRow)].sort((a, b) => b.occurredAt - a.occurredAt)
                  this.notify()
                }
              })
              return
            }
            logError('repository.notifications.add_failed', error, { entityId: signal.id })
            recordPersistenceFailure({ domain: 'notifications', operation: 'add', entityId: signal.id, error, occurredAt: Date.now() })
            return
          }
          logError('repository.notifications.add_failed', error, { entityId: signal.id })
          recordPersistenceFailure({
            domain: 'notifications',
            operation: 'add',
            entityId: signal.id,
            error,
            occurredAt: Date.now(),
          })
          enqueuePendingMutation({
            operation: 'insert',
            table: 'notification_signals',
            payload: signalToRow(signal) as unknown as Record<string, unknown>,
            domain: 'notifications',
            entityId: signal.id,
          })
        }
      })
  }

  markRead(id: string): void {
    const updated = this.signals.map((signal) =>
      signal.id === id ? { ...signal, read: true } : signal,
    )
    if (updated.some((s, i) => s.read !== this.signals[i].read)) {
      this.signals = updated
      this.notify()

      // Pre-flight: if a pending INSERT exists for this signal, the DB row does
      // not exist yet.  Firing an UPDATE would silently target zero rows — even
      // a successful response means read=false will remain in the row created by
      // the later INSERT replay.  Merge read=true into the INSERT payload now so
      // the row is created in the correct final state on replay.
      if (hasPendingMutationForEntity('notification_signals', id)) {
        const signal = this.signals.find((s) => s.id === id)
        if (signal) {
          enqueuePendingMutation({
            operation: 'insert',
            table: 'notification_signals',
            payload: signalToRow(signal) as unknown as Record<string, unknown>,
            domain: 'notifications',
            entityId: id,
          })
        }
        return
      }

      supabase
        .from('notification_signals')
        .update({ read: true })
        .eq('id', id)
        .then(({ error }) => {
          if (error) {
            logError('repository.notifications.mark_read_failed', error, { entityId: id })
            recordPersistenceFailure({
              domain: 'notifications',
              operation: 'update',
              entityId: id,
              error,
              occurredAt: Date.now(),
            })
            enqueuePendingMutation({
              operation: 'update',
              table: 'notification_signals',
              payload: { id, read: true } as Record<string, unknown>,
              domain: 'notifications',
              entityId: id,
            })
          }
        })
    }
  }

  markAllRead(): void {
    const unreadSignals = this.signals.filter((s) => !s.read)
    if (unreadSignals.length === 0) return
    this.signals = this.signals.map((signal) => ({ ...signal, read: true }))
    this.notify()

    // Partition by pending INSERT presence.
    // Signals with a pending INSERT have no DB row yet — the bulk UPDATE would
    // silently miss them, and even a successful UPDATE response cannot produce
    // read=true in the row that will be created later by the INSERT replay.
    // Merge read=true into each INSERT payload immediately so replay produces
    // the correct final row.  Only normal signals (no pending INSERT) go through
    // the DB UPDATE path.
    const normalSignals: NotificationSignal[] = []
    for (const signal of unreadSignals) {
      if (hasPendingMutationForEntity('notification_signals', signal.id)) {
        enqueuePendingMutation({
          operation: 'insert',
          table: 'notification_signals',
          payload: signalToRow({ ...signal, read: true }) as unknown as Record<string, unknown>,
          domain: 'notifications',
          entityId: signal.id,
        })
      } else {
        normalSignals.push(signal)
      }
    }

    if (normalSignals.length === 0) return

    supabase
      .from('notification_signals')
      .update({ read: true })
      .eq('read', false)
      .then(({ error }) => {
        if (error) {
          logError('repository.notifications.mark_all_read_failed', error, { entityId: 'all' })
          // Fan out per-entity: failure entityId must match the mutation entityId so
          // clearPersistenceFailureForEntity() in the flush success path precisely
          // clears each one.  An aggregate entityId='all' would never be cleared
          // since flushPendingMutations clears by per-entity id, leaving a stale banner.
          for (const signal of normalSignals) {
            recordPersistenceFailure({
              domain: 'notifications',
              operation: 'update',
              entityId: signal.id,
              error,
              occurredAt: Date.now(),
            })
            enqueuePendingMutation({
              operation: 'update',
              table: 'notification_signals',
              payload: { id: signal.id, read: true } as Record<string, unknown>,
              domain: 'notifications',
              entityId: signal.id,
            })
          }
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
