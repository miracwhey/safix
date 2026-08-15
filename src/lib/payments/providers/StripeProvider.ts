import type {
  PaymentProvider,
  CreateEscrowInput,
  EscrowResult,
  ConfirmDepositInput,
  DepositResult,
  ReleaseEscrowInput,
  RefundEscrowInput,
} from './PaymentProvider.js'
import { supabase } from '../../supabase.js'
import { apiUrl } from '../../api/baseUrl.js'

/**
 * StripeProvider — production-ready Stripe payment provider.
 *
 * ARCHITECTURE NOTE: This is a pure client-side Vite application. All
 * VITE_* environment variables are compiled into the client bundle and are
 * publicly visible. The Stripe secret key (sk_test_* / sk_live_*) MUST
 * NEVER appear in VITE_* variables or in this file.
 *
 * All secret-key operations (PaymentIntent creation, capture, refund) are
 * delegated to serverless API functions in api/ which run server-side on
 * Vercel and have access to STRIPE_SECRET_KEY.
 *
 * Backend URL resolution:
 *   - Resolved through apiUrl() (src/lib/api/baseUrl.ts). On web this is
 *     same-origin; on native (Capacitor) VITE_API_BASE_URL is required so
 *     /api/* calls resolve to the deployed Vercel origin instead of the
 *     capacitor://localhost shell.
 *
 * To activate this provider:
 *   1. Set VITE_PAYMENT_PROVIDER=stripe.
 *   2. Set VITE_STRIPE_PUBLISHABLE_KEY=pk_live_... (or pk_test_...).
 *   3. Set STRIPE_SECRET_KEY=sk_live_... in Vercel project settings
 *      (server-side only — never prefix with VITE_).
 *   4. Set VITE_API_BASE_URL (required for native, optional for web
 *      when the frontend and API share the same origin).
 *
 * confirmDeposit is intentionally a no-op: Stripe.js on the client has
 * already authorised the PaymentIntent before this method is called.
 * releaseEscrow calls POST /api/capture-escrow on the backend.
 * refundEscrow calls POST /api/refund-escrow on the backend.
 */

/**
 * Retrieves the current Supabase session access token for server-side auth.
 * Returns null when no session exists (user not logged in) or on error.
 */
async function getAccessToken(): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.getSession()
    if (error) {
      console.warn('[StripeProvider] Failed to retrieve session for auth header:', error.message)
      return null
    }
    return data.session?.access_token ?? null
  } catch (err: unknown) {
    console.warn('[StripeProvider] Unexpected error retrieving session:', err)
    return null
  }
}

/**
 * Builds the Authorization header object when a session token is available.
 * Returns an empty object when unauthenticated so callers can spread safely.
 */
async function buildAuthHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const

  async createEscrow(input: CreateEscrowInput): Promise<EscrowResult> {
    const url = apiUrl('/api/create-escrow')
    const authHeaders = await buildAuthHeaders()

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        jobId: input.jobId,
        customerId: input.customerId,
        craftsmanUserId: input.craftsmanUserId,
        amount: input.amount,
        currency: input.currency,
      }),
    }).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(
        `StripeProvider: could not reach create-escrow endpoint at ${url}: ${detail}`,
      )
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Stripe backend error (${response.status}): ${text}`)
    }

    const data = (await response.json()) as { paymentIntentId: string; clientSecret?: string | null }

    if (!data.paymentIntentId || typeof data.paymentIntentId !== 'string') {
      throw new Error(
        'Stripe backend returned an invalid response: expected a non-empty paymentIntentId string.',
      )
    }

    return {
      escrowId: data.paymentIntentId,
      status: 'created',
      // Normalize null → undefined so Payment.clientSecret stays string | undefined.
      clientSecret: data.clientSecret ?? undefined,
    }
  }

  async confirmDeposit(_input: ConfirmDepositInput): Promise<DepositResult> {
    // The customer has already confirmed the PaymentIntent via Stripe.js on the
    // client side (stripe.confirmPayment succeeded, status === 'requires_capture').
    // At this point the funds are on hold with Stripe.  We simply acknowledge the
    // confirmation so SaFix can advance its own payment state.
    return { depositConfirmed: true }
  }

  async releaseEscrow(input: ReleaseEscrowInput): Promise<void> {
    const url = apiUrl('/api/capture-escrow')
    const authHeaders = await buildAuthHeaders()

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ paymentIntentId: input.escrowId }),
    }).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(
        `StripeProvider: could not reach capture-escrow endpoint at ${url}: ${detail}`,
      )
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Stripe backend error (${response.status}): ${text}`)
    }
  }

  async refundEscrow(input: RefundEscrowInput): Promise<void> {
    const url = apiUrl('/api/refund-escrow')
    const authHeaders = await buildAuthHeaders()

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        paymentIntentId: input.escrowId,
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        ...(input.disputeId !== undefined ? { disputeId: input.disputeId } : {}),
      }),
    }).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(
        `StripeProvider: could not reach refund-escrow endpoint at ${url}: ${detail}`,
      )
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Stripe backend error (${response.status}): ${text}`)
    }
  }
}
