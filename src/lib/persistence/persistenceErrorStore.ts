/**
 * Centralized store for tracking optimistic write failures across all
 * Supabase-backed repositories.
 *
 * Each repository calls `recordPersistenceFailure()` whenever a background
 * Supabase mutation fails.  The store is reactive — any layer (UI, service)
 * can subscribe and surface failures without polling.
 *
 * Every failure is tagged with a `kind` (FailureKind) — either explicitly
 * by the caller or auto-classified from the raw error.  The kind drives
 * three policy decisions downstream:
 *
 *   1. `flushPendingMutations` decides whether to retry or drop+permanent
 *   2. `needsUserAttention` decides whether the SyncStatusBar should escalate
 *   3. Observability/logging can group by kind without re-parsing errors
 *
 * Recovery:
 *   Call `resyncRepositories()` from `src/lib/bootstrap` to reload all
 *   domains from the database and bring the local cache back in sync.
 *   After a successful re-sync, call `clearPersistenceFailures()` to
 *   dismiss stale failure records.
 */

import { classifyFailure, isPermanentKind, type FailureKind } from './classifyFailure'

export interface PersistenceFailure {
  /** Human-readable domain label, e.g. "jobs", "payments/ledger". */
  domain: string
  /** Write operation that failed. */
  operation:
    | 'add'
    | 'update'
    | 'remove'
    | 'history'
    | 'finalize_state_atomic'
    | 'open_atomic'
    | 'split_refund'
    | 'create_spatial_offer'
  /** Primary key of the entity that could not be persisted. */
  entityId: string
  /** Original error returned by Supabase (or any thrown value). */
  error: unknown
  /** Unix timestamp (ms) when the failure was last recorded. */
  occurredAt: number
  /**
   * Classified failure category.  Always present in stored entries — the
   * record path auto-classifies when the caller does not supply a kind.
   * Drives retry, banner, and recovery policy.
   */
  kind: FailureKind
  /** Unix timestamp (ms) when this entity's failure was first seen. Never overwritten on retry. */
  firstOccurredAt?: number
  /** How many times the background auto-recovery flush attempted and failed for this entity. */
  autoRecoveryAttempts?: number
  /**
   * When true, the failure needs user attention immediately regardless of age or retry count.
   * Set for mutations dropped after MAX_RETRIES — there will be no further auto-recovery.
   * Once set, permanent is never cleared back to false.
   */
  permanent?: boolean
}

/**
 * Input shape accepted by `recordPersistenceFailure` — kind is optional so
 * the 30+ existing repository callsites stay unchanged.  When omitted, the
 * store auto-classifies from `error`.
 */
export type PersistenceFailureInput = Omit<
  PersistenceFailure,
  'kind' | 'firstOccurredAt' | 'autoRecoveryAttempts' | 'permanent'
> & { kind?: FailureKind }

type Listener = () => void

let failures: PersistenceFailure[] = []
const listeners = new Set<Listener>()

function notify(): void {
  listeners.forEach((listener) => listener())
}

/**
 * Domains that enqueue pending mutations and therefore require both a minimum
 * number of auto-recovery attempts AND a minimum age before escalating to the user.
 * Non-queued domains escalate after the age threshold alone.
 */
