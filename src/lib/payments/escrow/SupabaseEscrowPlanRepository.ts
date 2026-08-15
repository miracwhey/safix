/**
 * Supabase-backed implementation of the EscrowPlanRepository interface.
 *
 * Uses a local in-memory cache to serve synchronous reads, keeping
 * the reactive subscription model intact while all writes are also
 * persisted to the `escrow_payment_plans` and `escrow_tranches` tables.
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
 *   and UPDATE events on `escrow_payment_plans` and `escrow_tranches`.
 *   INSERT rows are deduplicated by ID (prevents double-display after
 *   optimistic writes). UPDATE rows replace the existing cache entry so
 *   state transitions driven by the Stripe webhook (e.g. customer escrow
 *   funding confirmed) appear on the craftsman's device without a reload.
 */

import { supabase } from '../../supabase.js'
import { recordPersistenceFailure } from '../../persistence/index.js'
import { logBreadcrumb, logError, logInfo, logWarning } from '../../observability/index.js'
import type {
  EscrowPaymentPlan,
  EscrowTranche,
  EscrowPlanStatus,
  EscrowTrancheStatus,
  EscrowTrancheKind,
  EscrowReleaseTrigger,
  EscrowFundingMode,
  EscrowReleaseModel,
  EscrowActor,
} from './escrowTypes.js'
import type { EscrowPlanRepository } from './escrowRepository.js'

type Listener = () => void

// ── Row types (DB shape) ──────────────────────────────────────────────────

interface PlanRow {
  id: string
  source_offer_id: string
  job_id: string
  customer_user_id: string
  provider_id: string
  currency: string
  total_amount: number
  funding_mode: string
  release_model: string
  status: string
  created_at: string
  updated_at: string
  funding_initiated_at: string | null
  funded_at: string | null
  external_funding_ref: string | null
  funding_idempotency_key: string | null
  platform_fee_rate: number | null
  platform_fee_amount: number | null
  commercial_origin: string | null
}

