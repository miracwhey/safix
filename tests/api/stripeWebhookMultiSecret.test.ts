/**
 * Stripe webhook — multi-secret signature verification.
 *
 * SaFix uses DESTINATION CHARGES: the PaymentIntent/charge live on the PLATFORM
 * account, so payment_intent, charge, charge.dispute, refund and transfer events
 * arrive via an Account-level endpoint (connect=false), while payout,
 * account.updated and capability.updated arrive via the Connect endpoint
 * (connect=true). Each endpoint has its own signing secret. The handler must
 * verify against BOTH (STRIPE_WEBHOOK_SECRET + STRIPE_WEBHOOK_SECRET_ACCOUNT),
 * trying each until one matches — otherwise the Account-endpoint events (incl.
 * chargebacks) would be rejected with a 400 and silently lost.
 *
 * Locks:
 *   A. connect-secret fails, account-secret verifies → event accepted (2nd secret tried)
 *   B. both secrets fail                              → 400 signature-verification-failed
 *   C. only STRIPE_WEBHOOK_SECRET set (backward-compat) → single secret still works
 *   D. no secret configured                           → 500 misconfiguration
 */

const { mockConstructEvent } = vi.hoisted(() => ({ mockConstructEvent: vi.fn() }))
const { mockGetSupabaseAdmin } = vi.hoisted(() => ({ mockGetSupabaseAdmin: vi.fn() }))

vi.mock('../../api/_supabase', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
  getSupabaseAdminWithStatus: vi.fn(),
  formatAdminUnavailable: () => 'Supabase credentials missing.',
}))

vi.mock('stripe', () => ({
  default: class MockStripe {
    webhooks = { constructEvent: mockConstructEvent }
    accounts = { retrieve: vi.fn() }
    paymentIntents = { retrieve: vi.fn() }
  },
}))

vi.mock('../../api/_observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
  withSentryFlush: (handler: unknown) => handler,
  flushSentry: vi.fn(),
  setSentryRequestUser: vi.fn(),
}))

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}))

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import handler from '../../api/stripe-webhook'

const STRIPE_SIGNATURE = 't=1000,v1=abc123'
const CONNECT_SECRET = 'whsec_connect'
const ACCOUNT_SECRET = 'whsec_account'

function makeStreamReq(): VercelRequest {
  const emitter = new EventEmitter()
  const req = Object.assign(emitter, {
    method: 'POST',
    headers: { 'stripe-signature': STRIPE_SIGNATURE },
    url: '/api/stripe-webhook',
  })
  process.nextTick(() => {
    emitter.emit('data', Buffer.from('{}'))
    emitter.emit('end')
  })
  return req as unknown as VercelRequest
}

function makeRes(): { res: VercelResponse; statusCode: () => number; body: () => unknown } {
  let _status = 200
  let _body: unknown
  const res = {
    status(code: number) {
      _status = code
      return { json: (payload: unknown) => { _body = payload } }
    },
    json(payload: unknown) { _body = payload },
  }
  return { res: res as unknown as VercelResponse, statusCode: () => _status, body: () => _body }
}

function isSigFailure(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    String((body as { error: unknown }).error).includes('signature verification failed')
  )
}

// A permissive builder-chain admin so the handler can proceed PAST verification
// without crashing (we only assert on the verification outcome here).
function buildChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {}
  const pass = () => chain
  chain.select = pass
  chain.eq = pass
  chain.order = pass
  chain.limit = pass
  chain.in = pass
  chain.update = pass
  chain.insert = pass
  chain.upsert = pass
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null })
  chain.single = () => Promise.resolve({ data: null, error: null })
  ;(chain as { then?: (fn: (v: unknown) => unknown) => Promise<unknown> }).then = (fn) =>
    Promise.resolve({ data: null, error: null }).then(fn)
  return chain
}

describe('stripe-webhook multi-secret signature verification', () => {
  const ORIG = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'
    delete process.env.STRIPE_WEBHOOK_SECRET
    delete process.env.STRIPE_WEBHOOK_SECRET_ACCOUNT
    mockGetSupabaseAdmin.mockReturnValue({ from: () => buildChain() })
  })

  afterEach(() => {
    process.env = { ...ORIG }
  })

  it('A. verifies via STRIPE_WEBHOOK_SECRET_ACCOUNT when the connect secret fails', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = CONNECT_SECRET
    process.env.STRIPE_WEBHOOK_SECRET_ACCOUNT = ACCOUNT_SECRET
    const event = { id: 'evt_a', type: 'charge.dispute.created', account: null, data: { object: { id: 'dp_1' } } }
    mockConstructEvent.mockImplementation((_body: unknown, _sig: unknown, secret: string) => {
      if (secret === ACCOUNT_SECRET) return event
      throw new Error('No signatures found matching the expected signature for payload')
    })

    const { res, body } = makeRes()
    await handler(makeStreamReq(), res)

    // Both secrets were tried; the account secret was the 2nd attempt and won.
    expect(mockConstructEvent).toHaveBeenCalledTimes(2)
    expect(mockConstructEvent.mock.calls[1][2]).toBe(ACCOUNT_SECRET)
    // The handler proceeded past verification — NOT a signature-failure 400.
    expect(isSigFailure(body())).toBe(false)
  })

  it('B. rejects with 400 when no configured secret verifies', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = CONNECT_SECRET
    process.env.STRIPE_WEBHOOK_SECRET_ACCOUNT = ACCOUNT_SECRET
    mockConstructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload')
    })

    const { res, statusCode, body } = makeRes()
    await handler(makeStreamReq(), res)

    expect(mockConstructEvent).toHaveBeenCalledTimes(2)
    expect(statusCode()).toBe(400)
    expect(isSigFailure(body())).toBe(true)
  })

  it('C. backward-compatible: a single STRIPE_WEBHOOK_SECRET still verifies', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = CONNECT_SECRET
    const event = { id: 'evt_c', type: 'payout.paid', account: 'acct_x', data: { object: { id: 'po_1' } } }
    mockConstructEvent.mockImplementation((_body: unknown, _sig: unknown, secret: string) => {
      if (secret === CONNECT_SECRET) return event
      throw new Error('mismatch')
    })

    const { res, body } = makeRes()
    await handler(makeStreamReq(), res)

    expect(mockConstructEvent).toHaveBeenCalledTimes(1)
    expect(isSigFailure(body())).toBe(false)
  })

  it('D. returns 500 when no webhook secret is configured', async () => {
    const { res, statusCode, body } = makeRes()
    await handler(makeStreamReq(), res)

    expect(mockConstructEvent).not.toHaveBeenCalled()
    expect(statusCode()).toBe(500)
    expect(String((body() as { error: unknown }).error)).toContain('not configured')
  })
})
