/**
 * Chat-domain typed errors. Lives separate from chatWorkflow to avoid a
 * circular import between Repository ↔ Workflow.
 */

import { isServerSideError } from '../persistence/serverErrors'

export type ChatRBACErrorCode =
  | 'worker_in_customer_channel'
  | 'customer_in_internal_channel'
  | 'thread_not_found'
  | 'no_session'

export class ChatRBACError extends Error {
  readonly code: ChatRBACErrorCode
  constructor(code: ChatRBACErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'ChatRBACError'
  }
}

/**
 * Thrown by Repository.sendMessage when the target thread is still in a
 * pre-migration state (Coexistence-Read fallback). UI must surface a
 * non-blocking "Wird synchronisiert…" indicator and disable the send button
 * until migrationStatus reaches 'migration_complete' or 'migration_verified'.
 *
 * Distinct from `ChatRBACError`: RBAC-rejected sends are permanent (try-again
 * never resolves), migration-pending is transient (cron retries).
 */
export type ChatMigrationPendingErrorCode = 'migration_pending'

export class ChatMigrationPendingError extends Error {
  readonly code: ChatMigrationPendingErrorCode = 'migration_pending'
  readonly threadId: string
  readonly migrationStatus: string
  constructor(threadId: string, migrationStatus: string) {
    super(
      `chat.sendMessage.migration_pending: thread ${threadId} is being synced (${migrationStatus}); try again shortly`,
    )
    this.name = 'ChatMigrationPendingError'
    this.threadId = threadId
    this.migrationStatus = migrationStatus
  }
}

/**
 * Thrown by the attachment uploaders when a Supabase Storage upload fails.
 * Carries the HTTP `status` so the retry layer can distinguish a permanent
 * client rejection (400 mime-not-allowed, 413 too-large, 415 unsupported)
 * from a transient one (network, 5xx, 408/429). `message` is a user-facing
 * German string; `storageReason` keeps the raw storage error for diagnostics
 * so an allowlist regression is never swallowed into a generic message again.
 */
export class ChatStorageUploadError extends Error {
  readonly status: number | null
  readonly storageReason: string
  constructor(message: string, opts: { status?: number | null; storageReason?: string } = {}) {
    super(message)
    this.name = 'ChatStorageUploadError'
    this.status = opts.status ?? null
    this.storageReason = opts.storageReason ?? message
  }
}

// ── Send-error classification ────────────────────────────────────────────────

export type ChatSendErrorClass = 'authz' | 'moderation' | 'transient' | 'unknown'

export interface ClassifiedChatSendError {
  /** User-facing German message — safe to surface directly in a toast. */
  userMessage: string
  /** Whether retrying the IDENTICAL send could ever succeed. A non-retryable
   *  class must never get a retry affordance — it would re-issue the same
   *  doomed write forever (the live "kann keine Nachricht senden" loop). */
  retryable: boolean
  klass: ChatSendErrorClass
  code: string | null
}

const GENERIC_SEND_FAILURE = 'Nachricht konnte nicht gesendet werden.'

/**
 * Map any send-path error to a German user message + a retryability verdict.
 *
 * Distinguishes structurally different failures the send path previously
 * collapsed into one raw (English) toast + an always-on retry that re-issued
 * the identical doomed INSERT:
 *   - RLS authz (42501) / RPC guard (P0001) / 403  → permanent ("nicht senden")
 *   - moderation / content-filter (German plain Error) → permanent, message kept
 *   - network / abort / timeout / offline / migration-pending → retryable
 *   - any other code-carrying server reject → permanent (never loop a retry)
 */
