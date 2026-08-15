/**
 * Release Client — Server-authoritative tranche release.
 *
 * This module provides the ONLY client-side path for triggering
 * tranche releases. It calls the server /api/release-tranche endpoint
 * (the authoritative write path) and returns the server response.
 *
 * After a successful server release, the caller should refresh/revalidate
 * local repo state — NOT perform a second local truth write.
 *
 * The local `releaseEligibleTranche()` in releaseOperations.ts remains
 * available for server-side orchestration and tests, but MUST NOT be
 * called from UI components at runtime.
 */

import { supabase } from '../supabase'
import {
  tryAttributionBlockInfo,
  type AttributionBlockInfo,
} from '../commercialAttribution/attributionBlockUi'
import { apiUrl } from '../api/baseUrl'

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ServerReleaseSuccess = {
  ok: true
  data: {
    /**
     * Server-authoritative release outcome. Under the destination-charge
     * corridor (PAYOUT_MODE) a release is ASYNC — the server returns
     * `release_pending` (payout created, pays ~7d later via the payout.paid
     * webhook) or `release_deferred` (balance still pending, no payout yet).
     * Only `released` means the money has actually moved + the tranche row is
     * canonical. Callers MUST NOT run "released" side effects (job completion,
     * payment_released_at, "Zahlung freigegeben"-Toast/Email) unless this is
     * exactly `released` — the authoritative settlement for the async states is
     * performed server-side by the payout.paid webhook on `fully_released`.
     */
    status: 'released' | 'release_pending' | 'release_deferred'
    trancheId: string
    planId: string
    planStatus: string
    /** Absent for the async corridor states (set later by the webhook). */
    releasedAt: string | null
    externalReleaseRef: string | null
    /** True when the server returned this as an idempotent re-read */
    idempotent?: boolean
    /**
     * True when the Stripe Transfer succeeded but the subsequent Supabase
     * write did NOT — money has moved at the provider level but the canonical
     * tranche row is not yet `released`. The reconciliation cron (or a retry
     * driven by the stable idempotency key) will heal the divergence; the UI
     * MUST surface a fachliche reconciliation hint instead of a normal
     * success confirmation.
     */
    requiresReconciliation?: boolean
  }
}

export type ServerReleaseError = {
  ok: false
  message: string
  /** HTTP status code from server */
  statusCode?: number
  /** Current tranche status if the server returned a conflict */
  currentStatus?: string
  /**
   * Machine-readable error code from the server body (e.g.
   * 'SPLIT_PROVIDER_QUOTA_EXHAUSTED' on a 409 when a later split resolution
   * awards the provider less than prior releases already paid out). Callers use
   * this to distinguish an operator-action-required over-payment from a
   * transient/retryable bridge failure. Undefined when the body had no code.
   */
  code?: string
  /**
   * Structured attribution-block descriptor — present when the server
   * returned a 402 with a PAYMENT_BLOCKED_ATTRIBUTION_* code (or the
   * sibling JOB_NOT_FOUND / ATTRIBUTION_LOOKUP_FAILED codes).  UI surfaces
   * render this via the shared mapper in
   * `src/lib/commercialAttribution/attributionBlockUi.ts` — never fall
   * back to the raw `message` for these branches.
   */
  attributionBlock?: AttributionBlockInfo
}

export type ServerReleaseResult = ServerReleaseSuccess | ServerReleaseError

// ---------------------------------------------------------------------------
// Error mapping — no raw backend text in UI
// ---------------------------------------------------------------------------

/**
 * Maps raw server error messages to user-friendly German text.
 *
 * The server returns English technical messages for logging.
 * All UI surfaces must show fachliche German messages instead.
 */
function mapReleaseErrorToUserMessage(
  rawMessage: string,
  statusCode?: number,
  currentStatus?: string
): string {
  // Already a German fachliche message (from reconciled server)
  if (/Tranche|Freigabe|Streitfall|Einzahlung|storniert|erstattet/.test(rawMessage)) {
    return rawMessage
  }

  // Status-based mapping
  if (currentStatus === 'funded') {
    return 'Diese Tranche ist noch nicht freigabefähig. Die Voraussetzung (Arbeitsbeginn oder Fertigstellung) ist noch nicht erfüllt.'
  }
  if (currentStatus === 'pending_funding') {
    return 'Die Kundeneinzahlung steht noch aus. Freigabe erst nach vollständiger Einzahlung möglich.'
  }
  if (currentStatus === 'disputed') {
    return 'Ein aktiver Streitfall blockiert die Freigabe dieser Tranche.'
  }

  // Keyword-based mapping for common server errors
  if (/DISPUTE_BLOCKING/i.test(rawMessage)) {
    return 'Ein aktiver Streitfall verhindert die Freigabe.'
  }
  if (/PROVIDER_NOT_PAYOUT_READY/i.test(rawMessage) || /Stripe Connect/i.test(rawMessage)) {
    return 'Das Auszahlungskonto ist noch nicht eingerichtet. Bitte vervollständige das Stripe-Connect-Setup.'
  }
  if (/MISSING_FUNDING_REF/i.test(rawMessage) || /not funded/i.test(rawMessage)) {
    return 'Die Zahlung ist noch nicht abgeschlossen.'
  }
  if (/Stripe transfer failed/i.test(rawMessage)) {
    return 'Die Auszahlung konnte nicht durchgeführt werden. Bitte versuche es in wenigen Minuten erneut.'
  }
  if (/INCONSISTENT_RELEASE_STATE/i.test(rawMessage) || /Übergabe-Beleg/.test(rawMessage)) {
    return 'Diese Tranche ist als freigegeben markiert, aber die Übergabe ans Auszahlungskonto wird gerade automatisch abgeglichen. Bitte in wenigen Minuten erneut versuchen.'
  }

  // HTTP status fallback
  if (statusCode === 403) {
    return 'Du bist nicht berechtigt, diese Tranche freizugeben.'
  }
  if (statusCode === 404) {
    return 'Tranche oder Zahlungsplan nicht gefunden.'
  }
  if (statusCode && statusCode >= 500) {
    return 'Ein Serverfehler ist aufgetreten. Bitte versuche es später erneut.'
  }

  // Catch-all — never show raw English text
  return 'Die Freigabe konnte nicht durchgeführt werden. Bitte versuche es erneut.'
}

