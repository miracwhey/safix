/**
 * H9 — Stripe PaymentIntent verification on funding confirmation.
 *
 * api/confirm-funding.ts and api/confirm-supplementary-funding.ts mark
 * funding as confirmed. Before H9 they trusted the caller-provided
 * paymentIntentId string blindly — a customer could flip their own funding
 * request / supplementary payment request to 'funded' with any `pi_…` string
 * without ever paying. Both endpoints must now verify against Stripe
 * BEFORE any DB write (fail-closed):
 *
 *   A. PI status !== 'succeeded'           → 409 INTENT_NOT_CAPTURED, no DB write
 *   B. PI metadata does not bind to the    → 409 PI_METADATA_MISMATCH, no DB write
 *      resolved funding request / SPR
 *   C. Stripe retrieve fails               → 502, no DB write
 *   D. STRIPE_SECRET_KEY missing           → 500, no Stripe call, no DB write
 *   E. succeeded + metadata match          → 200, DB write happens
 *   F. Server-secret auth path is ALSO subject to PI verification
 */

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockRequireCustomer } = vi.hoisted(() => ({
  mockRequireCustomer: vi.fn(),
}))

const { mockAuthenticateRequest } = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
}))

const { mockGetSupabaseAdminWithStatus } = vi.hoisted(() => ({
  mockGetSupabaseAdminWithStatus: vi.fn(),
}))

const { mockPaymentIntentsRetrieve } = vi.hoisted(() => ({
  mockPaymentIntentsRetrieve: vi.fn(),
}))

vi.mock('../../api/_authRole', () => ({
  requireCustomer: mockRequireCustomer,
}))

vi.mock('../../api/_auth', () => ({
  authenticateRequest: mockAuthenticateRequest,
}))

vi.mock('../../api/_supabase', () => ({
  getSupabaseAdminWithStatus: mockGetSupabaseAdminWithStatus,
  formatAdminUnavailable: (missing: string[]) =>
    missing.length > 0 ? `missing ${missing.join(', ')}.` : 'Supabase credentials missing.',
}))

vi.mock('stripe', () => ({
  default: class MockStripe {
    paymentIntents = { retrieve: mockPaymentIntentsRetrieve }
  },
}))

vi.mock('../../api/_observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('../../api/_rateLimit', () => ({
  applyRateLimit: vi.fn().mockResolvedValue(false),
}))

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import confirmFundingHandler from '../../api/confirm-funding'
import confirmSupplementaryHandler from '../../api/confirm-supplementary-funding'

// ── Request / Response helpers ────────────────────────────────────────────────

function makeRequest(
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): VercelRequest {
  return {
    method: 'POST',
    headers,
    body,
    url: '/api/test',
  } as unknown as VercelRequest
}

function makeResponse(): {
  res: VercelResponse
  statusCode: () => number
  body: () => unknown
} {
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
    end: vi.fn(() => res),
  } as unknown as VercelResponse
  return { res, statusCode: () => _status, body: () => _body }
}

// ── Supabase admin mock ───────────────────────────────────────────────────────

type TableResult = { data: unknown; error: unknown }

const tableQueues: Record<string, TableResult[]> = {}
const updateCalls: Array<{ table: string; payload: unknown }> = []
const mockRpc = vi.fn()

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
  chain.update = (payload: unknown) => {
    updateCalls.push({ table, payload })
    return chain
  }
  chain.maybeSingle = () => Promise.resolve(result)
  chain.single = () => Promise.resolve(result)
  ;(chain as { then?: (fn: (v: unknown) => unknown) => Promise<unknown> }).then = (fn) =>
    Promise.resolve(result).then(fn)
  return chain
}

