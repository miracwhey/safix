import { supabase } from '../../supabase'
import { recordPersistenceFailure, enqueuePendingMutation, hasPendingMutationForEntity, getPendingMutationOperation, getPendingMutations, isServerSideError, isDuplicateKeyError } from '../../persistence'
import { logError, logInfo } from '../../observability'
import type { TeamMember } from '../../jobs/types'
import type { TeamMemberRepository } from './TeamMemberRepository'

type Listener = () => void

/**
 * Shape of a `team_members` row as stored in the Supabase database.
 *
 * Actual schema (authoritative — see live DB):
 *   id           uuid        NOT NULL  DEFAULT gen_random_uuid()
 *   provider_id  uuid        NOT NULL
 *   profile_id   uuid        nullable
 *   full_name    text        NOT NULL              ← canonical name field
 *   role         text        NOT NULL  DEFAULT 'worker'
 *   is_active    boolean     NOT NULL  DEFAULT true
 *   created_at   timestamptz NOT NULL  DEFAULT now()
 *   updated_at   timestamptz NOT NULL  DEFAULT now()
 *   name         text        nullable              ← legacy column, ignored on read/write
 */
interface TeamMemberRow {
  id: string
  full_name: string
  /** Legacy nullable column — ignored on write, used as fallback on read only. */
  name?: string | null
  role: string
  profile_id: string | null
  provider_id: string | null
  is_active?: boolean | null
  phone?: string | null
  email?: string | null
  avatar_url?: string | null
  weekly_target_hours?: number | string | null
  daily_target_hours?: number | string | null
  created_at?: string | null
}

function toNumberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function rowToMember(row: TeamMemberRow): TeamMember {
  return {
    id: row.id,
    // full_name is the canonical column; fall back to legacy name only for
    // rows that predate the schema change (should not exist in practice).
    name: row.full_name ?? row.name ?? '',
    role: row.role ?? '',
    isActive: row.is_active === false ? false : true,
    phone:     row.phone ?? null,
    email:     row.email ?? null,
    avatarUrl: row.avatar_url ?? null,
    weeklyTargetHours: toNumberOrNull(row.weekly_target_hours),
    dailyTargetHours:  toNumberOrNull(row.daily_target_hours),
    ...(row.profile_id != null ? { userId: row.profile_id } : {}),
    ...(row.provider_id != null ? { providerId: row.provider_id } : {}),
  }
}

/**
 * Produces a full insert row for a new team member.
 * provider_id is populated from the caller's resolved provider so that
 * ownership-based RLS policies can scope reads and writes correctly.
 */
function memberToInsertRow(
  member: TeamMember,
  providerId: string | null,
): Omit<TeamMemberRow, 'name'> {
  return {
    id: member.id,
    full_name: member.name,
    role: member.role,
    profile_id: member.userId ?? null,
    provider_id: providerId,
  }
}

/**
 * Produces a partial update row that intentionally excludes provider_id.
 * provider_id is set at insert time and must not be overwritten to null on
 * subsequent updates.
 */
function memberToUpdateRow(member: TeamMember): Omit<TeamMemberRow, 'provider_id' | 'name'> {
  return {
    id: member.id,
    full_name: member.name,
    role: member.role,
    profile_id: member.userId ?? null,
  }
}

/**
 * Supabase-backed implementation of the TeamMemberRepository interface.
 *
 * Uses a local in-memory cache to serve synchronous reads, keeping the
 * reactive subscription model intact while all writes are also persisted
 * to the `team_members` table asynchronously (optimistic update).
 *
 * Write durability: add() and update() are queue-durable via
 * enqueuePendingMutation. update() uses a pre-flight guard: if a pending
 * INSERT exists for the member, the update is merged into the INSERT payload
 * so replay produces the correct final row.
 */
export class SupabaseTeamMemberRepository implements TeamMemberRepository {
  private members: TeamMember[] = []
  private authUnsubscribe: (() => void) | null = null
  private readonly listeners = new Set<Listener>()
  private _hydrated = false
  private currentUid: string | null = null
  /** Resolved provider.id for the current user. Populated during loadForUser(). */
  private currentProviderId: string | null = null
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
      if (generation !== this._loadGeneration) return
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

    // Resolve the provider.id for this user so ownership-linked reads and
    // writes target the correct provider row.  Uses profile_id (auth UID),
    // not providers.id, which is the DB PK.
    const { data: providerRow } = await supabase
      .from('providers')
      .select('id')
      .eq('profile_id', uid)
      .maybeSingle()
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    this.currentProviderId = providerRow?.id ?? null

    const providerId = this.currentProviderId

    // Load team members owned by this provider or directly linked to this user.
    // userId and providerId are both UUIDs from trusted Supabase sources, so
    // .or() string interpolation is safe and avoids a second round-trip.
    const orFilter = providerId
      ? `profile_id.eq.${uid},provider_id.eq.${providerId}`
      : `profile_id.eq.${uid}`
    const { data, error } = await supabase
      .from('team_members')
      .select('*')
      .or(orFilter)
      .order('created_at', { ascending: false })
      .limit(100)
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    if (error) throw error
    const rows = (data ?? []) as TeamMemberRow[]

