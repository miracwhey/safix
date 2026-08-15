/**
 * Reactive session / role boundary.
 *
 * Provides a single canonical source of truth for:
 *   - current user (Supabase User | null)
 *   - current role  (Role | null)
 *   - current craftsmanRole (CraftsmanRole | null)
 *   - loading state
 *
 * Gates, screens and components subscribe via `subscribeSession` or use the
 * `useSession` React hook instead of independently running auth+profile loads.
 *
 * Auth callback handling:
 *   When the app loads with Supabase auth callback parameters in the URL
 *   (e.g. after clicking an email confirmation link), the initial refresh is
 *   deferred until the Supabase client finishes processing the callback tokens.
 *   This prevents a race condition where refreshSession() would read a stale/
 *   empty session before the callback token exchange completes.
 */

import type { User } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { ensureProfileExists, getMyProfile, acceptTos, type Role, type CraftsmanRole } from './profile'
import { isTosAcceptanceStale } from './legal/legalVersion'
import { resetGuidedEntry, hydrateFromProfile } from './customerEntry/guidedEntryState'
import { resetCustomerContext, updateCustomerContext } from './customer/customerContextStore'
import { loadCustomerAvatarFromStorage } from './customer/customerAvatarService'
import { getCustomerBillingProfileByUserId } from './customer/customerBillingProfileService'
import { resyncRepositories } from './bootstrap'
import { syncAllProjectsFromJobs } from './projects/projectJobSyncBridge'
import { setActiveMutationUser, hasPendingMutationsForCurrentUser } from './persistence/pendingMutationStore'
import { markRecoveryStarted, clearRecoveryStatus } from './persistence/recoveryStatus'
import { clearPersistenceFailures } from './persistence/persistenceErrorStore'
import { startNotificationBridge, stopNotificationBridge } from './notifications'
import {
  resetInAppNotificationRepository,
  initializeInAppNotificationRepository,
  restartInAppNotificationRealtimeIfDead,
} from './inAppNotifications/repository/registry'
import { restartJobRealtimeIfDead } from './jobs/repository/registry'
import { restartPaymentRealtimeIfDead } from './payments/repository/registry'
import { restartInvoiceRealtimeIfDead } from './invoices/repository/registry'
import { restartDisputeRealtimeIfDead } from './disputes/repository/registry'
import { restartMessageRealtimeIfDead } from './messages/repository/registry'
import { restartChatRealtimeIfDead } from './chat/repository/registry'
import { drainMediaOutbox, startMediaOutboxAutoDrain } from './workflow/chatWorkflow'
import { isNative } from './platform'
import { restartTimelineRealtimeIfDead } from './timeline/repository/registry'
import { restartNotificationRealtimeIfDead } from './notifications/repository/registry'
import { restartCalendarRealtimeIfDead } from './calendar/repository/registry'
import { restartTimeEntryRealtimeIfDead } from './team/repository/timeEntryRegistry'
import { restartAbsenceRealtimeIfDead } from './team/repository/absenceRegistry'
import { restartScheduleRealtimeIfDead } from './operations/repository/registry'
import { restartSupplementaryPaymentRealtimeIfDead } from './payments/supplementary/supplementaryPaymentRegistry'
import { restartEscrowPlanRealtimeIfDead } from './payments/escrow/escrowRegistry'
import { restartFundingRequestRealtimeIfDead } from './payments/fundingRequest/fundingRequestRegistry'
// Direct file import (not the subscription barrel) — keeps the module graph
// flat and avoids pulling unrelated subscription services into session.ts.
import { restartSubscriptionRealtimeIfDead } from './subscription/subscriptionRealtime'
import { restartFeatureFlagsRealtimeIfDead } from './flags/repository/registry'
import { refreshBlockCache } from './moderation/moderationService'
import { setSentryUser, clearSentryUser } from './sentry'
import { invalidateWorkerMembershipCache } from '../hooks/useWorkerMembership'
import { sweepAllDraftKeys } from '../hooks/useDraftPersistence'
import { resetOwnerJoinCodeFlag } from './company/joinCode'
import { logWarning } from './observability'
import {
  getAuthSession,
  retryOnAuthLockStolen,
  invalidateAuthSessionSingleFlight,
  isAuthLockStolenError,
} from './auth/authSingleFlight'

const SESSION_CACHE_KEY = 'fixup.session.cache.v1'

let lastResyncAt = 0
let activeResyncWave: Promise<void> | null = null
// True once a SIGNED_IN .finally() has been attached to the current wave.
// Cleared when the wave settles so the next SIGNED_IN can attach again.
let signinFollowupPending = false
// uid the active wave was started for; null when no wave is running.
let activeResyncWaveUid: string | null = null
const RESYNC_DEBOUNCE_MS = 30_000
// How long to wait for a Supabase auth read (getSession / getUser) before
// treating it as a network hang. On mobile a dropped connection may never
// reject — this cap ensures loading=true cannot persist indefinitely.
const AUTH_READ_TIMEOUT_MS = 20_000

/**
 * Returns the in-flight resync wave, or creates a new one.
 *
 * All call sites share the same Promise — resyncRepositories() is never
 * called twice in parallel regardless of how many SIGNED_IN re-emissions
 * or visibility/online triggers arrive concurrently.
 *
 * On success: updates lastResyncAt and fires syncAllProjectsFromJobs once.
 * On error:   logs a warning; lastResyncAt not advanced so next tryResync() retries.
 * Always resolves (error caught internally) so callers can use .finally() safely.
 */
function getOrStartResyncWave(): Promise<void> {
  if (activeResyncWave) return activeResyncWave
  signinFollowupPending = false
  const p: Promise<void> = resyncRepositories()
    .then(() => {
      // Only advance the timestamp and sync projects if this wave is still
      // authoritative — a discarded wave (user switched mid-flight) must not
      // suppress the new user's first resync or run syncAllProjectsFromJobs
      // against a partially-switched cache.
      if (activeResyncWave !== p) return
      lastResyncAt = Date.now()
      void syncAllProjectsFromJobs().catch(() => { /* non-critical */ })
    })
    .catch((e: unknown) => {
      console.warn('[SaFix] Resync wave failed (non-fatal):', e)
      // lastResyncAt intentionally not advanced — next tryResync() will retry.
    })
    .finally(() => {
      if (activeResyncWave === p) {
        activeResyncWave = null
        signinFollowupPending = false
        activeResyncWaveUid = null
      }
    })
  activeResyncWave = p
  return p
}

