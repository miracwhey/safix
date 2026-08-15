import { supabase } from '../../supabase'
import {
  recordPersistenceFailure,
  enqueuePendingMutation,
  hasPendingMutationForEntity,
  getPendingMutations,
} from '../../persistence'
import { logError, logWarning } from '../../observability'
import type { RealtimeChannel } from '@supabase/supabase-js'
import type {
  CustomerInvoiceSnapshot,
  Invoice,
  InvoiceAmounts,
  InvoiceKind,
  InvoiceLineItem,
  InvoiceParties,
  InvoiceServicePeriod,
  InvoiceStatus,
  InvoiceTaxBreakdownEntry,
  ProviderInvoiceSnapshot,
} from '../types'
import type { InvoiceRepository } from './InvoiceRepository'
import { shouldReplaceCached } from './invoiceMergeGuard'

type Listener = () => void

interface InvoiceRow {
  id: string
  job_id: string
  invoice_number: string
  status: string
  parties: InvoiceParties
  line_items: InvoiceLineItem[]
  amounts: InvoiceAmounts
  issued_at: number
  issued_at_label: string
  due_at_label: string
  sent_at: number
  // Block 7.1B3 — §14-Snapshot
  service_period_from: number | null
  service_period_to: number | null
  service_period_label: string | null
  tax_breakdown: InvoiceTaxBreakdownEntry[] | null
  tax_note: string | null
  provider_snapshot: ProviderInvoiceSnapshot | null
  customer_snapshot: CustomerInvoiceSnapshot | null
  source_offer_id: string | null
  source_change_order_ids: string[]
  source_supplementary_payment_ids: string[]
  // Block 7.1B4 — Korrekturbelege (Storno-Rechnung / Gutschrift)
  kind: string | null
  original_invoice_id: string | null
  correction_reason: string | null
  correction_amount_cents: number | null
  original_invoice_number: string | null
  original_invoice_issued_at_label: string | null
  refund_event_id: string | null
  created_at: number
  updated_at: number
}

function rowToServicePeriod(row: InvoiceRow): InvoiceServicePeriod | null {
  // Komplettes ServicePeriod-Objekt nur wenn der App-Code es als Snapshot
  // gesetzt hat. `label` ist die vom Snapshot-Builder gerenderte UI-Wahrheit
  // — fehlt sie, ist die Periode nicht persistiert.
  if (!row.service_period_label) return null
  return {
    from: row.service_period_from ?? null,
    to: row.service_period_to ?? null,
    label: row.service_period_label,
  }
}

