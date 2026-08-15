import { supabase } from '../../supabase'
import { recordPersistenceFailure } from '../../persistence'
import { logError } from '../../observability'
import type { Acceptance, AcceptanceStatus } from '../types'
import type { AcceptanceRepository } from './AcceptanceRepository'

type Listener = () => void

interface AcceptanceRow {
  id: string
  job_id: string
  payment_id: string | null
  source_offer_id: string | null
  customer_user_id: string
  status: string
  accepted_at: number | null
  expires_at: number | null
  notes: string | null
  reminders_sent: Record<string, boolean> | null
  created_at: number
  updated_at: number
}

function normalizeRemindersSent(
  raw: Record<string, boolean> | null | undefined,
): Record<string, boolean> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === true) out[key] = true
  }
  return out
}

function rowToAcceptance(row: AcceptanceRow): Acceptance {
  return {
    id: row.id,
    jobId: row.job_id,
    customerUserId: row.customer_user_id,
    status: row.status as AcceptanceStatus,
    remindersSent: normalizeRemindersSent(row.reminders_sent),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.payment_id != null && { paymentId: row.payment_id }),
    ...(row.source_offer_id != null && { sourceOfferId: row.source_offer_id }),
    ...(row.accepted_at != null && { acceptedAt: row.accepted_at }),
    ...(row.expires_at != null && { expiresAt: row.expires_at }),
    ...(row.notes != null && { notes: row.notes }),
  }
}

function acceptanceToRow(a: Acceptance): AcceptanceRow {
  return {
    id: a.id,
    job_id: a.jobId,
    payment_id: a.paymentId ?? null,
    source_offer_id: a.sourceOfferId ?? null,
    customer_user_id: a.customerUserId,
    status: a.status,
    accepted_at: a.acceptedAt ?? null,
    expires_at: a.expiresAt ?? null,
    notes: a.notes ?? null,
    reminders_sent: a.remindersSent ?? {},
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  }
}

/**
 * Supabase-backed AcceptanceRepository.
 *
 * Read scope: only acceptances where customer_user_id = current user OR
 * craftsman who owns the job (resolved via RLS on the acceptances table).
 * See migration 20260411000003_acceptances_table.sql.
 */
export class SupabaseAcceptanceRepository implements AcceptanceRepository {
  private acceptances: Acceptance[] = []
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
      .from('acceptances')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) throw error
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    this.acceptances = ((data ?? []) as AcceptanceRow[]).map(rowToAcceptance)
    this.notify()
  }

  private resetState(): void {
    this._initPromise = null
    this.currentUid = null
    this.acceptances = []
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

  getAll(): Acceptance[] {
    return [...this.acceptances]
  }

  getById(acceptanceId: string): Acceptance | undefined {
    return this.acceptances.find((a) => a.id === acceptanceId)
  }

  getByJobId(jobId: string): Acceptance | undefined {
    return this.acceptances.find((a) => a.jobId === jobId)
  }

  getExpiredPending(nowMs: number): Acceptance[] {
    return this.acceptances.filter(
      (a) => a.status === 'pending' && a.expiresAt != null && a.expiresAt <= nowMs
    )
  }

  async add(acceptance: Acceptance): Promise<void> {
    this.acceptances = [acceptance, ...this.acceptances]
    this.notify()
    const { error } = await supabase
      .from('acceptances')
      .insert(acceptanceToRow(acceptance))
    if (error) {
      this.acceptances = this.acceptances.filter((a) => a.id !== acceptance.id)
      this.notify()
      logError('repository.acceptances.add_failed', error, { entityId: acceptance.id, jobId: acceptance.jobId })
      recordPersistenceFailure({ domain: 'acceptances', operation: 'add', entityId: acceptance.id, error, occurredAt: Date.now() })
      throw error
    }
  }

  async update(acceptanceId: string, updater: (a: Acceptance) => Acceptance): Promise<void> {
    const previous = this.acceptances.find((a) => a.id === acceptanceId)
    let updated: Acceptance | undefined
    this.acceptances = this.acceptances.map((a) => {
      if (a.id === acceptanceId) { updated = updater(a); return updated }
      return a
    })
    this.notify()
    if (updated) {
      const { error } = await supabase
        .from('acceptances')
        .update(acceptanceToRow(updated))
        .eq('id', acceptanceId)
      if (error) {
        if (previous) {
          this.acceptances = this.acceptances.map((a) => a.id === acceptanceId ? previous : a)
          this.notify()
        }
        logError('repository.acceptances.update_failed', error, { entityId: acceptanceId })
        recordPersistenceFailure({ domain: 'acceptances', operation: 'update', entityId: acceptanceId, error, occurredAt: Date.now() })
        throw error
      }
    }
  }
}
