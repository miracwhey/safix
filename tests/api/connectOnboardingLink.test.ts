import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { SupabaseClient } from '@supabase/supabase-js'

const { mockAuthenticateRequest } = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
}))

const { mockRequireOwner } = vi.hoisted(() => ({
  mockRequireOwner: vi.fn(),
}))

const { mockGetSupabaseAdminWithStatus } = vi.hoisted(() => ({
  mockGetSupabaseAdminWithStatus: vi.fn(),
}))

const { mockStripeCreate } = vi.hoisted(() => ({
  mockStripeCreate: vi.fn(),
}))

vi.mock('../../api/_auth', () => ({
  authenticateRequest: mockAuthenticateRequest,
  requireAuth: async (req: unknown, res: { status: (code: number) => { json: (payload: unknown) => void } }) => {
    const result = await mockAuthenticateRequest(req)
    if (!result.ok) {
      res.status(result.statusCode).json({ error: result.error })
      return null
    }
    return { userId: result.userId, user: result.user }
  },
}))

vi.mock('../../api/_authRole', () => ({
  requireOwner: mockRequireOwner,
}))

vi.mock('../../api/_supabase', () => ({
  getSupabaseAdminWithStatus: mockGetSupabaseAdminWithStatus,
  getSupabaseAdmin: vi.fn(),
  formatAdminUnavailable: (missing: string[]) =>
    missing.length > 0
      ? `missing ${missing.join(', ')}.`
      : 'Supabase server credentials missing or invalid.',
}))

vi.mock('stripe', () => ({
  default: class MockStripe {
    accountLinks = { create: mockStripeCreate }
  },
}))

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}))

vi.mock('../../api/_subscriptionAuth', () => ({
  requireProEntitlement: vi.fn().mockResolvedValue({ ok: true }),
}))

import handler from '../../api/connect-onboarding-link'

function makeRequest(method: string, headers: Record<string, string | undefined> = {}): VercelRequest {
  return { method, headers, url: '/api/connect-onboarding-link' } as unknown as VercelRequest
}

function makeResponse(): { res: VercelResponse; statusCode: () => number; body: () => unknown } {
  let _status = 0
  let _body: unknown
  const res = {
    setHeader: vi.fn(() => res),
    status: vi.fn((code: number) => {
      _status = code
      return res
    }),
    json: vi.fn((payload: unknown) => {
      _body = payload
    }),
  } as unknown as VercelResponse
  return { res, statusCode: () => _status, body: () => _body }
}

describe('/api/connect-onboarding-link', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.STRIPE_SECRET_KEY = 'sk_test_key'
    process.env.APP_BASE_URL = 'https://fixup.app'
    mockAuthenticateRequest.mockResolvedValue({ ok: true, userId: 'user-1', user: {} })
    mockRequireOwner.mockImplementation(async () => {
      const auth = await mockAuthenticateRequest()
      if (!auth.ok) return null
      return { userId: auth.userId, user: auth.user, role: 'craftsman', craftsmanRole: 'owner' }
    })
  })

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY
    delete process.env.APP_BASE_URL
  })

  it('generates an onboarding link and marks the payout account as in progress', async () => {
    let capturedUpdate: Record<string, unknown> | null = null
    const payoutMaybeSingle = vi.fn().mockResolvedValue({
      data: { stripe_connect_account_id: 'acct_123' },
      error: null,
    })
    const updateEq = vi.fn().mockResolvedValue({ error: null })
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'providers') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'provider-1' }, error: null }) })),
            })),
          }
        }
        if (table === 'provider_payout_accounts') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({ maybeSingle: payoutMaybeSingle })),
            })),
            update: vi.fn((payload: Record<string, unknown>) => {
              capturedUpdate = payload
              return { eq: updateEq }
            }),
          }
        }
        return { select: vi.fn() }
      }),
    } as unknown as SupabaseClient

    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin })
    mockStripeCreate.mockResolvedValue({ url: 'https://stripe.test/onboard' })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest('POST'), res)

    expect(statusCode()).toBe(200)
    expect(body()).toEqual({ onboardingUrl: 'https://stripe.test/onboard' })
    expect(mockStripeCreate).toHaveBeenCalledWith({
      account: 'acct_123',
      refresh_url: 'https://fixup.app/payout-refresh',
      return_url: 'https://fixup.app/payout-return',
      type: 'account_onboarding',
    })
    expect(capturedUpdate?.onboarding_status).toBe('onboarding_in_progress')
    expect(updateEq).toHaveBeenCalledWith('provider_user_id', 'user-1')
  })

  it('returns 500 when APP_BASE_URL is not configured', async () => {
    delete process.env.APP_BASE_URL

    const payoutMaybeSingle = vi.fn().mockResolvedValue({
      data: { stripe_connect_account_id: 'acct_123' },
      error: null,
    })
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'providers') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'provider-1' }, error: null }) })),
            })),
          }
        }
        if (table === 'provider_payout_accounts') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({ maybeSingle: payoutMaybeSingle })),
            })),
            update: vi.fn(),
          }
        }
        return { select: vi.fn() }
      }),
    } as unknown as SupabaseClient

    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest('POST'), res)

    expect(statusCode()).toBe(500)
    expect(body()).toEqual({ error: 'Server misconfiguration: APP_BASE_URL not configured.' })
    expect(mockStripeCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when the payout account row is missing', async () => {
    const payoutMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'providers') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'provider-1' }, error: null }) })),
            })),
          }
        }
        if (table === 'provider_payout_accounts') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({ maybeSingle: payoutMaybeSingle })),
            })),
            update: vi.fn(),
          }
        }
        return { select: vi.fn() }
      }),
    } as unknown as SupabaseClient

    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest('POST'), res)

    expect(statusCode()).toBe(400)
    expect(body()).toEqual({ error: 'No payout account found. Call /api/connect-account first.' })
    expect(mockStripeCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when the payout account has no Stripe account id', async () => {
    const payoutMaybeSingle = vi.fn().mockResolvedValue({
      data: { stripe_connect_account_id: null },
      error: null,
    })
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'providers') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'provider-1' }, error: null }) })),
            })),
          }
        }
        if (table === 'provider_payout_accounts') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({ maybeSingle: payoutMaybeSingle })),
            })),
            update: vi.fn(),
          }
        }
        return { select: vi.fn() }
      }),
    } as unknown as SupabaseClient

    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest('POST'), res)

    expect(statusCode()).toBe(400)
    expect(body()).toEqual({ error: 'Stripe account id is missing for this payout account.' })
    expect(mockStripeCreate).not.toHaveBeenCalled()
  })
})