function tryResync(): void {
  // A wave already in flight will update lastResyncAt and run
  // syncAllProjectsFromJobs — no need to start another.
  if (activeResyncWave) return
  const now = Date.now()
  // Bypass the 30s debounce when the current user has queued writes — those
  // mutations must be flushed immediately on network restore regardless of
  // when the last successful resync occurred.
  if (!hasPendingMutationsForCurrentUser() && now - lastResyncAt < RESYNC_DEBOUNCE_MS) return
  activeResyncWaveUid = state.user?.id ?? null
  void getOrStartResyncWave()
}

// ---------------------------------------------------------------------------
// Mobile resume orchestration
// ---------------------------------------------------------------------------

/**
 * Maximum time the recovery flag is kept set, even if the inner Promises
 * (resync wave, refreshSession) hang because of a frozen WebView, DNS
 * timeout, or stalled Supabase reconnect.  Past this point the
 * SyncStatusBar is allowed to reflect actual failure state again — no
 * indefinite suppression.
 */
const RECOVERY_MAX_DURATION_MS = 10_000
const WAVE_TIMEOUT_MS = 8_000

let inflightResume: Promise<void> | null = null
// Identity token for the cycle currently owning `inflightResume`.  A
// sign-out (or a future replacement) sets this to null so a stale finally
// cannot clobber the slot of a newer cycle.  Compared by reference only.
let inflightResumeOwner: object | null = null

type ResumeReason = 'visibility' | 'native' | 'online'

/**
 * Single orchestrator for app-resume / connectivity-restore events.
 *
 * iOS WKWebView fires up to three distinct events for a single user
 * resume — `visibilitychange`, `fixup:app-resume`, and `online` — within
 * the same tick.  Without consolidation each one triggered:
 *   - 16 × restartXRealtimeIfDead() calls (× 3 events = 48 redundant calls)
 *   - up to 2 parallel refreshSession() calls
 *   - up to 3 tryResync() entries (debounced by activeResyncWave, but each
 *     still ran the realtime cascade)
 *
 * This function folds all three into one cycle and exposes a global
 * recovery flag (recoveryStatus) so the SyncStatusBar can suppress the
 * banner during the cycle.  Re-entrant: parallel calls join the in-flight
 * Promise rather than spawning a second cycle.
 *
 * Signed-out: no-op.  There is nothing to recover for an unauthenticated
 * session and the realtime channels would only spin against rejected RLS.
 *
 * Failsafe: the recovery flag is auto-cleared after RECOVERY_MAX_DURATION_MS
 * even if the inner Promises never settle.  finishRecovery() is idempotent
 * so the eventual settlement does not double-decrement.
 */
function handleAppResume(reason: ResumeReason): Promise<void> {
  if (inflightResume) return inflightResume
  if (!state.user) return Promise.resolve()

  const finishRecovery = markRecoveryStarted()
  const failsafeHandle = setTimeout(finishRecovery, RECOVERY_MAX_DURATION_MS)

  const owner = {}
  inflightResumeOwner = owner

  const promise: Promise<void> = (async () => {
    try {
      // Idempotent realtime cascade — restartIfDead is a no-op when the
      // channel is healthy, so running it once per resume cycle is enough.
      restartInAppNotificationRealtimeIfDead()
      restartJobRealtimeIfDead()
      restartPaymentRealtimeIfDead()
      restartDisputeRealtimeIfDead()
      restartMessageRealtimeIfDead()
      // force on native: after a long background the websocket can be dead while
      // channel.state still reads 'joined', so the default no-op-if-joined guard
      // leaves a silently dead socket delivering no messages. force does a clean
      // teardown + re-subscribe whose SUBSCRIBED callback gap-refetches what was
      // missed (bounded incremental .gt(created_at) refetch). Keyed on isNative()
      // not `reason` because one iOS resume fires visibility/native/online in the
      // same tick and handleAppResume dedupes to whichever arrives first — so
      // `reason==='native'` is unreliable. On web the socket survives background,
      // so keep the cheap no-op-if-healthy path.
      restartChatRealtimeIfDead({ force: isNative() })
      // Media outbox: an app-resume is a prime moment to flush queued sends
      // (offline/app-kill survivors). Ensure the auto-drain triggers are armed
      // and kick a drain now — cheap no-op when the queue is empty.
      startMediaOutboxAutoDrain()
      void drainMediaOutbox()
      restartTimelineRealtimeIfDead()
      restartNotificationRealtimeIfDead()
      restartCalendarRealtimeIfDead()
      restartScheduleRealtimeIfDead()
      restartSupplementaryPaymentRealtimeIfDead()
      restartTimeEntryRealtimeIfDead()
      restartAbsenceRealtimeIfDead()
      // Money + Pro-state channels (Block 3): escrow/funding-request realtime
      // dies permanently once attemptReconnection is exhausted, and the
      // craftsman_subscriptions channel had no resume restart at all — both
      // froze after background until a remount. Wire them into the one cascade.
      restartEscrowPlanRealtimeIfDead()
      restartFundingRequestRealtimeIfDead()
      restartSubscriptionRealtimeIfDead()
      // Force on native: the kill-switch must survive an iOS resume even when
      // the socket reads connected but is actually dead.
      restartFeatureFlagsRealtimeIfDead({ force: isNative() })
      // R4: live invoice status — force on native revives the post-suspend
      // zombie socket (same reasoning as chat above).
      restartInvoiceRealtimeIfDead({ force: isNative() })

      // tryResync starts (or joins) the resync wave; capture the resulting
      // wave Promise so the recovery flag stays set until the wave settles.
      tryResync()
      const wave: Promise<void> = activeResyncWave ?? Promise.resolve()

      // Connectivity restore alone does not invalidate the auth token —
      // skip refreshSession() on `online` to avoid a redundant getUser()
      // round-trip.  visibility / native resume still refresh: the token
      // may have expired during background.
      const refresh: Promise<void> =
        reason === 'online' ? Promise.resolve() : refreshSession()

      await Promise.race([
        Promise.allSettled([wave, refresh]),
        new Promise<void>((resolve) => setTimeout(resolve, WAVE_TIMEOUT_MS)),
      ])
    } finally {
      clearTimeout(failsafeHandle)
      finishRecovery()
      // Only clear the slot if we still own it.  Sign-out (or a future
      // replacement cycle) sets inflightResumeOwner to null/something
      // else; a stale finally must not clobber the new slot.
      if (inflightResumeOwner === owner) {
        inflightResumeOwner = null
        inflightResume = null
      }
    }
  })()

  inflightResume = promise
  return promise
}

