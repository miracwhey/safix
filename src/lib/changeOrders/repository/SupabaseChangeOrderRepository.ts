import { supabase } from '../../supabase'
import { recordPersistenceFailure } from '../../persistence'
import { logError } from '../../observability'
import type { ChangeOrder, ChangeOrderStatus } from '../types'
import type { ChangeOrderRepository } from './ChangeOrderRepository'

type Listener = () => void

interface ChangeOrderRow {
  id: string
  job_id: string
  source_offer_id: string | null
  craftsman_user_id: string
  customer_user_id: string
  description: string
  price: string
  currency: string | null
  gross_total: number | null
  net_total: number | null
  vat_rate: number | null
  status: string
  sent_at: number | null
  accepted_at: number | null
  declined_at: number | null
  created_at: number
  updated_at: number
}

function rowToChangeOrder(row: ChangeOrderRow): ChangeOrder {
  return {
    id: row.id,
    jobId: row.job_id,
    craftsmanUserId: row.craftsman_user_id,
    customerUserId: row.customer_user_id,
    description: row.description,
    price: row.price,
    status: row.status as ChangeOrderStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.source_offer_id != null && { sourceOfferId: row.source_offer_id }),
    ...(row.currency != null && { currency: row.currency as ChangeOrder['currency'] }),
    ...(row.gross_total != null && { grossTotal: row.gross_total }),
    ...(row.net_total != null && { netTotal: row.net_total }),
    ...(row.vat_rate != null && { vatRate: row.vat_rate }),
    ...(row.sent_at != null && { sentAt: row.sent_at }),
    ...(row.accepted_at != null && { acceptedAt: row.accepted_at }),
    ...(row.declined_at != null && { declinedAt: row.declined_at }),
  }
}

function changeOrderToRow(co: ChangeOrder): ChangeOrderRow {
  return {
    id: co.id,
    job_id: co.jobId,
    source_offer_id: co.sourceOfferId ?? null,
    craftsman_user_id: co.craftsmanUserId,
    customer_user_id: co.customerUserId,
    description: co.description,
    price: co.price,
    currency: co.currency ?? null,
    gross_total: co.grossTotal ?? null,
    net_total: co.netTotal ?? null,
    vat_rate: co.vatRate ?? null,
    status: co.status,
    sent_at: co.sentAt ?? null,
    accepted_at: co.acceptedAt ?? null,
    declined_at: co.declinedAt ?? null,
    created_at: co.createdAt,
    updated_at: co.updatedAt,
  }
}

/**
 * Supabase-backed ChangeOrderRepository.
 *
 * Read scope: change orders where craftsman_user_id = current user OR
 * customer_user_id = current user (enforced via RLS on change_orders table).
 * See migration 20260411000004_change_orders_table.sql.
 */
export class SupabaseChangeOrderRepository implements ChangeOrderRepository {
  private changeOrders: ChangeOrder[] = []
  private authUnsubscribe: (() => void) | null = null
  private readonly listeners = new Set<Listener>()
  private _hydrated = false
  private currentUid: string | null = null
  private _initPromise: Promise<void> | null = null
  private _loadGeneration = 0
  /** De-dupes concurrent lazy-by-id fetches (see ensureLoaded). */
  private readonly inFlightById = new Map<string, Promise<void>>()

