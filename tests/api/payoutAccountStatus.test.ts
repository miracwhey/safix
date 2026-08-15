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

const { mockStripeRetrieve } = vi.hoisted(() => ({
  mockStripeRetrieve: vi.fn(),
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
    accounts = { retrieve: mockStripeRetrieve }
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

import handler from '../../api/payout-account-status'

function makeRequest(method: string, headers: Record<string, string | undefined> = {}): VercelRequest {
  return { method, headers, url: '/api/payout-account-status' } as unknown as VercelRequest
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

describe('/api/payout-account-status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.STRIPE_SECRET_KEY = 'sk_test_key'
    mockRequireOwner.mockImplementation(async () => {
      const auth = await mockAuthenticateRequest()
      if (!auth.ok) return null
      return { userId: auth.userId, user: auth.user, role: 'craftsman', craftsmanRole: 'owner' }
    })
  })

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY
  })

  it('returns onboarding status and updates the payout account when auth and env are valid', async () => {
    mockAuthenticateRequest.mockResolvedValue({ ok: true, userId: 'user-123', user: {} })

    let capturedUpdate: Record<string, unknown> | null = null
    const providerMaybeSingle = vi.fn().mockResolvedValue({
      data: { id: 'prov-1', profile_id: 'user-123' },
      error: null,
    })
    const payoutMaybeSingle = vi.fn().mockResolvedValue({
      data: { stripe_connect_account_id: 'acct_123', onboarding_completed_at: null },
      error: null,
    })
    const updateEq = vi.fn().mockResolvedValue({ error: null })
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'providers') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({ maybeSingle: providerMaybeSingle })),
            })),
          }
        }
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ maybeSingle: payoutMaybeSingle })),
          })),
          update: vi.fn((payload: Record<string, unknown>) => {
            capturedUpdate = payload
            return { eq: updateEq }
          }),
        }
      }),
    } as unknown as SupabaseClient

    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin })
    mockStripeRetrieve.mockResolvedValue({
      charges_enabled: true,
      payouts_enabled: true,
      requirements: { currently_due: [] },
    })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest('POST'), res)

    expect(statusCode()).toBe(200)
    expect(body().status).toBe('onboarding_complete')
    expect(updateEq).toHaveBeenCalledWith('provider_user_id', 'user-123')
    expect(capturedUpdate?.onboarding_status).toBe('onboarding_complete')
    expect(capturedUpdate?.payouts_enabled).toBe(true)
  })

  it('returns 404 when the provider profile does not exist', async () => {
    mockAuthenticateRequest.mockResolvedValue({ ok: true, userId: 'user-456', user: {} })

    const providerMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'providers') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({ maybeSingle: providerMaybeSingle })),
            })),
          }
        }
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ maybeSingle: vi.fn() })),
          })),
          update: vi.fn(),
        }
      }),
    } as unknown as SupabaseClient

    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest('POST'), res)

    expect(statusCode()).toBe(404)
    expect(body()).toEqual({ error: 'No provider profile found for the authenticated user.' })
  })

  it('returns no_account when the payout record is missing', async () => {
    mockAuthenticateRequest.mockResolvedValue({ ok: true, userId: 'user-789', user: {} })

    const providerMaybeSingle = vi.fn().mockResolvedValue({
      data: { id: 'prov-2', profile_id: 'user-789' },
      error: null,
    })
    const payoutMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'providers') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({ maybeSingle: providerMaybeSingle })),
            })),
          }
        }
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ maybeSingle: payoutMaybeSingle })),
          })),
          update: vi.fn(),
        }
      }),
    } as unknown as SupabaseClient

    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest('POST'), res)

    expect(statusCode()).toBe(200)
    expect(body()).toEqual({
      status: 'no_account',
      account: null,
      reason: 'missing_payout_account',
    })
  })

  it('returns no_account when the payout record exists without a Stripe account id', async () => {
    mockAuthenticateRequest.mockResolvedValue({ ok: true, userId: 'user-322', user: {} })

    const providerMaybeSingle = vi.fn().mockResolvedValue({
      data: { id: 'prov-3', profile_id: 'user-322' },
      error: null,
    })
    const payoutMaybeSingle = vi.fn().mockResolvedValue({
      data: { stripe_connect_account_id: null, onboarding_status: 'not_started' },
      error: null,
    })
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'providers') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({ maybeSingle: providerMaybeSingle })),
            })),
          }
        }
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ maybeSingle: payoutMaybeSingle })),
          })),
          update: vi.fn(),
        }
      }),
    } as unknown as SupabaseClient

    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest('POST'), res)

    expect(statusCode()).toBe(200)
    expect(body()).toEqual({
      status: 'no_account',
      account: null,
      reason: 'missing_stripe_account_id',
    })
  })

  it('surfaces Stripe account retrieval failures with details', async () => {
    mockAuthenticateRequest.mockResolvedValue({ ok: true, userId: 'user-321', user: {} })

    const providerMaybeSingle = vi.fn().mockResolvedValue({
      data: { id: 'prov-3', profile_id: 'user-321' },
      error: null,
    })
    const payoutMaybeSingle = vi.fn().mockResolvedValue({
      data: { stripe_connect_account_id: 'acct_error', onboarding_completed_at: null },
      error: null,
    })
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'providers') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({ maybeSingle: providerMaybeSingle })),
            })),
          }
        }
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ maybeSingle: payoutMaybeSingle })),
          })),
          update: vi.fn(),
        }
      }),
    } as unknown as SupabaseClient

    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin })
    mockStripeRetrieve.mockRejectedValue(new Error('stripe boom'))

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest('POST'), res)

    expect(statusCode()).toBe(502)
    expect(body()).toEqual({ error: 'Failed to retrieve Stripe account: stripe boom' })
  })

  it('returns 500 with a precise error when the admin client cannot be built', async () => {
    mockAuthenticateRequest.mockResolvedValue({ ok: true, userId: 'user-123', user: {} })
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: false,
      missing: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest('POST'), res)

    expect(statusCode()).toBe(500)
    expect(body().error).toContain('SUPABASE_URL')
    expect(body().error).toContain('SUPABASE_SERVICE_ROLE_KEY')
  })

  it('returns 500 when the payout storage table is missing', async () => {
    mockAuthenticateRequest.mockResolvedValue({ ok: true, userId: 'user-missing', user: {} })

    const providerMaybeSingle = vi.fn().mockResolvedValue({
      data: { id: 'prov-missing', profile_id: 'user-missing' },
      error: null,
    })
    const payoutMaybeSingle = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "Could not find the table 'public.provider_payout_accounts' in the schema cache" },
    })
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'providers') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({ maybeSingle: providerMaybeSingle })),
            })),
          }
        }
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ maybeSingle: payoutMaybeSingle })),
          })),
          update: vi.fn(),
        }
      }),
    } as unknown as SupabaseClient

    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin })
    mockStripeRetrieve.mockResolvedValue({
      charges_enabled: true,
      payouts_enabled: true,
      requirements: { currently_due: [] },
    })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest('POST'), res)

    expect(statusCode()).toBe(500)
    expect(body()).toEqual({ error: 'Payout account storage is missing from the database schema.' })
  })
})
