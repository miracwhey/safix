/**
 * Initiate Funding API Client — Authenticated funding payment initiation.
 *
 * Calls POST /api/initiate-funding with a proper Authorization: Bearer <token>
 * header to create a Stripe PaymentIntent for funding an escrow plan.
 *
 * This is the single client-side path for initiating a funding payment.
 * The server validates the caller against the canonical funding request,
 * creates a Stripe PaymentIntent, and returns the clientSecret needed to
 * mount the Stripe payment form.
 */

import { supabase } from '../supabase'
import { logInfo, logWarning } from '../observability'
import {
  tryAttributionBlockInfo,
  type AttributionBlockInfo,
} from '../commercialAttribution/attributionBlockUi'
import { apiUrl } from '../api/baseUrl'

// ---------------------------------------------------------------------------
// Explicit outcome codes — must mirror the server contract exactly
// ---------------------------------------------------------------------------

export type InitiateFundingOutcome =
  | 'PAYMENT_FORM_READY'
  | 'PAYMENT_ALREADY_FUNDED'
  | 'PAYMENT_RETRY_READY'
  | 'PAYMENT_INIT_FAILED'
  | 'FUNDING_REQUEST_EXPIRED'

// ---------------------------------------------------------------------------
// Request / Response types — discriminated union on outcome
// ---------------------------------------------------------------------------

export type InitiateFundingParams = {
  fundingRequestId: string
  escrowPlanId: string
  jobId: string
}

/** Payment form is ready — mount Stripe Elements with clientSecret */
export type InitiateFundingFormReady = {
  ok: true
  outcome: 'PAYMENT_FORM_READY'
  data: {
    paymentIntentId: string
    clientSecret: string
    status: string
  }
}

/** Payment already funded — no clientSecret needed, show funded state */
export type InitiateFundingAlreadyFunded = {
  ok: true
  outcome: 'PAYMENT_ALREADY_FUNDED'
  message: string
  paymentIntentId: string | null
}

/** Replacement intent created — mount Stripe Elements with new clientSecret */
export type InitiateFundingRetryReady = {
  ok: true
  outcome: 'PAYMENT_RETRY_READY'
  data: {
    paymentIntentId: string
    clientSecret: string
    status: string
  }
}

/** Funding request has expired — non-retryable, customer must contact provider */
export type InitiateFundingExpired = {
  ok: false
  outcome: 'FUNDING_REQUEST_EXPIRED'
  message: string
  blockingReason?: string
  errorCode?: string
  attributionBlock?: AttributionBlockInfo
}

/** Explicit failure — show retryable error */
export type InitiateFundingError = {
  ok: false
  outcome: 'PAYMENT_INIT_FAILED'
  message: string
  errorCode?: string
  statusCode?: number
  /**
   * When the server blocks payment due to provider payout readiness,
   * one of: 'no_stripe_account' | 'charges_disabled' | 'payouts_disabled'.
   * Present only for PROVIDER_PAYOUT_NOT_READY failures.
   * UI should suppress the retry CTA for these — the customer cannot resolve
   * this by retrying; the craftsman must complete payout setup first.
   */
  blockingReason?: string
  /**
   * Structured attribution-block descriptor.  Present only when the server
   * responded 402 with a PAYMENT_BLOCKED_ATTRIBUTION_* / JOB_NOT_FOUND /
   * ATTRIBUTION_LOOKUP_FAILED code.  Screens render this via the shared
   * mapper in `src/lib/commercialAttribution/attributionBlockUi.ts` —
   * never fall back to the raw server message for these branches.
   */
  attributionBlock?: AttributionBlockInfo
}

// Legacy compat aliases (existing imports in barrel)
export type InitiateFundingSuccess = InitiateFundingFormReady | InitiateFundingRetryReady

export type InitiateFundingResult =
  | InitiateFundingFormReady
  | InitiateFundingAlreadyFunded
  | InitiateFundingRetryReady
  | InitiateFundingError
  | InitiateFundingExpired

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Initiates a funding payment via the server-authoritative endpoint.
 *
 * Retrieves the current Supabase session JWT and sends it as a Bearer token
 * in the Authorization header — required by the server's authenticateRequest
 * guard.
 *
 * @param params — canonical funding identifiers (fundingRequestId, escrowPlanId, jobId)
 */