// Set by LoginScreen before signUpWithPassword when the user accepted ToS.
// Keyed to the signup email so it can never be consumed by a different account.
// Consumed inside refreshSession() after the profile row exists, before state
// is broadcast. Always cleared after first check — stale state is never kept.
let pendingTosEmail: string | null = null

export function signalSignupTosAccepted(email: string): void {
  pendingTosEmail = email
}

export function clearPendingTosAcceptance(): void {
  pendingTosEmail = null
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export type BootstrapErrorKind =
  | 'invalid_session'
  | 'deleted_user'
  | 'missing_profile'
  | 'missing_role'
  | 'invalid_role'
  | 'profile_schema_mismatch'
  | 'network_error'
  | 'unknown_error'
  // Post-signup specific failure classifications
  | 'no_session_after_signup'
  | 'getUser_validation_failed'
  | 'profile_create_failed'
  | 'profile_load_failed'
  | 'profile_read_failed'

/** Returns true when the error looks like a connectivity / DNS / timeout failure. */
function isNetworkError(e: unknown): boolean {
  // navigator.locks steal (auth-js lock contention) is a transient, retryable
  // condition — semantically a network-class failure. Defense-in-depth: when
  // even the single lock-stolen retry gets stolen again, the error must keep
  // the cached user and surface the retryable path instead of falling through
  // to 'unknown_error' → EMPTY_SESSION (visible logout flash — the original
  // P0 symptom). The DOMException message 'Lock was stolen by another
  // request' matches none of the patterns below (only its NAME is
  // AbortError), so this explicit check is required.
  if (isAuthLockStolenError(e)) return true
  if (e instanceof TypeError && /fetch|network/i.test(e.message)) return true
  if (e instanceof Error && /networkerror|econnrefused|enotfound|abort|auth_read_timeout/i.test(e.message)) return true
  if (typeof e === 'object' && e !== null) {
    const obj = e as Record<string, unknown>
    if (obj.name === 'AuthRetryableFetchError') return true
    if ('status' in obj && obj.status === 0) return true
  }
  return false
}

/** Returns true when the error indicates the session / JWT / user is no longer valid. */
function isAuthError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const obj = e as Record<string, unknown>
  if (obj.name === 'AuthApiError' || obj.name === 'AuthSessionMissingError') return true
  if (typeof obj.status === 'number' && (obj.status === 401 || obj.status === 403)) return true
  if (typeof obj.message === 'string') {
    const msg = obj.message.toLowerCase()
    if (/jwt|token|session_not_found|user not found|invalid claim|not authorized|refresh_token/.test(msg)) return true
  }
  return false
}

export function classifyError(e: unknown): BootstrapErrorKind {
  if (isNetworkError(e)) return 'network_error'
  if (isAuthError(e)) {
    if (typeof e === 'object' && e !== null) {
      const obj = e as Record<string, unknown>
      if (
        obj.status === 404 ||
        (typeof obj.message === 'string' && obj.message.toLowerCase().includes('user not found'))
      ) {
        return 'deleted_user'
      }
    }
    return 'invalid_session'
  }
  return 'unknown_error'
}

/**
 * Returns true when the error indicates a schema mismatch, e.g. querying a
 * column that does not exist in the database.  PostgREST returns HTTP 400
 * with a message referencing the missing column.
 */
function isProfileSchemaMismatch(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const obj = e as Record<string, unknown>
  // PostgREST schema-related errors use code 42703 (undefined_column) or
  // include "column … does not exist" in the message.
  if (typeof obj.code === 'string' && obj.code === '42703') return true
  if (typeof obj.message === 'string') {
    const msg = obj.message.toLowerCase()
    if (/column.*does not exist|undefined.*column|schema/i.test(msg)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type SessionState = {
  user: User | null
  role: Role | null
  craftsmanRole: CraftsmanRole | null
  isOperator: boolean
  /** ISO timestamp of when the user accepted ToS. Null = not yet accepted. */
  tosAcceptedAt: string | null
  loading: boolean
  /** True only after the server has validated the session via `getUser()`. */
  sessionValidated: boolean
  error: string | null
  errorKind: BootstrapErrorKind | null
}

const EMPTY_SESSION: SessionState = {
  user: null,
  role: null,
  craftsmanRole: null,
  isOperator: false,
  tosAcceptedAt: null,
  loading: false,
  sessionValidated: false,
  error: null,
  errorKind: null,
}

let state: SessionState = {
  ...EMPTY_SESSION,
  loading: true,
}

// ---------------------------------------------------------------------------
// Subscriptions  (same pattern as every other store in this codebase)
// ---------------------------------------------------------------------------

type Listener = () => void
const listeners = new Set<Listener>()

function notify() {
  listeners.forEach((fn) => fn())
}

export function subscribeSession(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSession(): SessionState {
  return state
}

/**
 * Test-only hatch that overrides the in-memory session snapshot. Lives
 * here (not in a test helper) because the workflow-layer RBAC guards in
 * `src/lib/auth/rbacGuards.ts` read the session synchronously via
 * `getSession()` and there is no other authoritative seam.
 *
 * Production code MUST NOT call this. Tests should pair it with the
 * `mockCustomerSession` / `mockOwnerSession` / `mockWorkerSession`
 * builders in `tests/helpers/mockSession.ts`. `__testOnly_resetSession`
 * is wired into `setupCleanRepositories` so each test starts blank.
 */
export function __testOnly_setSession(snapshot: SessionState): void {
  state = snapshot
  notify()
}

export function __testOnly_resetSession(): void {
  state = { ...EMPTY_SESSION }
  notify()
}

/**
 * Optimistically patches role fields in the in-memory session state after a
 * confirmed DB write. Prevents the stale-read race where refreshSession()
 * reads the profiles table before the just-committed upsert is visible,
 * causing gates to see role=null and redirect back to the same onboarding screen.
 *
 * Safe because:
 *  - Only called after a write that has already thrown or succeeded (try/catch in caller)
 *  - Only applies when the session is already server-validated
 *  - refreshSession() runs concurrently in the background and will confirm/
 *    overwrite with the authoritative DB value once visible
 */
export function applyRoleToSession(role: Role, craftsmanRole: CraftsmanRole | null): void {
  if (!state.sessionValidated) return
  state = { ...state, role, craftsmanRole }
  notify()
}

// ---------------------------------------------------------------------------
// Error message extraction
// ---------------------------------------------------------------------------

/**
 * Extracts a human-readable error message from any thrown value.
 *
 * Supabase PostgREST errors are plain objects (not `Error` instances) that
 * carry a `message` property.  This helper extracts it instead of falling
 * back to a generic German placeholder.
 */
function extractErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'object' && e !== null && 'message' in e) {
    const msg = (e as Record<string, unknown>).message
    if (typeof msg === 'string' && msg.length > 0) return msg
  }
  if (typeof e === 'string' && e.length > 0) return e
  return fallback
}

// ---------------------------------------------------------------------------
// Load / refresh
// ---------------------------------------------------------------------------

let refreshPromise: Promise<void> | null = null
// Monotonically increasing counter.  Incremented each time a new refresh
// starts (i.e. when refreshPromise is null and refreshSession() enters).
// Each IIFE captures its value at creation; before writing any state it
// checks that the module-level counter still matches — if not, a newer
// refresh (or a forceRefreshSession / sign-out) has taken over and the
// stale result is silently discarded.
let refreshGeneration = 0
let visibilityListenerBound = false

type CachedSession = {
  user: User
  role: Role | null
  craftsmanRole: CraftsmanRole | null
  isOperator: boolean
}

function isWebStorage(storage: unknown): storage is Storage {
  return typeof storage === 'object'
    && storage !== null
    && typeof (storage as Record<string, unknown>).getItem === 'function'
    && typeof (storage as Record<string, unknown>).setItem === 'function'
    && typeof (storage as Record<string, unknown>).removeItem === 'function'
}

function getStorage(): Storage | null {
  if (typeof localStorage === 'undefined' || !isWebStorage(localStorage)) return null
  return localStorage
}

function loadCachedSession(): CachedSession | null {
  const storage = getStorage()
  if (!storage) return null

  const raw = storage.getItem(SESSION_CACHE_KEY)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw)
    // Validate structure: must be an object with a user that has an id.
    // Reject anything else to prevent corrupted cache from producing
    // a half-valid session state on reopen.
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.user !== 'object' ||
      parsed.user === null ||
      typeof parsed.user.id !== 'string' ||
      parsed.user.id.length === 0
    ) {
      storage.removeItem(SESSION_CACHE_KEY)
      return null
    }
    return parsed as CachedSession
  } catch {
    storage.removeItem(SESSION_CACHE_KEY)
    return null
  }
}