function rowToInvoice(row: InvoiceRow): Invoice {
  // Bestandsdaten ohne `kind`-Spalte (vor B4) sind alle Originalrechnungen.
  const kind = (row.kind ?? 'invoice') as InvoiceKind
  return {
    id: row.id,
    jobId: row.job_id,
    invoiceNumber: row.invoice_number,
    status: row.status as InvoiceStatus,
    parties: row.parties,
    lineItems: row.line_items,
    amounts: row.amounts,
    issuedAt: row.issued_at ?? 0,
    issuedAtLabel: row.issued_at_label,
    dueAtLabel: row.due_at_label,
    sentAt: row.sent_at ?? 0,
    servicePeriod: rowToServicePeriod(row),
    taxBreakdown: row.tax_breakdown ?? null,
    taxNote: row.tax_note ?? null,
    providerSnapshot: row.provider_snapshot ?? null,
    customerSnapshot: row.customer_snapshot ?? null,
    sourceOfferId: row.source_offer_id ?? null,
    sourceChangeOrderIds: row.source_change_order_ids ?? [],
    sourceSupplementaryPaymentIds: row.source_supplementary_payment_ids ?? [],
    kind,
    originalInvoiceId: row.original_invoice_id ?? null,
    correctionReason: row.correction_reason ?? null,
    correctionAmountCents: row.correction_amount_cents ?? null,
    originalInvoiceNumber: row.original_invoice_number ?? null,
    originalInvoiceIssuedAtLabel: row.original_invoice_issued_at_label ?? null,
    refundEventId: row.refund_event_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function invoiceToRow(invoice: Invoice): InvoiceRow {
  return {
    id: invoice.id,
    job_id: invoice.jobId,
    invoice_number: invoice.invoiceNumber,
    status: invoice.status,
    parties: invoice.parties,
    line_items: invoice.lineItems,
    amounts: invoice.amounts,
    issued_at: invoice.issuedAt,
    issued_at_label: invoice.issuedAtLabel,
    due_at_label: invoice.dueAtLabel,
    sent_at: invoice.sentAt,
    service_period_from: invoice.servicePeriod?.from ?? null,
    service_period_to: invoice.servicePeriod?.to ?? null,
    service_period_label: invoice.servicePeriod?.label ?? null,
    tax_breakdown: invoice.taxBreakdown,
    tax_note: invoice.taxNote,
    provider_snapshot: invoice.providerSnapshot,
    customer_snapshot: invoice.customerSnapshot,
    source_offer_id: invoice.sourceOfferId,
    source_change_order_ids: invoice.sourceChangeOrderIds,
    source_supplementary_payment_ids: invoice.sourceSupplementaryPaymentIds,
    kind: invoice.kind,
    original_invoice_id: invoice.originalInvoiceId,
    correction_reason: invoice.correctionReason,
    correction_amount_cents: invoice.correctionAmountCents,
    original_invoice_number: invoice.originalInvoiceNumber,
    original_invoice_issued_at_label: invoice.originalInvoiceIssuedAtLabel,
    refund_event_id: invoice.refundEventId,
    created_at: invoice.createdAt,
    updated_at: invoice.updatedAt,
  }
}

/**
 * Returns true when the error carries a Postgres server-side error code,
 * meaning the failure is a definitive server rejection — not a transient
 * network or connectivity issue. Only transient errors should be queued for
 * offline replay; server conflicts must not be silently upserted on flush.
 *
 * Postgres error class 23 = integrity constraint violations (duplicate key,
 * FK, not-null, check, exclusion). Class 42 = syntax/schema errors.
 * Neither class is retryable — queuing them would replay a write that the
 * server already rejected for a structural reason.
 */
function isServerSideError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const e = error as Record<string, unknown>
  if (typeof e.code !== 'string') return false
  return e.code.startsWith('22') || e.code.startsWith('23') || e.code.startsWith('42')
}

/** Returns true when the Postgres error is a unique-key violation (23505). */
function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const e = error as Record<string, unknown>
  return e.code === '23505'
}

/**
 * Supabase-backed implementation of the InvoiceRepository interface.
 *
 * Uses a local in-memory cache to serve synchronous reads, keeping
 * the reactive subscription model intact while all writes are also
 * persisted to the `invoices` table asynchronously.
 *
 * Bootstrap sequence:
 * 1. Construct the repository.
 * 2. Register it via `setInvoiceRepository()`.
 * 3. Await `initializeInvoiceRepository()` (or `repo.initialize()` directly)
 *    to load the initial dataset from Supabase before the UI first renders.
 *
 * Write path (optimistic):
 * - All write methods update the local cache and notify subscribers
 *   immediately so the UI stays responsive.
 * - The corresponding Supabase mutation is fired in the background.
 *   Failures are logged via `recordPersistenceFailure()`.
 *
 * Offline draft semantics:
 * - add() only queues on transient/network failures. Server-side conflicts
 *   (23505 duplicate key, other 23xxx/42xxx) are never queued — the flush
 *   path replays with upsert and would otherwise overwrite an existing invoice.
 * - update() blocks when a pending INSERT exists for the same invoice: the DB
 *   row does not exist yet, so the UPDATE would silently no-op and the
 *   draft → issued trigger would not fire.
 * - initialize() / loadForUser() hydrates queued draft inserts from the local
 *   pending-mutation store so drafts remain visible after app restart even
 *   when the DB row has not been written yet.
 *
 * Invoice number assignment:
 * - Draft invoices carry invoice_number = ''.
 * - A DB trigger (assign_invoice_number) atomically assigns a sequential
 *   number (FX-YYYY-NNNN) when status transitions from draft to issued.
 * - After a successful issued transition, the repository re-reads the
 *   invoice_number from the DB and updates the local cache, ensuring the
 *   client-side state always reflects the DB-authoritative number.
 *
 * sent_at column:
 * - The `invoices` table must have a `sent_at` column (bigint, default 0).
 * - Written on any update that includes sentAt > 0. Zero values are written
 *   explicitly to avoid NULL/0 ambiguity in the DB.
 */
