/**
 * Initiate Supplementary Funding API Client
 *
 * Calls POST /api/initiate-supplementary-funding with a proper
 * Authorization: Bearer <token> header to create a Stripe PaymentIntent
 * for a supplementary payment request (Nachtrag delta).
 *
 * Same outcome contract as initiate-funding:
 *   PAYMENT_FORM_READY      → clientSecret present
 *   PAYMENT_ALREADY_FUNDED  → no payment needed
 *   PAYMENT_RETRY_READY     → replacement intent, clientSecret present
 *   PAYMENT_INIT_FAILED     → explicit failure
 */

import { supabase } from '../supabase'
import { logInfo, logWarning } from '../observability'
import {
  tryAttributionBlockInfo,
  type AttributionBlockInfo,
} from '../commercialAttribution/attributionBlockUi'
import { apiUrl } from '../api/baseUrl'

// ── Outcome types ─────────────────────────────────────────────────────────────

export type InitiateSupplementaryOutcome =
  | 'PAYMENT_FORM_READY'
  | 'PAYMENT_ALREADY_FUNDED'
  | 'PAYMENT_RETRY_READY'
  | 'PAYMENT_INIT_FAILED'

export type InitiateSupplementaryFormReady = {
  ok: true
  outcome: 'PAYMENT_FORM_READY' | 'PAYMENT_RETRY_READY'
  data: {
    paymentIntentId: string
    clientSecret: string
  }
}

export type InitiateSupplementaryAlreadyFunded = {
  ok: true
  outcome: 'PAYMENT_ALREADY_FUNDED'
  message: string
  paymentIntentId: string | null
}

export type InitiateSupplementaryError = {
  ok: false
  outcome: 'PAYMENT_INIT_FAILED'
  message: string
  statusCode?: number
  /**
   * Structured attribution-block descriptor — see initiateFundingApi for
   * rationale.  Present only for 402 responses with an attribution error code.
   */
  attributionBlock?: AttributionBlockInfo
}

export type InitiateSupplementaryResult =
  | InitiateSupplementaryFormReady
  | InitiateSupplementaryAlreadyFunded
  | InitiateSupplementaryError

// ── Main function ─────────────────────────────────────────────────────────────

export async function initiateSupplementaryFunding(
  supplementaryPaymentId: string
): Promise<InitiateSupplementaryResult> {
  try {
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData?.session?.access_token

    if (!token) {
      logWarning('payment.initiate_supplementary_no_token', { supplementaryPaymentId })
      return {
        ok: false,
        outcome: 'PAYMENT_INIT_FAILED',
        message: 'Keine aktive Sitzung gefunden. Bitte erneut anmelden.',
      }
    }

    logInfo('payment.initiate_supplementary_api_call', { supplementaryPaymentId })

    const response = await fetch(apiUrl('/api/initiate-supplementary-funding'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ supplementaryPaymentId }),
    })

    const data = await response.json().catch(() => ({}))

    if (!response.ok) {
      const attributionBlock = tryAttributionBlockInfo(data)
      if (attributionBlock) {
        logWarning('payment.initiate_supplementary_attribution_block', {
          supplementaryPaymentId,
          status: response.status,
          kind: attributionBlock.kind,
          retryable: attributionBlock.retryable,
        })
        return {
          ok: false,
          outcome: 'PAYMENT_INIT_FAILED',
          message: attributionBlock.message,
          statusCode: response.status,
          attributionBlock,
        }
      }

      const errorMsg = typeof data.message === 'string'
        ? data.message
        : typeof data.error === 'string'
          ? data.error
          : `initiate-supplementary-funding failed (${response.status})`
      logWarning('payment.initiate_supplementary_http_error', {
        supplementaryPaymentId,
        status: response.status,
        error: errorMsg,
      })
      return {
        ok: false,
        outcome: 'PAYMENT_INIT_FAILED',
        message: errorMsg,
        statusCode: response.status,
      }
    }

    const outcome = data.outcome as InitiateSupplementaryOutcome | undefined

    if (!outcome) {
      return {
        ok: false,
        outcome: 'PAYMENT_INIT_FAILED',
        message: 'Server returned success without an explicit outcome.',
      }
    }

    if (outcome === 'PAYMENT_ALREADY_FUNDED') {
      logInfo('payment.initiate_supplementary_already_funded', { supplementaryPaymentId })
      return {
        ok: true,
        outcome: 'PAYMENT_ALREADY_FUNDED',
        message: typeof data.message === 'string' ? data.message : 'Bereits bezahlt.',
        paymentIntentId: typeof data.paymentIntentId === 'string' ? data.paymentIntentId : null,
      }
    }

    if (outcome === 'PAYMENT_FORM_READY' || outcome === 'PAYMENT_RETRY_READY') {
      const clientSecret = typeof data.clientSecret === 'string' ? data.clientSecret : null

      if (!clientSecret) {
        return {
          ok: false,
          outcome: 'PAYMENT_INIT_FAILED',
          message: `Server returned ${outcome} but no clientSecret.`,
        }
      }

      logInfo('payment.initiate_supplementary_success', {
        supplementaryPaymentId,
        outcome,
      })

      return {
        ok: true,
        outcome,
        data: {
          paymentIntentId: data.paymentIntentId,
          clientSecret,
        },
      }
    }

    if (outcome === 'PAYMENT_INIT_FAILED') {
      return {
        ok: false,
        outcome: 'PAYMENT_INIT_FAILED',
        message: typeof data.message === 'string' ? data.message : 'Payment initiation failed.',
      }
    }

    return {
      ok: false,
      outcome: 'PAYMENT_INIT_FAILED',
      message: `Unrecognized outcome: ${outcome}`,
    }
  } catch (e) {
    return {
      ok: false,
      outcome: 'PAYMENT_INIT_FAILED',
      message: e instanceof Error ? e.message : 'Netzwerkfehler bei der Zahlungsinitiierung.',
    }
  }
}