function persistSessionSnapshot(next: SessionState) {
  const storage = getStorage()
  if (!storage) return

  if (!next.user) {
    storage.removeItem(SESSION_CACHE_KEY)
    return
  }

  const payload: CachedSession = {
    user: next.user,
    role: next.role,
    craftsmanRole: next.craftsmanRole,
    isOperator: next.isOperator,
  }

  try {
    storage.setItem(SESSION_CACHE_KEY, JSON.stringify(payload))
  } catch {
    // Ignore storage failures (quota / private mode).
  }
}

// Hydrate from cached snapshot to avoid empty UI while Supabase restores.
// IMPORTANT: Only the user object is restored — role / craftsmanRole /
// isOperator are intentionally left at their empty defaults.  Restoring
// stale role data would allow components that read `role` before
// `sessionValidated` becomes true to see a leftover value from a
// previous session (e.g. a prior account's 'customer' role leaking into
// a brand-new signup).  The canonical role is always loaded fresh from
// the server by refreshSession().
const cached = loadCachedSession()
if (cached) {
  state = {
    ...state,
    user: cached.user,
    role: null,
    craftsmanRole: null,
    isOperator: false,
    loading: true,
    sessionValidated: false,
    error: null,
    errorKind: null,
  }
}

// ---------------------------------------------------------------------------
// Invalid-session recovery
// ---------------------------------------------------------------------------

/**
 * Deterministic recovery for invalid / deleted sessions.
 *
 * Clears every piece of local user state so the app falls back to the
 * unauthenticated start screen (/login) without leaving stale data behind.
 */
export async function performInvalidSessionRecovery(): Promise<void> {
  // 1. Clear session snapshot cache
  const storage = getStorage()
  if (storage) {
    storage.removeItem(SESSION_CACHE_KEY)
  }

  // 2. Reset guided-entry state + its localStorage cache
  resetGuidedEntry()

  // 3. Local-only sign-out — clears Supabase's own auth storage
  //    without making a network call (the server already rejected us).
  try {
    await supabase.auth.signOut({ scope: 'local' })
  } catch {
    // Best-effort — the session is already invalid on the server.
  }

  // 4. Clean state with no error — gates will redirect to /login
  state = { ...EMPTY_SESSION }
  persistSessionSnapshot(state)
  notify()
}

// ---------------------------------------------------------------------------
// Load / refresh
// ---------------------------------------------------------------------------

/**
 * Races a Supabase auth promise against a hard timeout so that a dropped
 * mobile connection (no TCP RST, no rejection) cannot hold loading=true
 * forever.  Rejects with 'auth_read_timeout' which isNetworkError() maps
 * to BootstrapErrorKind 'network_error' → gates show retry UI.
 */
function withAuthTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error('auth_read_timeout')),
        AUTH_READ_TIMEOUT_MS,
      )
    ),
  ])
}

/**
 * Loads (or re-loads) the current session and profile.
 * Multiple concurrent callers share the same in-flight promise.
 *
 * Recovery paths:
 *   - invalid_session / deleted_user → clear all local state, route to /login
 *   - missing_profile → ensureProfileExists creates the row, continue normally
 *   - missing_role → role is null, gates redirect to /onboarding/role
 *   - network_error → surface retry-able error to gates
 */
