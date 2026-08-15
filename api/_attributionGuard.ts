/**
 * Shared Attribution Gate — single source of truth for all payment surfaces.
 *
 * Every server path that moves money (create escrow, initiate supplementary
 * funding, release escrow tranche, release supplementary payout) MUST pass
 * through `assertAttributionFinalized` before invoking Stripe.  No Stripe call
 * may be issued while `jobs.attribution_status` is anything other than
 * `'finalized'` with a valid `commercial_origin`.
 *
 * Fail closed:
 *   - Missing job row → JOB_NOT_FOUND
 *   - attribution_status = 'dlq' → ATTRIBUTION_DLQ (terminal, operator must resolve)
 *   - attribution_status = 'pending' | 'retrying' | null → ATTRIBUTION_UNRESOLVED (retryable)
 *   - attribution_status = 'finalized' but commercial_origin not in
 *     ('merchant_brought' | 'platform_acquired') → ATTRIBUTION_INVALID
 *   - DB lookup failure → DB_ERROR (release blocked for safety)
 *
 * The `dlq` state is recognised even before the DB CHECK constraint is
 * widened (Stage 2 migration adds it) — reading an unknown value returns a
 * non-finalized branch, which the guard already blocks.  Once the CHECK
 * constraint is in place, `dlq` becomes a first-class terminal state.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logError, logWarning } from './_observability.js'

// ── Result contract ──────────────────────────────────────────────────────────

export type AttributionGateBlocked =
  | { ok: false; code: 'JOB_NOT_FOUND'; jobId: string }
  | { ok: false; code: 'ATTRIBUTION_UNRESOLVED'; jobId: string; attributionStatus: string }
  | { ok: false; code: 'ATTRIBUTION_DLQ'; jobId: string; dlqReason: string | null }
  | { ok: false; code: 'ATTRIBUTION_INVALID'; jobId: string; commercialOrigin: string | null }
  | { ok: false; code: 'DB_ERROR'; jobId: string; message: string }

export type AttributionGateResult =
  | { ok: true; jobId: string; commercialOrigin: 'merchant_brought' | 'platform_acquired' }
  | AttributionGateBlocked

// ── Guard ────────────────────────────────────────────────────────────────────

/**
 * Verifies that the given job is safe for payment / payout.
 *
 * Returns a typed result the caller can map to an HTTP response (see
 * {@link attributionGateToHttpResponse}).  Callers MUST branch on `ok` and
 * return the mapped response when `ok === false` — never fall through.
 */
export async function assertAttributionFinalized(
  supabase: SupabaseClient,
  rawJobId: string,
  /** Observability prefix, e.g. 'api.release_tranche' or 'supplementary_release'. */
  logPrefix: string,
): Promise<AttributionGateResult> {
  const jobId = typeof rawJobId === 'string' ? rawJobId.trim() : ''
  if (!jobId) {
    logWarning(`${logPrefix}.attribution_job_id_missing`, { rawJobId })
    return { ok: false, code: 'JOB_NOT_FOUND', jobId }
  }

  const { data, error } = await supabase
    .from('jobs')
    .select('id, commercial_origin, attribution_status, attribution_dlq_reason')
    .eq('id', jobId)
    .maybeSingle()

  if (error) {
    logError(`${logPrefix}.attribution_lookup_failed`, error, { jobId })
    return { ok: false, code: 'DB_ERROR', jobId, message: error.message }
  }

  if (!data) {
    logWarning(`${logPrefix}.attribution_job_not_found`, { jobId })
    return { ok: false, code: 'JOB_NOT_FOUND', jobId }
  }

  const status = data.attribution_status as string | null

  // DLQ: terminal manual-review state.  Returned as a distinct code so the UI
  // can surface "manual review required" instead of an auto-retry hint.
  if (status === 'dlq') {
    const dlqReason = (data.attribution_dlq_reason as string | null) ?? null
    logWarning(`${logPrefix}.attribution_dlq`, { jobId, dlqReason })
    return { ok: false, code: 'ATTRIBUTION_DLQ', jobId, dlqReason }
  }

  if (status !== 'finalized') {
    logWarning(`${logPrefix}.attribution_unresolved`, {
      jobId,
      attributionStatus: status ?? 'null',
    })
    return {
      ok: false,
      code: 'ATTRIBUTION_UNRESOLVED',
      jobId,
      attributionStatus: status ?? 'null',
    }
  }

  // Finalized + origin validity invariant.  A `finalized` row with an
  // invalid origin is a data-corruption signal (migration 20260410000003
  // was supposed to prevent this).  Block and alert — never silently fall
  // back to the safe default fee rate, because that would grant money
  // movement on an unverified origin.
  const origin = data.commercial_origin as string | null
  if (origin !== 'merchant_brought' && origin !== 'platform_acquired') {
    logError(`${logPrefix}.attribution_origin_invalid`, undefined, {
      jobId,
      commercialOrigin: origin,
      action: 'payment_blocked — data invariant violation, investigate finalized+NULL rows',
    })
    return { ok: false, code: 'ATTRIBUTION_INVALID', jobId, commercialOrigin: origin }
  }

  return { ok: true, jobId, commercialOrigin: origin }
}

