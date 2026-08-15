/**
 * Release Supplementary Payout — Handler Authorization Gate (A29)
 *
 * Validates that api/release-supplementary-payout.ts binds the JWT caller to
 * the supplementary payment request before any money movement:
 *
 * 1. JWT caller == spr.customer_user_id  → helper invoked, 200 released
 * 2. JWT caller == spr.craftsman_user_id → helper invoked, 200 released
 * 3. Unrelated JWT + is_operator=false   → 403, helper NOT invoked (IDOR pin)
 * 4. Unrelated JWT + is_operator=true    → helper invoked, 200 released
 * 5. Server secret (cron path)           → NO SPR authz fetch, helper invoked
 * 6. JWT path + SPR not found            → 404 before helper
 * 7. Authz fetch DB error                → 500 fail-closed, helper NOT invoked
 *
 * The shared module api/_releaseSupplementaryPayout.ts is mocked — its own
 * guards are covered by tests/api/supplementaryReleaseAttributionGate.test.ts.
 */

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockAuthenticateRequest } = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
}))

const { mockGetSupabaseAdminWithStatus } = vi.hoisted(() => ({
  mockGetSupabaseAdminWithStatus: vi.fn(),
}))

const { mockReleaseSupplementaryPayout } = vi.hoisted(() => ({
  mockReleaseSupplementaryPayout: vi.fn(),
}))

const { mockFetchIsOperator } = vi.hoisted(() => ({
  mockFetchIsOperator: vi.fn(),
}))

vi.mock('../../api/_auth', () => ({
  authenticateRequest: mockAuthenticateRequest,
}))

vi.mock('../../api/_supabase', () => ({
  getSupabaseAdminWithStatus: mockGetSupabaseAdminWithStatus,
  formatAdminUnavailable: (missing: string[]) =>
    missing.length > 0 ? `missing ${missing.join(', ')}.` : 'Supabase credentials missing.',
}))

vi.mock('../../api/_releaseSupplementaryPayout', () => ({
  releaseSupplementaryPayout: mockReleaseSupplementaryPayout,
}))

vi.mock('../../api/_paymentAuth', () => ({
  fetchIsOperator: mockFetchIsOperator,
}))

vi.mock('../../api/_rateLimit', () => ({
  applyRateLimit: vi.fn().mockResolvedValue(false),
}))

vi.mock('../../api/_observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('stripe', () => ({
  default: class MockStripe {},
}))

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { SupabaseClient } from '@supabase/supabase-js'
import handler from '../../api/release-supplementary-payout'

// ── Request / Response helpers ────────────────────────────────────────────────

function makeRequest(
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): VercelRequest {
  return {
    method: 'POST',
    headers,
    body,
    url: '/api/release-supplementary-payout',
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
  } as unknown as VercelResponse
  return { res, statusCode: () => _status, body: () => _body }
}

// ── DB mock builder ──────────────────────────────────────────────────────────

/**
 * Builds a minimal Supabase admin mock.  The handler's authorization gate is
 * the ONLY DB consumer here (the release helper is mocked), so only
 * supplementary_payment_requests needs a select chain.
 */
function makeAdmin({
  spr,
  sprError = null,
}: {
  spr?: Record<string, unknown> | null
  sprError?: unknown
} = {}): { admin: SupabaseClient; fromSpy: ReturnType<typeof vi.fn> } {
  const sprSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: spr ?? null, error: sprError }),
    }),
  })

  const fromSpy = vi.fn((table: string) => {
    if (table === 'supplementary_payment_requests') return { select: sprSelect }
    return {}
  })

  const admin = { from: fromSpy } as unknown as SupabaseClient
  return { admin, fromSpy }
}

// ── Common test data ──────────────────────────────────────────────────────────

const SPR_ID = 'spr-abc-123'
const CUSTOMER_USER_ID = 'user-customer-1'
const CRAFTSMAN_USER_ID = 'user-craftsman-1'
const STRANGER_USER_ID = 'user-stranger-1'
const TRANSFER_ID = 'tr_mock_transfer_id'

const SPR_ROW = {
  id: SPR_ID,
  customer_user_id: CUSTOMER_USER_ID,
  craftsman_user_id: CRAFTSMAN_USER_ID,
}

const RELEASED_RESULT = {
  ok: true,
  outcome: 'RELEASED',
  transferId: TRANSFER_ID,
  netAmountCents: 9100,
  platformFeeCents: 900,
}

