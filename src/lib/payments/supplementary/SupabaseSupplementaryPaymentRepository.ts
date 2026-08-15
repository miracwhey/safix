/**
 * Supabase-backed implementation of SupplementaryPaymentRepository.
 *
 * Uses a local in-memory cache to serve synchronous reads (reactive model).
 * All writes are persisted to `supplementary_payment_requests` and update
 * the cache immediately (optimistic) with rollback on failure.
 *
 * Realtime path:
 * - After initial load, a Supabase Realtime channel subscribes to INSERT
 *   and UPDATE events on `supplementary_payment_requests`.  INSERT rows are
 *   deduplicated by ID (prevents double-display after optimistic writes).
 *   UPDATE rows replace the existing cache entry so state transitions driven
 *   by Stripe webhooks (e.g. webhook sets status → 'funded') appear without
 *   a manual reload.  This is essential for the server-confirming recovery
 *   flow in SupplementaryFundingScreen.
 *
 * Schema: supabase/migrations/20260412000010_supplementary_payment_requests.sql
 *         supabase/migrations/20260413000001_supplementary_payment_v2_funding.sql
 *         supabase/migrations/20260413000002_supplementary_payment_v3_payout.sql
 *         supabase/migrations/20260418000002_supplementary_payment_realtime.sql
 */

import { supabase } from '../../supabase.js'
import { recordPersistenceFailure } from '../../persistence/index.js'
import { logBreadcrumb, logError, logInfo, logWarning } from '../../observability/index.js'
import type { SupplementaryPaymentRequest, SupplementaryPaymentStatus } from './types.js'
import type { SupplementaryPaymentRepository } from './SupplementaryPaymentRepository.js'

type Listener = () => void

// ── DB row type ────────────────────────────────────────────────────────────────

interface SupplementaryPaymentRow {
  id: string
  change_order_id: string
  job_id: string
  original_payment_id: string
  customer_user_id: string
  craftsman_user_id: string
  amount_cents: number
  currency: string
  status: string
  acknowledged_at: number | null
  funding_initiated_at: number | null
  funded_at: number | null
  released_at: number | null
  paid_at: number | null
  waived_at: number | null
  external_ref: string | null
  external_payout_ref: string | null
  created_at: number
  updated_at: number
}

// ── Row ↔ Domain mapping ────────────────────────────────────────────────────