export async function refreshSession(): Promise<void> {
  if (refreshPromise) return refreshPromise

  const myGeneration = ++refreshGeneration

  refreshPromise = (async () => {
    // A warm re-validate on an already-valid session must stay invisible:
    // setting loading=true here would make loading-gated consumers
    // (PersistentTabs, route gates) drop their mounted tree, wiping scroll
    // position, realtime subscriptions and component state on every resume /
    // visibilitychange / token refresh. Only the cold start (sessionValidated
    // still false) shows the skeleton; the success block below sets the final
    // loading:false + sessionValidated:true once validation completes.
    state = { ...state, loading: state.sessionValidated ? false : true, error: null, errorKind: null }
    notify()

    try {
      // Single-flight seam (auth/authSingleFlight.ts): shares ONE underlying
      // getSession() with the repository-init paths so parallel boot/resume
      // readers cannot steal the navigator.locks auth lock from each other
      // (Sentry P0 'AbortError: Lock was stolen by another request').
      const {
        data: { session },
        error: sessionError,
      } = await withAuthTimeout(getAuthSession())

      if (sessionError) throw sessionError

      if (refreshGeneration !== myGeneration) {
        await (refreshPromise ?? Promise.resolve())
        return
      }

      const user = session?.user ?? null

      if (!user) {
        state = { ...EMPTY_SESSION }
        persistSessionSnapshot(state)
        notify()
        return
      }

      // Validate the token against the server.
      // getSession() returns the locally-cached JWT without checking the server;
      // getUser() makes a round-trip and catches stale / revoked / deleted sessions.
      // getUser() also contends for the auth lock — a stolen lock here would
      // classify as unknown_error and wipe the cached user (visible logout
      // flash). Retried exactly once; NOT single-flighted so the
      // forceRefreshSession() force-fresh semantics stay intact.
      const { data: userData, error: userError } = await withAuthTimeout(
        retryOnAuthLockStolen(() => supabase.auth.getUser()),
      )

      if (refreshGeneration !== myGeneration) {
        await (refreshPromise ?? Promise.resolve())
        return
      }

      if (userError || !userData?.user) {
        const kind = userError ? classifyError(userError) : 'invalid_session'
        if (kind === 'network_error') {
          // Network is down but the local session might still be valid once
          // connectivity returns — surface a retry-able error.
          const message = extractErrorMessage(userError, 'Session-Laden fehlgeschlagen')
          state = { ...state, loading: false, error: message, errorKind: 'network_error' }
          notify()
          return
        }
        // Token / user is genuinely invalid → full local reset.
        await performInvalidSessionRecovery()
        return
      }

      const validatedUser = userData.user

      // Guarantee a profile row exists before querying it. The row is
      // created by the on_auth_user_created trigger (SECURITY DEFINER) — this
      // SELECT just confirms the trigger committed. Right after signup the
      // trigger may not have propagated yet, so we retry once with a short delay.
      try {
        await ensureProfileExists(validatedUser.id)
      } catch (profileCreateErr: unknown) {
        if (isNetworkError(profileCreateErr) || isAuthError(profileCreateErr)) throw profileCreateErr
        // Single retry — profile creation can fail transiently right after
        // signup when the auth user row is still being committed.
        await new Promise((r) => setTimeout(r, 500))
        try {
          await ensureProfileExists(validatedUser.id)
        } catch (retryErr: unknown) {
          if (isAuthError(retryErr)) throw retryErr
          const message = extractErrorMessage(retryErr, 'Profil konnte nicht erstellt werden')
          // Auth succeeded — keep the user authenticated so gates can show a
          // retry screen instead of bouncing to login.  Previously this set
          // EMPTY_SESSION which cleared the user and caused the login loop.
          state = {
            user: validatedUser,
            role: null,
            craftsmanRole: null,
            isOperator: false,
            tosAcceptedAt: null,
            loading: false,
            sessionValidated: true,
            error: message,
            errorKind: 'profile_create_failed',
          }
          persistSessionSnapshot(state)
          notify()
          return
        }
      }

      let profile
      try {
        profile = await getMyProfile()
      } catch (profileLoadErr: unknown) {
        if (isNetworkError(profileLoadErr) || isAuthError(profileLoadErr)) throw profileLoadErr

        // Check for schema mismatch (e.g. missing columns like guided_entry_state)
        if (isProfileSchemaMismatch(profileLoadErr)) {
          const message = extractErrorMessage(profileLoadErr, 'Profil-Schema stimmt nicht überein')
          state = {
            ...EMPTY_SESSION,
            error: message,
            errorKind: 'profile_schema_mismatch',
          }
          persistSessionSnapshot(state)
          notify()
          return
        }

        // Single retry for profile load — same transient-timing reasoning.
        await new Promise((r) => setTimeout(r, 500))
        try {
          profile = await getMyProfile()
        } catch (retryErr: unknown) {
          if (isAuthError(retryErr)) throw retryErr

          const errorKind: BootstrapErrorKind = isProfileSchemaMismatch(retryErr)
            ? 'profile_schema_mismatch'
            : 'profile_load_failed'
          const message = extractErrorMessage(retryErr, 'Profil konnte nicht geladen werden')
          // Auth succeeded — keep the user authenticated so gates can show a
          // retry screen instead of bouncing to login.  Previously this set
          // EMPTY_SESSION which cleared the user and caused the login loop.
          state = {
            user: validatedUser,
            role: null,
            craftsmanRole: null,
            isOperator: false,
            tosAcceptedAt: null,
            loading: false,
            sessionValidated: true,
            error: message,
            errorKind,
          }
          persistSessionSnapshot(state)
          notify()
          return
        }
      }

      // Hydrate guided-entry from Supabase (canonical source) on every refresh
      hydrateFromProfile(profile.guided_entry_state)

      // Hydrate the customer's display name + city from the CANONICAL personal
      // data record (customer_billing_profiles). The in-memory context store is
      // only a projection of it — never a second source of truth. Fire-and-forget
      // so it never blocks session init; a missing/empty profile simply means no
      // name is shown yet (honest, no fallback). The full legal name lives in
      // billingName; the greeting derives the first name from it.
      if (profile.role === 'customer') {
        void getCustomerBillingProfileByUserId(validatedUser.id)
          .then((billing) => {
            updateCustomerContext({
              displayName: (billing?.billingName ?? '').trim(),
              city: (billing?.billingCity ?? '').trim(),
            })
          })
          .catch(() => {
            /* non-blocking — projection stays empty until the profile loads */
          })
        // Load previously uploaded avatar — fire-and-forget, must not block session init.
        void loadCustomerAvatarFromStorage(validatedUser.id).then((avatarUrl) => {
          if (avatarUrl) updateCustomerContext({ avatarUrl })
        })
      }

      // Refresh the moderation block cache so selectors can filter synchronously.
      // Fire-and-forget; failure must not break session init.
      void refreshBlockCache().catch(() => { /* non-critical */ })

      // Persist signup ToS acceptance before broadcasting state. Only applied when
      // the pending email matches the validated user — prevents cross-account
      // contamination from stale flags. Always cleared after first check.
      //
      // #1 re-acceptance chokepoint: a persisted acceptance stamped BEFORE
      // TOS_REACCEPT_AFTER is treated as null here so the existing ToS gate
      // (App.tsx / AuthGate.tsx, which already react to null) forces re-consent —
      // no gate-component change. Dormant (TOS_REACCEPT_AFTER=null) → byte-identical
      // (raw returned unchanged); fail-open on a malformed timestamp. A just-
      // completed acceptTos() below overrides with a fresh now(), never stale.
      const rawTosAcceptedAt = profile.tos_accepted_at
      let tosAcceptedAt = isTosAcceptanceStale(rawTosAcceptedAt) ? null : rawTosAcceptedAt
      if (pendingTosEmail) {
        const expectedEmail = pendingTosEmail
        pendingTosEmail = null
        if (expectedEmail === validatedUser.email) {
          try {
            await acceptTos()
            tosAcceptedAt = new Date().toISOString()
          } catch { /* non-critical — TosGateScreen enforces as fallback */ }
        }
      }

      if (refreshGeneration !== myGeneration) {
        await (refreshPromise ?? Promise.resolve())
        return
      }

      state = {
        user: validatedUser,
        role: profile.role,
        craftsmanRole: profile.craftsman_role,
        isOperator: profile.is_operator,
        tosAcceptedAt,
        loading: false,
        sessionValidated: true,
        error: null,
        errorKind: null,
      }
      persistSessionSnapshot(state)
      notify()
    } catch (e: unknown) {
      // A newer refresh (forceRefreshSession, sign-out, or user switch) has
      // taken over — join it so callers await the real completion instead of
      // observing a false early resolution with stale session data.
      if (refreshGeneration !== myGeneration) {
        await (refreshPromise ?? Promise.resolve())
        return
      }

      const kind = classifyError(e)
      if (kind === 'invalid_session' || kind === 'deleted_user') {
        // Auth / profile call was rejected — the session is no longer valid.
        await performInvalidSessionRecovery()
        return
      }

      const message = extractErrorMessage(e, 'Session-Laden fehlgeschlagen')
      if (kind === 'network_error') {
        // Network is down — keep cached user visible so gates can show a
        // retry screen, but do NOT mark the session as validated.
        state = { ...state, loading: false, error: message, errorKind: kind }
      } else {
        // Unknown / unclassified error — clear cached user to prevent
        // post-auth routing with an unvalidated session.
        state = { ...EMPTY_SESSION, error: message, errorKind: kind }
        persistSessionSnapshot(state)
      }
      notify()
    } finally {
      refreshPromise = null
    }
  })()

  return refreshPromise
}

