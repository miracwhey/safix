import { supabase } from '../../supabase'
import { recordPersistenceFailure } from '../../persistence'
import { logError } from '../../observability'
import type {
  CorrectionApplySkipReason,
  CorrectionKind,
  CorrectionRequest,
  CorrectionStatus,
} from '../types'
import type { CorrectionRepository } from './CorrectionRepository'

type Listener = () => void

interface CorrectionRow {
  id: string
  provider_id: string
  worker_team_member_id: string
  worker_profile_id: string
  calendar_entry_id: string | null
  requested_date: string | null
  kind: string
  description: string
  status: string
  owner_note: string | null
  // Block 7.2.3 — strukturierte Korrektur-Felder
  field: string | null
  current_value: string | null
  proposed_value: string | null
  reason: string | null
  // Block 7.2.7b — Auto-Apply-Trace (nullable, von approveCorrectionWorkflow gesetzt)
  applied_at: number | null
  applied_target_entry_id: string | null
  apply_skip_reason: string | null
  created_at: number
  updated_at: number
}

export function rowToRequest(row: CorrectionRow): CorrectionRequest {
  return {
    id: row.id,
    providerId: row.provider_id,
    workerTeamMemberId: row.worker_team_member_id,
    workerProfileId: row.worker_profile_id,
    kind: row.kind as CorrectionKind,
    description: row.description,
    status: row.status as CorrectionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.calendar_entry_id != null && { calendarEntryId: row.calendar_entry_id }),
    ...(row.requested_date != null && { requestedDate: row.requested_date }),
    ...(row.owner_note != null && { ownerNote: row.owner_note }),
    ...(row.field != null && { field: row.field }),
    ...(row.current_value != null && { currentValue: row.current_value }),
    ...(row.proposed_value != null && { proposedValue: row.proposed_value }),
    ...(row.reason != null && { reason: row.reason }),
    ...(row.applied_at != null && { appliedAt: row.applied_at }),
    ...(row.applied_target_entry_id != null && {
      appliedTargetEntryId: row.applied_target_entry_id,
    }),
    ...(row.apply_skip_reason != null && {
      applySkipReason: row.apply_skip_reason as CorrectionApplySkipReason,
    }),
  }
}

export function requestToRow(r: CorrectionRequest): CorrectionRow {
  return {
    id: r.id,
    provider_id: r.providerId,
    worker_team_member_id: r.workerTeamMemberId,
    worker_profile_id: r.workerProfileId,
    calendar_entry_id: r.calendarEntryId ?? null,
    requested_date: r.requestedDate ?? null,
    kind: r.kind,
    description: r.description,
    status: r.status,
    owner_note: r.ownerNote ?? null,
    field: r.field ?? null,
    current_value: r.currentValue ?? null,
    proposed_value: r.proposedValue ?? null,
    reason: r.reason ?? null,
    applied_at: r.appliedAt ?? null,
    applied_target_entry_id: r.appliedTargetEntryId ?? null,
    apply_skip_reason: r.applySkipReason ?? null,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  }
}

/**
 * Supabase-backed CorrectionRepository.
 *
 * RLS at the DB level enforces visibility:
 *   - Workers see only their own requests (worker_profile_id = auth.uid())
 *   - Owners see all requests for their company (provider_id in owned providers)
 *
 * Optimistic updates + rollback on persistence failure.
 */
export class SupabaseCorrectionRepository implements CorrectionRepository {
  private requests: CorrectionRequest[] = []
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
      .from('correction_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) throw error
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    this.requests = ((data ?? []) as CorrectionRow[]).map(rowToRequest)
    this.notify()
  }

  private resetState(): void {
    this._initPromise = null
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
    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): CorrectionRequest[] {
    return [...this.requests]
  }

  getById(id: string): CorrectionRequest | undefined {
    return this.requests.find((r) => r.id === id)
  }

  async add(request: CorrectionRequest): Promise<void> {
    this.requests = [request, ...this.requests]
    this.notify()
    const { error } = await supabase
      .from('correction_requests')
      .insert(requestToRow(request))
    if (error) {
      this.requests = this.requests.filter((r) => r.id !== request.id)
      this.notify()
      logError('repository.corrections.add_failed', error, { entityId: request.id })
      recordPersistenceFailure({
        domain: 'corrections',
        operation: 'add',
        entityId: request.id,
        error,
        occurredAt: Date.now(),
      })
      throw error
    }
  }

  async update(
    id: string,
    updater: (r: CorrectionRequest) => CorrectionRequest,
  ): Promise<void> {
    const previous = this.requests.find((r) => r.id === id)
    let updated: CorrectionRequest | undefined
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
        .from('correction_requests')
        .update(requestToRow(updated))
        .eq('id', id)
      if (error) {
        if (previous) {
          this.requests = this.requests.map((r) => (r.id === id ? previous : r))
          this.notify()
        }
        logError('repository.corrections.update_failed', error, { entityId: id })
        recordPersistenceFailure({
          domain: 'corrections',
          operation: 'update',
          entityId: id,
          error,
          occurredAt: Date.now(),
        })
        throw error
      }
    }
  }
}