export class SupabaseInvoiceRepository implements InvoiceRepository {
  private invoices: Invoice[] = []
  private authUnsubscribe: (() => void) | null = null
  private readonly listeners = new Set<Listener>()
  private _hydrated = false
  private currentUid: string | null = null
  private _initPromise: Promise<void> | null = null
  private _loadGeneration = 0
  /** De-dupes concurrent lazy-by-id fetches (see ensureLoaded). */
  private readonly inFlightById = new Map<string, Promise<void>>()
  /** De-dupes concurrent lazy-by-jobId fetches (see ensureLoadedByJobId). */
  private readonly inFlightByJobId = new Map<string, Promise<void>>()
  // R4 — realtime (live invoice status). Mirrors SupabaseFundingRequestRepository.
  private realtimeChannel: RealtimeChannel | null = null
  private channelGeneration = 0
  private isRealtimeConnected = false
  private reconnectAttempts = 0
  private readonly MAX_RECONNECT_ATTEMPTS = 5
  private readonly RECONNECT_DELAY = 2000

  /**
   * Best-effort fetch-and-refresh of a single invoice by id. Used by the chat
   * Rechnung card + the invoice detail screen on every mount, so the status is
   * fresh each time the customer opens the thread/screen — not pinned to the
   * one-shot initial load. An invoices realtime channel now exists (R4), so this
   * is a belt-and-suspenders refresh: rows beyond the initial 200, missed events,
   * and the resume-in-place / already-mounted window before the channel revives.
   *
   * Always refetches (no cache early-return) and REPLACES the cached row, so a
   * status transition (issued→sent→paid→cancelled) made elsewhere surfaces.
   * Concurrent calls for the same id are de-duped. RLS decides visibility; a
   * miss is silent — the snapshot fallback still renders.
   */
  async ensureLoaded(id: string): Promise<void> {
    if (!id) return
    const inFlight = this.inFlightById.get(id)
    if (inFlight) return inFlight
    // Snapshot load-generation + uid so a read that resolves after a sign-out /
    // resync does not re-populate a cleared/other-user cache.
    const gen = this._loadGeneration
    const uid = this.currentUid
    const promise = (async () => {
      try {
        const { data, error } = await supabase
          .from('invoices')
          .select('*')
          .eq('id', id)
          .maybeSingle()
        if (error || !data) return
        if (gen !== this._loadGeneration || uid !== this.currentUid) return
        // Merge via the FSM-rank guard so a status transition surfaces and a
        // stale read never clobbers a newer optimistic local write.
        this.upsertFresh(rowToInvoice(data as InvoiceRow))
      } catch {
        // best-effort — the snapshot fallback covers a miss
      } finally {
        this.inFlightById.delete(id)
      }
    })()
    this.inFlightById.set(id, promise)
    return promise
  }

