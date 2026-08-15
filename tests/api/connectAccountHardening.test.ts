const { mockRequireOwner } = vi.hoisted(() => ({ mockRequireOwner: vi.fn() }))
const { mockGetSupabaseAdminWithStatus } = vi.hoisted(() => ({
  mockGetSupabaseAdminWithStatus: vi.fn(),
}))
const { mockAccountsCreate } = vi.hoisted(() => ({ mockAccountsCreate: vi.fn() }))

vi.mock('../../api/_authRole', () => ({ requireOwner: mockRequireOwner }))
vi.mock('../../api/_supabase', () => ({
  getSupabaseAdminWithStatus: mockGetSupabaseAdminWithStatus,
  formatAdminUnavailable: () => 'missing credentials.',
}))
vi.mock('../../api/_subscriptionAuth', () => ({
  requireProEntitlement: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('../../api/_rateLimit', () => ({ applyRateLimit: vi.fn().mockResolvedValue(false) }))
vi.mock('../../api/_observability', () => ({ logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('stripe', () => ({
  default: class MockStripe {
    accounts = { create: mockAccountsCreate }
  },
}))

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { SupabaseClient } from '@supabase/supabase-js'
import handler from '../../api/connect-account'

function makeRequest(): VercelRequest {
  return { method: 'POST', headers: {}, body: {}, url: '/api/connect-account' } as unknown as VercelRequest
}

function makeResponse(): { res: VercelResponse; statusCode: () => number; body: () => unknown } {
  let status = 0
  let payload: unknown
  const res = {
    setHeader: vi.fn(() => res),
    status: vi.fn((nextStatus: number) => {
      status = nextStatus
      return res
    }),
    json: vi.fn((nextPayload: unknown) => {
      payload = nextPayload
      return res
    }),
  } as unknown as VercelResponse
  return { res, statusCode: () => status, body: () => payload }
}

function buildAdmin(options: {
  provider?: { id: string } | null
  payoutRows?: Array<{ stripe_connect_account_id: string | null } | null>
  upsertErrors?: Array<{ message: string } | null>
}): SupabaseClient {
  const provider = options.provider === undefined ? { id: 'provider-1' } : options.provider
  const payoutRows = [...(options.payoutRows ?? [null])]
  const upsertErrors = [...(options.upsertErrors ?? [null])]
  return {
    from: vi.fn((table: string) => {
      if (table === 'providers') {
        return {
          select: vi.fn(() => ({
              eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: provider, error: null }) })),
          })),
        }
      }
      if (table === 'provider_payout_accounts') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockImplementation(async () => ({ data: payoutRows.shift() ?? null, error: null })),
            })),
          })),
          upsert: vi.fn().mockImplementation(async () => ({ error: upsertErrors.shift() ?? null })),
        }
      }
      return {}
    }),
  } as unknown as SupabaseClient
}

describe('/api/connect-account — owner and exactly-once boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
    mockRequireOwner.mockResolvedValue({
      userId: 'owner-1',
      user: {},
      role: 'craftsman',
      craftsmanRole: 'owner',
    })
    mockAccountsCreate.mockResolvedValue({ id: 'acct_1' })
  })

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY
  })

  it('never reaches Stripe when the authenticated owner has no provider profile', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: buildAdmin({ provider: null }),
    })
    const { res, statusCode } = makeResponse()

    await handler(makeRequest(), res)

    expect(statusCode()).toBe(409)
    expect(mockAccountsCreate).not.toHaveBeenCalled()
  })

  it('creates an Express account with a stable user-bound idempotency key', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: buildAdmin({ payoutRows: [null], upsertErrors: [null] }),
    })
    const { res, statusCode, body } = makeResponse()

    await handler(makeRequest(), res)

    expect(statusCode()).toBe(200)
    expect((body() as { stripeConnectAccountId?: string }).stripeConnectAccountId).toBe('acct_1')
    expect(mockAccountsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { provider_user_id: 'owner-1' } }),
      expect.objectContaining({ idempotencyKey: 'stripe_connect_account_owner-1' }),
    )
  })

  it('uses the same Stripe key when a failed DB link is retried', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: buildAdmin({
        payoutRows: [null, null],
        upsertErrors: [{ message: 'temporary database error' }, null],
      }),
    })

    const first = makeResponse()
    await handler(makeRequest(), first.res)
    const second = makeResponse()
    await handler(makeRequest(), second.res)

    expect(first.statusCode()).toBe(500)
    expect(second.statusCode()).toBe(200)
    expect(mockAccountsCreate).toHaveBeenCalledTimes(2)
    expect(mockAccountsCreate.mock.calls.map(([, options]) => options.idempotencyKey)).toEqual([
      'stripe_connect_account_owner-1',
      'stripe_connect_account_owner-1',
    ])
  })
})