export function classifyChatSendError(error: unknown): ClassifiedChatSendError {
  // Typed chat errors first — authoritative.
  if (error instanceof ChatRBACError) {
    // thread_not_found here means RLS-invisible/deleted AFTER an authoritative
    // server seed (see resolveThreadOrSeed); channel-RBAC + no_session are all
    // permanent at send time.
    return {
      userMessage: 'Du kannst in dieser Unterhaltung gerade nicht senden.',
      retryable: false,
      klass: 'authz',
      code: error.code,
    }
  }
  if (error instanceof ChatMigrationPendingError) {
    return {
      userMessage: 'Unterhaltung wird synchronisiert — bitte gleich erneut senden.',
      retryable: true,
      klass: 'transient',
      code: error.code,
    }
  }
  // Storage upload failure — classify on `.status`, NOT on `.message`: the
  // uploader wraps everything in a user-facing German message, so the
  // English-pattern transient regex below can never match it. Mirrors
  // uploadWithRetry.isRetryable so the retry loop and the outbox/bubble
  // state machine agree: network (0), abort/stall/timeout (null), 408/429
  // and 5xx are transient; any other 4xx (mime, size, RLS 400) is permanent.
  if (error instanceof ChatStorageUploadError) {
    const transient =
      error.status === null ||
      error.status === 0 ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500
    return {
      userMessage: transient ? 'Keine Verbindung — bitte erneut versuchen.' : error.message,
      retryable: transient,
      klass: transient ? 'transient' : 'unknown',
      code: null,
    }
  }

  const e = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>
  const code = typeof e.code === 'string' ? e.code : null
  const status = typeof e.status === 'number' ? e.status : null
  const name = typeof e.name === 'string' ? e.name : null
  const rawMsg = typeof e.message === 'string' ? e.message : ''

  // RLS / authz reject. 42501 = insufficient_privilege (RLS WITH CHECK fail:
  // missing live participant row / moderation gate). P0001 = plpgsql RAISE from
  // the send RPCs (worker-in-customer, not-a-participant, no-session). 403 =
  // PostgREST surface of the same. All permanent — a retry can never succeed.
  if (code === '42501' || code === 'P0001' || status === 403) {
    return {
      userMessage: 'Du kannst in dieser Unterhaltung gerade nicht senden.',
      retryable: false,
      klass: 'authz',
      code,
    }
  }

  // Session not yet resolved (cold-start / push deep-link) — self-resolves once
  // the session module populates. Covers both the workflow's German throw and
  // the repository's `chat.sendMessage: no authenticated session` (English).
  if (/Sitzung wird verbunden|no authenticated session/i.test(rawMsg)) {
    return {
      userMessage: 'Sitzung wird verbunden — bitte gleich erneut senden.',
      retryable: true,
      klass: 'transient',
      code,
    }
  }

  // Network / abort / timeout / offline / connection — the only genuinely
  // retryable class. CRITICAL: postgrest-js maps an aborted fetch (our
  // AbortSignal.timeout) to { code: '' (EMPTY string, not null), message:
  // 'TimeoutError: …' / 'AbortError: …' } with NO top-level `name` — so the
  // empty code and the message prefix are the only signals. PG 08xxx/53xxx/57xxx
  // are connection/resource-exhaustion codes (also transient). OfflineError
  // carries its own German message.
  if (
    code === '' ||
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    name === 'OfflineError' ||
    (code !== null && (code.startsWith('08') || code.startsWith('53') || code.startsWith('57'))) ||
    /AbortError|TimeoutError|signal (is )?aborted|signal timed out|timed out|aborted|Failed to fetch|NetworkError|Load failed|fetch failed|Keine Verbindung|bitte Internet/i.test(rawMsg)
  ) {
    return {
      userMessage: 'Keine Verbindung — bitte erneut versuchen.',
      retryable: true,
      klass: 'transient',
      code,
    }
  }

  // Deterministic server reject — Postgres class 22 (data) / 23 (integrity,
  // incl. 23514 business check) / 42 (syntax/schema). Permanent: replaying the
  // identical write is rejected again. Mirrors the repository's outbox gate
  // (isServerSideError) so the screen and the replay queue agree.
  if (isServerSideError(error)) {
    return { userMessage: GENERIC_SEND_FAILURE, retryable: false, klass: 'unknown', code }
  }

  // Any other code-carrying error → non-retryable generic (never loop a retry
  // on an unknown server reject).
  if (code !== null) {
    return { userMessage: GENERIC_SEND_FAILURE, retryable: false, klass: 'unknown', code }
  }

  // Code-less plain Error: the workflow's moderation / content-filter throws
  // carry an already-user-facing German message — trust it; permanent.
  return {
    userMessage: rawMsg || GENERIC_SEND_FAILURE,
    retryable: false,
    klass: 'moderation',
    code: null,
  }
}
