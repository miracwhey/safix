import { supabase } from '../../supabase'
import { recordPersistenceFailure, enqueuePendingMutation, hasPendingMutationForEntity, getPendingMutations, isServerSideError, isDuplicateKeyError } from '../../persistence'
import { logError, logInfo } from '../../observability'
import type { InAppNotification, InAppNotificationEntityType, InAppNotificationType } from '../types'
import type { InAppNotificationRepository } from './InAppNotificationRepository'

type Listener = () => void

/**
 * Shape of a `notification_signals` row as stored in the Supabase database.
 * Migration: 20240800000000_secondary_tables_create.sql
 * Columns: id, job_id (NOT NULL FK → jobs), type, priority, read, occurred_at
 */
interface NotificationSignalRow {
  id: string
  job_id: string
  type: string
  priority: string
  read: boolean
  occurred_at: number
  recipient_role: string
}

function rowToNotification(row: NotificationSignalRow): InAppNotification {
  return {
    id: row.id,
    userId: '',
    type: row.type as InAppNotificationType,
    entityType: (row.job_id ? 'job' : '') as InAppNotificationEntityType,
    entityId: row.job_id,
    title: '',
    message: '',
    isRead: row.read,
    createdAt: row.occurred_at,
    recipientRole: row.recipient_role === 'customer' ? 'customer' : 'craftsman',
  }
}

function notificationToRow(notification: InAppNotification): NotificationSignalRow {
  return {
    id: notification.id,
    job_id: notification.entityId,
    type: notification.type,
    priority: 'info',
    read: notification.isRead,
    occurred_at: notification.createdAt,
    recipient_role: notification.recipientRole ?? 'craftsman',
  }
}

/**
 * Supabase-backed implementation of InAppNotificationRepository.
 *
 * Uses a local in-memory cache to serve synchronous reads, keeping the
 * reactive subscription model intact while all writes are also persisted
 * to the `notification_signals` table asynchronously.
 *
 * Write durability: all three write paths (create, markRead, markAllRead)
 * are queue-durable via enqueuePendingMutation. Pre-flight guards prevent
 * UPDATE no-ops when a pending INSERT exists for the same ID — the UPDATE
 * is merged into the INSERT payload instead.
 */
