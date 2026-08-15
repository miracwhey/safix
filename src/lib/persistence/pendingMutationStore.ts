export interface PendingMutation {
  id: string
  /** 'insert' → replay via upsert; 'update' → replay via update().eq('id',...) */
  operation: 'insert' | 'update'
  table: string
  payload: Record<string, unknown>
  domain: string
  entityId: string
  /**
   * Supabase user ID that enqueued the mutation. Set at enqueue time via
   * setActiveMutationUser(). Undefined for legacy entries that pre-date
   * user scoping — treated as belonging to the current user on replay.
   */
  userId?: string
  enqueuedAt: number
  retryCount: number
}

const STORAGE_KEY = 'fixup.pending_mutations.v1'
const SCHEMA_VERSION_KEY = 'fixup.pending_mutations.schema_version'

/**
 * Bump this when a build introduces semantics that change how queued
 * mutations should be handled — kind classification, retry policy,
 * payload shape.  On first start after a bump, mutations older than
 * `PRE_BUMP_STALE_THRESHOLD_MS` are purged so a test device or a
 * rollout doesn't carry forward an orphan queue that fails forever
 * under the new logic.
 *
 * Versions:
 *   0 (implicit) → original store, pre kind-classification block.
 *   1            → introduces kind tagging + isServerSideError-guard
 *                  on Calendar.replace().  Stale orphans queued by
 *                  the old replace() path can never replay cleanly,
 *                  so they are purged on first boot under v1.
 *   2            → calendar entries now use job.id (plain UUID) as their
 *                  DB primary key instead of the old "cal_<jobId>" prefix.
 *                  Any queued calendar mutations with a "cal_"-prefixed
 *                  entityId can never succeed (Postgres uuid column rejects
 *                  the non-UUID string) and are purged on first boot under v2.
 *   3            → invoices now use job.id (plain UUID) as their DB primary
 *                  key instead of the old "inv_<jobId>" prefix.  Queued
 *                  invoices/draft mutations with an "inv_"-prefixed entityId
 *                  always fail with 22P02 and are purged on first boot under v3.
 *   4            → schedules and timeline_signals now use generateUUID() as
 *                  their DB primary key instead of the old "schedule-<jobId>-…"
 *                  and "timeline-<jobId>-…" prefixes.  Queued mutations with
 *                  those entityId prefixes always fail with 22P02 and are
 *                  purged on first boot under v4.
 */
const CURRENT_SCHEMA_VERSION = 4

/**
 * Mutations older than this are dropped during the one-time migration
 * (NOT during normal pruning).  One hour is short enough to clear genuine
 * orphans while preserving in-flight offline writes a user genuinely made
 * just before the upgrade.
 */
const PRE_BUMP_STALE_THRESHOLD_MS = 60 * 60 * 1000

/**
 * Maximum age (ms) a pending mutation may live in the queue before
 * `prunePendingMutations()` removes it.
 *
 * Why 7 days:
 *   - Long enough to survive a vacation / weekend offline window.
 *   - Short enough to break the "stale orphan" loop where a mutation that
 *     can never replay (cross-account leftover, schema-drift after a
 *     deploy, RLS rule change) keeps re-failing every resume and
 *     re-escalating the SyncStatusBar after 15 s.
 *
 * The prune path records each removed mutation as a permanent failure
 * before deletion so the user/observability still sees what was lost —
 * never silent.
 */
export const MAX_PENDING_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Snapshot fields exposed for diagnostics (logging, Sentry breadcrumbs).
 *
 * Intentionally excludes `payload` and `id` — the payload may carry
 * sensitive / domain data and the synthetic id is not useful for triage.
 * Everything that helps explain why a mutation is stuck is included.
 */
export interface PendingMutationSnapshot {
  domain: string
  table: string
  entityId: string
  operation: 'insert' | 'update'
  userId: string | null
  retryCount: number
  enqueuedAt: number
  ageMs: number
}

// Set by session.ts on every auth event so new mutations are tagged with
// the current user's uid. Cleared to null on sign-out.
let activeUserId: string | null = null

/** Call from session auth listeners to keep mutation ownership current. */
export function setActiveMutationUser(uid: string | null): void {
  activeUserId = uid
}

function load(): PendingMutation[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as PendingMutation[]
  } catch {
    return []
  }
}

function persist(mutations: PendingMutation[]): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mutations))
  } catch {
    // Storage quota or private-browsing — accept the loss gracefully
  }
}

/**
 * Enqueues a pending mutation for background replay.
 *
 * Deduplication: if a mutation for the same (table, entityId) already exists,
 * the payload is replaced with the newer value and retryCount is reset to 0.
 * A new id is generated so any in-flight flush holding the old id cannot
 * accidentally remove this updated entry when it calls removePendingMutation.
 *
 * Operation preservation: if the existing mutation is 'insert' (the row has
 * never been persisted), subsequent updates keep the operation as 'insert'.
 * Replaying as 'update' against a non-existent row would silently succeed
 * with zero affected rows, permanently losing the offline-created entity.
 *
 * User scoping: each mutation is tagged with the currently active user id so
 * the flush path can skip mutations that belong to a different user.
 */
