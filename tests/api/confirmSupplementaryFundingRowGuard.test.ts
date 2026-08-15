/**
 * H1 — confirm-supplementary-funding must check UPDATE affected rows.
 *
 * The guarded UPDATE (`.eq('id').in('status', [pending|acknowledged|
 * funding_initiated])`) previously never checked affected rows and answered
 * 200 {status:'funded'} unconditionally. Race with waiveSupplementaryPayment
 * (flips the row terminal, never cancels the PaymentIntent): Stripe captured,
 * UPDATE matched 0 rows, client saw success → money stranded without
 * release/ledger.
 *
 * Contract under test:
 *   A. UPDATE matches a row                       → 200 funded (happy path)
 *   B. 0 rows + current status terminal (waived)  → refund PI + 409 REQUEST_NOT_FUNDABLE
 *   C. 0 rows + already funded by the SAME PI     → 200 idempotent, NO refund
 *   D. 0 rows + released by the SAME PI           → 200 idempotent, NO refund
 *   E. 0 rows + funded by a DIFFERENT PI          → refund (duplicate capture) + 409
 *   F. 0 rows + refund throws                     → 500 (no webhook heal exists), no 200
 *   G. UPDATE error                               → 500, no longer swallowed
 */

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockAuthenticateRequest } = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
}))

const { mockGetSupabaseAdminWithStatus } = vi.hoisted(() => ({
  mockGetSupabaseAdminWithStatus: vi.fn(),
}))

const { mockPaymentIntentsRetrieve } = vi.hoisted(() => ({
  mockPaymentIntentsRetrieve: vi.fn(),
}))

