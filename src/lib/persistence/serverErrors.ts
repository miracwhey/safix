/**
 * Postgres server-side error classification helpers for repository write paths.
 *
 * Used by all queued repositories to distinguish non-retryable server errors
 * (which must never be enqueued for offline replay) from transient network
 * failures (which are safe to queue and replay via flushPendingMutations).
 *
 * Postgres error class 23 = integrity constraint violations (duplicate key,
 * FK, not-null, check, exclusion). Class 42 = syntax / schema errors.
 * Neither class is retryable — queuing them would replay a write that the
 * server already rejected for a structural reason, potentially corrupting
 * DB-authoritative state via the upsert flush path.
 */

/** Returns true when the error carries a Postgres server-side error code. */
export function isServerSideError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const e = error as Record<string, unknown>
  if (typeof e.code !== 'string') return false
  // class 22 = data exceptions (22P02 invalid input syntax for type, etc.)
  // class 23 = integrity constraint violations
  // class 42 = syntax / schema errors
  return e.code.startsWith('22') || e.code.startsWith('23') || e.code.startsWith('42')
}

/** Returns true when the Postgres error is a unique-key violation (23505). */
export function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const e = error as Record<string, unknown>
  return e.code === '23505'
}

/**
 * Extract a structured, production-safe shape from a raw write-path error.
 *
 * The returned fields are exactly the ones safe to surface in observability
 * (Sentry breadcrumbs, on-device diagnostic UI) without leaking payloads or
 * PII: Postgres / PostgREST `code`, HTTP `status`, error `name`, and a
 * truncated `message`.  Used by `flushPendingMutations` for replay-failure
 * telemetry AND by the SyncStatusBar's diagnostic disclosure so a real-device
 * tester can read the actual reject reason without Safari Web Inspector.
 *
 * Truncation: `message` is capped at 200 chars — long enough for a typical
 * Postgres / PostgREST error sentence, short enough that a verbose stack
 * trace cannot leak into Sentry / UI.
 */
export interface ErrorShape {
  code?: string
  status?: number
  name?: string
  message?: string
}

export function describeError(error: unknown): ErrorShape {
  if (typeof error !== 'object' || error === null) {
    return { message: typeof error === 'string' ? error.slice(0, 200) : undefined }
  }
  const e = error as Record<string, unknown>
  const out: ErrorShape = {}
  if (typeof e.code === 'string') out.code = e.code
  if (typeof e.status === 'number') out.status = e.status
  if (typeof e.name === 'string') out.name = e.name
  if (typeof e.message === 'string') out.message = e.message.slice(0, 200)
  return out
}