// Domains that enqueue pending mutations: escalation requires ≥2 flush attempts AND ≥15s age.
// 'timeline', 'notifications', 'inAppNotifications' queue inserts/updates on failure.
// 'team', 'media', 'ratings', 'feedback' queue inserts/updates on failure.
// 'payments/ledger' is intentionally excluded: financial failures must escalate on age alone
// (15s) regardless of retry count — faster user visibility for audit-trail gaps.
// 'disputes/history' is intentionally excluded: bigserial PK incompatible with queue replay.
const QUEUED_DOMAINS = new Set([
  'calendar', 'schedules', 'jobs', 'messages', 'timeline', 'notifications',
  // inAppNotifications shares the notification_signals table and self-heals via flush
  'inAppNotifications',
  // Secondary domains: team assignments, media artifacts, ratings, feedback —
  // all enqueue on failure and self-heal via flushPendingMutations
  'team', 'media', 'ratings', 'feedback',
  // Invoice draft INSERT is queue-durable: add() enqueues under 'invoices/draft'
  // and self-heals via flushPendingMutations. Using a sub-domain keeps update()
  // failures under the plain 'invoices' domain (non-queued) so that a failed
  // syncInvoiceWithPayment or issueInvoiceWorkflow still escalates at the 15 s
  // age threshold alone — those paths do not enqueue and must remain visible.
  'invoices/draft',
])
const MIN_AGE_MS = 15_000
const MIN_AUTO_RECOVERY_ATTEMPTS = 2

/**
 * Returns true when a failure has persisted long enough and through enough
 * auto-recovery attempts to warrant user attention via the SyncStatusBar.
 *
 * Policy by kind:
 *   - `permanent` flag set            → always (set when the queue dropped a write)
 *   - `auth-not-ready`                → never (silent until the next auth-ready flush)
 *   - `permission-denied` / `business-rejected` / `validation`
 *                                     → immediately (no age-threshold; the write
 *                                       cannot self-heal and the user/dev must act)
 *   - `transient` / `retryable` / `unknown` (queued domain)
 *                                     → ≥ MIN_AUTO_RECOVERY_ATTEMPTS retries AND ≥ MIN_AGE_MS age
 *   - `transient` / `retryable` / `unknown` (non-queued domain)
 *                                     → ≥ MIN_AGE_MS age (no self-healing path)
 *
 * The kind-driven branches sit in front of the legacy age-threshold logic so
 * a final business/permission failure is never hidden behind the 15 s gate.
 */
export function needsUserAttention(failure: PersistenceFailure): boolean {
  if (failure.permanent) return true
  if (failure.kind === 'auth-not-ready') return false
  if (isPermanentKind(failure.kind)) return true
  const age = Date.now() - (failure.firstOccurredAt ?? failure.occurredAt)
  if (QUEUED_DOMAINS.has(failure.domain)) {
    return (failure.autoRecoveryAttempts ?? 0) >= MIN_AUTO_RECOVERY_ATTEMPTS && age >= MIN_AGE_MS
  }
  return age >= MIN_AGE_MS
}

/**
 * Returns the number of milliseconds until the next non-escalated failure will
 * cross the age threshold and need user attention, or `null` if no time-gated
 * transition is pending.
 *
 * Used by `usePersistenceErrors` to schedule a re-evaluation exactly when the
 * grace period expires — without polling and without waiting for a store event.
 *
 * Only failures that are already past the retry-count requirement (or are
 * non-queued) are considered — queued failures that still need more retry events
 * will be re-evaluated when those events fire via `recordPersistenceFailure`.
 */
export function getEscalationTimeoutMs(): number | null {
  const now = Date.now()
  let earliest: number | null = null
  for (const f of failures) {
    if (needsUserAttention(f)) continue
    if (f.permanent) continue
    // Kind-driven branches are not time-gated — they either escalate
    // immediately (handled by needsUserAttention above) or never escalate
    // at all (auth-not-ready).  Skip them so we don't schedule a
    // pointless setTimeout for a failure that will never cross a threshold.
    if (f.kind === 'auth-not-ready') continue
    if (isPermanentKind(f.kind)) continue
    const isQueued = QUEUED_DOMAINS.has(f.domain)
    if (isQueued && (f.autoRecoveryAttempts ?? 0) < MIN_AUTO_RECOVERY_ATTEMPTS) {
      // Retry-count threshold not yet reached — needs more flush events, not a timer
      continue
    }
    const age = now - (f.firstOccurredAt ?? f.occurredAt)
    const remaining = Math.max(0, MIN_AGE_MS - age)
    if (earliest === null || remaining < earliest) {
      earliest = remaining
    }
  }
  return earliest === null ? null : earliest + 10 // +10 ms buffer so threshold is safely passed
}