  /**
   * Best-effort fetch-and-refresh of a job's ORIGINAL invoice (kind='invoice')
   * by jobId. The payment-sync path (syncInvoiceWithPayment) only knows the
   * jobId, and a provider invoice can sit outside the initial 200-row window —
   * so a by-jobId cache miss would otherwise silently skip the issued→sent
   * advance. Mirrors ensureLoaded's generation/uid guards + the FSM-rank merge.
   * Concurrent calls per jobId are de-duped; a miss is silent (caller re-reads
   * via getByJobId).
   */
  async ensureLoadedByJobId(jobId: string): Promise<void> {
    if (!jobId) return
    const inFlight = this.inFlightByJobId.get(jobId)
    if (inFlight) return inFlight
    const gen = this._loadGeneration
    const uid = this.currentUid
    const promise = (async () => {
      try {
        const { data, error } = await supabase
          .from('invoices')
          .select('*')
          .eq('job_id', jobId)
          .eq('kind', 'invoice')
          .maybeSingle()
        if (error || !data) return
        if (gen !== this._loadGeneration || uid !== this.currentUid) return
        this.upsertFresh(rowToInvoice(data as InvoiceRow))
      } catch {
        // best-effort — caller re-reads via getByJobId
      } finally {
        this.inFlightByJobId.delete(jobId)
      }
    })()
    this.inFlightByJobId.set(jobId, promise)
    return promise
  }

  /**
   * R3 single-writer boundary: the server settle trigger on `payments` owns the
   * invoice→'paid' transition (SECURITY DEFINER, bypasses RLS + immutability).
   * The client must therefore NOT attempt the →'paid' write — it is provider-RLS
   * / due_at_label-immutability rejected; the 'paid' status arrives via realtime.
   */
  serverDrivesPaidStatus(): boolean {
    return true
  }

  /**
   * Merge a freshly fetched/echoed invoice into the cache via the clock-agnostic
   * FSM-rank guard (shouldReplaceCached) — drops only a genuine staleness, lets
   * a forward status transition (e.g. server 'paid') win regardless of clock.
   */
  private upsertFresh(fresh: Invoice): void {
    const idx = this.invoices.findIndex((inv) => inv.id === fresh.id)
    if (idx >= 0) {
      if (!shouldReplaceCached(fresh, this.invoices[idx])) return
      this.invoices = this.invoices.map((inv) => (inv.id === fresh.id ? fresh : inv))
    } else {
      this.invoices = [fresh, ...this.invoices]
    }
    this.notify()
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

  private async loadForUser(uid: string, generationSnapshot: number): Promise<void> {
    await this.fetchInvoicesForUser(uid, generationSnapshot)
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    this.startRealtimeSubscription(uid)
  }

  /** Fetch + populate the user-scoped cache WITHOUT (re)subscribing realtime —
   *  so fallbackRefresh can re-fetch on reconnect without re-subscribing. */
  private async fetchInvoicesForUser(uid: string, generationSnapshot: number): Promise<void> {
    this.currentUid = uid
    const channelGen = this.channelGeneration
    const { data, error } = await supabase
      .from('invoices')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) throw error
    // channelGeneration guard (mirrors funding's fetchAndLoadFromDatabase): a
    // fallbackRefresh whose channel was re-subscribed mid-flight must NOT
    // wholesale-clobber newer realtime-applied state with its stale snapshot
    // (e.g. revert a just-applied paid→issued). A reconnect bumps only
    // channelGeneration, so currentUid/_loadGeneration alone do not catch it.
    if (
      this.currentUid !== uid ||
      generationSnapshot !== this._loadGeneration ||
      channelGen !== this.channelGeneration
    )
      return
    this.invoices = ((data ?? []) as InvoiceRow[]).map(rowToInvoice)
    this.hydrateFromQueue(uid)
    this.notify()
  }

  private hydrateFromQueue(uid: string): void {
    const pending = getPendingMutations()
    for (const m of pending) {
      if (m.table !== 'invoices' || m.operation !== 'insert') continue
      if (m.userId && m.userId !== uid) continue
      const alreadyInCache = this.invoices.some((inv) => inv.id === m.entityId)
      if (alreadyInCache) continue
      try {
        const invoice = rowToInvoice(m.payload as unknown as InvoiceRow)
        this.invoices = [invoice, ...this.invoices]
      } catch {
        // Malformed queue payload — skip without crashing the repository load.
      }
    }
  }


