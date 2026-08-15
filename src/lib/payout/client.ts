import type {
  ProviderPayoutAccount,
  PayoutOnboardingStatus,
  PayoutReadinessStatus,
} from './types'
import { derivePayoutReadinessStatus } from './selectors'
import { supabase } from '../supabase'
import { apiUrl } from '../api/baseUrl'

type PayoutStatusResponse = {
  status: string
  account: {
    stripeConnectAccountId: string
    onboardingStatus: PayoutOnboardingStatus
    chargesEnabled: boolean
    payoutsEnabled: boolean
    requirementsDue?: string | null
  } | null
}

type AuthHeaders = {
  'Content-Type': 'application/json'
  Authorization?: string
}

function buildAuthHeaders(token: string | null): AuthHeaders {
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

function mapAccountFromResponse(
  account: NonNullable<PayoutStatusResponse['account']>
): ProviderPayoutAccount {
  return {
    id: '__placeholder__',
    providerUserId: '__placeholder__',
    stripeConnectAccountId: account.stripeConnectAccountId,
    onboardingStatus: account.onboardingStatus,
    chargesEnabled: account.chargesEnabled,
    payoutsEnabled: account.payoutsEnabled,
    onboardingCompletedAt: null,
    requirementsDue: account.requirementsDue ?? null,
    createdAt: 0,
    updatedAt: 0,
  }
}

async function getJsonOrDefault(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Maps server error responses to German user-facing messages.
 * Never passes raw English server errors to the UI.
 */
function getErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object' || !('error' in body)) return fallback
  const raw = (body as { error: unknown }).error
  if (typeof raw !== 'string') return fallback

  // Already German — pass through
  if (/[äöüÄÖÜß]/.test(raw)) return raw

  // Map known server errors to German
  if (raw.includes('Production environment misconfiguration')) {
    return 'Serverkonfiguration unvollständig. Bitte wende dich an den Support.'
  }
  if (raw.includes('Server misconfiguration')) {
    return 'Serverkonfiguration fehlerhaft. Bitte versuche es später erneut.'
  }
  if (raw.includes('not found') || raw.includes('Not found')) {
    return 'Konto nicht gefunden. Bitte versuche es erneut.'
  }
  if (raw.includes('Stripe account') || raw.includes('payout account')) {
    return 'Auszahlungskonto konnte nicht verarbeitet werden. Bitte versuche es erneut.'
  }
  if (raw.includes('Unauthorized') || raw.includes('unauthorized')) {
    return 'Nicht autorisiert. Bitte melde dich erneut an.'
  }
  if (raw.includes('Failed to')) {
    return 'Anfrage fehlgeschlagen. Bitte versuche es erneut.'
  }
  if (raw.startsWith('Unexpected server error:')) {
    return 'Serverfehler. Bitte versuche es später erneut.'
  }

  // Unknown English error — use German fallback, never expose raw
  return fallback
}

export async function fetchPayoutStatus(
  token: string | null,
): Promise<{
  readiness: PayoutReadinessStatus
  account: ProviderPayoutAccount | null
  rawStatus: string
}> {
  const res = await fetch(apiUrl('/api/payout-account-status'), {
    method: 'POST',
    headers: buildAuthHeaders(token),
  })

  if (!res.ok) {
    const body = await getJsonOrDefault(res)
    throw new Error(getErrorMessage(body, 'Status konnte nicht abgerufen werden.'))
  }

  const json = await res.json() as PayoutStatusResponse
  const account = json.account ? mapAccountFromResponse(json.account) : null
  const readiness = derivePayoutReadinessStatus(account)

  return { readiness, account, rawStatus: json.status }
}

/**
 * Loads the current user's payout account for onboarding/dashboard use.
 * Resolves the auth token internally. Returns null on any error so callers
 * can treat a missing/unavailable payout account as "not yet set up".
 */
export async function fetchPayoutAccountForOnboarding(): Promise<ProviderPayoutAccount | null> {
  try {
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token ?? null
    const { account } = await fetchPayoutStatus(token)
    return account
  } catch {
    return null
  }
}

/**
 * Maps network-level fetch errors to a user-facing German message.
 * iOS WKWebView throws "Load failed" for CORS/offline/timeout — never show that raw.
 */
export function resolvePayoutErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : ''
  if (!msg) return 'Ein Fehler ist aufgetreten.'
  if (msg.includes('Load failed') || msg.startsWith('Failed to fetch') || msg.includes('NetworkError')) {
    return 'Verbindung fehlgeschlagen. Bitte Internetverbindung prüfen und erneut versuchen.'
  }
  return msg
}

export async function startStripeOnboarding(
  token: string | null,
): Promise<{ onboardingUrl: string }> {
  const headers = buildAuthHeaders(token)

  const accountRes = await fetch(apiUrl('/api/connect-account'), {
    method: 'POST',
    headers,
  })

  if (!accountRes.ok) {
    const body = await getJsonOrDefault(accountRes)
    throw new Error(getErrorMessage(body, 'Konto konnte nicht erstellt werden.'))
  }

  const linkRes = await fetch(apiUrl('/api/connect-onboarding-link'), {
    method: 'POST',
    headers,
  })

  if (!linkRes.ok) {
    const body = await getJsonOrDefault(linkRes)
    throw new Error(getErrorMessage(body, 'Onboarding-Link konnte nicht erstellt werden.'))
  }

  const { onboardingUrl } = await linkRes.json() as { onboardingUrl?: string }
  if (!onboardingUrl) {
    throw new Error('Onboarding-Link fehlt. Bitte versuche es erneut.')
  }

  return { onboardingUrl }
}