/**
 * Forces a fresh session refresh, cancelling any in-flight refresh promise.
 *
 * Used by the onAuthStateChange handler for SIGNED_IN events — particularly
 * after Supabase processes an email-confirmation or magic-link callback.
 * The previous in-flight refresh may have read stale/empty data before the
 * callback token exchange completed, so we must discard it and start fresh.
 */
export async function forceRefreshSession(): Promise<void> {
  // Discard any in-flight promise so the next refreshSession() starts fresh.
  // The shared getSession single-flight is invalidated too: joining a read
  // that started BEFORE the auth-callback token exchange (or token refresh)
  // completed would return the stale pre-exchange session — the exact race
  // forceRefreshSession() exists to prevent.
  invalidateAuthSessionSingleFlight()
  refreshPromise = null
  return refreshSession()
}

// ---------------------------------------------------------------------------
// Auth callback detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the current URL contains Supabase auth callback parameters.
 *
 * Supabase email-confirmation and magic-link redirects append either:
 *   - Hash fragments: `#access_token=…&type=signup` (implicit flow)
 *   - Query params:   `?code=…` (PKCE flow)
 *
 * When these are present, the Supabase client's internal `_initialize()` method
 * is processing the token exchange asynchronously.  Calling `getSession()` or
 * `getUser()` before that exchange completes will return stale/empty data and
 * can trigger the generic error screen or invalid-session recovery — killing
 * the session that Supabase is in the middle of establishing.
 */
export function hasAuthCallbackParams(): boolean {
  if (typeof window === 'undefined') return false

  const hash = window.location.hash
  if (hash && /access_token=/.test(hash)) return true

  const params = new URLSearchParams(window.location.search)
  if (params.has('code')) return true

  return false
}

// ---------------------------------------------------------------------------
// Password-recovery flag
// ---------------------------------------------------------------------------
//
// Supabase establishes a real session for recovery URLs but the only legitimate
// next action is updateUser({ password }).  Without an explicit flag the rest
// of the app cannot distinguish a recovery session from a normal sign-in and
// would route the user into the gates as if they had logged in — bypassing the
// password-set step entirely.
//
// The flag is captured from three sources, in priority order:
//   1. URL hash (`type=recovery`) at module load — runs synchronously BEFORE
//      Supabase strips the fragment, so a deep-link cold start is covered.
//   2. Persisted sessionStorage entry — survives the reload that happens when
//      the native deep-link handler navigates to /auth/reset-password.
//   3. Supabase `PASSWORD_RECOVERY` event in onAuthStateChange (warm-start).
//
// Cleared on SIGNED_OUT and explicitly by clearPasswordRecovery() once the
// password update succeeds.

const PASSWORD_RECOVERY_FLAG_KEY = 'fixup.auth.password_recovery'

let recoveryActive = false

function urlIndicatesRecovery(): boolean {
  if (typeof window === 'undefined') return false
  const haystack = `${window.location.hash}&${window.location.search}`
  return /[?#&]type=recovery(?:&|$)/.test(haystack)
}

function persistRecoveryFlag(value: boolean): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    if (value) sessionStorage.setItem(PASSWORD_RECOVERY_FLAG_KEY, '1')
    else sessionStorage.removeItem(PASSWORD_RECOVERY_FLAG_KEY)
  } catch {
    // Best-effort — private mode / quota.
  }
}

function readPersistedRecoveryFlag(): boolean {
  if (typeof sessionStorage === 'undefined') return false
  try {
    return sessionStorage.getItem(PASSWORD_RECOVERY_FLAG_KEY) === '1'
  } catch {
    return false
  }
}

