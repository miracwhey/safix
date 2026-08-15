/**
 * Failure classifier — turns a raw write-path error into a typed FailureKind.
 *
 * Used by `recordPersistenceFailure` and `flushPendingMutations` to drive
 * three orthogonal policy decisions:
 *
 *   1. Should the mutation be retried automatically?
 *   2. Should the failure surface in the SyncStatusBar?
 *   3. Should the pending-mutation entry be dropped from the queue?
 *
 * The classifier inspects the shape and contents of the error in this
 * priority order:
 *
 *   - context (caller-supplied auth state)  → auth-not-ready
 *   - Postgres `code` (PGRST301, 23xxx, 42xxx)  → permission-denied / business-rejected / validation
 *   - HTTP `status` (401, 403, 408, 429, 5xx)  → permission-denied / auth-not-ready / retryable
 *   - error name (`AbortError`, `AuthRetryableFetchError`, `TypeError fetch`)  → transient
 *   - error message (`permission denied`, `network`, `failed to fetch`, `aborted`)
 *   - fallback  → unknown
 *
 * No external imports — pure logic so the classifier is safe to run inside
 * any error path, including the persistence store itself.
 */

export type FailureKind =
  /** Network / fetch / DNS / timeout — should retry on next opportunity. */
  | 'transient'
  /** Server transient (HTTP 5xx, 429 rate-limit) — retry with bounded retries. */
  | 'retryable'
  /** Session not validated yet, or 401 expired-token — silent skip; retry once auth resolves. */
  | 'auth-not-ready'
  /** RLS deny / 403 / explicit "permission denied" — needs user attention; not retryable. */
  | 'permission-denied'
  /** Postgres class 23 integrity constraint (NOT NULL, FK, check, exclusion, unique) — not retryable. */
  | 'business-rejected'
  /** Postgres class 42 syntax / schema / undefined column — developer/system error; not retryable. */
  | 'validation'
  /** Anything else — conservative retry, age-based escalation. */
  | 'unknown'

export interface ClassifyContext {
  /** Set by callers in flushPendingMutations to detect cross-/no-session skips. */
  currentUid?: string | null
  /**
   * The userId the mutation was tagged with at enqueue time.  When set and
   * different from currentUid (or currentUid is null), the failure is
   * classified as `auth-not-ready` regardless of the underlying error.
   */
  mutationUserId?: string | null
}

/** Postgres class 22 — data exceptions (22P02 invalid input syntax for type, etc.). */
function isPostgresDataExceptionCode(code: string): boolean {
  return code.length >= 2 && code.startsWith('22')
}

/** Postgres class 23 — integrity constraint violations (incl. unique-key 23505). */
function isPostgresIntegrityCode(code: string): boolean {
  return code.length >= 2 && code.startsWith('23')
}

/** Postgres class 42 — syntax / schema / undefined column. */
function isPostgresSchemaCode(code: string): boolean {
  return code.length >= 2 && code.startsWith('42')
}

/** PostgREST RLS-reject codes (always begin with PGRST3, e.g. PGRST301). */
function isPostgrestRlsCode(code: string): boolean {
  return code.startsWith('PGRST3')
}

function readObjectField<T>(error: unknown, field: string): T | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const v = (error as Record<string, unknown>)[field]
  return v as T | undefined
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  const m = readObjectField<unknown>(error, 'message')
  return typeof m === 'string' ? m : ''
}

function readErrorName(error: unknown): string {
  if (error instanceof Error) return error.name
  const n = readObjectField<unknown>(error, 'name')
  return typeof n === 'string' ? n : ''
}

/**
 * Classify a raw error into a FailureKind.
 *
 * The optional `context` lets callers (currently only flushPendingMutations)
 * short-circuit to `auth-not-ready` when the active session is missing or
 * does not own the mutation — those skips must never escalate as a
 * persistent banner because they self-heal once the user is signed in.
 */
export function classifyFailure(error: unknown, context?: ClassifyContext): FailureKind {
  // 1. Auth-not-ready short-circuit driven by the caller's session context.
  //    When the mutation is tagged with a userId but the active session is
  //    absent or belongs to a different user, the replay must be deferred —
  //    not retried, not recorded as a permanent failure.
  if (context && context.mutationUserId) {
    if (!context.currentUid || context.mutationUserId !== context.currentUid) {
      return 'auth-not-ready'
    }
  }

  // 2. Postgres / PostgREST error codes — strongest signal we have.
  const code = readObjectField<string>(error, 'code')
  if (typeof code === 'string' && code.length > 0) {
    if (isPostgrestRlsCode(code)) return 'permission-denied'
    if (isPostgresDataExceptionCode(code)) return 'validation'
    if (isPostgresIntegrityCode(code)) return 'business-rejected'
    if (isPostgresSchemaCode(code)) return 'validation'
  }

  // 3. HTTP status — Supabase fetch failures, edge function errors.
  const status = readObjectField<number>(error, 'status')
  if (typeof status === 'number') {
    if (status === 401) return 'auth-not-ready' // expired JWT — refreshable
    if (status === 403) return 'permission-denied'
    if (status === 429) return 'retryable'
    if (status === 408) return 'retryable' // request timeout
    if (status >= 500 && status <= 599) return 'retryable'
  }

  // 4. Known error names from the JS / Supabase SDK.
  const name = readErrorName(error)
  if (name === 'AbortError') return 'transient'
  if (name === 'AuthRetryableFetchError') return 'transient'
  if (name === 'TimeoutError') return 'transient'

  // 5. Message-based heuristics — last-resort string sniffing.  Kept narrow
  //    so we don't classify domain errors that happen to mention these words.
  const message = readErrorMessage(error).toLowerCase()
  if (message) {
    if (
      message.includes('permission denied') ||
      message.includes('rls') ||
      message.includes('row-level security')
    ) {
      return 'permission-denied'
    }
    if (
      message.includes('failed to fetch') ||
      message.includes('network request failed') ||
      message.includes('networkerror') ||
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('etimedout') ||
      message.includes('timed out') ||
      message.includes('timeout') ||
      message.includes('abort')
    ) {
      return 'transient'
    }
  }

  // 6. TypeError thrown by fetch on the JS side (no status, no code).
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
    return 'transient'
  }

  return 'unknown'
}

/**
 * Returns true when the kind is safe to auto-retry in the flush path.
 *
 * Non-retryable kinds (`permission-denied`, `business-rejected`,
 * `validation`) must drop the pending mutation immediately and surface the
 * failure as permanent — repeating the same write would only fail again.
 *
 * `auth-not-ready` is retryable in spirit but handled by skipping the
 * mutation without incrementing the retry count, so it is not in this set.
 */
export function isRetryableKind(kind: FailureKind): boolean {
  return kind === 'transient' || kind === 'retryable' || kind === 'unknown'
}

/**
 * Returns true when a kind represents a final, user-or-developer-actionable
 * failure that must surface immediately in the SyncStatusBar — no
 * age-threshold suppression, no auto-recovery counting.
 */
export function isPermanentKind(kind: FailureKind): boolean {
  return (
    kind === 'permission-denied' ||
    kind === 'business-rejected' ||
    kind === 'validation'
  )
}
