/**
 * Attribution-Block → UI-State Mapping.
 *
 * Every money-moving client path (create-escrow, initiate-funding,
 * initiate-supplementary-funding, release-tranche, release-supplementary-payout)
 * receives a 402 with one of five canonical error codes when the server's
 * Attribution Guard blocks a request.  This module is the single source of
 * truth that turns those codes into a fachlicher UI-State with pre-mapped
 * German copy, retryable flag, and an optional CTA.
 *
 * Keep this mapper in sync with api/_attributionGuard.ts `attributionGateToHttpResponse`.
 * Screens MUST NOT render raw server messages for attribution blocks — they
 * consume `AttributionBlockInfo` instead.
 */

// ── Canonical error codes ───────────────────────────────────────────────────

export const ATTRIBUTION_BLOCK_ERROR_CODES = [
  'PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED',
  'PAYMENT_BLOCKED_ATTRIBUTION_DLQ',
  'PAYMENT_BLOCKED_ATTRIBUTION_INVALID',
  'PAYMENT_BLOCKED_JOB_NOT_FOUND',
  'ATTRIBUTION_LOOKUP_FAILED',
] as const

export type AttributionBlockErrorCode = typeof ATTRIBUTION_BLOCK_ERROR_CODES[number]

// ── UI-state discriminants ──────────────────────────────────────────────────

export type AttributionBlockKind =
  | 'unresolved'    // PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED — retry after short delay
  | 'dlq'           // PAYMENT_BLOCKED_ATTRIBUTION_DLQ         — operator review in progress
  | 'invalid'       // PAYMENT_BLOCKED_ATTRIBUTION_INVALID     — contract mismatch (support)
  | 'job_not_found' // PAYMENT_BLOCKED_JOB_NOT_FOUND           — stale link (dismiss)
  | 'lookup_failed' // ATTRIBUTION_LOOKUP_FAILED               — server error, retry

export type AttributionBlockCtaAction = 'retry' | 'support' | 'dismiss'

export interface AttributionBlockCta {
  label: string
  action: AttributionBlockCtaAction
}

export interface AttributionBlockInfo {
  /** Canonical server error code (null when inferred from statusCode=500). */
  code: AttributionBlockErrorCode | null
  /** High-level bucket the UI switches on. */
  kind: AttributionBlockKind
  /** True only when retrying within a short window has a real chance of success. */
  retryable: boolean
  /** Short fachliche title for state cards / banners. */
  title: string
  /** Longer message explaining what's happening without leaking backend detail. */
  message: string
  /** Hint for automatic retry scheduling (seconds). Null when non-retryable. */
  retryAfterSeconds: number | null
  /** Suggested call-to-action. Null when no meaningful action exists. */
  cta: AttributionBlockCta | null
  /** Job id echoed by the server (forensic). */
  jobId: string | null
  /** attribution_status snapshot if the server included one. */
  attributionStatus: string | null
  /** DLQ reason from the server (only for kind='dlq'). */
  dlqReason: string | null
}

// ── Server payload shape (defensive, all optional) ──────────────────────────

export interface AttributionBlockServerBody {
  error?: string
  message?: string
  retryable?: boolean
  jobId?: string
  attributionStatus?: string
  commercialOrigin?: string | null
  dlqReason?: string | null
}

// ── Detection ────────────────────────────────────────────────────────────────

export function isAttributionBlockCode(code: unknown): code is AttributionBlockErrorCode {
  return typeof code === 'string'
    && (ATTRIBUTION_BLOCK_ERROR_CODES as readonly string[]).includes(code)
}

export function isAttributionBlockError(body: unknown): body is AttributionBlockServerBody {
  if (!body || typeof body !== 'object') return false
  return isAttributionBlockCode((body as { error?: unknown }).error)
}

// ── Mapping ─────────────────────────────────────────────────────────────────

/**
 * Builds the UI-state descriptor for a given server 402 body.
 *
 * The mapper is pure and deterministic — same input produces the same
 * AttributionBlockInfo every time.  Screens can compare info.code or info.kind
 * to decide rendering without parsing any backend strings.
 */