    this.members = rows.map(rowToMember)
    this.hydrateFromQueue(uid)
    this.notify()
  }

  private resetState(): void {
    this._initPromise = null
    this.currentUid = null
    this.currentProviderId = null
    this.members = []
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

  private notify(): void {
    this.listeners.forEach((l) => l())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): TeamMember[] {
    return [...this.members]
  }

  getById(id: string): TeamMember | undefined {
    return this.members.find((m) => m.id === id)
  }

  getByUserId(userId: string): TeamMember | undefined {
    return this.members.find((m) => m.userId === userId)
  }

  private hydrateFromQueue(uid: string): void {
    const pending = getPendingMutations()
    for (const m of pending) {
      if (m.table !== 'team_members' || m.operation !== 'insert') continue
      if (m.userId && m.userId !== uid) continue
      if (this.members.some((mbr) => mbr.id === m.entityId)) continue
      try {
        const member = rowToMember(m.payload as unknown as TeamMemberRow)
        this.members = [member, ...this.members]
      } catch { /* malformed payload */ }
    }
  }

  add(member: TeamMember): void {
    this.members = [...this.members, member]
    this.notify()

    // Pending guard: if a prior add() for this member already failed and is
    // queued for replay, skip the write — the queue covers it.
    if (hasPendingMutationForEntity('team_members', member.id)) {
      logInfo('repository.team.add_skipped_pending', { entityId: member.id })
      return
    }

    // Capture providerId synchronously before the async callback — currentProviderId
    // is set during loadForUser() and stable for the session lifetime.
    const providerId = this.currentProviderId
    supabase
      .from('team_members')
      .insert(memberToInsertRow(member, providerId))
      .then(({ error }) => {
        if (error) {
          if (isServerSideError(error)) {
            this.members = this.members.filter((m) => m.id !== member.id)
            this.notify()
            if (isDuplicateKeyError(error)) {
              void supabase.from('team_members').select('*').eq('id', member.id).single().then(({ data }) => {
                if (data) {
                  this.members = [rowToMember(data as TeamMemberRow), ...this.members]
                  this.notify()
                }
              })
              return
            }
            logError('repository.team.add_failed', error, { entityId: member.id })
            recordPersistenceFailure({ domain: 'team', operation: 'add', entityId: member.id, error, occurredAt: Date.now() })
            return
          }
          logError('repository.team.add_failed', error, { entityId: member.id })
          recordPersistenceFailure({
            domain: 'team',
            operation: 'add',
            entityId: member.id,
            error,
            occurredAt: Date.now(),
          })
          enqueuePendingMutation({
            operation: 'insert',
            table: 'team_members',
            payload: memberToInsertRow(member, providerId) as unknown as Record<string, unknown>,
            domain: 'team',
            entityId: member.id,
          })
        }
      })
  }

  update(memberId: string, updater: (m: TeamMember) => TeamMember): void {
    this.members = this.members.map((m) => (m.id === memberId ? updater(m) : m))
    this.notify()
    const updated = this.members.find((m) => m.id === memberId)
    if (updated) {
      // Pre-flight guard: if a pending mutation exists, the DB may not have
      // the current row yet (pending INSERT) or a previous update already failed
      // (pending UPDATE). In both cases skip the live DB call and merge the latest
      // state into the queued payload.
      //
      // Why distinguish INSERT vs UPDATE:
      // - INSERT payload must include provider_id (required NOT NULL FK for RLS).
      //   Using memberToInsertRow() ensures the correct full row is replayed.
      // - UPDATE payload intentionally excludes provider_id to avoid nulling it.
      //   Passing operation='insert' to enqueuePendingMutation when a pending UPDATE
      //   exists would corrupt the operation type (dedup logic: existing UPDATE →
      //   mutation.operation wins → stored as INSERT, which fails INSERT RLS for
      //   worker-owned rows that already exist).
      const pendingOp = getPendingMutationOperation('team_members', memberId)
      if (pendingOp !== undefined) {
        if (pendingOp === 'insert') {
          const providerId = this.currentProviderId
          enqueuePendingMutation({
            operation: 'insert',
            table: 'team_members',
            payload: memberToInsertRow(updated, providerId) as unknown as Record<string, unknown>,
            domain: 'team',
            entityId: memberId,
          })
        } else {
          // pending UPDATE: keep UPDATE semantics, use partial row (no provider_id)
          enqueuePendingMutation({
            operation: 'update',
            table: 'team_members',
            payload: memberToUpdateRow(updated) as unknown as Record<string, unknown>,
            domain: 'team',
            entityId: memberId,
          })
        }
        return
      }

      supabase
        .from('team_members')
        .update(memberToUpdateRow(updated))
        .eq('id', memberId)
        .then(({ error }) => {
          if (error) {
            logError('repository.team.update_failed', error, { entityId: memberId })
            recordPersistenceFailure({
              domain: 'team',
              operation: 'update',
              entityId: memberId,
              error,
              occurredAt: Date.now(),
            })
            enqueuePendingMutation({
              operation: 'update',
              table: 'team_members',
              payload: memberToUpdateRow(updated) as unknown as Record<string, unknown>,
              domain: 'team',
              entityId: memberId,
            })
          }
        })
    }
  }

  reset(): void {
    this.resetState()
  }

  prepareForResync(): void {
    this._initPromise = null
    this._loadGeneration++
  }
}