export function enqueuePendingMutation(
  mutation: Omit<PendingMutation, 'id' | 'enqueuedAt' | 'retryCount' | 'userId'>,
): void {
  const mutations = load()
  const idx = mutations.findIndex(
    (m) => m.table === mutation.table && m.entityId === mutation.entityId,
  )
  if (idx >= 0) {
    // Preserve 'insert': an offline-created row that was never persisted must
    // still be inserted even if subsequent local edits arrive as 'update'.
    const operation: PendingMutation['operation'] =
      mutations[idx].operation === 'insert' ? 'insert' : mutation.operation
    mutations[idx] = {
      id: `${mutation.table}_${mutation.entityId}_${Date.now()}`,
      operation,
      table: mutations[idx].table,
      domain: mutations[idx].domain,
      entityId: mutations[idx].entityId,
      userId: activeUserId ?? undefined,
      payload: mutation.payload,
      enqueuedAt: Date.now(),
      retryCount: 0,
    }
  } else {
    mutations.push({
      id: `${mutation.table}_${mutation.entityId}_${Date.now()}`,
      ...mutation,
      userId: activeUserId ?? undefined,
      enqueuedAt: Date.now(),
      retryCount: 0,
    })
  }
  persist(mutations)
}

export function getPendingMutations(): PendingMutation[] {
  return load()
}

export function removePendingMutation(id: string): void {
  persist(load().filter((m) => m.id !== id))
}

export function incrementRetryCount(id: string): void {
  persist(
    load().map((m) => (m.id === id ? { ...m, retryCount: m.retryCount + 1 } : m)),
  )
}

export function hasPendingMutations(): boolean {
  return load().length > 0
}

/**
 * Returns true when there is already a pending mutation for the given
 * (table, entityId) pair. Used by repository add() paths to avoid firing
 * a second Supabase write for an entity that is already queued for replay.
 */
export function hasPendingMutationForEntity(table: string, entityId: string): boolean {
  return load().some((m) => m.table === table && m.entityId === entityId)
}

/**
 * Returns the operation type of the pending mutation for a given (table, entityId)
 * pair, or undefined if no mutation is queued.
 *
 * Required when a write path must distinguish between a pending INSERT (row does
 * not exist yet — UPDATE would silently no-op) and a pending UPDATE (row exists
 * but a previous write failed). Using the wrong payload shape on merge can break
 * RLS (e.g. inserting without provider_id) or corrupt the row.
 */
export function getPendingMutationOperation(
  table: string,
  entityId: string,
): PendingMutation['operation'] | undefined {
  return load().find((m) => m.table === table && m.entityId === entityId)?.operation
}

/**
 * Returns true only when there is at least one pending mutation that belongs
 * to the currently active user (or has no userId — legacy entries).
 *
 * Use this in foreground/resume handlers where activeUserId is already set so
 * that only-foreign-user queue entries don't trigger a pointless flush.
 * Falls back to hasPendingMutations() when no active user is known.
 */
export function hasPendingMutationsForCurrentUser(): boolean {
  if (!activeUserId) return hasPendingMutations()
  return load().some((m) => !m.userId || m.userId === activeUserId)
}

export function clearPendingMutations(): void {
  persist([])
}

/**
 * Removes pending mutations whose age exceeds `MAX_PENDING_AGE_MS`.
 *
 * Returns the removed entries so the caller can surface them as permanent
 * failures (the persistence error store is the canonical record of what was
 * lost).  Never silent: every prune writes the count + sample to the log.
 *
 * Called from `flushPendingMutations` before any replay attempt so a stale
 * orphan can't sit through MAX_RETRIES network round-trips just to be
 * dropped at the end.
 */
export function prunePendingMutations(now: number = Date.now()): PendingMutation[] {
  const all = load()
  const fresh: PendingMutation[] = []
  const stale: PendingMutation[] = []
  for (const m of all) {
    if (now - m.enqueuedAt > MAX_PENDING_AGE_MS) {
      stale.push(m)
    } else {
      fresh.push(m)
    }
  }
  if (stale.length > 0) {
    persist(fresh)
  }
  return stale
}

/**
 * Returns a sanitized snapshot of every queued mutation — no payload, no
 * synthetic id — for logging / Sentry breadcrumbs.  Intended for both
 * production telemetry (kind / age / retry visibility on real iPhones)
 * and dev-only diagnostics, never for UI rendering of domain content.
 */