function authAs(userId: string): void {
  mockAuthenticateRequest.mockResolvedValue({ ok: true, userId })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('release-supplementary-payout handler authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
    delete process.env.RELEASE_CONFIRM_SECRET
    mockReleaseSupplementaryPayout.mockResolvedValue(RELEASED_RESULT)
    mockFetchIsOperator.mockResolvedValue(false)
  })

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY
    delete process.env.RELEASE_CONFIRM_SECRET
  })

  it('1: allows the customer on the SPR — helper invoked, 200 released', async () => {
    authAs(CUSTOMER_USER_ID)
    const { admin } = makeAdmin({ spr: SPR_ROW })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ supplementaryPaymentId: SPR_ID }), res)

    expect(statusCode()).toBe(200)
    expect(body()).toMatchObject({ status: 'released', transferId: TRANSFER_ID })
    expect(mockReleaseSupplementaryPayout).toHaveBeenCalledTimes(1)
    expect(mockReleaseSupplementaryPayout).toHaveBeenCalledWith(admin, expect.anything(), SPR_ID)
    expect(mockFetchIsOperator).not.toHaveBeenCalled()
  })

  it('2: allows the craftsman on the SPR — helper invoked, 200 released', async () => {
    authAs(CRAFTSMAN_USER_ID)
    const { admin } = makeAdmin({ spr: SPR_ROW })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ supplementaryPaymentId: SPR_ID }), res)

    expect(statusCode()).toBe(200)
    expect(body()).toMatchObject({ status: 'released' })
    expect(mockReleaseSupplementaryPayout).toHaveBeenCalledTimes(1)
    expect(mockFetchIsOperator).not.toHaveBeenCalled()
  })

  it('3: rejects an unrelated JWT caller with 403 — helper NOT invoked (IDOR pin)', async () => {
    authAs(STRANGER_USER_ID)
    mockFetchIsOperator.mockResolvedValue(false)
    const { admin } = makeAdmin({ spr: SPR_ROW })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ supplementaryPaymentId: SPR_ID }), res)

    expect(statusCode()).toBe(403)
    expect(body()).toEqual({
      error: 'Forbidden: you are not authorized to release this supplementary payout.',
    })
    expect(mockFetchIsOperator).toHaveBeenCalledWith(STRANGER_USER_ID, admin)
    expect(mockReleaseSupplementaryPayout).not.toHaveBeenCalled()
  })

  it('4: allows an unrelated JWT caller with operator elevation', async () => {
    authAs(STRANGER_USER_ID)
    mockFetchIsOperator.mockResolvedValue(true)
    const { admin } = makeAdmin({ spr: SPR_ROW })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ supplementaryPaymentId: SPR_ID }), res)

    expect(statusCode()).toBe(200)
    expect(body()).toMatchObject({ status: 'released' })
    expect(mockFetchIsOperator).toHaveBeenCalledWith(STRANGER_USER_ID, admin)
    expect(mockReleaseSupplementaryPayout).toHaveBeenCalledTimes(1)
  })

  it('5: server-secret (cron) path skips the SPR authz fetch entirely', async () => {
    process.env.RELEASE_CONFIRM_SECRET = 'cron-secret'
    const { admin, fromSpy } = makeAdmin({ spr: null })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin })

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({ supplementaryPaymentId: SPR_ID }, { 'x-release-confirm-secret': 'cron-secret' }),
      res,
    )

    expect(statusCode()).toBe(200)
    expect(body()).toMatchObject({ status: 'released' })
    expect(mockAuthenticateRequest).not.toHaveBeenCalled()
    expect(fromSpy).not.toHaveBeenCalled()
    expect(mockFetchIsOperator).not.toHaveBeenCalled()
    expect(mockReleaseSupplementaryPayout).toHaveBeenCalledTimes(1)
  })

  it('6: JWT path returns 404 before the helper when the SPR does not exist', async () => {
    authAs(CUSTOMER_USER_ID)
    const { admin } = makeAdmin({ spr: null })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ supplementaryPaymentId: SPR_ID }), res)

    expect(statusCode()).toBe(404)
    expect(body()).toEqual({ error: 'NOT_FOUND' })
    expect(mockReleaseSupplementaryPayout).not.toHaveBeenCalled()
  })

  it('7: authz fetch DB error fails closed with 500 — helper NOT invoked', async () => {
    authAs(CUSTOMER_USER_ID)
    const { admin } = makeAdmin({ spr: null, sprError: { message: 'connection reset' } })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ supplementaryPaymentId: SPR_ID }), res)

    expect(statusCode()).toBe(500)
    expect(body()).toEqual({
      error: 'Failed to verify authorization for this supplementary payout.',
    })
    expect(mockReleaseSupplementaryPayout).not.toHaveBeenCalled()
  })
})