  async initialize(): Promise<void> {
    if (this._initPromise) return this._initPromise
    const generation = ++this._loadGeneration
    const p: Promise<void> = (async () => {
      const { data: { session } } = await supabase.auth.getSession()
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
      .from('change_orders')
      .select('*')
      .or(`craftsman_user_id.eq.${uid},customer_user_id.eq.${uid}`)
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) throw error
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    this.changeOrders = ((data ?? []) as ChangeOrderRow[]).map(rowToChangeOrder)
    this.notify()
  }

  /**
   * Best-effort lazy load of a single ChangeOrder by id (e.g. the counterparty
   * opening a Nachtrag card, or refreshing its status on mount — there is no
   * change_orders realtime channel). RLS decides visibility; a stale read never
   * clobbers a newer cached row (updatedAt guard), and a sign-out/resync during
   * the fetch is dropped via the generation + uid snapshot.
   */
  async ensureLoaded(id: string): Promise<void> {
    if (!id) return
    const inFlight = this.inFlightById.get(id)
    if (inFlight) return inFlight
    const gen = this._loadGeneration
    const uid = this.currentUid
    const promise = (async () => {
      try {
        const { data, error } = await supabase
          .from('change_orders')
          .select('*')
          .eq('id', id)
          .maybeSingle()
        if (error || !data) return
        if (gen !== this._loadGeneration || uid !== this.currentUid) return
        const fresh = rowToChangeOrder(data as ChangeOrderRow)
        const idx = this.changeOrders.findIndex((c) => c.id === id)
        if (idx >= 0) {
          if (fresh.updatedAt < this.changeOrders[idx].updatedAt) return
          this.changeOrders = this.changeOrders.map((c) => (c.id === id ? fresh : c))
        } else {
          this.changeOrders = [fresh, ...this.changeOrders]
        }
        this.notify()
      } catch {
        // best-effort — the snapshot fallback covers a miss
      } finally {
        this.inFlightById.delete(id)
      }
    })()
    this.inFlightById.set(id, promise)
    return promise
  }

  private resetState(): void {
    this._initPromise = null
    this.currentUid = null
    this.changeOrders = []
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
    this.listeners.forEach((l) => l())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getAll(): ChangeOrder[] {
    return [...this.changeOrders]
  }

  getById(changeOrderId: string): ChangeOrder | undefined {
    return this.changeOrders.find((co) => co.id === changeOrderId)
  }

  getByJobId(jobId: string): ChangeOrder[] {
    return this.changeOrders
      .filter((co) => co.jobId === jobId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  getAcceptedByJobId(jobId: string): ChangeOrder | undefined {
    return this.changeOrders
      .filter((co) => co.jobId === jobId && co.status === 'accepted')
      .sort((a, b) => b.createdAt - a.createdAt)[0]
  }

  async add(changeOrder: ChangeOrder): Promise<void> {
    this.changeOrders = [changeOrder, ...this.changeOrders]
    this.notify()
    const { error } = await supabase
      .from('change_orders')
      .insert(changeOrderToRow(changeOrder))
    if (error) {
      this.changeOrders = this.changeOrders.filter((co) => co.id !== changeOrder.id)
      this.notify()
      logError('repository.changeOrders.add_failed', error, { entityId: changeOrder.id, jobId: changeOrder.jobId })
      recordPersistenceFailure({ domain: 'changeOrders', operation: 'add', entityId: changeOrder.id, error, occurredAt: Date.now() })
      throw error
    }
  }

  async update(changeOrderId: string, updater: (co: ChangeOrder) => ChangeOrder): Promise<void> {
    const previous = this.changeOrders.find((co) => co.id === changeOrderId)
    let updated: ChangeOrder | undefined
    this.changeOrders = this.changeOrders.map((co) => {
      if (co.id === changeOrderId) { updated = updater(co); return updated }
      return co
    })
    this.notify()
    if (updated) {
      const { error } = await supabase
        .from('change_orders')
        .update(changeOrderToRow(updated))
        .eq('id', changeOrderId)
      if (error) {
        if (previous) {
          this.changeOrders = this.changeOrders.map((co) =>
            co.id === changeOrderId ? previous : co
          )
          this.notify()
        }
        logError('repository.changeOrders.update_failed', error, { entityId: changeOrderId })
        recordPersistenceFailure({ domain: 'changeOrders', operation: 'update', entityId: changeOrderId, error, occurredAt: Date.now() })
        throw error
      }
    }
  }
}