export async function initiateFundingPayment(
  params: InitiateFundingParams,
): Promise<InitiateFundingResult> {
  const { fundingRequestId, escrowPlanId, jobId } = params

  try {
    // Retrieve the current Supabase session token for authenticated API calls
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData?.session?.access_token

    if (!token) {
      logWarning('payment.initiate_funding_no_token', { fundingRequestId, jobId })
      return {
        ok: false,
        outcome: 'PAYMENT_INIT_FAILED',
        message: 'Keine aktive Sitzung gefunden. Bitte erneut anmelden.',
        errorCode: 'NO_SESSION',
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    }

    logInfo('payment.initiate_funding_api_call', { fundingRequestId, escrowPlanId, jobId })

    const response = await fetch(apiUrl('/api/initiate-funding'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ fundingRequestId, escrowPlanId, jobId }),
    })

    const data = await response.json().catch(() => ({}))

    // ── Non-2xx: always a failure ──────────────────────────────────────
    if (!response.ok) {
      // Expired funding request — distinct from generic failure; non-retryable.
      if (data.outcome === 'FUNDING_REQUEST_EXPIRED') {
        logWarning('payment.initiate_funding_expired', {
          fundingRequestId,
          status: response.status,
        })
        return {
          ok: false,
          outcome: 'FUNDING_REQUEST_EXPIRED',
          message: typeof data.error === 'string'
            ? data.error
            : 'This funding request has expired. Please contact your service provider.',
        }
      }

      // Attribution-block codes take precedence: the shared UI mapper
      // produces fachliche copy + retryable flag + CTA.  Screens consume
      // `attributionBlock` and the mapped `message` instead of the raw
      // server text.
      const attributionBlock = tryAttributionBlockInfo(data)
      if (attributionBlock) {
        logWarning('payment.initiate_funding_attribution_block', {
          fundingRequestId,
          status: response.status,
          kind: attributionBlock.kind,
          retryable: attributionBlock.retryable,
        })
        return {
          ok: false,
          outcome: 'PAYMENT_INIT_FAILED',
          message: attributionBlock.message,
          errorCode: attributionBlock.code ?? 'ATTRIBUTION_BLOCK',
          statusCode: response.status,
          attributionBlock,
        }
      }

      const errorMsg = typeof data.message === 'string'
        ? data.message
        : typeof data.error === 'string'
          ? data.error
          : `Initiate-funding failed (${response.status})`
      const blockingReason = typeof data.blockingReason === 'string' ? data.blockingReason : undefined
      logWarning('payment.initiate_funding_http_error', {
        fundingRequestId,
        status: response.status,
        outcome: data.outcome ?? 'PAYMENT_INIT_FAILED',
        error: errorMsg,
        blockingReason,
      })
      return {
        ok: false,
        outcome: 'PAYMENT_INIT_FAILED',
        message: errorMsg,
        errorCode: typeof data.errorCode === 'string' ? data.errorCode : undefined,
        statusCode: response.status,
        blockingReason,
      }
    }

    // ── 2xx: parse explicit server outcome ─────────────────────────────
    const outcome = data.outcome as InitiateFundingOutcome | undefined

    // Validate: server MUST return an explicit outcome
    if (!outcome) {
      logWarning('payment.initiate_funding_missing_outcome', {
        fundingRequestId,
        responseKeys: Object.keys(data),
      })
      return {
        ok: false,
        outcome: 'PAYMENT_INIT_FAILED',
        message: 'Server returned success without an explicit outcome. Contract violation.',
        errorCode: 'CONTRACT_VIOLATION_NO_OUTCOME',
      }
    }

    // ── PAYMENT_ALREADY_FUNDED ─────────────────────────────────────────
    if (outcome === 'PAYMENT_ALREADY_FUNDED') {
      logInfo('payment.initiate_funding_already_funded', {
        fundingRequestId,
        outcome,
      })
      return {
        ok: true,
        outcome: 'PAYMENT_ALREADY_FUNDED',
        message: typeof data.message === 'string' ? data.message : 'Funding already completed.',
        paymentIntentId: typeof data.paymentIntentId === 'string' ? data.paymentIntentId : null,
      }
    }

    // ── PAYMENT_FORM_READY or PAYMENT_RETRY_READY ──────────────────────
    if (outcome === 'PAYMENT_FORM_READY' || outcome === 'PAYMENT_RETRY_READY') {
      const clientSecret = typeof data.clientSecret === 'string' ? data.clientSecret : null

      if (!clientSecret) {
        // Server promised a payment-ready outcome but didn't deliver clientSecret
        logWarning('payment.initiate_funding_outcome_without_secret', {
          fundingRequestId,
          outcome,
          responseKeys: Object.keys(data),
        })
        return {
          ok: false,
          outcome: 'PAYMENT_INIT_FAILED',
          message: `Server returned ${outcome} but no clientSecret. Contract violation.`,
          errorCode: 'CONTRACT_VIOLATION_NO_CLIENT_SECRET',
        }
      }

      logInfo('payment.initiate_funding_success', {
        fundingRequestId,
        hasClientSecret: true,
        outcome,
        status: data.status,
      })

      return {
        ok: true,
        outcome,
        data: {
          paymentIntentId: data.paymentIntentId,
          clientSecret,
          status: data.status ?? 'funding_initiated',
        },
      }
    }

    // ── PAYMENT_INIT_FAILED (server-side explicit failure) ─────────────
    if (outcome === 'PAYMENT_INIT_FAILED') {
      logWarning('payment.initiate_funding_server_failure', {
        fundingRequestId,
        outcome,
        errorCode: data.errorCode,
      })
      return {
        ok: false,
        outcome: 'PAYMENT_INIT_FAILED',
        message: typeof data.message === 'string' ? data.message : 'Payment initiation failed.',
        errorCode: typeof data.errorCode === 'string' ? data.errorCode : undefined,
      }
    }

    // ── Unknown outcome — contract violation ───────────────────────────
    logWarning('payment.initiate_funding_unknown_outcome', {
      fundingRequestId,
      outcome,
    })
    return {
      ok: false,
      outcome: 'PAYMENT_INIT_FAILED',
      message: `Server returned unrecognized outcome: ${outcome}`,
      errorCode: 'CONTRACT_VIOLATION_UNKNOWN_OUTCOME',
    }
  } catch (e) {
    return {
      ok: false,
      outcome: 'PAYMENT_INIT_FAILED',
      message: e instanceof Error ? e.message : 'Netzwerkfehler bei der Zahlungsinitiierung.',
      errorCode: 'NETWORK_ERROR',
    }
  }
}
