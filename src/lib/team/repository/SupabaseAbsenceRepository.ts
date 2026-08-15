import { supabase } from '../../supabase'
import { logBreadcrumb, logError, logInfo, logWarning } from '../../observability'
import type { Absence, AbsenceStatus, AbsenceType } from '../absenceTypes'
import {
  AbsenceNotFoundError,
  type AbsenceCreateInput,
  type AbsenceRepository,
  type AbsenceUpdatePatch,
} from './AbsenceRepository'

type Listener = () => void

interface AbsenceRow {
  id: string
  provider_id: string
  member_id: string
  type: AbsenceType
  start_date: string
  end_date: string
  reason_note: string | null
  status: AbsenceStatus
  sick_note_requested: boolean
  sick_note_requested_at: string | null
  sick_note_url: string | null
  sick_note_submitted_at: string | null
  created_at: string
  updated_at: string
  cancelled_at: string | null
}

function rowToAbsence(row: AbsenceRow): Absence {
  return {
    id: row.id,
    providerId: row.provider_id,
    memberId: row.member_id,
    type: row.type,
    startDate: row.start_date,
    endDate: row.end_date,
    reasonNote: row.reason_note,
    status: row.status,
    sickNoteRequested: row.sick_note_requested,
    sickNoteRequestedAt: row.sick_note_requested_at,
    sickNoteUrl: row.sick_note_url,
    sickNoteSubmittedAt: row.sick_note_submitted_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * How far back to hydrate cancelled rows on initial load. Active rows are
 * always loaded (they drive the live roster), but the worker history view
 * only needs a bounded slice of cancelled rows.
 */
const HYDRATION_WINDOW_DAYS = 90

export class SupabaseAbsenceRepository implements AbsenceRepository {
  private absences: Absence[] = []
  private readonly listeners = new Set<Listener>()
  private _hydrated = false
  private _initPromise: Promise<void> | null = null
  private _loadGeneration = 0
  private currentUid: string | null = null
  private authUnsubscribe: (() => void) | null = null
  private realtimeChannel: ReturnType<typeof supabase.channel> | null = null
  private realtimeGeneration = 0
  private isRealtimeConnected = false
  private reconnectAttempts = 0
  private readonly MAX_RECONNECT_ATTEMPTS = 5
  private readonly RECONNECT_DELAY = 3000

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
      if (generation !== this._loadGeneration) return
      this._hydrated = true
      this.notify()
      this.ensureAuthListener()
      this.startRealtimeSubscription(session.user.id)
    })()
    this._initPromise = p
    void p.then(
      () => {
        if (this._initPromise === p) this._initPromise = null
      },
      () => {
        if (this._initPromise === p) this._initPromise = null
      },
    )
    return p
  }

  isHydrated(): boolean {
    return this._hydrated
  }

  private async loadForUser(uid: string, generationSnapshot: number): Promise<void> {
    this.currentUid = uid
    const sinceDate = new Date(Date.now() - HYDRATION_WINDOW_DAYS * 86400_000)
    const sinceKey = sinceDate.toISOString().slice(0, 10)
    const { data, error } = await supabase
      .from('absences')
      .select('*')
      .or(`status.eq.active,end_date.gte.${sinceKey}`)
      .order('start_date', { ascending: false })
      .limit(500)
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    if (error) {
      logError('repository.absences.load_failed', error, { uid })
      throw error
    }
    const rows = (data ?? []) as AbsenceRow[]
    this.absences = rows.map(rowToAbsence)
    this.notify()
  }

  private resetState(): void {
    this._initPromise = null
    // Reset hydration flag so consumers see the loading state while
    // re-initialization completes after sign-out or reset.
    this._hydrated = false
    this.realtimeGeneration++
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
      this.realtimeChannel = null
    }
    this.isRealtimeConnected = false
    this.reconnectAttempts = 0
    this.currentUid = null
    this.absences = []
    this.notify()
  }

  private ensureAuthListener(): void {
    if (this.authUnsubscribe) return
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      const uid = session?.user?.id
      if (
        (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') &&
        uid &&
        (uid !== this.currentUid || !this._hydrated)
      ) {
        const gen = ++this._loadGeneration
        void this.loadForUser(uid, gen)
          .then(() => {
            if (gen !== this._loadGeneration) return
            if (!this._hydrated) {
              this._hydrated = true
              this.notify()
            }
            this.startRealtimeSubscription(uid)
          })
          .catch((err) => {
            logError('repository.absences.reload_failed', err, { uid })
          })
      }
      if (event === 'SIGNED_OUT') {
        this.resetState()
      }
    })
    this.authUnsubscribe = subscription?.unsubscribe
      ? subscription.unsubscribe.bind(subscription)
      : null
  }

  private startRealtimeSubscription(uid: string, fromReconnection = false): void {
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
    }
    const generation = ++this.realtimeGeneration
    this.realtimeChannel = supabase
      .channel(`fixup-absences-${uid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'absences' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as AbsenceRow
          if (this.absences.some((a) => a.id === row.id)) return
          this.absences = [rowToAbsence(row), ...this.absences]
          this.notify()
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'absences' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as AbsenceRow
          const exists = this.absences.some((a) => a.id === row.id)
          if (exists) {
            this.absences = this.absences.map((a) => (a.id === row.id ? rowToAbsence(row) : a))
          } else {
            this.absences = [rowToAbsence(row), ...this.absences]
          }
          this.notify()
        },
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'absences' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.old as Partial<AbsenceRow>
          if (!row.id) return
          this.absences = this.absences.filter((a) => a.id !== row.id)
          this.notify()
        },
      )
      .subscribe((status) => {
        if (generation !== this.realtimeGeneration) return
        if (status === 'SUBSCRIBED') {
          this.isRealtimeConnected = true
          this.reconnectAttempts = 0
          logInfo('repository.absences.realtime_subscribed', { uid })
          if (fromReconnection) void this.fallbackRefresh(uid)
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.isRealtimeConnected = false
          logBreadcrumb(
            'repository.absences.realtime_disconnected',
            'warning',
            { uid, status },
          )
          void this.fallbackRefresh(uid)
          this.attemptReconnection(uid)
        }
      })
  }

  private async fallbackRefresh(uid: string): Promise<void> {
    try {
      const generation = ++this._loadGeneration
      await this.loadForUser(uid, generation)
      // Guarantee hydration after a successful fallback load. initialize()
      // may have returned early (generation mismatch) before setting
      // _hydrated — fallbackRefresh is the recovery path that fills that gap.
      if (generation === this._loadGeneration && !this._hydrated) {
        this._hydrated = true
        this.notify()
      }
      logInfo('repository.absences.fallback_refresh_completed', { uid })
    } catch (error) {
      logError('repository.absences.fallback_refresh_error', error as Error, { uid })
    }
  }

  private attemptReconnection(uid: string): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logWarning(
        'repository.absences.realtime_reconnect_exhausted',
        { uid, attempts: this.reconnectAttempts },
      )
      return
    }
    this.reconnectAttempts++
    logInfo('repository.absences.realtime_reconnect_attempt', {
      uid,
      attempt: this.reconnectAttempts,
      maxAttempts: this.MAX_RECONNECT_ATTEMPTS,
    })
    setTimeout(() => {
      if (!this.isRealtimeConnected && this.currentUid === uid) {
        this.startRealtimeSubscription(uid, true)
      }
    }, this.RECONNECT_DELAY * this.reconnectAttempts)
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

  private notify(): void {
    this.listeners.forEach((l) => l())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): Absence[] {
    return [...this.absences]
  }

  getById(id: string): Absence | undefined {
    return this.absences.find((a) => a.id === id)
  }

  async create(input: AbsenceCreateInput): Promise<Absence> {
    const insertRow = {
      provider_id: input.providerId,
      member_id: input.memberId,
      type: input.type,
      start_date: input.startDate,
      end_date: input.endDate,
      reason_note: input.reasonNote ?? null,
      status: 'active' as const,
    }

    const { data, error } = await supabase
      .from('absences')
      .insert(insertRow)
      .select()
      .single()

    if (error) {
      logError('repository.absences.create_failed', error, {
        memberId: input.memberId,
        type: input.type,
      })
      throw error
    }

    const absence = rowToAbsence(data as AbsenceRow)
    if (!this.absences.some((a) => a.id === absence.id)) {
      this.absences = [absence, ...this.absences]
      this.notify()
    }
    return absence
  }

  async update(id: string, patch: AbsenceUpdatePatch): Promise<Absence> {
    const updateRow: Record<string, unknown> = {}
    if (patch.status !== undefined) updateRow.status = patch.status
    if (patch.cancelledAt !== undefined) updateRow.cancelled_at = patch.cancelledAt
    if (patch.sickNoteRequested !== undefined) updateRow.sick_note_requested = patch.sickNoteRequested
    if (patch.sickNoteRequestedAt !== undefined)
      updateRow.sick_note_requested_at = patch.sickNoteRequestedAt
    if (patch.sickNoteUrl !== undefined) updateRow.sick_note_url = patch.sickNoteUrl
    if (patch.sickNoteSubmittedAt !== undefined)
      updateRow.sick_note_submitted_at = patch.sickNoteSubmittedAt

    const { data, error } = await supabase
      .from('absences')
      .update(updateRow)
      .eq('id', id)
      .select()
      .maybeSingle()

    if (error) {
      logError('repository.absences.update_failed', error, { id })
      throw error
    }
    if (!data) {
      throw new AbsenceNotFoundError(id)
    }
    const absence = rowToAbsence(data as AbsenceRow)
    this.absences = this.absences.map((a) => (a.id === id ? absence : a))
    this.notify()
    return absence
  }

  reset(): void {
    this.resetState()
  }

  prepareForResync(): void {
    this._initPromise = null
    this._loadGeneration++
  }
}
