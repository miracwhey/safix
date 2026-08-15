/**
 * Auth-read single-flight + lock-stolen retry.
 *
 * Sentry P0 (FIXUP-WEB-56 / -A / -B / -9 / -C): during boot and resume, many
 * repository `initialize()` paths each fire their own `supabase.auth.getSession()`
 * in parallel. Every one of those calls acquires the auth-js navigator.locks
 * lock — under contention (or when WKWebView releases locks across a
 * suspension) one contender steals the lock and the victims reject with
 * `AbortError: Lock was stolen by another request`, hard-failing chat /
 * messages initialization and (10s later, same trace) the 15s bootstrap
 * timeout.
 *
 * Two mitigations live here:
 *
 * 1. `getAuthSession()` — ONE shared in-flight promise for `getSession()`.
 *    N concurrent callers (session.ts refresh + repository inits) collapse
 *    into a single lock acquisition. No result caching: the slot only holds
 *    an IN-FLIGHT promise and is always cleared on settle, so a sign-out /
 *    account switch can never be served a stale session from here.
 *
 * 2. `retryOnAuthLockStolen()` — classifies the lock-steal signature and
 *    retries the read exactly once after a short backoff. Plain AbortErrors
 *    (genuine caller-side cancellation) are NOT retried — classification is
 *    by message match, not by error name.
 */

import { supabase } from '../supabase'

type AuthSessionResult = Awaited<ReturnType<typeof supabase.auth.getSession>>

/**
 * Mirrors AUTH_READ_TIMEOUT_MS in session.ts. The shared promise must never
 * occupy the slot forever: an iOS suspension mid-call can leave the
 * underlying fetch permanently hung — without this cap every later caller
 * (including the post-resume refresh) would join the dead promise and the
 * app could never recover. On timeout the shared promise rejects with
 * 'auth_read_timeout' (classified as network_error by session.ts) and the
 * slot is cleared so the next caller starts a fresh read.
 */
const SINGLE_FLIGHT_TIMEOUT_MS = 20_000

/**
 * Backoff before the single retry. The thief that stole the lock is usually
 * an internal auth-js operation (initialize / token refresh) — give it a
 * moment to finish instead of immediately contending again.
 */
const LOCK_STOLEN_RETRY_DELAY_MS = 300

function extractMessage(e: unknown): string | null {
  if (typeof e === 'string') return e
  if (typeof e === 'object' && e !== null && 'message' in e) {
    const msg = (e as Record<string, unknown>).message
    if (typeof msg === 'string') return msg
  }
  return null
}

/**
 * True when the error carries the navigator.locks steal signature.
 *
 * Producer shapes (all carried by the same message text):
 *  - DOMException { name: 'AbortError', message: 'Lock was stolen by another request' }
 *    thrown directly by `supabase.auth.getSession()` (WebKit wording).
 *  - Chromium wording: 'Lock broken by another request with the "steal" option.'
 *  - PostgREST-wrapped: postgrest-js converts fetch rejections into
 *    `{ message: 'AbortError: Lock was stolen by another request', ... }`
 *    result errors — the same signature surfaces via `result.error.message`.
 *
 * Deliberately message-based: `name === 'AbortError'` alone is NOT enough —
 * a genuine manual cancellation must not be retried.
 */
export function isAuthLockStolenError(e: unknown): boolean {
  const message = extractMessage(e)
  if (!message) return false
  return /lock\s+(was\s+)?(stolen|broken)/i.test(message)
}

/**
 * Runs an auth read and retries it EXACTLY once when it fails with the
 * lock-stolen signature. All other failures propagate unchanged.
 */
export async function retryOnAuthLockStolen<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (e: unknown) {
    if (!isAuthLockStolenError(e)) throw e
    await new Promise((resolve) => setTimeout(resolve, LOCK_STOLEN_RETRY_DELAY_MS))
    return read()
  }
}

let inflightGetSession: Promise<AuthSessionResult> | null = null

/**
 * Single-flight `supabase.auth.getSession()`.
 *
 * - Concurrent callers share ONE underlying call (one lock acquisition).
 * - The slot is cleared when the call settles (resolve OR reject) — a
 *   rejection never poisons subsequent calls.
 * - Includes the one-shot lock-stolen retry (shared by all joiners).
 * - Hard 20s cap so a permanently hung read cannot occupy the slot forever
 *   (see SINGLE_FLIGHT_TIMEOUT_MS).
 */
export function getAuthSession(): Promise<AuthSessionResult> {
  if (inflightGetSession) return inflightGetSession

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error('auth_read_timeout')),
      SINGLE_FLIGHT_TIMEOUT_MS,
    )
  })

  const p: Promise<AuthSessionResult> = Promise.race([
    retryOnAuthLockStolen(() => supabase.auth.getSession()),
    timeout,
  ]).finally(() => {
    clearTimeout(timeoutHandle)
    if (inflightGetSession === p) inflightGetSession = null
  })

  inflightGetSession = p
  return p
}

/**
 * Drops the in-flight promise WITHOUT cancelling it — the next
 * `getAuthSession()` starts a fresh read instead of joining the old one.
 *
 * Callers (session.ts):
 *  - forceRefreshSession(): a SIGNED_IN / TOKEN_REFRESHED follow-up must
 *    re-read the session AFTER the token exchange — joining a read that
 *    started before the exchange would return the pre-exchange (possibly
 *    empty) session and break the auth-callback flow.
 *  - SIGNED_OUT: narrows the window in which a post-sign-out caller could
 *    join a pre-sign-out read and observe the previous user's session.
 */
export function invalidateAuthSessionSingleFlight(): void {
  inflightGetSession = null
}