const { mockExecuteEscrowRefundForIntent } = vi.hoisted(() => ({
  mockExecuteEscrowRefundForIntent: vi.fn(),
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

vi.mock('../../api/_escrowRefundService', () => ({
  executeEscrowRefundForIntent: mockExecuteEscrowRefundForIntent,
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
import confirmSupplementaryHandler from '../../api/confirm-supplementary-funding'

// ── Request / Response helpers ────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown> = {}): VercelRequest {
  return {
    method: 'POST',
    headers: {},
    body,
    url: '/api/confirm-supplementary-funding',
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

// ── Supabase admin mock (queue per table, FIFO per from() call) ───────────────

type TableResult = { data: unknown; error: unknown }

const tableQueues: Record<string, TableResult[]> = {}
const updateCalls: Array<{ table: string; payload: unknown }> = []

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
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CUSTOMER_ID = 'customer-uuid'
const SPR_ID = 'spr-1'
const PI_ID = 'pi_supp'

const SUCCEEDED_SUPP_INTENT = {
  id: PI_ID,
  status: 'succeeded',
  metadata: {
    type: 'supplementary_funding',
    supplementaryPaymentId: SPR_ID,
  },
}

function suppBody(): Record<string, unknown> {
  return { paymentIntentId: PI_ID, supplementaryPaymentId: SPR_ID }
}

/** from() call #1: ownership check (JWT path). */
function queueOwnership(): void {
  queueTableResult('supplementary_payment_requests', {
    data: { customer_user_id: CUSTOMER_ID },
    error: null,
  })
}

/** from() call #2: the guarded UPDATE (…select() resolves to affected rows). */
function queueUpdateResult(rows: unknown[], error: unknown = null): void {
  queueTableResult('supplementary_payment_requests', { data: rows, error })
}

/** from() call #3 (only on 0 affected rows): current-state fetch. */
function queueCurrentState(status: string, externalRef: string | null): void {
  queueTableResult('supplementary_payment_requests', {
    data: { status, external_ref: externalRef },
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

  mockAuthenticateRequest.mockResolvedValue({ ok: true, userId: CUSTOMER_ID })
  mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: adminClient })
  mockPaymentIntentsRetrieve.mockResolvedValue(SUCCEEDED_SUPP_INTENT)
  mockExecuteEscrowRefundForIntent.mockResolvedValue({ ok: true, mode: 'refunded' })
})

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY
  delete process.env.FUNDING_CONFIRM_SECRET
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('api/confirm-supplementary-funding — UPDATE row-count guard (H1)', () => {
  it('A: returns 200 funded when the guarded UPDATE transitions the row', async () => {
    queueOwnership()
    queueUpdateResult([{ id: SPR_ID }])

    const { res, statusCode, body } = makeResponse()
    await confirmSupplementaryHandler(makeRequest(suppBody()), res)

    expect(statusCode()).toBe(200)
    expect((body() as { status?: string }).status).toBe('funded')
    expect(mockExecuteEscrowRefundForIntent).not.toHaveBeenCalled()
  })

  it('B: waived race — 0 rows updated → refunds the captured PI and returns 409 REQUEST_NOT_FUNDABLE', async () => {
    queueOwnership()
    queueUpdateResult([])
    queueCurrentState('waived', null)

    const { res, statusCode, body } = makeResponse()
    await confirmSupplementaryHandler(makeRequest(suppBody()), res)

    expect(statusCode()).toBe(409)
    expect((body() as { code?: string }).code).toBe('REQUEST_NOT_FUNDABLE')
    expect(mockExecuteEscrowRefundForIntent).toHaveBeenCalledTimes(1)
    // Refunds the retrieved intent (metadata-bound to THIS request)
    expect(mockExecuteEscrowRefundForIntent.mock.calls[0][1]).toMatchObject({ id: PI_ID })
  })

  it('C: already funded by the SAME PI → 200 idempotent, no refund', async () => {
    queueOwnership()
    queueUpdateResult([])
    queueCurrentState('funded', PI_ID)

    const { res, statusCode, body } = makeResponse()
    await confirmSupplementaryHandler(makeRequest(suppBody()), res)

    expect(statusCode()).toBe(200)
    expect((body() as { status?: string }).status).toBe('funded')
    expect(mockExecuteEscrowRefundForIntent).not.toHaveBeenCalled()
  })

  it('D: already released via the SAME PI → 200 idempotent, no refund', async () => {
    queueOwnership()
    queueUpdateResult([])
    queueCurrentState('released', PI_ID)

    const { res, statusCode } = makeResponse()
    await confirmSupplementaryHandler(makeRequest(suppBody()), res)

    expect(statusCode()).toBe(200)
    expect(mockExecuteEscrowRefundForIntent).not.toHaveBeenCalled()
  })

  it('E: funded by a DIFFERENT PI (duplicate capture) → refund + 409', async () => {
    queueOwnership()
    queueUpdateResult([])
    queueCurrentState('funded', 'pi_other')

    const { res, statusCode, body } = makeResponse()
    await confirmSupplementaryHandler(makeRequest(suppBody()), res)

    expect(statusCode()).toBe(409)
    expect((body() as { code?: string }).code).toBe('REQUEST_NOT_FUNDABLE')
    expect(mockExecuteEscrowRefundForIntent).toHaveBeenCalledTimes(1)
  })

  it('F: refund failure on terminal state → 500 (retryable), never a false 200', async () => {
    queueOwnership()
    queueUpdateResult([])
    queueCurrentState('waived', null)
    mockExecuteEscrowRefundForIntent.mockRejectedValue(new Error('stripe down'))

    const { res, statusCode, body } = makeResponse()
    await confirmSupplementaryHandler(makeRequest(suppBody()), res)

    expect(statusCode()).toBe(500)
    expect((body() as { status?: string }).status).toBeUndefined()
  })

  it('G: UPDATE error is no longer swallowed → 500', async () => {
    queueOwnership()
    queueUpdateResult([], { message: 'db exploded' })

    const { res, statusCode, body } = makeResponse()
    await confirmSupplementaryHandler(makeRequest(suppBody()), res)

    expect(statusCode()).toBe(500)
    expect((body() as { error?: string }).error).toContain('db exploded')
    expect(mockExecuteEscrowRefundForIntent).not.toHaveBeenCalled()
  })
})
