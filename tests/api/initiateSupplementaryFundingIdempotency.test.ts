const { mockRequireAuth } = vi.hoisted(() => ({ mockRequireAuth: vi.fn() }))
const { mockGetSupabaseAdminWithStatus } = vi.hoisted(() => ({
  mockGetSupabaseAdminWithStatus: vi.fn(),
}))
const { mockPaymentIntentsRetrieve, mockPaymentIntentsCreate, mockPaymentIntentsCancel } = vi.hoisted(() => ({
  mockPaymentIntentsRetrieve: vi.fn(),
  mockPaymentIntentsCreate: vi.fn(),
  mockPaymentIntentsCancel: vi.fn(),
}))

vi.mock('../../api/_auth', () => ({ requireAuth: mockRequireAuth }))
vi.mock('../../api/_supabase', () => ({
  getSupabaseAdminWithStatus: mockGetSupabaseAdminWithStatus,
  formatAdminUnavailable: () => 'missing credentials.',
}))
vi.mock('../../api/_observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))
vi.mock('../../api/_attributionGuard', () => ({
  assertAttributionFinalized: vi.fn().mockResolvedValue({ ok: true, commercialOrigin: 'platform_acquired' }),
  attributionGateToHttpResponse: vi.fn(),
}))
vi.mock('../../api/_feeRate', () => ({
  resolveCommercialFeeRate: vi.fn(() => ({ rate: 0.09 })),
}))
vi.mock('../../api/_rateLimit', () => ({ applyRateLimit: vi.fn().mockResolvedValue(false) }))
vi.mock('stripe', () => ({
  default: class MockStripe {
    paymentIntents = {
      retrieve: mockPaymentIntentsRetrieve,
      create: mockPaymentIntentsCreate,
      cancel: mockPaymentIntentsCancel,
    }
  },
}))

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import handler from '../../api/initiate-supplementary-funding'

type TableResult = { data: unknown; error: unknown }

const tableQueues: Record<string, TableResult[]> = {}

function queueTableResult(table: string, result: TableResult): void {
  if (!tableQueues[table]) tableQueues[table] = []
  tableQueues[table].push(result)
}

function buildChain(table: string): Record<string, unknown> {
  const result = tableQueues[table]?.shift() ?? { data: null, error: null }
  const chain: Record<string, unknown> = {}
  const passthrough = () => chain
  chain.select = passthrough
  chain.eq = passthrough
  chain.in = passthrough
  chain.update = passthrough
  chain.maybeSingle = () => Promise.resolve(result)
  ;(chain as { then?: (fn: (value: unknown) => unknown) => Promise<unknown> }).then = (fn) =>
    Promise.resolve(result).then(fn)
  return chain
}

const adminClient = {
  from: (table: string) => buildChain(table),
}

const SPR_ID = 'spr-1'
const CUSTOMER_ID = 'customer-1'

function queueFundableRequest(externalRef: string | null): void {
  queueTableResult('supplementary_payment_requests', {
    data: {
      id: SPR_ID,
      customer_user_id: CUSTOMER_ID,
      craftsman_user_id: 'craftsman-1',
      job_id: 'job-1',
      change_order_id: 'change-1',
      amount_cents: 12500,
      currency: 'eur',
      status: 'pending',
      external_ref: externalRef,
    },
    error: null,
  })
  queueTableResult('provider_payout_accounts', {
    data: { stripe_connect_account_id: 'acct-1', charges_enabled: true, payouts_enabled: true },
    error: null,
  })
}

function queuePersist(result: TableResult): void {
  queueTableResult('supplementary_payment_requests', result)
}

function makeRequest(): VercelRequest {
  return {
    method: 'POST',
    headers: {},
    body: { supplementaryPaymentId: SPR_ID },
    url: '/api/initiate-supplementary-funding',
  } as unknown as VercelRequest
}

function makeResponse(): {
  res: VercelResponse
  statusCode: () => number
  body: () => unknown
} {
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

describe('/api/initiate-supplementary-funding — exactly-once PaymentIntent contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(tableQueues)) delete tableQueues[key]
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
    mockRequireAuth.mockResolvedValue({ userId: CUSTOMER_ID })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: adminClient })
    mockPaymentIntentsCancel.mockResolvedValue({ id: 'pi-new', status: 'canceled' })
  })

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY
  })

  it('fails closed on an ambiguous existing PaymentIntent retrieve failure', async () => {
    queueFundableRequest('pi-existing')
    mockPaymentIntentsRetrieve.mockRejectedValue(new Error('Stripe timeout'))

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(), res)

    expect(statusCode()).toBe(502)
    expect((body() as { error?: string }).error).toBe('EXISTING_PAYMENT_INTENT_UNVERIFIED')
    expect(mockPaymentIntentsCreate).not.toHaveBeenCalled()
  })

  it('uses a stable replacement key after a terminally cancelled intent', async () => {
    queueFundableRequest('pi-canceled')
    queuePersist({ data: [{ id: SPR_ID, external_ref: 'pi-replacement', status: 'funding_initiated' }], error: null })
    mockPaymentIntentsRetrieve.mockResolvedValue({ id: 'pi-canceled', status: 'canceled', client_secret: null })
    mockPaymentIntentsCreate.mockResolvedValue({ id: 'pi-replacement', client_secret: 'secret-replacement' })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(), res)

    expect(statusCode()).toBe(200)
    expect((body() as { outcome?: string }).outcome).toBe('PAYMENT_RETRY_READY')
    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: `supp_funding_${SPR_ID}_r_pi-canceled` }),
    )
  })

  it('does not return a client secret when persisting the canonical reference fails', async () => {
    queueFundableRequest(null)
    queuePersist({ data: null, error: { message: 'database unavailable' } })
    mockPaymentIntentsCreate.mockResolvedValue({ id: 'pi-new', client_secret: 'secret-new' })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(), res)

    expect(statusCode()).toBe(500)
    expect((body() as { error?: string }).error).toBe('PAYMENT_INTENT_PERSIST_FAILED')
    expect((body() as { clientSecret?: string }).clientSecret).toBeUndefined()
    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled()
  })

  it('cancels a newly created but unlinked intent after a concurrent terminal transition', async () => {
    queueFundableRequest(null)
    queuePersist({ data: [], error: null })
    mockPaymentIntentsCreate.mockResolvedValue({ id: 'pi-new', client_secret: 'secret-new' })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(), res)

    expect(statusCode()).toBe(409)
    expect((body() as { error?: string }).error).toBe('SUPPLEMENTARY_REQUEST_NO_LONGER_FUNDABLE')
    expect(mockPaymentIntentsCancel).toHaveBeenCalledWith('pi-new')
  })
})