// Synchronous capture at module load. Must run before Supabase's async URL
// detection strips the fragment.
recoveryActive = urlIndicatesRecovery() || readPersistedRecoveryFlag()
if (recoveryActive) persistRecoveryFlag(true)

// Native cold-start: the WebView reload triggered by routeDeepLink may not
// preserve the URL fragment for Supabase's detectSessionInUrl to consume.
// bootstrap.ts stashes the original hash into sessionStorage; if the live
// URL no longer carries the recovery tokens, re-apply them via setSession so
// the recovery session is established deterministically.
function restoreRecoveryHashIfStashed(): void {
  if (typeof window === 'undefined' || typeof sessionStorage === 'undefined') return
  let stash: string | null = null
  try {
    stash = sessionStorage.getItem('fixup.auth.recovery_hash')
  } catch {
    return
  }
  if (!stash) return
  // One-shot consume — clear immediately so subsequent reloads don't loop.
  try { sessionStorage.removeItem('fixup.auth.recovery_hash') } catch { /* ignore */ }
  // If Supabase already sees the tokens in the URL fragment, let its own
  // detectSessionInUrl flow handle establishment (and fire PASSWORD_RECOVERY).
  if (/access_token=/.test(window.location.hash)) return
  const params = new URLSearchParams(stash.startsWith('#') ? stash.slice(1) : stash)
  const access_token = params.get('access_token')
  const refresh_token = params.get('refresh_token')
  if (!access_token || !refresh_token) return
  void supabase.auth.setSession({ access_token, refresh_token }).catch((e: unknown) => {
    logWarning('session.recovery.setSession_failed', { error: String(e) })
  })
}

if (recoveryActive) restoreRecoveryHashIfStashed()

export function isPasswordRecoveryActive(): boolean {
  return recoveryActive
}

