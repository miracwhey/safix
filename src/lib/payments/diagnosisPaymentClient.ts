/**
 * Diagnosis Payment Client — Server-authoritative PaymentIntent creation.
 *
 * Calls /api/initiate-diagnosis-payment to create (or retrieve) a Stripe
 * PaymentIntent for a diagnosis instant-payment.
 *
 * This is the ONLY client-side path for triggering diagnosis PI creation.
 * The server validates canonical data, creates the PI with the correct fee,
 * stores the provider_ref on the payment record, and returns the clientSecret.
 */

import { supabase } from '../supabase'
import { apiUrl } from '../api/baseUrl'

export type InitiateDiagnosisPaymentSuccess = {
  ok: true
  outcome: 'PAYMENT_FORM_READY' | 'ALREADY_COMPLETED'
  clientSecret: string | null
}

export type InitiateDiagnosisPaymentError = {
  ok: false
  message: string
  code?: string
}

export type InitiateDiagnosisPaymentResult =
  | InitiateDiagnosisPaymentSuccess
  | InitiateDiagnosisPaymentError

/**
 * Initiates a diagnosis instant-payment for the given job.
 *
 * Returns a clientSecret when the payment form should be shown.
 * Returns outcome 'ALREADY_COMPLETED' when the diagnosis was already paid.
 *
 * @param jobId — The diagnosis Job ID
 */
export async function initiateDiagnosisPayment(
  jobId: string,
): Promise<InitiateDiagnosisPaymentResult> {
  try {
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData?.session?.access_token

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const response = await fetch(apiUrl('/api/initiate-diagnosis-payment'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ jobId }),
    })

    const body = await response.json().catch(() => ({ error: 'Unknown server error' }))

    if (!response.ok) {
      return {
        ok: false,
        message: body.error ?? `Server-Fehler (${response.status})`,
        code: body.code,
      }
    }

    return {
      ok: true,
      outcome: body.outcome ?? 'PAYMENT_FORM_READY',
      clientSecret: body.clientSecret ?? null,
    }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Netzwerkfehler bei der Zahlungsinitiierung.',
    }
  }
}
