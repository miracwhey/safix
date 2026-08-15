import { supabase } from '../../supabase.js'
import { recordPersistenceFailure } from '../../persistence/index.js'
import { logBreadcrumb, logError, logInfo, logWarning } from '../../observability/index.js'
import type { Payment, PaymentAmounts, PaymentState } from '../types.js'
import type { PaymentRepository } from './PaymentRepository.js'
import { canTransition } from '../stateMachine.js'

type Listener = () => void

interface PaymentRow {
  id: string
  job_id: string
  project_id: string | null
  customer_user_id: string | null
  craftsman_user_id: string | null
  offer_id: string | null
  status: string
  total_amount: number
  deposit_amount: number
  final_amount: number
  provider_ref: string | null
  client_secret: string | null
  refunded_amount: number | null
  created_at: string
  updated_at: string
}

function rowToPayment(row: PaymentRow): Payment {
  const amounts: PaymentAmounts = {
    totalAmount: row.total_amount,
    depositAmount: row.deposit_amount,
    finalAmount: row.final_amount,
  }
  return {
    id: row.id,
    jobId: row.job_id,
    projectId: row.project_id ?? undefined,
    customerUserId: row.customer_user_id ?? undefined,
    craftsmanUserId: row.craftsman_user_id ?? undefined,
    offerId: row.offer_id ?? undefined,
    state: row.status as PaymentState,
    amounts,
    providerRef: row.provider_ref ?? undefined,
    clientSecret: row.client_secret ?? undefined,
    refundedAmount: row.refunded_amount ?? undefined,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
  }
}

function paymentToRow(payment: Payment): PaymentRow {
  return {
    id: payment.id,
    job_id: payment.jobId,
    project_id: payment.projectId ?? null,
    customer_user_id: payment.customerUserId ?? null,
    craftsman_user_id: payment.craftsmanUserId ?? null,
    offer_id: payment.offerId ?? null,
    status: payment.state,
    total_amount: payment.amounts.totalAmount,
    deposit_amount: payment.amounts.depositAmount,
    final_amount: payment.amounts.finalAmount,
    provider_ref: payment.providerRef ?? null,
    client_secret: payment.clientSecret ?? null,
    refunded_amount: payment.refundedAmount ?? null,
    created_at: new Date(payment.createdAt).toISOString(),
    updated_at: new Date(payment.updatedAt).toISOString(),
  }
}

/**
 * Supabase-backed implementation of the PaymentRepository interface.
 *
 * Uses a local in-memory cache to serve synchronous reads, keeping
 * the reactive subscription model intact while all writes are also
 * persisted to the `payments` table asynchronously.
 *
 * Bootstrap sequence:
 * 1. Construct the repository.
 * 2. Register it via `setPaymentRepository()`.
 * 3. Await `initializePaymentRepository()` (or `repo.initialize()` directly)
 *    to load the initial dataset from Supabase before the UI first renders.
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
 *   and UPDATE events on the `payments` table.  INSERT rows are deduplicated
 *   by ID (prevents double-display after optimistic writes).  UPDATE rows
 *   replace the existing cache entry so state transitions from the other party
 *   (e.g. customer deposit confirmation, Stripe webhook state advance) appear
 *   without a manual reload.
 */
export class SupabasePaymentRepository implements PaymentRepository {
  private payments: Payment[] = []
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

  reset(): void {
    this._initPromise = null
    this._loadGeneration++
  }

  prepareForResync(): void {
    this._initPromise = null
    this._loadGeneration++
  }

