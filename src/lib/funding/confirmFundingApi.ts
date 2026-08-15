/**
 * Confirm Funding API Client — Authenticated funding confirmation.
 *
 * Calls POST /api/confirm-funding with a proper Authorization: Bearer <token>
 * header to confirm a successful Stripe payment on the server side.
 *
 * This is the single client-side path for confirming a funding payment.
 * The server validates the caller against the funding request's customer,
 * transitions the funding request and escrow plan to 'funded' status,
 * and returns the confirmed state.
 *
 * Webhook reconciliation remains as a backup/idempotent recovery path.
 */

import { supabase } from '../supabase'
import { logInfo, logWarning } from '../observability'
import { apiUrl } from '../api/baseUrl'

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

export type ConfirmFundingParams = {
  paymentIntentId: string
  fundingRequestId: string
  escrowPlanId: string
  jobId: string
}

export type ConfirmFundingSuccess = {
  ok: true
  data: {
    status: string
    fundingRequestId: string
    escrowPlanId: string
    jobId: string
  }
}

export type ConfirmFundingError = {
  ok: false
  message: string
  statusCode?: number
}

export type ConfirmFundingResult =
  | ConfirmFundingSuccess
  | ConfirmFundingError

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Confirms a funding payment via the server-authoritative endpoint.
 *
 * Retrieves the current Supabase session JWT and sends it as a Bearer token
 * in the Authorization header — required by the server's authenticateRequest
 * guard for browser-based callers.
 *
 * @param params — payment and funding identifiers
 */
export async function confirmFundingPayment(
  params: ConfirmFundingParams,
): Promise<ConfirmFundingResult> {
  const { paymentIntentId, fundingRequestId, escrowPlanId, jobId } = params

  try {
    // Retrieve the current Supabase session token for authenticated API calls
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData?.session?.access_token

    if (!token) {
      logWarning('payment.confirm_funding_no_token', { fundingRequestId, jobId })
      return {
        ok: false,
        message: 'Keine aktive Sitzung gefunden. Bitte erneut anmelden.',
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    }

    logInfo('payment.confirm_funding_api_call', { paymentIntentId, fundingRequestId, escrowPlanId, jobId })

    const response = await fetch(apiUrl('/api/confirm-funding'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ paymentIntentId, fundingRequestId, escrowPlanId, jobId }),
    })

    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: undefined as string | undefined }))
      const errorMsg = typeof body.error === 'string'
        ? body.error
        : `Confirm-funding failed (${response.status})`
      logWarning('payment.confirm_funding_http_error', {
        fundingRequestId,
        status: response.status,
        error: errorMsg,
      })
      return {
        ok: false,
        message: errorMsg,
        statusCode: response.status,
      }
    }

    const data = await response.json()

    logInfo('payment.confirm_funding_success', {
      fundingRequestId: data.fundingRequestId,
      escrowPlanId: data.escrowPlanId,
      status: data.status,
    })

    return {
      ok: true,
      data: {
        status: data.status,
        fundingRequestId: data.fundingRequestId ?? fundingRequestId,
        escrowPlanId: data.escrowPlanId ?? escrowPlanId,
        jobId: data.jobId ?? jobId,
      },
    }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Netzwerkfehler bei der Zahlungsbestätigung.',
    }
  }
}