const adminClient = {
  from: (table: string) => buildChain(table),
  rpc: mockRpc,
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CUSTOMER_ID = 'customer-uuid'

const SUCCEEDED_ESCROW_INTENT = {
  status: 'succeeded',
  metadata: {
    type: 'escrow_funding',
    fundingRequestId: 'fr-1',
    escrowPlanId: 'plan-1',
  },
}

const SUCCEEDED_SUPP_INTENT = {
  status: 'succeeded',
  metadata: {
    type: 'supplementary_funding',
    supplementaryPaymentId: 'spr-1',
  },
}

function confirmFundingBody(): Record<string, unknown> {
  return {
    paymentIntentId: 'pi_test',
    fundingRequestId: 'fr-1',
    escrowPlanId: 'plan-1',
    jobId: 'job-1',
  }
}

function queueFundingOwnership(customerUserId: string = CUSTOMER_ID): void {
  queueTableResult('funding_requests', {
    data: {
      id: 'fr-1',
      escrow_plan_id: 'plan-1',
      job_id: 'job-1',
      customer_user_id: customerUserId,
      external_funding_ref: 'pi_test',
    },
    error: null,
  })
}

function queueSupplementaryOwnership(customerUserId: string = CUSTOMER_ID): void {
  queueTableResult('supplementary_payment_requests', {
    data: { customer_user_id: customerUserId },
    error: null,
  })
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(tableQueues)) delete tableQueues[k]
  updateCalls.length = 0

  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  delete process.env.FUNDING_CONFIRM_SECRET

  mockRequireCustomer.mockResolvedValue({ userId: CUSTOMER_ID, role: 'customer' })
  mockAuthenticateRequest.mockResolvedValue({ ok: true, userId: CUSTOMER_ID })
  mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: adminClient })
  mockRpc.mockResolvedValue({
    data: { outcome: 'confirmed', funding_request_updated: true, escrow_plan_updated: true, tranches_updated: 2 },
    error: null,
  })
})

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY
  delete process.env.FUNDING_CONFIRM_SECRET
})

// ── confirm-funding ───────────────────────────────────────────────────────────