  private async fetchPaymentsFromDatabase(): Promise<Payment[]> {
    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) throw error
    return ((data ?? []) as PaymentRow[]).map(rowToPayment)
  }

  private async loadForUser(uid: string, generationSnapshot: number): Promise<void> {
    this.currentUid = uid
    const payments = await this.fetchPaymentsFromDatabase()
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    this.payments = payments
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
    this.payments = []
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
   * Subscribes to INSERT and UPDATE events on the `payments` table via Supabase Realtime.
   *
   * INSERT deduplication: if the arriving payment ID already exists in the local cache
   * (inserted optimistically by this client) we silently drop it.
   *
   * UPDATE merge: replaces the existing cache entry by ID so that state transitions
   * driven by Stripe webhooks or the other party (e.g. customer paying deposit)
   * appear without a manual reload.  If the payment is not yet in the local cache,
   * it is added — handles the case where a webhook creates the payment before the
   * initial page load completes.
   */
  private startRealtimeSubscription(uid: string, fromReconnection = false): void {
    // Remove any previously active channel before creating a new one.
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
    }
    const generation = ++this.realtimeGeneration
    this.realtimeChannel = supabase
      .channel(`fixup-payments-${uid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'payments' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as PaymentRow
          if (this.payments.some((p) => p.id === row.id)) return
          this.payments = [rowToPayment(row), ...this.payments]
          this.notify()
          logInfo('payment.realtime_inserted', { paymentId: row.id, jobId: row.job_id })
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'payments' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as PaymentRow
          const incoming = rowToPayment(row)
          const current = this.payments.find((p) => p.id === incoming.id)

          if (current) {
            // Merge guard: reject backward state transitions from realtime events.
            // A stale webhook or a delayed postgres_changes event must not overwrite
            // a valid forward transition that the optimistic write already applied.
            // Accept if: same state (idempotent), OR valid forward transition.
            if (
              incoming.state !== current.state &&
              !canTransition(current.state, incoming.state)
            ) {
              logWarning('payment.realtime_update_rejected_backward_transition', {
                paymentId: incoming.id,
                jobId: incoming.jobId,
                currentState: current.state,
                incomingState: incoming.state,
              })
              return
            }
            this.payments = this.payments.map((p) => (p.id === row.id ? incoming : p))
          } else {
            // Payment not yet in local cache — add it (e.g. created by webhook before page load)
            this.payments = [incoming, ...this.payments]
          }
          this.notify()
          logInfo('payment.realtime_updated', { paymentId: row.id, jobId: row.job_id, status: row.status })
        },
      )
      .subscribe((status) => {
        if (generation !== this.realtimeGeneration) return
        if (status === 'SUBSCRIBED') {
          this.isRealtimeConnected = true
          this.reconnectAttempts = 0
          logInfo('payment.realtime_connected', { userId: uid })
          if (fromReconnection) void this.fallbackRefresh(uid)
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.isRealtimeConnected = false
          logBreadcrumb(
            'repository.payments.realtime_disconnected',
            'warning',
            { userId: uid, status },
          )
          void this.fallbackRefresh(uid)
          this.attemptReconnection(uid)
        }
      })
  }

  /**
   * Fallback refresh: re-fetches all payments from the database when realtime fails.
   * Replaces the local cache with the fresh server state to ensure correctness.
   */
  private async fallbackRefresh(uid: string): Promise<void> {
    try {
      const freshPayments = await this.fetchPaymentsFromDatabase()
      this.payments = freshPayments
      this.notify()
      logInfo('payment.fallback_refresh_completed', { userId: uid })
    } catch (error) {
      logError('repository.payments.fallback_refresh_error', error as Error, { userId: uid })
    }
  }

  /**
   * Attempt to reconnect the realtime subscription with exponential backoff.
   */
  private attemptReconnection(uid: string): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logWarning(
        'repository.payments.realtime_reconnect_exhausted',
        { userId: uid, attempts: this.reconnectAttempts },
      )
      return
    }

    this.reconnectAttempts++
    logInfo('payment.realtime_reconnect_attempt', {
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

  getAll(): Payment[] {
    return [...this.payments]
  }

  getByJobId(jobId: string): Payment | undefined {
    return this.payments.find((payment) => payment.jobId === jobId)
  }

  async add(payment: Payment): Promise<void> {
    this.payments = [payment, ...this.payments]
    this.notify()
    const { error } = await supabase
      .from('payments')
      .insert(paymentToRow(payment))
    if (error) {
      // Rollback optimistic insert
      this.payments = this.payments.filter((p) => p.id !== payment.id)
      this.notify()
      logError('repository.payments.add_failed', error, { entityId: payment.id, jobId: payment.jobId })
      recordPersistenceFailure({ domain: 'payments', operation: 'add', entityId: payment.id, error, occurredAt: Date.now() })
      throw error
    }
  }

  async update(paymentId: string, updater: (payment: Payment) => Payment): Promise<void> {
    const previous = this.payments.find((p) => p.id === paymentId)
    let updated: Payment | undefined
    this.payments = this.payments.map((payment) => {
      if (payment.id === paymentId) {
        updated = updater(payment)
        return updated
      }
      return payment
    })
    this.notify()
    if (updated) {
      const { error } = await supabase
        .from('payments')
        .update(paymentToRow(updated))
        .eq('id', paymentId)
      if (error) {
        // Rollback optimistic update
        if (previous) {
          this.payments = this.payments.map((p) => (p.id === paymentId ? previous : p))
          this.notify()
        }
        logError('repository.payments.update_failed', error, { entityId: paymentId })
        recordPersistenceFailure({ domain: 'payments', operation: 'update', entityId: paymentId, error, occurredAt: Date.now() })
        throw error
      }
    }
  }

  /**
   * Atomically commits a terminal payment state across payments + jobs +
   * projects in a single PostgreSQL transaction via the
   * `finalize_payment_state_atomic` RPC.
   *
   * On success: updates the local cache to reflect the new state and notifies
   * subscribers — no second Supabase write is issued.
   *
   * On failure: logs + records persistence failure + throws.  Callers that reach
   * this method have already executed an irreversible Stripe operation, so the
   * error must propagate for operator recovery.
   */
  async finalizeStateAtomic(
    jobId: string,
    targetState: 'released' | 'refunded',
    options?: { disputeId?: string; actor?: string; refundedAmount?: number }
  ): Promise<Payment> {
    const existing = this.payments.find((p) => p.jobId === jobId)
    if (!existing) {
      throw new Error(`finalizeStateAtomic: no payment for job ${jobId}`)
    }

    if (existing.state === targetState) {
      logInfo('repository.payments.finalize_state_atomic_idempotent', {
        jobId,
        targetState,
        paymentId: existing.id,
      })
      return existing
    }

    const { error: rpcError } = await supabase.rpc('finalize_payment_state_atomic', {
      p_job_id:          jobId,
      p_target_state:    targetState,
      p_dispute_id:      options?.disputeId ?? null,
      p_actor:           options?.actor ?? 'system',
      p_refunded_amount: options?.refundedAmount ?? null,
    })

    if (rpcError) {
      logError('repository.payments.finalize_state_atomic_failed', rpcError, {
        jobId,
        targetState,
        disputeId: options?.disputeId,
      })
      recordPersistenceFailure({
        domain:      'payments',
        operation:   'finalize_state_atomic',
        entityId:    existing.id,
        error:       rpcError,
        occurredAt:  Date.now(),
      })
      throw rpcError
    }

    // Update local cache without a second Supabase write.
    // Realtime CDC will also deliver the DB change — the local update ensures
    // immediate UI responsiveness before the CDC event arrives.
    const updated: Payment = {
      ...existing,
      state: targetState,
      ...(options?.refundedAmount !== undefined ? { refundedAmount: options.refundedAmount } : {}),
      updatedAt: Date.now(),
    }
    this.payments = this.payments.map((p) => (p.jobId === jobId ? updated : p))
    this.notify()

    logInfo('repository.payments.finalize_state_atomic_committed', {
      jobId,
      targetState,
      paymentId: existing.id,
      actor: options?.actor ?? 'system',
    })

    return updated
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