/**
 * Record a persistence failure and notify all subscribers.
 *
 * Deduplication: if a failure for the same (domain, entityId) already exists,
 * the existing entry is replaced rather than a second entry appended. This keeps
 * the failure count equal to the number of distinct failing entities — not the
 * number of failed write attempts.
 *
 * Tracking:
 * - `firstOccurredAt` is preserved from the first occurrence.
 * - When `opts.fromAutoRecovery` is true (called by flushPendingMutations),
 *   `autoRecoveryAttempts` is incremented so the escalation threshold can be
 *   evaluated without any UI involvement.
 * - When `opts.permanent` is true, `permanent` is set and never cleared — the
 *   failure will always be surfaced to the user on the next hook evaluation.
 *
 * Also forwards to `console.error` so existing log pipelines are unaffected.
 */
export function recordPersistenceFailure(
  input: PersistenceFailureInput,
  opts?: { fromAutoRecovery?: boolean; permanent?: boolean },
): void {
  // Auto-classify when the caller did not supply a kind.  Repositories that
  // already inspect the error (e.g. the isServerSideError branches) may pass
  // a more accurate kind; everyone else gets the inferred one.
  const kind: FailureKind = input.kind ?? classifyFailure(input.error)

  const idx = failures.findIndex(
    (f) => f.domain === input.domain && f.entityId === input.entityId,
  )
  let next: PersistenceFailure
  if (idx >= 0) {
    const existing = failures[idx]
    next = {
      ...input,
      kind,
      firstOccurredAt: existing.firstOccurredAt ?? existing.occurredAt,
      autoRecoveryAttempts: opts?.fromAutoRecovery
        ? (existing.autoRecoveryAttempts ?? 0) + 1
        : (existing.autoRecoveryAttempts ?? 0),
      permanent: opts?.permanent || existing.permanent,
    }
    failures = [...failures.slice(0, idx), next, ...failures.slice(idx + 1)]
  } else {
    next = {
      ...input,
      kind,
      firstOccurredAt: input.occurredAt,
      autoRecoveryAttempts: opts?.fromAutoRecovery ? 1 : 0,
      permanent: opts?.permanent,
    }
    failures = [...failures, next]
  }
  console.error(
    `[${input.domain}] ${input.operation} failed for entity ${input.entityId} (kind=${kind})`,
    input.error,
  )
  notify()
}

/** Returns a snapshot of all recorded failures (newest last). */
export function getPersistenceFailures(): PersistenceFailure[] {
  return [...failures]
}

/** Returns true when there is at least one uncleared failure. */
export function hasPersistenceFailures(): boolean {
  return failures.length > 0
}

/**
 * Clears all recorded failures and notifies subscribers.
 * Intended to be called after a successful `resyncRepositories()` call.
 */
export function clearPersistenceFailures(): void {
  failures = []
  notify()
}

/**
 * Removes only the failures for a specific (domain, entityId) pair.
 *
 * Used by `flushPendingMutations` to precisely clear the failure record for
 * each successfully replayed mutation without touching unrelated failures from
 * repos that do not enqueue mutations (e.g. payment updates, job removes).
 */
export function clearPersistenceFailureForEntity(domain: string, entityId: string): void {
  const next = failures.filter((f) => !(f.domain === domain && f.entityId === entityId))
  if (next.length !== failures.length) {
    failures = next
    notify()
  }
}

/**
 * Returns true when there is already a recorded failure for the given
 * (domain, entityId) pair.
 */
export function hasPersistenceFailureForEntity(domain: string, entityId: string): boolean {
  return failures.some((f) => f.domain === domain && f.entityId === entityId)
}

/**
 * Subscribe to changes in the failure list.
 * Returns an unsubscribe function (same pattern used by all domain stores).
 */
export function subscribeToPersistenceFailures(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