// ---------------------------------------------------------------------------
// Core release request
// ---------------------------------------------------------------------------

/**
 * Valid actor identifiers for release audit trail.
 *
 * - `customer`  — customer-initiated release (acceptance / trust action)
 * - `provider`  — provider-initiated release (operations card CTA)
 * - `operator`  — operator/admin action (dispute resolution, backoffice)
 * - `system`    — server-initiated (cron reconciliation, webhook)
 * - `consensus` — two-party consensus split resolution (P4 Teil A). Records the
 *                 party-agreed origin of a dispute split release in the
 *                 app-level audit trail. Inert until a consensus release issues
 *                 (gated by VITE_CONSENSUS_SPLIT_ENABLED at the workflow layer).
 *                 NOTE: the server downgrades this to the DB-accepted 'system'
 *                 sentinel for escrow_tranches.released_by, whose CHECK
 *                 constraint does not include 'consensus' — see
 *                 api/release-tranche.ts (dbReleaseActor).
 */
export type ReleaseActor = 'customer' | 'provider' | 'operator' | 'system' | 'consensus'

/**
 * Request a tranche release via the server API.
 *
 * This is the single authoritative release path for client-side code.
 * The server validates tranche eligibility, executes the release, and
 * updates the plan rollup status.
 *
 * Payout readiness gating is enforced client-side before calling this
 * function (the CTA is only shown when payout is ready). The server
 * additionally validates tranche status as a defense-in-depth guard.
 *
 * Idempotent: if the tranche is already released, the server returns
 * 200 with the current state. No duplicate side effects.
 *
 * @param trancheId        — ID of the tranche to release
 * @param planId           — ID of the escrow plan containing the tranche
 * @param actor            — Who triggered the release (for audit trail)
 * @param externalReleaseRef — Optional Stripe Transfer ID or equivalent
 * @param splitRatio       — For dispute split resolution: fraction [0–1] of
 *                           tranche amount to transfer to provider. Omit for
 *                           full (non-split) releases.
 */
export async function requestServerTrancheRelease(
  trancheId: string,
  planId: string,
  actor: ReleaseActor = 'system',
  externalReleaseRef?: string,
  splitRatio?: number
): Promise<ServerReleaseResult> {
  try {
    // Retrieve the current Supabase session token for authenticated API calls
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData?.session?.access_token

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const response = await fetch(apiUrl('/api/release-tranche'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        trancheId,
        planId,
        actor,
        ...(externalReleaseRef ? { externalReleaseRef } : {}),
        ...(splitRatio !== undefined ? { splitRatio } : {}),
      }),
    })

    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'Unknown server error' }))

      // Attribution-block codes go through the shared mapper — they have
      // retryable semantics distinct from the generic release-failure copy.
      const attributionBlock = tryAttributionBlockInfo(body)
      if (attributionBlock) {
        return {
          ok: false,
          message: attributionBlock.message,
          statusCode: response.status,
          attributionBlock,
        }
      }

      const rawMessage = body.error ?? `Server release failed (${response.status})`
      return {
        ok: false,
        message: mapReleaseErrorToUserMessage(rawMessage, response.status, body.currentStatus),
        statusCode: response.status,
        currentStatus: body.currentStatus,
        ...(typeof body.code === 'string' ? { code: body.code } : {}),
      }
    }

    const data = await response.json()
    // Propagate the TRUE server status. The server returns 'release_pending'
    // (200, PAYOUT_MODE payout created) or 'release_deferred' (202, balance
    // pending) for the async corridor; collapsing these into 'released' (the
    // prior bug) made the workflow settle the job + notify "freigegeben" before
    // the payout actually paid. Anything the server does not explicitly mark as
    // one of the two async states is a synchronous (legacy) 'released'.
    const serverStatus =
      data.status === 'release_pending' || data.status === 'release_deferred'
        ? data.status
        : 'released'
    return {
      ok: true,
      data: {
        status: serverStatus,
        trancheId: data.trancheId,
        planId: data.planId,
        planStatus: data.planStatus ?? 'unknown',
        releasedAt: data.releasedAt ?? null,
        // PAYOUT_MODE returns the payout ref under `externalPayoutRef`.
        externalReleaseRef: data.externalReleaseRef ?? data.externalPayoutRef ?? null,
        idempotent: data.idempotent ?? false,
        requiresReconciliation: data.requiresReconciliation === true,
      },
    }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Netzwerkfehler bei der Freigabe.',
    }
  }
}