interface TrancheRow {
  id: string
  plan_id: string
  kind: string
  percentage: number
  amount: number
  release_trigger: string
  status: string
  created_at: string
  updated_at: string
  eligible_at: string | null
  released_at: string | null
  external_release_ref: string | null
  transfer_reversal_ref: string | null
  triggered_by: string | null
  released_by: string | null
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

function rowToPlan(row: PlanRow): EscrowPaymentPlan {
  return {
    id: row.id,
    sourceOfferId: row.source_offer_id,
    jobId: row.job_id,
    customerUserId: row.customer_user_id,
    providerId: row.provider_id,
    currency: row.currency as EscrowPaymentPlan['currency'],
    totalAmount: Number(row.total_amount),
    fundingMode: row.funding_mode as EscrowFundingMode,
    releaseModel: row.release_model as EscrowReleaseModel,
    status: row.status as EscrowPlanStatus,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    fundingInitiatedAt: tsToMs(row.funding_initiated_at),
    fundedAt: tsToMs(row.funded_at),
    externalFundingRef: row.external_funding_ref ?? undefined,
    fundingIdempotencyKey: row.funding_idempotency_key ?? undefined,
    platformFeeRate: row.platform_fee_rate ?? undefined,
    platformFeeAmount: row.platform_fee_amount ?? undefined,
    commercialOrigin: row.commercial_origin ?? undefined,
  }
}

function planToRow(plan: EscrowPaymentPlan): PlanRow {
  return {
    id: plan.id,
    source_offer_id: plan.sourceOfferId,
    job_id: plan.jobId,
    customer_user_id: plan.customerUserId,
    provider_id: plan.providerId,
    currency: plan.currency,
    total_amount: plan.totalAmount,
    funding_mode: plan.fundingMode,
    release_model: plan.releaseModel,
    status: plan.status,
    created_at: msToTs(plan.createdAt) ?? new Date().toISOString(),
    updated_at: msToTs(plan.updatedAt) ?? new Date().toISOString(),
    funding_initiated_at: msToTs(plan.fundingInitiatedAt),
    funded_at: msToTs(plan.fundedAt),
    external_funding_ref: plan.externalFundingRef ?? null,
    funding_idempotency_key: plan.fundingIdempotencyKey ?? null,
    platform_fee_rate: plan.platformFeeRate ?? null,
    platform_fee_amount: plan.platformFeeAmount ?? null,
    commercial_origin: plan.commercialOrigin ?? null,
  }
}

function rowToTranche(row: TrancheRow): EscrowTranche {
  return {
    id: row.id,
    planId: row.plan_id,
    kind: row.kind as EscrowTrancheKind,
    percentage: Number(row.percentage),
    amount: Number(row.amount),
    releaseTrigger: row.release_trigger as EscrowReleaseTrigger,
    status: row.status as EscrowTrancheStatus,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    eligibleAt: tsToMs(row.eligible_at),
    releasedAt: tsToMs(row.released_at),
    externalReleaseRef: row.external_release_ref ?? undefined,
    transferReversalRef: row.transfer_reversal_ref ?? undefined,
    triggeredBy: (row.triggered_by as EscrowActor) ?? undefined,
    releasedBy: (row.released_by as EscrowActor) ?? undefined,
  }
}

function trancheToRow(tranche: EscrowTranche): TrancheRow {
  return {
    id: tranche.id,
    plan_id: tranche.planId,
    kind: tranche.kind,
    percentage: tranche.percentage,
    amount: tranche.amount,
    release_trigger: tranche.releaseTrigger,
    status: tranche.status,
    created_at: msToTs(tranche.createdAt) ?? new Date().toISOString(),
    updated_at: msToTs(tranche.updatedAt) ?? new Date().toISOString(),
    eligible_at: msToTs(tranche.eligibleAt),
    released_at: msToTs(tranche.releasedAt),
    external_release_ref: tranche.externalReleaseRef ?? null,
    transfer_reversal_ref: tranche.transferReversalRef ?? null,
    triggered_by: tranche.triggeredBy ?? null,
    released_by: tranche.releasedBy ?? null,
  }
}

// ── Repository implementation ─────────────────────────────────────────────

export class SupabaseEscrowPlanRepository implements EscrowPlanRepository {
  private plans: EscrowPaymentPlan[] = []
  private tranches: EscrowTranche[] = []
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
    // Snapshot the generation before any await. If resetState() or a new
    // loadForUser() runs while the query is in-flight, channelGeneration will
    // have incremented and the checks below will abort before mutating state.
    const generation = this.channelGeneration

    const { data: planData, error: planError } = await supabase
      .from('escrow_payment_plans')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
    if (planError) throw planError
    if (generation !== this.channelGeneration) return
    if (loadGeneration !== undefined && loadGeneration !== this._loadGeneration) return

    this.plans = ((planData ?? []) as PlanRow[]).map(rowToPlan)

    const planIds = this.plans.map((p) => p.id)
    if (planIds.length > 0) {
      const { data: trancheData, error: trancheError } = await supabase
        .from('escrow_tranches')
        .select('*')
        .in('plan_id', planIds)
      if (trancheError) throw trancheError
      if (generation !== this.channelGeneration) return
      if (loadGeneration !== undefined && loadGeneration !== this._loadGeneration) return
      this.tranches = ((trancheData ?? []) as TrancheRow[]).map(rowToTranche)
    } else {
      this.tranches = []
    }

    this.notify()
  }

