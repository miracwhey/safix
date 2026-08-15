/**
 * Supabase-backed implementation of the FundingRequestRepository interface.
 *
 * Uses a local in-memory cache to serve synchronous reads, keeping
 * the reactive subscription model intact while all writes are also
 * persisted to the `funding_requests` table.
 *
 * Write path (optimistic with rollback):
 * - All write methods update the local cache and notify subscribers
 *   immediately so the UI stays responsive.
 * - The corresponding Supabase mutation is awaited.
 *   On failure the local cache is rolled back to its previous state,
 *   subscribers are re-notified, and the error is thrown so callers
 *   can distinguish real success from failed persistence.
 *
 * Realtime path:
 * - After initial load, a Supabase Realtime channel subscribes to INSERT
 *   and UPDATE events on `funding_requests`. INSERT rows are deduplicated
 *   by ID (prevents double-display after optimistic writes). UPDATE rows
 *   replace the existing cache entry so status transitions driven by the
 *   Stripe webhook (confirm_funding_atomic RPC) — e.g. status → funded —
 *   appear on the craftsman's device without a manual reload.
 */

import { supabase } from '../../supabase.js'
import { recordPersistenceFailure } from '../../persistence/index.js'
import { logBreadcrumb, logError, logInfo, logWarning } from '../../observability/index.js'
import type { FundingRequest, FundingRequestStatus, FundingRequestType } from './types.js'
import type { FundingRequestRepository } from './fundingRequestRepository.js'

type Listener = () => void

// ── Row type (DB shape) ───────────────────────────────────────────────────

interface FundingRequestRow {
  id: string
  source_offer_id: string
  job_id: string
  escrow_plan_id: string
  customer_user_id: string
  provider_id: string
  provider_user_id: string
  type: string
  status: string
  amount: number
  currency: string
  created_by: string
  conversation_id: string | null
  message_id: string | null
  created_at: string
  updated_at: string
  sent_at: string | null
  expires_at: number | null
  funded_at: string | null
  external_funding_ref: string | null
  funding_idempotency_key: string | null
  failure_reason: string | null
}

// ── Row ↔ Domain mapping ─────────────────────────────────────────────────

function tsToMs(ts: string | null | undefined): number | undefined {
  if (ts == null) return undefined
  return new Date(ts).getTime()
}

function msToTs(ms: number | undefined): string | null {
  if (ms == null) return null
  return new Date(ms).toISOString()
}

function rowToFundingRequest(row: FundingRequestRow): FundingRequest {
  return {
    id: row.id,
    sourceOfferId: row.source_offer_id,
    jobId: row.job_id,
    escrowPlanId: row.escrow_plan_id,
    customerUserId: row.customer_user_id,
    providerId: row.provider_id,
    providerUserId: row.provider_user_id,
    type: row.type as FundingRequestType,
    status: row.status as FundingRequestStatus,
    amount: Number(row.amount),
    currency: row.currency,
    createdBy: row.created_by as 'provider' | 'system',
    conversationId: row.conversation_id ?? undefined,
    messageId: row.message_id ?? undefined,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    sentAt: tsToMs(row.sent_at),
    ...(row.expires_at != null && { expiresAt: row.expires_at }),
    fundedAt: tsToMs(row.funded_at),
    externalFundingRef: row.external_funding_ref ?? undefined,
    fundingIdempotencyKey: row.funding_idempotency_key ?? undefined,
    failureReason: row.failure_reason ?? undefined,
  }
}

function fundingRequestToRow(request: FundingRequest): FundingRequestRow {
  return {
    id: request.id,
    source_offer_id: request.sourceOfferId,
    job_id: request.jobId,
    escrow_plan_id: request.escrowPlanId,
    customer_user_id: request.customerUserId,
    provider_id: request.providerId,
    provider_user_id: request.providerUserId,
    type: request.type,
    status: request.status,
    amount: request.amount,
    currency: request.currency,
    created_by: request.createdBy,
    conversation_id: request.conversationId ?? null,
    message_id: request.messageId ?? null,
    created_at: msToTs(request.createdAt) ?? new Date().toISOString(),
    updated_at: msToTs(request.updatedAt) ?? new Date().toISOString(),
    sent_at: msToTs(request.sentAt),
    expires_at: request.expiresAt ?? null,
    funded_at: msToTs(request.fundedAt),
    external_funding_ref: request.externalFundingRef ?? null,
    funding_idempotency_key: request.fundingIdempotencyKey ?? null,
    failure_reason: request.failureReason ?? null,
  }
}