export function getPendingMutationsSnapshot(now: number = Date.now()): PendingMutationSnapshot[] {
  return load().map((m) => ({
    domain: m.domain,
    table: m.table,
    entityId: m.entityId,
    operation: m.operation,
    userId: m.userId ?? null,
    retryCount: m.retryCount,
    enqueuedAt: m.enqueuedAt,
    ageMs: now - m.enqueuedAt,
  }))
}

function readStoredSchemaVersion(): number {
  try {
    if (typeof localStorage === 'undefined') return CURRENT_SCHEMA_VERSION
    const raw = localStorage.getItem(SCHEMA_VERSION_KEY)
    if (!raw) return 0
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

function writeStoredSchemaVersion(v: number): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(SCHEMA_VERSION_KEY, String(v))
  } catch {
    /* private mode / quota — best effort */
  }
}

/**
 * One-time migration triggered when the stored schema version trails
 * `CURRENT_SCHEMA_VERSION`.  Applies each version step in sequence so
 * devices that skipped intermediate releases still converge correctly.
 *
 * Returns the purged mutations so the caller (flushPendingMutations)
 * can surface them as permanent failures with a clear log breadcrumb.
 *
 * Idempotent: once the schema version is bumped, subsequent calls
 * detect the match and return [].
 *
 * v0→v1: purge mutations older than PRE_BUMP_STALE_THRESHOLD_MS
 *        (stale orphans from the pre-kind-classification era).
 * v1→v2: purge calendar mutations whose entityId starts with "cal_"
 *        (generated by the old cal_<jobId> scheme; the Postgres uuid
 *        column rejects them with 22P02 and they can never replay).
 * v2→v3: purge invoices/draft mutations whose entityId starts with "inv_"
 *        (generated by the old inv_<jobId> scheme; same 22P02 rejection).
 * v3→v4: purge schedules/timeline mutations whose entityId starts with
 *        "schedule-" or "timeline-" (produced by the old string-template
 *        scheme; Postgres uuid column rejects them with 22P02).
 */
export function migratePendingMutationsIfNeeded(
  now: number = Date.now(),
): PendingMutation[] {
  const stored = readStoredSchemaVersion()
  if (stored >= CURRENT_SCHEMA_VERSION) return []

  let all = load()
  const purged: PendingMutation[] = []

  // v0 → v1: time-based orphan prune
  if (stored < 1) {
    const stale = all.filter((m) => now - m.enqueuedAt > PRE_BUMP_STALE_THRESHOLD_MS)
    purged.push(...stale)
    all = all.filter((m) => now - m.enqueuedAt <= PRE_BUMP_STALE_THRESHOLD_MS)
  }

  // v1 → v2: purge invalid-UUID calendar mutations
  // "cal_"-prefixed entityIds were produced by the old calendarEngine before
  // calendar entries switched to using job.id (a proper UUID) as their DB PK.
  // These writes always fail with Postgres 22P02 and must not be retried.
  if (stored < 2) {
    const invalid = all.filter(
      (m) => m.domain === 'calendar' && m.entityId.startsWith('cal_'),
    )
    purged.push(...invalid)
    all = all.filter(
      (m) => !(m.domain === 'calendar' && m.entityId.startsWith('cal_')),
    )
  }

  // v2 → v3: purge invalid-UUID invoice mutations
  // "inv_"-prefixed entityIds were produced by the old invoiceEngine before
  // invoices switched to using job.id (a proper UUID) as their DB PK.
  // These writes always fail with Postgres 22P02 and must not be retried.
  if (stored < 3) {
    const invalid = all.filter(
      (m) => m.domain === 'invoices/draft' && m.entityId.startsWith('inv_'),
    )
    purged.push(...invalid)
    all = all.filter(
      (m) => !(m.domain === 'invoices/draft' && m.entityId.startsWith('inv_')),
    )
  }

  // v3 → v4: purge invalid-UUID schedule and timeline mutations.
  // "schedule-"-prefixed entityIds were produced by createJobSchedule() before
  // it switched to generateUUID(). "timeline-"-prefixed entityIds were produced
  // by createTimelineEvent() before the same fix. Both always fail with Postgres
  // 22P02 (invalid input syntax for type uuid) and must not be retried.
  if (stored < 4) {
    const invalid = all.filter(
      (m) =>
        (m.domain === 'schedules' && m.entityId.startsWith('schedule-')) ||
        (m.domain === 'timeline' && m.entityId.startsWith('timeline-')),
    )
    purged.push(...invalid)
    all = all.filter(
      (m) =>
        !(m.domain === 'schedules' && m.entityId.startsWith('schedule-')) &&
        !(m.domain === 'timeline' && m.entityId.startsWith('timeline-')),
    )
  }

  persist(all)
  writeStoredSchemaVersion(CURRENT_SCHEMA_VERSION)
  return purged
}