  private resetState(): void {
    this._initPromise = null
    // Invalidate pending realtime callbacks before tearing the channel down so
    // the async CLOSED event Supabase fires is treated as stale.
    this.channelGeneration++
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
      this.realtimeChannel = null
    }
    this.isRealtimeConnected = false
    this.reconnectAttempts = 0
    this.currentUid = null
    this.invoices = []
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
        this.currentUid = null
        this.resetState()
      }
    })
    this.authUnsubscribe = subscription?.unsubscribe
      ? subscription.unsubscribe.bind(subscription)
      : null
  }

  // ── Realtime (R4) ────────────────────────────────────────────────────────
  /**
   * Subscribes to INSERT + UPDATE on `invoices`. A status transition made by
   * the craftsman / the payment-settle path surfaces on the counterparty's open
   * thread without a reload. Realtime respects RLS — the user only receives rows
   * they may SELECT. Mirrors SupabaseFundingRequestRepository.
   */
  private startRealtimeSubscription(uid: string, fromReconnection = false): void {
    const myGeneration = ++this.channelGeneration
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
    }
    this.realtimeChannel = supabase
      .channel(`fixup-invoices-${uid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'invoices' },
        (payload) => {
          if (myGeneration !== this.channelGeneration) return
          this.applyRealtimeRow(payload.new as InvoiceRow)
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'invoices' },
        (payload) => {
          if (myGeneration !== this.channelGeneration) return
          this.applyRealtimeRow(payload.new as InvoiceRow)
        },
      )
      .subscribe((status) => {
        if (myGeneration !== this.channelGeneration) return
        if (status === 'SUBSCRIBED') {
          this.isRealtimeConnected = true
          this.reconnectAttempts = 0
          if (fromReconnection) void this.fallbackRefresh(uid)
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.isRealtimeConnected = false
          void this.fallbackRefresh(uid)
          this.attemptReconnection(uid)
        }
      })
  }

  /**
   * Upserts a realtime row into the cache via the FSM-rank merge guard.
   *
   * R3 seam (resolved): invoices now have TWO writers — the provider client
   * (device wall-clock updatedAt) and the server settle trigger (DB epoch_ms).
   * A wall-clock compare would silently drop a server 'paid' echo whose clock
   * lands below an ahead device 'sent'. upsertFresh ranks by FSM status instead
   * (clock-agnostic): a forward transition always wins, same-status echoes fall
   * back to the updatedAt tiebreak. See INVOICE_FSM_RANK.
   */
  private applyRealtimeRow(row: InvoiceRow): void {
    this.upsertFresh(rowToInvoice(row))
  }

  private async fallbackRefresh(uid: string): Promise<void> {
    try {
      await this.fetchInvoicesForUser(uid, this._loadGeneration)
    } catch (error) {
      logError('repository.invoices.fallback_refresh_error', error as Error, { userId: uid })
    }
  }

  private attemptReconnection(uid: string): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logWarning('invoice.realtime_reconnect_exhausted', {
        userId: uid,
        attempts: this.reconnectAttempts,
      })
      return
    }
    this.reconnectAttempts++
    setTimeout(() => {
      if (!this.isRealtimeConnected && this.currentUid === uid) {
        this.startRealtimeSubscription(uid, true)
      }
    }, this.RECONNECT_DELAY * this.reconnectAttempts)
  }

  /**
   * Resume-cascade hook (session.ts handleAppResume). No-op while the channel
   * reads healthy — unless `force`: after an iOS suspend the socket is dead while
   * isRealtimeConnected still reads true (zombie, no CLOSED fires), so a forced
   * restart skips the lagging check, tears the channel down and re-subscribes.
   * Mirrors SupabaseFundingRequestRepository.
   */
  restartRealtimeIfDead(options?: { force?: boolean }): void {
    if (!this.currentUid) return
    if (!options?.force && this.isRealtimeConnected) return
    this.isRealtimeConnected = false
    this.reconnectAttempts = 0
    this.startRealtimeSubscription(this.currentUid, true)
  }

  reset(): void {
    this.resetState()
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

  getAll(): Invoice[] {
    return [...this.invoices]
  }

  getByJobId(jobId: string): Invoice | undefined {
    return this.invoices.find((invoice) => invoice.jobId === jobId)
  }

  async add(invoice: Invoice): Promise<void> {
    // Pre-flight: draft was queued in a prior offline session. Ensure it is
    // visible in the local cache (the DB row may not exist yet if flush has not
    // run) and return — do not fire a second DB write or a duplicate queue entry.
    if (hasPendingMutationForEntity('invoices', invoice.id)) {
      const alreadyInCache = this.invoices.some((inv) => inv.id === invoice.id)
      if (!alreadyInCache) {
        this.invoices = [invoice, ...this.invoices]
        this.notify()
      }
      return
    }

    const alreadyExists = this.invoices.some((inv) => inv.id === invoice.id)
    if (alreadyExists) return

    this.invoices = [invoice, ...this.invoices]
    this.notify()
    const { error } = await supabase
      .from('invoices')
      .insert(invoiceToRow(invoice))
    // Block 7.1B4 — Korrekturbelege können theoretisch atomar als
    // `status = 'issued'` eingefügt werden; der DB-Trigger feuert dann auf
    // BEFORE INSERT und vergibt eine Belegnummer aus der kind-spezifischen
    // Sequenz. Heute geht der `invoiceCorrectionWorkflow` über
    // draft → issued (mit der bestehenden UPDATE-Re-Read-Logik), aber der
    // INSERT-Pfad bleibt als Sicherheitsnetz. Im Erfolgsfall lesen wir die
    // vom Trigger zugewiesene Nummer zurück, damit der lokale Cache der
    // DB-Wahrheit folgt.
    if (!error && invoice.status === 'issued' && !invoice.invoiceNumber) {
      const { data: insertedRow, error: readError } = await supabase
        .from('invoices')
        .select('invoice_number')
        .eq('id', invoice.id)
        .single()
      if (
        !readError &&
        insertedRow &&
        (insertedRow as { invoice_number: string }).invoice_number
      ) {
        const assignedNumber = (insertedRow as { invoice_number: string })
          .invoice_number
        this.invoices = this.invoices.map((inv) =>
          inv.id === invoice.id
            ? { ...inv, invoiceNumber: assignedNumber }
            : inv,
        )
        this.notify()
      }
    }
    if (error) {
      if (isServerSideError(error)) {
        // Server rejected the INSERT for a structural reason — not a transient
        // network failure. Never queue: the flush path uses upsert and would
        // silently overwrite an existing invoice's status, number, or amounts.
        this.invoices = this.invoices.filter((inv) => inv.id !== invoice.id)
        this.notify()

        if (isDuplicateKeyError(error)) {
          // 23505: the invoice already exists in Supabase (stale local cache).
          // Reload the DB-authoritative version so the cache reflects reality.
          const { data } = await supabase
            .from('invoices')
            .select('*')
            .eq('id', invoice.id)
            .single()
          if (data) {
            const existing = rowToInvoice(data as InvoiceRow)
            if (!this.invoices.some((inv) => inv.id === existing.id)) {
              this.invoices = [existing, ...this.invoices]
              this.notify()
            }
          }
          // Return without queuing or throwing — cache now holds DB truth.
          return
        }

        // Other server-side error (FK violation, schema mismatch, etc.):
        // surface as a hard failure. Do not queue.
        logError('repository.invoices.add_conflict', error, { entityId: invoice.id })
        recordPersistenceFailure({
          domain: 'invoices',
          operation: 'add',
          entityId: invoice.id,
          error,
          occurredAt: Date.now(),
        })
        throw error
      }

      // Transient / offline error — queue the draft insert for replay.
      // Domain 'invoices/draft' keeps the queued grace period (≥2 retries +
      // ≥15 s) separate from update() failures, which are non-queued and
      // escalate on age alone under domain 'invoices'.
      enqueuePendingMutation({
        operation: 'insert',
        table: 'invoices',
        payload: invoiceToRow(invoice) as unknown as Record<string, unknown>,
        domain: 'invoices/draft',
        entityId: invoice.id,
      })
      logError('repository.invoices.add_failed', error, { entityId: invoice.id })
      recordPersistenceFailure({
        domain: 'invoices/draft',
        operation: 'add',
        entityId: invoice.id,
        error,
        occurredAt: Date.now(),
      })
      // Do not throw: createInvoiceWorkflow completes with the local draft as
      // source of truth. SyncStatusBar surfaces the failure after the grace
      // period if the queue does not self-heal.
    }
  }

  async update(invoiceId: string, updater: (invoice: Invoice) => Invoice): Promise<void> {
    // Guard: a pending INSERT for this invoice means the DB row does not exist
    // yet. Running UPDATE against a missing row is a silent no-op in Supabase —
    // the draft → issued trigger would not fire and no invoice number would be
    // assigned. Block updates until the pending insert has been flushed.
    if (hasPendingMutationForEntity('invoices', invoiceId)) {
      throw new Error(
        `Invoice "${invoiceId}" cannot be updated: a draft insert is pending sync. ` +
        `Wait for the pending draft to be flushed to the database before issuing or updating this invoice.`,
      )
    }

    const previous = this.invoices.find((inv) => inv.id === invoiceId)
    let updated: Invoice | undefined
    this.invoices = this.invoices.map((invoice) => {
      if (invoice.id === invoiceId) {
        updated = updater(invoice)
        return updated
      }
      return invoice
    })
    this.notify()
    if (updated) {
      // Never write invoice_number in UPDATE — it is assigned exclusively by the
      // DB trigger (assign_invoice_number) on draft → issued. Excluding it here
      // prevents a transient readback failure from erasing the trigger-assigned
      // number on any subsequent update (e.g. issued → sent).
      const { invoice_number: _ignored, ...rowWithoutNumber } = invoiceToRow(updated)
      const { error } = await supabase
        .from('invoices')
        .update(rowWithoutNumber)
        .eq('id', invoiceId)
      if (error) {
        // Rollback optimistic update
        if (previous) {
          this.invoices = this.invoices.map((inv) => (inv.id === invoiceId ? previous : inv))
          this.notify()
        }
        logError('repository.invoices.update_failed', error, { entityId: invoiceId })
        recordPersistenceFailure({
          domain: 'invoices',
          operation: 'update',
          entityId: invoiceId,
          error,
          occurredAt: Date.now(),
        })
        throw error
      }

      // Re-read the invoice_number from the DB after a successful issued transition.
      // The DB trigger (assign_invoice_number) atomically assigns the sequential
      // number during the UPDATE — the client cannot know the assigned value without
      // reading it back. This keeps the local cache in sync with DB truth.
      if (updated.status === 'issued') {
        const { data, error: readError } = await supabase
          .from('invoices')
          .select('invoice_number')
          .eq('id', invoiceId)
          .single()
        if (!readError && data && (data as { invoice_number: string }).invoice_number) {
          const assignedNumber = (data as { invoice_number: string }).invoice_number
          this.invoices = this.invoices.map((inv) =>
            inv.id === invoiceId ? { ...inv, invoiceNumber: assignedNumber } : inv
          )
          this.notify()
        }
      }
    }
  }
}