export function clearPasswordRecovery(): void {
  recoveryActive = false
  persistRecoveryFlag(false)
  if (typeof sessionStorage !== 'undefined') {
    try { sessionStorage.removeItem('fixup.auth.recovery_hash') } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Auth-state listener — auto-refresh on login / logout
// ---------------------------------------------------------------------------

supabase.auth.onAuthStateChange((event, session) => {
  const user = session?.user ?? null

  // Latch the recovery flag the moment Supabase confirms a recovery session.
  // Covers the warm-start case where the URL was processed after module load.
  if (event === 'PASSWORD_RECOVERY') {
    recoveryActive = true
    persistRecoveryFlag(true)
  }

  // Quick synchronous update for user, then full refresh for profile
  if (!user) {
    // During initial startup the Supabase client may fire INITIAL_SESSION
    // with no user while refreshSession() is still running.  If a refresh
    // is in-flight and this isn't an explicit sign-out, let the refresh
    // determine the final state — don't prematurely clear to EMPTY_SESSION
    // which causes a brief flash of the unauthenticated landing screen.
    if (event !== 'SIGNED_OUT' && refreshPromise) return

    // Recovery is bound to a single session — sign-out ends the flow.
    recoveryActive = false
    persistRecoveryFlag(false)
    if (typeof sessionStorage !== 'undefined') {
      try { sessionStorage.removeItem('fixup.auth.recovery_hash') } catch { /* ignore */ }
    }

    // Drop any in-flight shared getSession read so a caller arriving after
    // this sign-out cannot join a pre-sign-out read and observe the previous
    // user's session (the slot never caches results, this only narrows the
    // in-flight window).
    invalidateAuthSessionSingleFlight()

    state = { ...EMPTY_SESSION }
    clearSentryUser()
    persistSessionSnapshot(state)
    resetGuidedEntry()
    resetCustomerContext()
    // Server-initiated sign-out (token revoke / expiry / other-device) lands
    // ONLY here — never in auth.ts#signOut — so sweep the user-private composer
    // drafts (chat + quote/change-order/dispute) so they cannot surface for the
    // next account on a shared device. Gated to the explicit SIGNED_OUT event:
    // a no-user INITIAL_SESSION (e.g. an expired session on cold start) must
    // NOT wipe a still-pending draft. Idempotent with the auth.ts sweep.
    if (event === 'SIGNED_OUT') sweepAllDraftKeys()
    // Clear the active-user tag so new mutations are not attributed to the
    // signed-out user. The queue itself is preserved — the same user signing
    // back in will replay their own mutations. Cross-user mutations are
    // filtered inside flushPendingMutations() via userId comparison.
    setActiveMutationUser(null)
    // Reset company membership + join code caches so a subsequent sign-in
    // does not see stale data from the previous session.
    invalidateWorkerMembershipCache()
    resetOwnerJoinCodeFlag()
    notify()
    // Clear all in-memory repository caches so a subsequent user cannot
    // see stale data from this session.  Most repos have no internal auth
    // listener and will retain the previous user's data indefinitely
    // without this call.  Non-fatal: a failure here must not block the
    // logout state transition.
    resetInAppNotificationRepository()
    stopNotificationBridge()
    // Drop persistence failures + recovery flag immediately so a subsequent
    // user does not inherit the previous session's banner state.  The
    // failure store is RAM-only (lives across sign-out via WebView reuse)
    // and the recovery flag is reference-counted, so an outstanding resume
    // cycle from before sign-out would otherwise keep the SyncStatusBar
    // suppressed for the next user.  The inflightResume slot is invalidated
    // for the same reason — the next resume must spawn a fresh cycle.
    clearPersistenceFailures()
    clearRecoveryStatus()
    inflightResume = null
    inflightResumeOwner = null
    // Invalidate any in-flight resync wave so a subsequent SIGNED_IN for the
    // same UID cannot reuse a pre-sign-out wave that loaded stale/cleared data.
    activeResyncWave = null
    signinFollowupPending = false
    activeResyncWaveUid = null
    void resyncRepositories().catch((e: unknown) => {
      console.warn('[SaFix] Repository reset after sign-out failed (non-fatal):', e)
    })
  } else {
    // Tag new mutations with this user's id so the flush path can skip
    // mutations that belong to a different (previous) user's session.
    setActiveMutationUser(user.id)

    // USER_UPDATED fires after updateUser({ password }) in the password-reset
    // flow.  PasswordResetScreen immediately calls signOut() after this event —
    // running refreshSession() here races with that signOut(): hydrateFromProfile
    // notifies subscribeGuidedEntry listeners mounted by PersistentTabs, which
    // can trigger profile upserts whose HTTP requests arrive after localStorage is
    // cleared → anonymous request → "new row violates RLS policy for profiles".
    // Skipping the refresh is safe: the session is about to be destroyed anyway.
    if (event === 'USER_UPDATED' && recoveryActive) return

    if (event === 'SIGNED_IN') {
      // Same-user SIGNED_IN re-fire (token recovery on every foreground / tab
      // refocus — see the resetCustomerContext note below): supabase-js re-emits
      // SIGNED_IN for the already-signed-in user. Resetting sessionValidated +
      // running the full repository resync here unmounts the entire tab tree
      // (PersistentTabs) and blocks for seconds re-initialising 26 repos — the
      // "app reloads and hangs on a quick background→foreground" symptom. For an
      // already-validated SAME user there is nothing to load and the token that
      // triggered this event is already fresh: keep the warm session mounted and
      // skip the teardown + resync. handleAppResume() still runs its (debounced)
      // resync + warm refreshSession() on resume. A genuine account switch
      // (different id) or an unvalidated session falls through to the full cold
      // path below, so cross-account isolation is unchanged.
      if (state.user?.id === user.id && state.sessionValidated) {
        setSentryUser(user.id)
        return
      }
      // New sign-in: reset all session data to prevent stale role /
      // craftsmanRole / sessionValidated from a previous session from
      // leaking through and causing gates to briefly route based on
      // old cached data.
      // Also reset company membership + join code caches so the incoming
      // user does not inherit the previous session's resolved state.
      setSentryUser(user.id)
      invalidateWorkerMembershipCache()
      resetOwnerJoinCodeFlag()
      // Only reset customer context when the user account actually changes.
      // SIGNED_IN can re-fire during token refresh / tab refocus for the same
      // user — unconditionally resetting here would wipe in-flight prefill data.
      if (state.user?.id !== user.id) resetCustomerContext()
      state = {
        user,
        role: null,
        craftsmanRole: null,
        isOperator: false,
        tosAcceptedAt: null,
        loading: true,
        sessionValidated: false,
        error: null,
        errorKind: null,
      }
    } else {
      // Other events (TOKEN_REFRESHED, USER_UPDATED, etc.): keep existing
      // role / session data while the refresh runs. Same warm-revalidate guard
      // as refreshSession(): only flip loading when the session was never
      // validated, so a token refresh on a live session does not unmount tabs.
      state = { ...state, user, loading: state.sessionValidated ? false : true, error: null, errorKind: null }
    }
    notify()

    // TOKEN_REFRESHED: identity unchanged — force-refresh the session token only.
    // Other non-SIGNED_IN events: standard session refresh.
    // SIGNED_IN: handled below (repos load first, then session validates).
    if (event === 'TOKEN_REFRESHED') {
      void forceRefreshSession()
    } else if (event !== 'SIGNED_IN') {
      void refreshSession()
    }

    // On a new sign-in, load repository caches BEFORE allowing gates to open.
    //
    // Sequencing: resyncRepositories() runs first so that all in-memory caches
    // hold the incoming user's data (RLS enforces correct DB filtering).
    // forceRefreshSession() fires in .finally() — sessionValidated becomes true
    // only after repos are populated, preventing a cross-account window where
    // User B's gates open while caches still hold User A's data.
    //
    // TOKEN_REFRESHED is excluded — user identity is unchanged.
    //
    // Guard: signinResyncInFlight prevents a second parallel full-resync when
    // Supabase re-emits SIGNED_IN while the first reload is still in flight.
    // The .finally() block always clears the guard — no deadlock on error.
    if (event === 'SIGNED_IN') {
      // If a wave is already running for a different user, discard it so
      // User B does not inherit User A's resync result or follow-up callbacks.
      if (activeResyncWave && activeResyncWaveUid !== user.id) {
        activeResyncWave = null
        signinFollowupPending = false
        activeResyncWaveUid = null
      }
      activeResyncWaveUid = user.id

      // Start or join the shared wave. If one is already running for the same
      // user (e.g. from a visibility/online-triggered tryResync), join it rather
      // than spawning a second resyncRepositories() call.
      //
      // signinFollowupPending ensures startNotificationBridge/forceRefreshSession
      // fire exactly once per wave even when Supabase re-emits SIGNED_IN.
      const wave = getOrStartResyncWave()
      if (!signinFollowupPending) {
        signinFollowupPending = true
        const capturedUid = user.id
        void wave.finally(() => {
          // Skip if a different user has taken over since this callback was registered.
          if (state.user?.id !== capturedUid) return
          startNotificationBridge()
          void forceRefreshSession()
        })
      }
      // In-app notifications sit outside the generic resync path because
      // their initialize() takes an explicit userId.  Reload here so the
      // incoming user sees their own notifications immediately.
      void initializeInAppNotificationRepository(user.id).catch((e: unknown) => {
        console.warn('[SaFix] In-app notification reinitialize after sign-in failed (non-fatal):', e)
      })
    }
  }
})

// Kick off initial load — but defer when callback params are present.
// When callback params exist, the Supabase client is processing the token
// exchange.  The onAuthStateChange listener will fire SIGNED_IN once that
// exchange completes, which calls forceRefreshSession().
if (!hasAuthCallbackParams()) {
  void refreshSession()
} else {
  // Keep loading indicator visible while the callback is processed.
  state = { ...state, loading: true }
  notify()
}

// On foreground/resume or connectivity restore: delegate to handleAppResume
// so the realtime cascade, resync wave, and session refresh are folded into
// a single recovery cycle.  iOS WKWebView fires up to all three of these
// events for a single user resume — handleAppResume dedupes them into one
// banner-suppression window so the SyncStatusBar does not flash a stale
// failure during the resume → flush → resync transition.
if (!visibilityListenerBound && typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void handleAppResume('visibility')
    }
  })
  if (typeof window !== 'undefined') {
    window.addEventListener('fixup:app-resume', () => { void handleAppResume('native') })
    window.addEventListener('online', () => { void handleAppResume('online') })
  }
  visibilityListenerBound = true
  // Arm the media-outbox drain triggers at BOOTSTRAP, not first-send/resume:
  // after an app-kill mid-send the cold-start rehydration nudge
  // (requestOutboxDrain → CHAT_OUTBOX_DRAIN_EVENT) must find its listener
  // installed, or the queued record sits until the next resume. The direct
  // drain kick covers a nudge that fired before this module loaded — cheap
  // no-op when the queue is empty.
  startMediaOutboxAutoDrain()
  void drainMediaOutbox()
}
