/**
 * Confirm Supplementary Funding API Client
 *
 * Calls POST /api/confirm-supplementary-funding with a proper
 * Authorization: Bearer <token> header to confirm a successful
 * Stripe payment for a supplementary payment request.
 *
 * Webhook reconciliation remains as backup/idempotent recovery.
 */

import { supabase } from '../supabase'
import { logInfo, logWarning } from '../observability'
import { apiUrl } from '../api/baseUrl'

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConfirmSupplementaryParams = {
  paymentIntentId: string
  supplementaryPaymentId: string
}

export type ConfirmSupplementarySuccess = {
  ok: true
  data: {
    status: string
    supplementaryPaymentId: string
  }
}

export type ConfirmSupplementaryError = {
  ok: false
  message: string
  statusCode?: number
}

export type ConfirmSupplementaryResult =
  | ConfirmSupplementarySuccess
  | ConfirmSupplementaryError

// ── Main function ─────────────────────────────────────────────────────────────

export async function confirmSupplementaryFunding(
  params: ConfirmSupplementaryParams
): Promise<ConfirmSupplementaryResult> {
  const { paymentIntentId, supplementaryPaymentId } = params

  try {
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData?.session?.access_token

    if (!token) {
      logWarning('payment.confirm_supplementary_no_token', { supplementaryPaymentId })
      return {
        ok: false,
        message: 'Keine aktive Sitzung gefunden. Bitte erneut anmelden.',
      }
    }

    logInfo('payment.confirm_supplementary_api_call', { paymentIntentId, supplementaryPaymentId })

    const response = await fetch(apiUrl('/api/confirm-supplementary-funding'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ paymentIntentId, supplementaryPaymentId }),
    })

    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: undefined as string | undefined }))
      const errorMsg = typeof body.error === 'string'
        ? body.error
        : `confirm-supplementary-funding failed (${response.status})`
      logWarning('payment.confirm_supplementary_http_error', {
        supplementaryPaymentId,
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

    logInfo('payment.confirm_supplementary_success', {
      supplementaryPaymentId: data.supplementaryPaymentId,
      status: data.status,
    })

    return {
      ok: true,
      data: {
        status: data.status,
        supplementaryPaymentId: data.supplementaryPaymentId ?? supplementaryPaymentId,
      },
    }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Netzwerkfehler bei der Zahlungsbestätigung.',
    }
  }
}