describe('api/confirm-funding — Stripe PI verification (H9)', () => {
  it('returns 409 INTENT_NOT_CAPTURED when PI status is requires_payment_method', async () => {
    queueFundingOwnership()
    mockPaymentIntentsRetrieve.mockResolvedValue({
      ...SUCCEEDED_ESCROW_INTENT,
      status: 'requires_payment_method',
    })

    const { res, statusCode, body } = makeResponse()
    await confirmFundingHandler(makeRequest(confirmFundingBody()), res)

    expect(statusCode()).toBe(409)
    expect((body() as { code?: string }).code).toBe('INTENT_NOT_CAPTURED')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('returns 409 INTENT_NOT_CAPTURED when PI status is requires_capture', async () => {
    queueFundingOwnership()
    mockPaymentIntentsRetrieve.mockResolvedValue({
      ...SUCCEEDED_ESCROW_INTENT,
      status: 'requires_capture',
    })

    const { res, statusCode, body } = makeResponse()
    await confirmFundingHandler(makeRequest(confirmFundingBody()), res)

    expect(statusCode()).toBe(409)
    expect((body() as { code?: string }).code).toBe('INTENT_NOT_CAPTURED')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('returns 409 PI_METADATA_MISMATCH when metadata.fundingRequestId differs', async () => {
    queueFundingOwnership()
    mockPaymentIntentsRetrieve.mockResolvedValue({
      status: 'succeeded',
      metadata: {
        type: 'escrow_funding',
        fundingRequestId: 'fr-OTHER',
        escrowPlanId: 'plan-1',
      },
    })

    const { res, statusCode, body } = makeResponse()
    await confirmFundingHandler(makeRequest(confirmFundingBody()), res)

    expect(statusCode()).toBe(409)
    expect((body() as { code?: string }).code).toBe('PI_METADATA_MISMATCH')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('returns 409 PI_METADATA_MISMATCH when metadata.type is missing', async () => {
    queueFundingOwnership()
    mockPaymentIntentsRetrieve.mockResolvedValue({
      status: 'succeeded',
      metadata: {
        fundingRequestId: 'fr-1',
        escrowPlanId: 'plan-1',
      },
    })

    const { res, statusCode, body } = makeResponse()
    await confirmFundingHandler(makeRequest(confirmFundingBody()), res)

    expect(statusCode()).toBe(409)
    expect((body() as { code?: string }).code).toBe('PI_METADATA_MISMATCH')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('returns 409 PI_METADATA_MISMATCH when both escrowPlanIds are set but differ', async () => {
    queueFundingOwnership()
    mockPaymentIntentsRetrieve.mockResolvedValue({
      status: 'succeeded',
      metadata: {
        type: 'escrow_funding',
        fundingRequestId: 'fr-1',
        escrowPlanId: 'plan-OTHER',
      },
    })

    const { res, statusCode, body } = makeResponse()
    await confirmFundingHandler(makeRequest(confirmFundingBody()), res)

    expect(statusCode()).toBe(409)
    expect((body() as { code?: string }).code).toBe('PI_METADATA_MISMATCH')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('returns 409 PI_METADATA_MISMATCH when metadata lacks the canonical escrowPlanId', async () => {
    queueFundingOwnership()
    mockPaymentIntentsRetrieve.mockResolvedValue({
      status: 'succeeded',
      metadata: {
        type: 'escrow_funding',
        fundingRequestId: 'fr-1',
      },
    })

    const { res, statusCode, body } = makeResponse()
    await confirmFundingHandler(makeRequest(confirmFundingBody()), res)

    expect(statusCode()).toBe(409)
    expect((body() as { code?: string }).code).toBe('PI_METADATA_MISMATCH')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('returns 502 when the Stripe retrieve call fails — no RPC', async () => {
    queueFundingOwnership()
    mockPaymentIntentsRetrieve.mockRejectedValue(new Error('No such payment_intent: pi_test'))

    const { res, statusCode } = makeResponse()
    await confirmFundingHandler(makeRequest(confirmFundingBody()), res)

    expect(statusCode()).toBe(502)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('returns 500 when STRIPE_SECRET_KEY is not configured — no Stripe call, no RPC', async () => {
    delete process.env.STRIPE_SECRET_KEY
    queueFundingOwnership()

    const { res, statusCode } = makeResponse()
    await confirmFundingHandler(makeRequest(confirmFundingBody()), res)

    expect(statusCode()).toBe(500)
    expect(mockPaymentIntentsRetrieve).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('returns 200 and calls the atomic RPC when PI succeeded + metadata match', async () => {
    queueFundingOwnership()
    mockPaymentIntentsRetrieve.mockResolvedValue(SUCCEEDED_ESCROW_INTENT)

    const { res, statusCode, body } = makeResponse()
    await confirmFundingHandler(makeRequest(confirmFundingBody()), res)

    expect(statusCode()).toBe(200)
    expect((body() as { status?: string }).status).toBe('funded_in_escrow')
    expect(mockPaymentIntentsRetrieve).toHaveBeenCalledWith('pi_test')
    expect(mockRpc).toHaveBeenCalledWith('confirm_funding_atomic', {
      p_funding_request_id: 'fr-1',
      p_escrow_plan_id: 'plan-1',
      p_payment_intent_id: 'pi_test',
    })
  })

  it('ignores caller-supplied plan and job IDs in favor of the funding request relationship', async () => {
    queueFundingOwnership()
    mockPaymentIntentsRetrieve.mockResolvedValue(SUCCEEDED_ESCROW_INTENT)

    const { res, statusCode } = makeResponse()
    await confirmFundingHandler(
      makeRequest({ ...confirmFundingBody(), escrowPlanId: 'plan-attacker', jobId: 'job-attacker' }),
      res,
    )

    expect(statusCode()).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('confirm_funding_atomic', {
      p_funding_request_id: 'fr-1',
      p_escrow_plan_id: 'plan-1',
      p_payment_intent_id: 'pi_test',
    })
  })

  it('server-secret auth path is also subject to PI verification (fail-closed)', async () => {
    process.env.FUNDING_CONFIRM_SECRET = 'server-secret'
    queueFundingOwnership()
    mockPaymentIntentsRetrieve.mockResolvedValue({
      ...SUCCEEDED_ESCROW_INTENT,
      status: 'requires_capture',
    })

    const { res, statusCode, body } = makeResponse()
    await confirmFundingHandler(
      makeRequest(confirmFundingBody(), { 'x-funding-confirm-secret': 'server-secret' }),
      res,
    )

    // Server-secret callers skip role/ownership gates but NOT the PI verify.
    expect(mockRequireCustomer).not.toHaveBeenCalled()
    expect(statusCode()).toBe(409)
    expect((body() as { code?: string }).code).toBe('INTENT_NOT_CAPTURED')
    expect(mockRpc).not.toHaveBeenCalled()
  })
})

// ── confirm-supplementary-funding ─────────────────────────────────────────────

describe('api/confirm-supplementary-funding — Stripe PI verification (H9)', () => {
  function suppBody(): Record<string, unknown> {
    return { paymentIntentId: 'pi_supp', supplementaryPaymentId: 'spr-1' }
  }

  function suppUpdateCalls(): Array<{ table: string; payload: unknown }> {
    return updateCalls.filter((c) => c.table === 'supplementary_payment_requests')
  }

  it('returns 409 INTENT_NOT_CAPTURED when PI is not succeeded — no DB update', async () => {
    queueSupplementaryOwnership()
    mockPaymentIntentsRetrieve.mockResolvedValue({
      ...SUCCEEDED_SUPP_INTENT,
      status: 'requires_capture',
    })

    const { res, statusCode, body } = makeResponse()
    await confirmSupplementaryHandler(makeRequest(suppBody()), res)

    expect(statusCode()).toBe(409)
    expect((body() as { code?: string }).code).toBe('INTENT_NOT_CAPTURED')
    expect(suppUpdateCalls()).toHaveLength(0)
  })

  it('returns 409 PI_METADATA_MISMATCH when metadata.supplementaryPaymentId differs', async () => {
    queueSupplementaryOwnership()
    mockPaymentIntentsRetrieve.mockResolvedValue({
      status: 'succeeded',
      metadata: {
        type: 'supplementary_funding',
        supplementaryPaymentId: 'spr-OTHER',
      },
    })

    const { res, statusCode, body } = makeResponse()
    await confirmSupplementaryHandler(makeRequest(suppBody()), res)

    expect(statusCode()).toBe(409)
    expect((body() as { code?: string }).code).toBe('PI_METADATA_MISMATCH')
    expect(suppUpdateCalls()).toHaveLength(0)
  })

  it('returns 409 PI_METADATA_MISMATCH when metadata.type is wrong', async () => {
    queueSupplementaryOwnership()
    mockPaymentIntentsRetrieve.mockResolvedValue({
      status: 'succeeded',
      metadata: {
        type: 'escrow_funding',
        supplementaryPaymentId: 'spr-1',
      },
    })

    const { res, statusCode, body } = makeResponse()
    await confirmSupplementaryHandler(makeRequest(suppBody()), res)

    expect(statusCode()).toBe(409)
    expect((body() as { code?: string }).code).toBe('PI_METADATA_MISMATCH')
    expect(suppUpdateCalls()).toHaveLength(0)
  })

  it('returns 502 when the Stripe retrieve call fails — no DB update', async () => {
    queueSupplementaryOwnership()
    mockPaymentIntentsRetrieve.mockRejectedValue(new Error('No such payment_intent: pi_supp'))

    const { res, statusCode } = makeResponse()
    await confirmSupplementaryHandler(makeRequest(suppBody()), res)

    expect(statusCode()).toBe(502)
    expect(suppUpdateCalls()).toHaveLength(0)
  })

  it('returns 500 when STRIPE_SECRET_KEY is not configured — no Stripe call, no update', async () => {
    delete process.env.STRIPE_SECRET_KEY
    queueSupplementaryOwnership()

    const { res, statusCode } = makeResponse()
    await confirmSupplementaryHandler(makeRequest(suppBody()), res)

    expect(statusCode()).toBe(500)
    expect(mockPaymentIntentsRetrieve).not.toHaveBeenCalled()
    expect(suppUpdateCalls()).toHaveLength(0)
  })

  it('returns 200 and writes funded only after PI succeeded + metadata match', async () => {
    queueSupplementaryOwnership()
    // H1: the guarded UPDATE now checks affected rows via .select() — queue a
    // non-empty result so the happy path sees its row transitioned.
    queueTableResult('supplementary_payment_requests', {
      data: [{ id: 'spr-1' }],
      error: null,
    })
    mockPaymentIntentsRetrieve.mockResolvedValue(SUCCEEDED_SUPP_INTENT)

    const { res, statusCode, body } = makeResponse()
    await confirmSupplementaryHandler(makeRequest(suppBody()), res)

    expect(statusCode()).toBe(200)
    expect((body() as { status?: string }).status).toBe('funded')
    expect(mockPaymentIntentsRetrieve).toHaveBeenCalledWith('pi_supp')
    const updates = suppUpdateCalls()
    expect(updates).toHaveLength(1)
    expect((updates[0].payload as { status?: string }).status).toBe('funded')
    expect((updates[0].payload as { external_ref?: string }).external_ref).toBe('pi_supp')
  })

  it('server-secret auth path is also subject to PI verification (fail-closed)', async () => {
    process.env.FUNDING_CONFIRM_SECRET = 'server-secret'
    mockPaymentIntentsRetrieve.mockResolvedValue({
      ...SUCCEEDED_SUPP_INTENT,
      status: 'processing',
    })

    const { res, statusCode, body } = makeResponse()
    await confirmSupplementaryHandler(
      makeRequest(suppBody(), { 'x-funding-confirm-secret': 'server-secret' }),
      res,
    )

    expect(mockAuthenticateRequest).not.toHaveBeenCalled()
    expect(statusCode()).toBe(409)
    expect((body() as { code?: string }).code).toBe('INTENT_NOT_CAPTURED')
    expect(suppUpdateCalls()).toHaveLength(0)
  })
})