// ── HTTP mapping ─────────────────────────────────────────────────────────────

/**
 * Canonical HTTP response for each blocked branch.  Every API endpoint that
 * uses {@link assertAttributionFinalized} MUST surface the user-facing error
 * through this mapping so the mobile client sees a consistent contract and
 * can render the fachliche state (see UI-Mapping in Stage 6).
 *
 * All responses use HTTP 402 for payment-contract blocks (aligned with
 * create-escrow).  DB errors return 500 — the lookup itself failed.
 */
export function attributionGateToHttpResponse(result: AttributionGateBlocked): {
  status: number
  body: {
    error: string
    message: string
    retryable: boolean
    jobId: string
    attributionStatus?: string
    commercialOrigin?: string | null
    dlqReason?: string | null
  }
} {
  switch (result.code) {
    case 'JOB_NOT_FOUND':
      return {
        status: 402,
        body: {
          error: 'PAYMENT_BLOCKED_JOB_NOT_FOUND',
          message: 'Auftrag nicht gefunden. Zahlung kann nicht verarbeitet werden.',
          retryable: false,
          jobId: result.jobId,
        },
      }
    case 'ATTRIBUTION_UNRESOLVED':
      return {
        status: 402,
        body: {
          error: 'PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED',
          message:
            'Die Provisions­zuordnung wird noch geprüft. Bitte in wenigen Momenten erneut versuchen.',
          retryable: true,
          jobId: result.jobId,
          attributionStatus: result.attributionStatus,
        },
      }
    case 'ATTRIBUTION_DLQ':
      return {
        status: 402,
        body: {
          error: 'PAYMENT_BLOCKED_ATTRIBUTION_DLQ',
          message:
            'Die Provisions­zuordnung braucht eine manuelle Prüfung. Unser Team wurde informiert und meldet sich.',
          retryable: false,
          jobId: result.jobId,
          dlqReason: result.dlqReason,
        },
      }
    case 'ATTRIBUTION_INVALID':
      return {
        status: 402,
        body: {
          error: 'PAYMENT_BLOCKED_ATTRIBUTION_INVALID',
          message:
            'Die Provisions­zuordnung ist abgeschlossen, aber ungültig. Bitte Support kontaktieren.',
          retryable: false,
          jobId: result.jobId,
          commercialOrigin: result.commercialOrigin,
        },
      }
    case 'DB_ERROR':
      return {
        status: 500,
        body: {
          error: 'ATTRIBUTION_LOOKUP_FAILED',
          message: 'Die Provisions­prüfung ist fehlgeschlagen. Die Freigabe wurde aus Sicherheitsgründen gestoppt.',
          retryable: true,
          jobId: result.jobId,
        },
      }
  }
}
