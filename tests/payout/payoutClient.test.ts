import { describe, it, expect, afterEach, vi } from 'vitest'
import { fetchPayoutStatus, startStripeOnboarding } from '../../src/lib/payout/client'
import { apiUrl } from '../../src/lib/api/baseUrl'

const originalFetch = globalThis.fetch

afterEach(() => {
  vi.resetAllMocks()
  if (originalFetch) {
    globalThis.fetch = originalFetch
  } else {
    // @ts-expect-error - cleanup only
    delete globalThis.fetch
  }
})

describe('payout client', () => {
  it('starts Stripe onboarding by creating the account and generating a link', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            stripeConnectAccountId: 'acct_1',
            onboardingStatus: 'onboarding_in_progress',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ onboardingUrl: 'https://stripe.test/onboard' }),
          { status: 200 },
        ),
      )

    vi.stubGlobal('fetch', fetchMock)

    const result = await startStripeOnboarding('token-123')

    expect(result.onboardingUrl).toBe('https://stripe.test/onboard')
    expect(fetchMock).toHaveBeenNthCalledWith(1, apiUrl('/api/connect-account'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-123',
      },
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, apiUrl('/api/connect-onboarding-link'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-123',
      },
    })
  })

  it('maps payout-ready state when Stripe has enabled charges and payouts', async () => {
    const payload = {
      status: 'onboarding_complete',
      account: {
        stripeConnectAccountId: 'acct_ready',
        onboardingStatus: 'onboarding_complete',
        chargesEnabled: true,
        payoutsEnabled: true,
        requirementsDue: null,
      },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })),
    )

    const result = await fetchPayoutStatus('token-ready')

    expect(result.readiness).toBe('payout_ready')
    expect(result.account?.stripeConnectAccountId).toBe('acct_ready')
  })

  it('returns onboarding_in_progress for an incomplete Connect account', async () => {
    const payload = {
      status: 'onboarding_in_progress',
      account: {
        stripeConnectAccountId: 'acct_incomplete',
        onboardingStatus: 'onboarding_in_progress',
        chargesEnabled: false,
        payoutsEnabled: false,
      },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })),
    )

    const result = await fetchPayoutStatus(null)

    expect(result.readiness).toBe('onboarding_in_progress')
    expect(result.account?.stripeConnectAccountId).toBe('acct_incomplete')
  })

  it('sends the Authorization header when a token is provided', async () => {
    const payload = {
      status: 'onboarding_in_progress',
      account: {
        stripeConnectAccountId: 'acct_incomplete',
        onboardingStatus: 'onboarding_in_progress',
        chargesEnabled: false,
        payoutsEnabled: false,
      },
    }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await fetchPayoutStatus('token-auth')

    expect(fetchMock).toHaveBeenCalledWith(apiUrl('/api/payout-account-status'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-auth',
      },
    })
  })

  it('throws with German fallback when the payout status endpoint returns unknown English error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
      ),
    )

    await expect(fetchPayoutStatus(null)).rejects.toThrow(/Status konnte nicht abgerufen werden/)
  })

  it('maps backend auth errors to German user-facing text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'Unauthorized: missing or malformed Authorization header.' }),
          { status: 401 },
        ),
      ),
    )

    await expect(fetchPayoutStatus(null)).rejects.toThrow(
      /Nicht autorisiert/
    )
  })
})