export class SupabaseInAppNotificationRepository
  implements InAppNotificationRepository
{
  private notifications: InAppNotification[] = []
  private readonly listeners = new Set<Listener>()
  private currentUserId: string | null = null
  private _hydrated = false
  private _initPromise: Promise<void> | null = null
  private _initUserId: string | null = null
  private realtimeChannel: ReturnType<typeof supabase.channel> | null = null
  private isRealtimeConnected = false
  private reconnectAttempts = 0
  private readonly MAX_RECONNECT_ATTEMPTS = 5
  private readonly RECONNECT_DELAY = 3000
  private realtimeGeneration = 0

  async initialize(userId: string): Promise<void> {
    if (this._initPromise && this._initUserId === userId) return this._initPromise
    const p: Promise<void> = (async () => {
      this.currentUserId = userId
      const { data, error } = await supabase
        .from('notification_signals')
        .select('*')
        .order('occurred_at', { ascending: false })
        .limit(200)

      if (this.currentUserId !== userId) return
      if (error) throw error
      this.notifications = ((data ?? []) as NotificationSignalRow[]).map(rowToNotification)
      this.hydrateFromQueue(userId)
      this._hydrated = true
      this.notify()
      this.startRealtimeSubscription(userId)
    })()
    this._initUserId = userId
    this._initPromise = p
    void p.then(
      () => { if (this._initPromise === p) { this._initPromise = null; this._initUserId = null } },
      () => { if (this._initPromise === p) { this._initPromise = null; this._initUserId = null } },
    )
    return p
  }

  private startRealtimeSubscription(userId: string, fromReconnection = false): void {
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
    }
    const generation = ++this.realtimeGeneration
    this.realtimeChannel = supabase
      .channel(`fixup-inapp-notifications-${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notification_signals' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as NotificationSignalRow
          if (this.notifications.some((n) => n.id === row.id)) return
          const notification = rowToNotification(row)
          this.notifications = [notification, ...this.notifications].sort(
            (a, b) => b.createdAt - a.createdAt,
          )
          this.notify()
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'notification_signals' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as NotificationSignalRow
          const exists = this.notifications.some((n) => n.id === row.id)
          const updated = rowToNotification(row)
          if (exists) {
            this.notifications = this.notifications.map((n) =>
              n.id === row.id ? updated : n,
            )
          } else {
            this.notifications = [updated, ...this.notifications].sort(
              (a, b) => b.createdAt - a.createdAt,
            )
          }
          this.notify()
        },
      )
      .subscribe((status) => {
        if (generation !== this.realtimeGeneration) return
        if (status === 'SUBSCRIBED') {
          this.isRealtimeConnected = true
          this.reconnectAttempts = 0
          if (fromReconnection) void this.fallbackRefresh()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.isRealtimeConnected = false
          void this.fallbackRefresh()
          this.attemptReconnection(userId)
        }
      })
  }

  private async fallbackRefresh(): Promise<void> {
    const capturedGeneration = this.realtimeGeneration
    try {
      const { data, error } = await supabase
        .from('notification_signals')
        .select('*')
        .order('occurred_at', { ascending: false })
        .limit(200)
      if (!error && data && capturedGeneration === this.realtimeGeneration) {
        this.notifications = (data as NotificationSignalRow[]).map(rowToNotification)
        this.notify()
      }
    } catch {
      // non-critical
    }
  }

  private attemptReconnection(userId: string): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) return
    this.reconnectAttempts++
    setTimeout(() => {
      if (!this.isRealtimeConnected && this.currentUserId === userId) {
        this.startRealtimeSubscription(userId, true)
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

  getAll(): InAppNotification[] {
    return [...this.notifications]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((n) => ({ ...n }))
  }

  getUnread(): InAppNotification[] {
    return this.notifications
      .filter((n) => !n.isRead)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((n) => ({ ...n }))
  }

  getUnreadCount(): number {
    return this.notifications.filter((n) => !n.isRead).length
  }

  hasNotification(id: string): boolean {
    return this.notifications.some((n) => n.id === id)
  }

  isHydrated(): boolean {
    return this._hydrated
  }

  private hydrateFromQueue(uid: string): void {
    const pending = getPendingMutations()
    for (const m of pending) {
      if (m.table !== 'notification_signals' || m.operation !== 'insert') continue
      if (m.userId && m.userId !== uid) continue
      if (this.notifications.some((n) => n.id === m.entityId)) continue
      try {
        const notification = rowToNotification(m.payload as unknown as NotificationSignalRow)
        this.notifications = [notification, ...this.notifications].sort((a, b) => b.createdAt - a.createdAt)
      } catch { /* malformed payload */ }
    }
  }

  create(notification: InAppNotification): void {
    if (this.hasNotification(notification.id)) return

    this.notifications = [...this.notifications, notification].sort(
      (a, b) => b.createdAt - a.createdAt,
    )
    this.notify()

    // Pending guard: if a prior create() for this notification already failed and is
    // queued for replay, skip the write — the queue covers it.
    if (hasPendingMutationForEntity('notification_signals', notification.id)) {
      logInfo('repository.inAppNotifications.create_skipped_pending', { entityId: notification.id })
      return
    }

    supabase
      .from('notification_signals')
      .insert(notificationToRow(notification))
      .then(({ error }) => {
        if (error) {
          if (isServerSideError(error)) {
            this.notifications = this.notifications.filter((n) => n.id !== notification.id)
            this.notify()
            if (isDuplicateKeyError(error)) {
              void supabase.from('notification_signals').select('*').eq('id', notification.id).single().then(({ data }) => {
                if (data) {
                  this.notifications = [rowToNotification(data as NotificationSignalRow), ...this.notifications].sort((a, b) => b.createdAt - a.createdAt)
                  this.notify()
                }
              })
              return
            }
            logError('repository.inAppNotifications.create_failed', error, { entityId: notification.id })
            recordPersistenceFailure({ domain: 'inAppNotifications', operation: 'add', entityId: notification.id, error, occurredAt: Date.now() })
            return
          }
          logError('repository.inAppNotifications.create_failed', error, {
            entityId: notification.id,
          })
          recordPersistenceFailure({
            domain: 'inAppNotifications',
            operation: 'add',
            entityId: notification.id,
            error,
            occurredAt: Date.now(),
          })
          enqueuePendingMutation({
            operation: 'insert',
            table: 'notification_signals',
            payload: notificationToRow(notification) as unknown as Record<string, unknown>,
            domain: 'inAppNotifications',
            entityId: notification.id,
          })
        }
      })
  }

  markRead(notificationId: string): void {
    const updated = this.notifications.map((n) =>
      n.id === notificationId ? { ...n, isRead: true } : n,
    )
    if (updated.some((n, i) => n.isRead !== this.notifications[i].isRead)) {
      this.notifications = updated
      this.notify()

      // Pre-flight guard BEFORE the DB call: if a pending INSERT exists for this
      // notification, the DB row doesn't exist yet — UPDATE would be a silent no-op
      // and the INSERT payload would replay as isRead=false. Merge isRead=true into
      // the INSERT payload now so replay produces the correct final row.
      if (hasPendingMutationForEntity('notification_signals', notificationId)) {
        const notification = this.notifications.find((n) => n.id === notificationId)
        if (notification) {
          enqueuePendingMutation({
            operation: 'insert',
            table: 'notification_signals',
            payload: notificationToRow(notification) as unknown as Record<string, unknown>,
            domain: 'inAppNotifications',
            entityId: notificationId,
          })
        }
        return
      }

      supabase
        .from('notification_signals')
        .update({ read: true })
        .eq('id', notificationId)
        .then(({ error }) => {
          if (error) {
            logError('repository.inAppNotifications.mark_read_failed', error, {
              entityId: notificationId,
            })
            recordPersistenceFailure({
              domain: 'inAppNotifications',
              operation: 'update',
              entityId: notificationId,
              error,
              occurredAt: Date.now(),
            })
            enqueuePendingMutation({
              operation: 'update',
              table: 'notification_signals',
              payload: { id: notificationId, read: true } as Record<string, unknown>,
              domain: 'inAppNotifications',
              entityId: notificationId,
            })
          }
        })
    }
  }

  markAllRead(userId: string): void {
    const unreadNotifications = this.notifications.filter((n) => !n.isRead)
    if (unreadNotifications.length === 0) return

    this.notifications = this.notifications.map((n) => ({ ...n, isRead: true }))
    this.notify()

    // Partition by pending INSERT presence.
    // Notifications with a pending INSERT have no DB row yet — the bulk UPDATE
    // would silently miss them. Merge isRead=true into each INSERT payload so
    // replay produces the correct final row. Normal notifications go through
    // the DB UPDATE path.
    const normalNotifications: InAppNotification[] = []
    for (const notification of unreadNotifications) {
      if (hasPendingMutationForEntity('notification_signals', notification.id)) {
        enqueuePendingMutation({
          operation: 'insert',
          table: 'notification_signals',
          payload: notificationToRow({ ...notification, isRead: true }) as unknown as Record<string, unknown>,
          domain: 'inAppNotifications',
          entityId: notification.id,
        })
      } else {
        normalNotifications.push(notification)
      }
    }

    if (normalNotifications.length === 0) return

    supabase
      .from('notification_signals')
      .update({ read: true })
      .eq('read', false)
      .then(({ error }) => {
        if (error) {
          logError('repository.inAppNotifications.mark_all_read_failed', error, {
            entityId: userId,
          })
          // Per-entity failures (NOT aggregate entityId=userId) so
          // clearPersistenceFailureForEntity can precisely clear each one when
          // flush replays per-entity UPDATE mutations.
          for (const notification of normalNotifications) {
            recordPersistenceFailure({
              domain: 'inAppNotifications',
              operation: 'update',
              entityId: notification.id,
              error,
              occurredAt: Date.now(),
            })
            enqueuePendingMutation({
              operation: 'update',
              table: 'notification_signals',
              payload: { id: notification.id, read: true } as Record<string, unknown>,
              domain: 'inAppNotifications',
              entityId: notification.id,
            })
          }
        }
      })
  }

  reset(): void {
    this._initPromise = null
    this._initUserId = null
    this.realtimeGeneration++
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
      this.realtimeChannel = null
    }
    this.currentUserId = null
    this.isRealtimeConnected = false
    this.reconnectAttempts = 0
    this.notifications = []
    this.notify()
  }

  restartRealtimeIfDead(options?: { force?: boolean }): void {
    if (!this.currentUserId) return
    // force: pessimistic restart after a real background stay — the socket
    // can be dead while isRealtimeConnected still reads true (iOS zombie).
    if (!options?.force && this.isRealtimeConnected) return
    this.isRealtimeConnected = false
    this.reconnectAttempts = 0
    this.startRealtimeSubscription(this.currentUserId, true)
  }
}