function rowToEntity(row: SupplementaryPaymentRow): SupplementaryPaymentRequest {
  return {
    id: row.id,
    changeOrderId: row.change_order_id,
    jobId: row.job_id,
    originalPaymentId: row.original_payment_id,
    customerUserId: row.customer_user_id,
    craftsmanUserId: row.craftsman_user_id,
    amountCents: row.amount_cents,
    currency: row.currency,
    status: row.status as SupplementaryPaymentStatus,
    ...(row.acknowledged_at != null && { acknowledgedAt: row.acknowledged_at }),
    ...(row.funding_initiated_at != null && { fundingInitiatedAt: row.funding_initiated_at }),
    ...(row.funded_at != null && { fundedAt: row.funded_at }),
    ...(row.released_at != null && { releasedAt: row.released_at }),
    ...(row.paid_at != null && { paidAt: row.paid_at }),
    ...(row.waived_at != null && { waivedAt: row.waived_at }),
    ...(row.external_ref != null && { externalRef: row.external_ref }),
    ...(row.external_payout_ref != null && { externalPayoutRef: row.external_payout_ref }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function entityToRow(e: SupplementaryPaymentRequest): SupplementaryPaymentRow {
  return {
    id: e.id,
    change_order_id: e.changeOrderId,
    job_id: e.jobId,
    original_payment_id: e.originalPaymentId,
    customer_user_id: e.customerUserId,
    craftsman_user_id: e.craftsmanUserId,
    amount_cents: e.amountCents,
    currency: e.currency,
    status: e.status,
    acknowledged_at: e.acknowledgedAt ?? null,
    funding_initiated_at: e.fundingInitiatedAt ?? null,
    funded_at: e.fundedAt ?? null,
    released_at: e.releasedAt ?? null,
    paid_at: e.paidAt ?? null,
    waived_at: e.waivedAt ?? null,
    external_ref: e.externalRef ?? null,
    external_payout_ref: e.externalPayoutRef ?? null,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
  }
}

export class SupabaseSupplementaryPaymentRepository implements SupplementaryPaymentRepository {
  private cache: SupplementaryPaymentRequest[] = []
  private hydrated = false
  private authUnsubscribe: (() => void) | null = null
  private readonly listeners = new Set<Listener>()
  private currentUid: string | null = null
  private _initPromise: Promise<void> | null = null
  private _loadGeneration = 0

  /** Active Supabase Realtime channel, or null when not subscribed. */
  private realtimeChannel: ReturnType<typeof supabase.channel> | null = null
  private isRealtimeConnected = false
  private reconnectAttempts = 0
  private readonly MAX_RECONNECT_ATTEMPTS = 5
  private readonly RECONNECT_DELAY = 3000
  /** Generation counter — incremented on every new channel to invalidate stale subscribe callbacks. */
  private realtimeGeneration = 0

  private notify(): void {
    this.listeners.forEach((fn) => fn())
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
        this.resetState()
        this.hydrated = true
        this.notify()
        return
      }
      await this.loadForUser(session.user.id, generation)
      this.hydrated = true
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
    return this.hydrated
  }

  private async loadForUser(uid: string, generationSnapshot: number): Promise<void> {
    this.currentUid = uid
    const { data, error } = await supabase
      .from('supplementary_payment_requests')
      .select('*')
      .order('created_at', { ascending: false })
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    if (error) {
      logError('SupabaseSupplementaryPaymentRepository.initialize', error)
      throw error
    }
    this.cache = (data as SupplementaryPaymentRow[]).map(rowToEntity)
    this.notify()
    this.startRealtimeSubscription(uid)
  }

  private resetState(): void {
    this._initPromise = null
    this.currentUid = null
    this.cache = []
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
      this.realtimeChannel = null
    }
    this.isRealtimeConnected = false
    this.reconnectAttempts = 0
    this.realtimeGeneration++
    this.notify()
  }

  private ensureAuthListener(): void {
    if (this.authUnsubscribe) return
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      const uid = session?.user?.id
      if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && uid && (uid !== this.currentUid || !this.hydrated)) {
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

  reset(): void {
    this.resetState()
  }

  prepareForResync(): void {
    this._initPromise = null
    this._loadGeneration++
  }

  // ── Realtime ────────────────────────────────────────────────────────────────

  restartRealtimeIfDead(options?: { force?: boolean }): void {
    if (!this.currentUid) return
    // force: pessimistic restart after a real background stay — the socket
    // can be dead while isRealtimeConnected still reads true (iOS zombie).
    if (!options?.force && this.isRealtimeConnected) return
    this.isRealtimeConnected = false
    this.reconnectAttempts = 0
    this.startRealtimeSubscription(this.currentUid, true)
  }

  /**
   * Subscribes to INSERT and UPDATE events on `supplementary_payment_requests`
   * via Supabase Realtime.
   *
   * INSERT deduplication: if the arriving ID already exists in the local cache
   * (inserted optimistically by this client) the event is silently dropped.
   *
   * UPDATE merge: replaces the existing cache entry by ID so that state
   * transitions driven by Stripe webhooks (status → 'funded', 'released') are
   * reflected in open sessions without a reload.  This is the mechanism that
   * lets SupplementaryFundingScreen exit the 'server-confirming' phase
   * automatically when the webhook reconciles the payment.
   */
  private startRealtimeSubscription(uid: string, fromReconnection = false): void {
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
    }
    const generation = ++this.realtimeGeneration
    this.realtimeChannel = supabase
      .channel(`fixup-supplementary-${uid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'supplementary_payment_requests' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as SupplementaryPaymentRow
          if (this.cache.some((r) => r.id === row.id)) return
          this.cache = [rowToEntity(row), ...this.cache]
          this.notify()
          logInfo('supplementary.realtime_inserted', { id: row.id, changeOrderId: row.change_order_id })
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'supplementary_payment_requests' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as SupplementaryPaymentRow
          const exists = this.cache.some((r) => r.id === row.id)
          if (exists) {
            this.cache = this.cache.map((r) => (r.id === row.id ? rowToEntity(row) : r))
          } else {
            this.cache = [rowToEntity(row), ...this.cache]
          }
          this.notify()
          logInfo('supplementary.realtime_updated', { id: row.id, status: row.status })
        },
      )
      .subscribe((status) => {
        if (generation !== this.realtimeGeneration) return
        if (status === 'SUBSCRIBED') {
          this.isRealtimeConnected = true
          this.reconnectAttempts = 0
          logInfo('supplementary.realtime_connected', { userId: uid })
          if (fromReconnection) void this.fallbackRefresh()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.isRealtimeConnected = false
          logBreadcrumb(
            'repository.supplementary.realtime_disconnected',
            'warning',
            { userId: uid, status },
          )
          void this.fallbackRefresh()
          this.attemptReconnection(uid)
        }
      })
  }

  /**
   * Fallback: re-fetches all supplementary payment requests from the database
   * when realtime fails.  Replaces the local cache with fresh server state.
   */
  private async fallbackRefresh(): Promise<void> {
    try {
      const { data, error } = await supabase
        .from('supplementary_payment_requests')
        .select('*')
        .order('created_at', { ascending: false })
      if (!error && data) {
        this.cache = (data as SupplementaryPaymentRow[]).map(rowToEntity)
        this.notify()
        logInfo('supplementary.fallback_refresh_completed', {})
      }
    } catch (err) {
      logError('repository.supplementary.fallback_refresh_error', err as Error, {})
    }
  }

  /**
   * Exponential-backoff reconnection — gives up after MAX_RECONNECT_ATTEMPTS.
   */
  private attemptReconnection(uid: string): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logWarning(
        'repository.supplementary.realtime_reconnect_exhausted',
        { userId: uid, attempts: this.reconnectAttempts },
      )
      return
    }

    this.reconnectAttempts++
    logInfo('supplementary.realtime_reconnect_attempt', {
      userId: uid,
      attempt: this.reconnectAttempts,
      maxAttempts: this.MAX_RECONNECT_ATTEMPTS,
    })

    setTimeout(() => {
      if (!this.isRealtimeConnected) {
        this.startRealtimeSubscription(uid, true)
      }
    }, this.RECONNECT_DELAY * this.reconnectAttempts)
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  getAll(): SupplementaryPaymentRequest[] {
    return [...this.cache]
  }

  getById(id: string): SupplementaryPaymentRequest | undefined {
    return this.cache.find((r) => r.id === id)
  }

  getByChangeOrderId(changeOrderId: string): SupplementaryPaymentRequest | undefined {
    return this.cache.find((r) => r.changeOrderId === changeOrderId)
  }

  getByJobId(jobId: string): SupplementaryPaymentRequest[] {
    return this.cache.filter((r) => r.jobId === jobId)
  }

  // ── Mutations ────────────────────────────────────────────────────────────────

  async add(request: SupplementaryPaymentRequest): Promise<void> {
    const prev = [...this.cache]
    this.cache = [request, ...this.cache]
    this.notify()

    const { error } = await supabase
      .from('supplementary_payment_requests')
      .insert(entityToRow(request))

    if (error) {
      this.cache = prev
      this.notify()
      recordPersistenceFailure({
        domain: 'supplementary_payment_requests',
        operation: 'add',
        entityId: request.id,
        error: String(error.message),
        occurredAt: Date.now(),
      })
      logError('SupabaseSupplementaryPaymentRepository.add', error, { id: request.id })
      throw error
    }
  }

  async update(id: string, updater: (r: SupplementaryPaymentRequest) => SupplementaryPaymentRequest): Promise<void> {
    const prev = [...this.cache]
    const existing = this.cache.find((r) => r.id === id)
    if (!existing) return

    const updated = updater(existing)
    this.cache = this.cache.map((r) => (r.id === id ? updated : r))
    this.notify()

    const { error } = await supabase
      .from('supplementary_payment_requests')
      .update(entityToRow(updated))
      .eq('id', id)

    if (error) {
      this.cache = prev
      this.notify()
      recordPersistenceFailure({
        domain: 'supplementary_payment_requests',
        operation: 'update',
        entityId: id,
        error: String(error.message),
        occurredAt: Date.now(),
      })
      logError('SupabaseSupplementaryPaymentRepository.update', error, { id })
      throw error
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