  private async loadForUser(uid: string, generationSnapshot: number): Promise<void> {
    this.currentUid = uid
    // Capture before the async fetch so we can detect context changes that
    // happen while the DB query is in-flight (logout, account switch, re-init).
    const generation = this.channelGeneration
    await this.fetchAndLoadFromDatabase(generationSnapshot)
    // Only open a Realtime subscription if the context is still ours.
    // fetchAndLoadFromDatabase already guards its own mutations; this guard
    // prevents subscribing for a stale uid after a successful (but now
    // irrelevant) fetch.
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
    this.plans = []
    this.tranches = []
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
   * Subscribes to INSERT and UPDATE events on `escrow_payment_plans` and
   * `escrow_tranches` via Supabase Realtime.
   *
   * INSERT deduplication: if the row ID already exists in the local cache
   * (written optimistically by this client) we silently drop it.
   *
   * UPDATE merge: replaces the existing cache entry so that state transitions
   * driven by the Stripe webhook (confirm_funding_atomic RPC) — e.g. plan
   * status → funded_in_escrow, tranche status → held — appear on the
   * craftsman's device without a manual reload.
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
      .channel(`fixup-escrow-plans-${uid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'escrow_payment_plans' },
        (payload) => {
          if (myGeneration !== this.channelGeneration) return
          const row = payload.new as PlanRow
          if (this.plans.some((p) => p.id === row.id)) return
          this.plans = [rowToPlan(row), ...this.plans]
          this.notify()
          logInfo('escrow_plan.realtime_inserted', { planId: row.id, jobId: row.job_id })
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'escrow_payment_plans' },
        (payload) => {
          if (myGeneration !== this.channelGeneration) return
          const row = payload.new as PlanRow
          const exists = this.plans.some((p) => p.id === row.id)
          if (exists) {
            this.plans = this.plans.map((p) => (p.id === row.id ? rowToPlan(row) : p))
          } else {
            this.plans = [rowToPlan(row), ...this.plans]
          }
          this.notify()
          logInfo('escrow_plan.realtime_updated', { planId: row.id, jobId: row.job_id, status: row.status })
        },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'escrow_tranches' },
        (payload) => {
          if (myGeneration !== this.channelGeneration) return
          const row = payload.new as TrancheRow
          if (this.tranches.some((t) => t.id === row.id)) return
          this.tranches = [rowToTranche(row), ...this.tranches]
          this.notify()
          logInfo('escrow_tranche.realtime_inserted', { trancheId: row.id, planId: row.plan_id })
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'escrow_tranches' },
        (payload) => {
          if (myGeneration !== this.channelGeneration) return
          const row = payload.new as TrancheRow
          const exists = this.tranches.some((t) => t.id === row.id)
          if (exists) {
            this.tranches = this.tranches.map((t) => (t.id === row.id ? rowToTranche(row) : t))
          } else {
            this.tranches = [rowToTranche(row), ...this.tranches]
          }
          this.notify()
          logInfo('escrow_tranche.realtime_updated', { trancheId: row.id, planId: row.plan_id, status: row.status })
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
          logInfo('escrow_plan.realtime_connected', { userId: uid })
          if (fromReconnection) void this.fallbackRefresh(uid)
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.isRealtimeConnected = false
          logBreadcrumb(
            'repository.escrow_plans.realtime_disconnected',
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
      logInfo('escrow_plan.fallback_refresh_completed', { userId: uid })
    } catch (error) {
      logError('repository.escrow_plans.fallback_refresh_error', error as Error, { userId: uid })
    }
  }

  private attemptReconnection(uid: string): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logWarning(
        'repository.escrow_plans.realtime_reconnect_exhausted',
        { userId: uid, attempts: this.reconnectAttempts },
      )
      return
    }

    this.reconnectAttempts++
    logInfo('escrow_plan.realtime_reconnect_attempt', {
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

  // ── Plan reads ──────────────────────────────────────────────────────────

  getAllPlans(): EscrowPaymentPlan[] {
    return [...this.plans]
  }

  getPlanById(planId: string): EscrowPaymentPlan | undefined {
    return this.plans.find((p) => p.id === planId)
  }

  getPlanByOfferId(offerId: string): EscrowPaymentPlan | undefined {
    return this.plans.find((p) => p.sourceOfferId === offerId)
  }

  getPlanByJobId(jobId: string): EscrowPaymentPlan | undefined {
    return this.plans.find((p) => p.jobId === jobId)
  }

  // ── Plan writes ─────────────────────────────────────────────────────────

  async addPlan(plan: EscrowPaymentPlan): Promise<void> {
    this.plans = [plan, ...this.plans]
    this.notify()
    const { error } = await supabase
      .from('escrow_payment_plans')
      .insert(planToRow(plan))
    if (error) {
      // Duplicate-key: plan already exists in the DB (e.g. seeded from a
      // server-authoritative payload before local repo hydrated). Treat as
      // idempotent success — the in-memory cache already has the correct value.
      if ((error as { code?: string }).code === '23505') return

      this.plans = this.plans.filter((p) => p.id !== plan.id)
      this.notify()
      logError('repository.escrow_plans.add_failed', error, { entityId: plan.id, jobId: plan.jobId })
      recordPersistenceFailure({ domain: 'escrow_plans', operation: 'add', entityId: plan.id, error, occurredAt: Date.now() })
      throw error
    }
  }

  async updatePlan(planId: string, updater: (plan: EscrowPaymentPlan) => EscrowPaymentPlan): Promise<void> {
    const previous = this.plans.find((p) => p.id === planId)
    let updated: EscrowPaymentPlan | undefined
    this.plans = this.plans.map((p) => {
      if (p.id === planId) {
        updated = updater(p)
        return updated
      }
      return p
    })
    this.notify()
    if (updated) {
      const { error } = await supabase
        .from('escrow_payment_plans')
        .update(planToRow(updated))
        .eq('id', planId)
      if (error) {
        if (previous) {
          this.plans = this.plans.map((p) => (p.id === planId ? previous : p))
          this.notify()
        }
        logError('repository.escrow_plans.update_failed', error, { entityId: planId })
        recordPersistenceFailure({ domain: 'escrow_plans', operation: 'update', entityId: planId, error, occurredAt: Date.now() })
        throw error
      }
    }
  }

  // ── Tranche reads ───────────────────────────────────────────────────────

  getTranchesForPlan(planId: string): EscrowTranche[] {
    return this.tranches.filter((t) => t.planId === planId)
  }

  // ── Tranche writes ──────────────────────────────────────────────────────

  async addTranche(tranche: EscrowTranche): Promise<void> {
    this.tranches = [tranche, ...this.tranches]
    this.notify()
    const { error } = await supabase
      .from('escrow_tranches')
      .insert(trancheToRow(tranche))
    if (error) {
      // Duplicate-key: tranche already exists in the DB. Treat as idempotent
      // success — the in-memory cache already has the correct value.
      if ((error as { code?: string }).code === '23505') return

      this.tranches = this.tranches.filter((t) => t.id !== tranche.id)
      this.notify()
      logError('repository.escrow_tranches.add_failed', error, { entityId: tranche.id, planId: tranche.planId })
      recordPersistenceFailure({ domain: 'escrow_tranches', operation: 'add', entityId: tranche.id, error, occurredAt: Date.now() })
      throw error
    }
  }

  async updateTranche(trancheId: string, updater: (tranche: EscrowTranche) => EscrowTranche): Promise<void> {
    const previous = this.tranches.find((t) => t.id === trancheId)
    let updated: EscrowTranche | undefined
    this.tranches = this.tranches.map((t) => {
      if (t.id === trancheId) {
        updated = updater(t)
        return updated
      }
      return t
    })
    this.notify()
    if (updated) {
      const { error } = await supabase
        .from('escrow_tranches')
        .update(trancheToRow(updated))
        .eq('id', trancheId)
      if (error) {
        if (previous) {
          this.tranches = this.tranches.map((t) => (t.id === trancheId ? previous : t))
          this.notify()
        }
        logError('repository.escrow_tranches.update_failed', error, { entityId: trancheId })
        recordPersistenceFailure({ domain: 'escrow_tranches', operation: 'update', entityId: trancheId, error, occurredAt: Date.now() })
        throw error
      }
    }
  }
}