export function buildAttributionBlockInfo(
  body: AttributionBlockServerBody,
): AttributionBlockInfo {
  const code = isAttributionBlockCode(body.error) ? body.error : null
  const jobId = typeof body.jobId === 'string' ? body.jobId : null
  const attributionStatus = typeof body.attributionStatus === 'string' ? body.attributionStatus : null
  const dlqReason = typeof body.dlqReason === 'string' ? body.dlqReason : null

  switch (code) {
    case 'PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED':
      return {
        code,
        kind: 'unresolved',
        retryable: true,
        title: 'Provisions­prüfung läuft',
        message:
          'Die Provisions­zuordnung für diesen Auftrag wird noch geprüft. Das dauert meist nur wenige Sekunden. Bitte in einem Moment erneut versuchen.',
        retryAfterSeconds: 30,
        cta: { label: 'Erneut versuchen', action: 'retry' },
        jobId,
        attributionStatus,
        dlqReason: null,
      }
    case 'PAYMENT_BLOCKED_ATTRIBUTION_DLQ':
      return {
        code,
        kind: 'dlq',
        retryable: false,
        title: 'Manuelle Prüfung läuft',
        message:
          'Dieser Auftrag wird von unserem Team geprüft. Die Zahlung kann in diesem Moment nicht freigegeben werden. Wir melden uns, sobald es weitergeht — erneutes Versuchen ändert nichts.',
        retryAfterSeconds: null,
        cta: { label: 'Support kontaktieren', action: 'support' },
        jobId,
        attributionStatus: 'dlq',
        dlqReason,
      }
    case 'PAYMENT_BLOCKED_ATTRIBUTION_INVALID':
      return {
        code,
        kind: 'invalid',
        retryable: false,
        title: 'Zahlung blockiert',
        message:
          'Die Provisions­zuordnung ist abgeschlossen, aber nicht eindeutig. Bitte Support kontaktieren, um die Zahlung freizugeben.',
        retryAfterSeconds: null,
        cta: { label: 'Support kontaktieren', action: 'support' },
        jobId,
        attributionStatus,
        dlqReason: null,
      }
    case 'PAYMENT_BLOCKED_JOB_NOT_FOUND':
      return {
        code,
        kind: 'job_not_found',
        retryable: false,
        title: 'Auftrag nicht gefunden',
        message:
          'Der Auftrag existiert nicht oder ist nicht mehr verfügbar. Bitte Bildschirm schließen und erneut aus der Übersicht öffnen.',
        retryAfterSeconds: null,
        cta: { label: 'Zurück zur Übersicht', action: 'dismiss' },
        jobId,
        attributionStatus: null,
        dlqReason: null,
      }
    case 'ATTRIBUTION_LOOKUP_FAILED':
      return {
        code,
        kind: 'lookup_failed',
        retryable: true,
        title: 'Prüfung gerade nicht möglich',
        message:
          'Die Provisions­prüfung ist vorübergehend nicht erreichbar. Die Zahlung wurde aus Sicherheits­gründen gestoppt. Bitte in wenigen Momenten erneut versuchen.',
        retryAfterSeconds: 30,
        cta: { label: 'Erneut versuchen', action: 'retry' },
        jobId,
        attributionStatus: null,
        dlqReason: null,
      }
    case null:
    default: {
      // Defensive: treat unknown codes as transient unresolved.  Should be
      // unreachable when callers gate entry through isAttributionBlockError.
      return {
        code: null,
        kind: 'unresolved',
        retryable: true,
        title: 'Provisions­prüfung läuft',
        message:
          'Die Provisions­zuordnung wird geprüft. Bitte in einem Moment erneut versuchen.',
        retryAfterSeconds: 30,
        cta: { label: 'Erneut versuchen', action: 'retry' },
        jobId,
        attributionStatus,
        dlqReason: null,
      }
    }
  }
}

/**
 * Convenience: try to build AttributionBlockInfo from a server response body.
 * Returns null when the body is NOT an attribution block — callers can
 * branch on `info === null` to fall through to their existing generic-error
 * handling.
 */
export function tryAttributionBlockInfo(
  body: unknown,
): AttributionBlockInfo | null {
  if (!isAttributionBlockError(body)) return null
  return buildAttributionBlockInfo(body)
}
