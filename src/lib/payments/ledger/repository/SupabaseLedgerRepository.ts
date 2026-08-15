import { supabase } from '../../../supabase.js'
import { getPendingMutations } from '../../../persistence/index.js'
import { logBreadcrumb } from '../../../observability/index.js'
import type { LedgerEntry, LedgerEntryType } from '../ledgerTypes.js'
import type { LedgerRepository } from './LedgerRepository.js'

type Listener = () => void

interface LedgerEntryRow {
  id: string
  payment_id: string
  job_id: string
  type: string
  amount: number
  currency: string
  created_at: number
  note: string | null
  dispute_id: string | null
}

function rowToLedgerEntry(row: LedgerEntryRow): LedgerEntry {
  return {
    id: row.id,
    paymentId: row.payment_id,
    jobId: row.job_id,
    type: row.type as LedgerEntryType,
    amount: row.amount,
    currency: row.currency as 'EUR',
    createdAt: row.created_at,
    ...(row.note != null && { note: row.note }),
    ...(row.dispute_id != null && { disputeId: row.dispute_id }),
  }
}

function ledgerEntryToRow(entry: LedgerEntry): LedgerEntryRow {
  return {
    id: entry.id,
    payment_id: entry.paymentId,
    job_id: entry.jobId,
    type: entry.type,
    amount: entry.amount,
    currency: entry.currency,
    created_at: entry.createdAt,
    note: entry.note ?? null,
    dispute_id: entry.disputeId ?? null,
  }
}

/**
 * Supabase-backed implementation of the LedgerRepository interface.
 *
 * Uses a local in-memory cache to serve synchronous reads, keeping
 * the reactive subscription model intact while all writes are also
 * persisted to the `ledger_entries` table asynchronously.
 *
 * Bootstrap sequence:
 * 1. Construct the repository.
 * 2. Register it via `setLedgerRepository()`.
 * 3. Await `initializeLedgerRepository()` (or `repo.initialize()` directly)
 *    to load the initial dataset from Supabase before the UI first renders.
 *
 * Write path (optimistic):
 * - All write methods update the local cache and notify subscribers
 *   immediately so the UI stays responsive.
 * - The corresponding Supabase mutation is fired in the background.
 *   Failures are logged to the console.
 */
export class SupabaseLedgerRepository implements LedgerRepository {
  private ledger: LedgerEntry[] = []
  private authUnsubscribe: (() => void) | null = null
  private readonly listeners = new Set<Listener>()
  private _hydrated = false
  private currentUid: string | null = null
  private _initPromise: Promise<void> | null = null
  private _loadGeneration = 0

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
    this.currentUid = uid
    const { data, error } = await supabase
      .from('ledger_entries')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500)
    if (error) throw error
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    this.ledger = ((data ?? []) as LedgerEntryRow[]).map(rowToLedgerEntry)
    this.hydrateFromQueue(uid)
    this.notify()
  }

  private resetState(): void {
    this._initPromise = null
    this.currentUid = null
    this.ledger = []
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

  reset(): void {
    this.resetState()
  }

  prepareForResync(): void {
    this._initPromise = null
    this._loadGeneration++
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

  getAll(): LedgerEntry[] {
    return [...this.ledger]
  }

  getForPayment(paymentId: string): LedgerEntry[] {
    return this.ledger.filter((entry) => entry.paymentId === paymentId)
  }

  getForJob(jobId: string): LedgerEntry[] {
    return this.ledger.filter((entry) => entry.jobId === jobId)
  }

  private hydrateFromQueue(uid: string): void {
    const pending = getPendingMutations()
    for (const m of pending) {
      if (m.table !== 'ledger_entries' || m.operation !== 'insert') continue
      if (m.userId && m.userId !== uid) continue
      if (this.ledger.some((e) => e.id === m.entityId)) continue
      try {
        const entry = rowToLedgerEntry(m.payload as unknown as LedgerEntryRow)
        this.ledger = [entry, ...this.ledger]
      } catch { /* malformed payload */ }
    }
  }

  add(entry: LedgerEntry): void {
    this.ledger = [entry, ...this.ledger]
    this.notify()

    // SCHEMA DRIFT — write intentionally skipped (Block PA; re-home in Block P).
    //
    // Prod `ledger_entries` is a money-MOVEMENT model: uuid ids, a NOT NULL
    // `entry_type` with a CHECK enum (escrow_deposit | platform_fee | payout |
    // …), `metadata` jsonb, timestamptz `created_at`. This client writes the
    // older lifecycle-event shape (text id, `type`, `note`, bigint epoch). Every
    // insert therefore fails — PGRST204 on the missing `note` column, then a NOT
    // NULL violation on `entry_type` — and the prod table holds 0 rows. The only
    // effect of firing it was a `logError` on each offer accept, burning Sentry
    // quota for a write that can never succeed. The optimistic cache update above
    // already serves the reactive read path, so we skip the doomed round-trip and
    // record a no-cost breadcrumb until the ledger is re-pointed onto the
    // movement model in the Payout-Korridor (Block P / P5). No money semantics
    // change here: nothing was being persisted before either.
    logBreadcrumb('repository.ledger.write_skipped_schema_drift', 'info', {
      entityId: entry.id,
      entryType: entry.type,
    })
  }

  updateEntryAmount(entryId: string, newAmount: number): void {
    // Optimistic cache update only — DB persistence intentionally skipped,
    // mirroring add() (SCHEMA DRIFT, Block PA; re-home in Block P / P5).
    //
    // add() never persists a ledger row, so there is no prod row to UPDATE. The
    // prior DB path was prod-invalid against the movement model: prod
    // `ledger_entries.id` is uuid, so `.eq('id', 'ledger_…')` raises 22P02, and
    // the queued full-row replay payload (text id, `type`, `note`, bigint epoch)
    // is the same triple-invalid drift shape prod rejects on every column. Until
    // the client ledger is re-pointed onto the entry_type movement model
    // (P2/P3 — domain-taxonomy↔movement-enum unification), keep the reactive
    // cache accurate and record a no-cost breadcrumb instead of a doomed
    // round-trip / replay queue.
    this.ledger = this.ledger.map((e) =>
      e.id === entryId ? { ...e, amount: newAmount } : e
    )
    this.notify()
    const updatedEntry = this.ledger.find((e) => e.id === entryId)
    if (!updatedEntry) return

    logBreadcrumb('repository.ledger.update_amount_skipped_schema_drift', 'info', {
      entityId: entryId,
    })
  }
}

// Retained for the deferred re-enable of client-side ledger persistence (Block
// P2/P3): the row-mapper feeds the write path again once the domain taxonomy is
// unified with the prod entry_type movement enum. Referenced here so eslint's
// no-unused-vars does not flag it while the write path is skipped.
void ledgerEntryToRow