// ── Repository implementation ─────────────────────────────────────────────

export class SupabaseFundingRequestRepository implements FundingRequestRepository {
  private requests: FundingRequest[] = []
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
  /**
   * Monotonically increasing counter. Incremented before any intentional
   * channel teardown (replace or resetState). Each subscribe callback closes
   * over the generation value at creation time and exits early if it no longer
   * matches — preventing stale CLOSED callbacks from triggering reconnect/
   * fallback on an already-replaced or signed-out channel.
   */
  private channelGeneration = 0

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

  reset(): void {
    this._initPromise = null
    this._loadGeneration++
  }

  prepareForResync(): void {
    this._initPromise = null
    this._loadGeneration++
  }

  private async fetchAndLoadFromDatabase(loadGeneration?: number): Promise<void> {
    const generation = this.channelGeneration
    const { data, error } = await supabase
      .from('funding_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) throw error
    if (generation !== this.channelGeneration) return
    if (loadGeneration !== undefined && loadGeneration !== this._loadGeneration) return
    this.requests = ((data ?? []) as FundingRequestRow[]).map(rowToFundingRequest)
    this.notify()
  }

  private async loadForUser(uid: string, generationSnapshot: number): Promise<void> {
    this.currentUid = uid
    const generation = this.channelGeneration
    await this.fetchAndLoadFromDatabase(generationSnapshot)
    if (generation !== this.channelGeneration || this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    this.startRealtimeSubscription(uid)
  }

  private resetState(): void {
    this._initPromise = null
    // Invalidate any pending status callbacks before removing the channel so
    // the CLOSED event that Supabase fires asynchronously is treated as stale.
    this.channelGeneration++
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
      this.realtimeChannel = null
    }
    this.currentUid = null
    this.requests = []
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
   * Subscribes to INSERT and UPDATE events on `funding_requests` via
   * Supabase Realtime.
   *
   * INSERT deduplication: if the row ID already exists in the local cache
   * (written optimistically by this client) we silently drop it.
   *
   * UPDATE merge: replaces the existing cache entry so that status
   * transitions driven by the Stripe webhook (confirm_funding_atomic RPC)
   * — e.g. status → funded — appear without a manual reload.
   */
  private startRealtimeSubscription(uid: string, fromReconnection = false): void {
    // Increment generation BEFORE removing the old channel. The old channel's
    // CLOSED callback fires asynchronously after removeChannel; by the time it
    // runs, myGeneration will no longer equal this.channelGeneration, so the
    // callback exits early instead of triggering a spurious fallback + reconnect.
    const myGeneration = ++this.channelGeneration
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
    }
    this.realtimeChannel = supabase
      .channel(`fixup-funding-requests-${uid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'funding_requests' },
        (payload) => {
          if (myGeneration !== this.channelGeneration) return
          const row = payload.new as FundingRequestRow
          if (this.requests.some((r) => r.id === row.id)) return
          this.requests = [rowToFundingRequest(row), ...this.requests]
          this.notify()
          logInfo('funding_request.realtime_inserted', { requestId: row.id, jobId: row.job_id })
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'funding_requests' },
        (payload) => {
          if (myGeneration !== this.channelGeneration) return
          const row = payload.new as FundingRequestRow
          const exists = this.requests.some((r) => r.id === row.id)
          if (exists) {
            this.requests = this.requests.map((r) => (r.id === row.id ? rowToFundingRequest(row) : r))
          } else {
            this.requests = [rowToFundingRequest(row), ...this.requests]
          }
          this.notify()
          logInfo('funding_request.realtime_updated', { requestId: row.id, jobId: row.job_id, status: row.status })
        },
      )
      .subscribe((status) => {
        // Stale callback: this channel was intentionally replaced or signed out.
        // The old channel fires CLOSED asynchronously; ignore it so the healthy
        // new channel is not disturbed.
        if (myGeneration !== this.channelGeneration) return
        if (status === 'SUBSCRIBED') {
          this.isRealtimeConnected = true
          this.reconnectAttempts = 0
          logInfo('funding_request.realtime_connected', { userId: uid })
          if (fromReconnection) void this.fallbackRefresh(uid)
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.isRealtimeConnected = false
          logBreadcrumb(
            'repository.funding_requests.realtime_disconnected',
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
      await this.fetchAndLoadFromDatabase()
      logInfo('funding_request.fallback_refresh_completed', { userId: uid })
    } catch (error) {
      logError('repository.funding_requests.fallback_refresh_error', error as Error, { userId: uid })
    }
  }

  private attemptReconnection(uid: string): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logWarning(
        'repository.funding_requests.realtime_reconnect_exhausted',
        { userId: uid, attempts: this.reconnectAttempts },
      )
      return
    }

    this.reconnectAttempts++
    logInfo('funding_request.realtime_reconnect_attempt', {
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

  /**
   * Resume-cascade hook (session.ts handleAppResume). No-op while the channel
   * reads healthy — unless `force` is set: after an iOS suspend the socket is
   * dead while isRealtimeConnected still reads true (zombie), so a forced
   * restart skips the lagging check, tears the channel down and re-subscribes.
   * fromReconnection=true triggers a single fallbackRefresh on SUBSCRIBED.
   */
  restartRealtimeIfDead(options?: { force?: boolean }): void {
    if (!this.currentUid) return
    if (!options?.force && this.isRealtimeConnected) return
    this.isRealtimeConnected = false
    this.reconnectAttempts = 0
    this.startRealtimeSubscription(this.currentUid, true)
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

  // ── Reads ───────────────────────────────────────────────────────────────

  getAll(): FundingRequest[] {
    return [...this.requests]
  }

  getById(id: string): FundingRequest | undefined {
    return this.requests.find((r) => r.id === id)
  }

  getByEscrowPlanId(escrowPlanId: string): FundingRequest | undefined {
    return this.requests.find((r) => r.escrowPlanId === escrowPlanId)
  }

  getByJobId(jobId: string): FundingRequest | undefined {
    return this.requests.find((r) => r.jobId === jobId)
  }

  getByOfferId(offerId: string): FundingRequest | undefined {
    return this.requests.find((r) => r.sourceOfferId === offerId)
  }

  // ── Writes ──────────────────────────────────────────────────────────────

  async add(request: FundingRequest): Promise<void> {
    this.requests = [request, ...this.requests]
    this.notify()
    const { error } = await supabase
      .from('funding_requests')
      .insert(fundingRequestToRow(request))
    if (error) {
      // Duplicate-key: row already exists in the DB (e.g. seeded from a
      // server-authoritative payload before local repo hydrated). Treat as
      // idempotent success — the in-memory cache already has the correct value.
      if ((error as { code?: string }).code === '23505') return

      this.requests = this.requests.filter((r) => r.id !== request.id)
      this.notify()
      logError('repository.funding_requests.add_failed', error, { entityId: request.id, jobId: request.jobId })
      recordPersistenceFailure({ domain: 'funding_requests', operation: 'add', entityId: request.id, error, occurredAt: Date.now() })
      throw error
    }
  }

  async update(id: string, updater: (r: FundingRequest) => FundingRequest): Promise<void> {
    const previous = this.requests.find((r) => r.id === id)
    let updated: FundingRequest | undefined
    this.requests = this.requests.map((r) => {
      if (r.id === id) {
        updated = updater(r)
        return updated
      }
      return r
    })
    this.notify()
    if (updated) {
      const { error } = await supabase
        .from('funding_requests')
        .update(fundingRequestToRow(updated))
        .eq('id', id)
      if (error) {
        if (previous) {
          this.requests = this.requests.map((r) => (r.id === id ? previous : r))
          this.notify()
        }
        logError('repository.funding_requests.update_failed', error, { entityId: id })
        recordPersistenceFailure({ domain: 'funding_requests', operation: 'update', entityId: id, error, occurredAt: Date.now() })
        throw error
      }
    }
  }
}
