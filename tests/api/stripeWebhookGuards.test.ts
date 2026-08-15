/**
 * Block 10.1 — Stripe Webhook Handler Guards
 *
 * Verifies that the stripe-webhook handler enforces its required environment
 * variables and signature checks before processing any event.
 *
 * The pre-body guards (A–C) short-circuit before `readRawBody` is called, so
 * they use a plain object mock with no stream behavior.
 *
 * The post-body guards (D–E) require a request that emits stream events.
 *
 * Covers:
 *   A. Returns 500 when STRIPE_SECRET_KEY is missing
 *   B. Returns 500 when STRIPE_WEBHOOK_SECRET is missing
 *   C. Returns 400 when Stripe-Signature header is absent
 *   D. Returns 400 when constructEvent throws (invalid signature)
 *   E. Returns 200 in log-only mode when Supabase admin is unavailable
 *      (Stripe must not retry — webhook still "received" the event)
 */

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

const { mockConstructEvent } = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
}))

const { mockGetSupabaseAdmin } = vi.hoisted(() => ({
  mockGetSupabaseAdmin: vi.fn(),
}))

vi.mock('../../api/_supabase', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
  getSupabaseAdminWithStatus: vi.fn(),
  formatAdminUnavailable: (missing: string[]) =>
    missing.length > 0
      ? `missing ${missing.join(', ')}.`
      : 'Supabase server credentials missing or invalid.',
}))

vi.mock('stripe', () => ({
  default: class MockStripe {
    webhooks = { constructEvent: mockConstructEvent }
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

vi.mock('../../api/_webhookHelpers', () => ({
  isValidWebhookTransition: vi.fn().mockReturnValue(true),
}))

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}))

// ── Imports after mocks ───────────────────────────────────────────────────────

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import handler from '../../api/stripe-webhook'

// ── Helpers ───────────────────────────────────────────────────────────────────

const STRIPE_SIGNATURE = 't=1000,v1=abc123'

/** Plain mock request — no stream, used for guards that fire before readRawBody. */
function makePlainReq(overrides: {
  method?: string
  headers?: Record<string, string | undefined>
} = {}): VercelRequest {
  return {
    method: overrides.method ?? 'POST',
    headers: overrides.headers ?? { 'stripe-signature': STRIPE_SIGNATURE },
    url: '/api/stripe-webhook',
  } as unknown as VercelRequest
}

/** Stream-capable mock request — emits data/end events for readRawBody. */
function makeStreamReq(body = '{}', headers?: Record<string, string | undefined>): VercelRequest {
  const emitter = new EventEmitter()
  const req = Object.assign(emitter, {
    method: 'POST',
    headers: headers ?? { 'stripe-signature': STRIPE_SIGNATURE },
    url: '/api/stripe-webhook',
  })
  process.nextTick(() => {
    emitter.emit('data', Buffer.from(body))
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
    json(payload: unknown) {
      _body = payload
    },
  }
  return {
    res: res as unknown as VercelResponse,
    statusCode: () => _status,
    body: () => _body,
  }
}

function saveEnv(keys: string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {}
  for (const k of keys) saved[k] = process.env[k]
  return saved
}

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Block 10.1 — Stripe Webhook Handler Guards', () => {
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    vi.clearAllMocks()
    savedEnv = saveEnv(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'])
    // Default: both keys present
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_abc'
    process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_test'
    // Default: Supabase admin unavailable (simplifies tests D, E)
    mockGetSupabaseAdmin.mockReturnValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    restoreEnv(savedEnv)
  })

  // ── A. STRIPE_SECRET_KEY missing → 500 ────────────────────────────────────

  describe('A. STRIPE_SECRET_KEY missing', () => {
    it('returns 500 when STRIPE_SECRET_KEY is not set', async () => {
      delete process.env['STRIPE_SECRET_KEY']
      const req = makePlainReq()
      const { res, statusCode, body } = makeRes()

      await handler(req, res)

      expect(statusCode()).toBe(500)
      expect(body()).toMatchObject({ error: expect.stringContaining('Stripe secret key') })
    })

    it('does not call constructEvent when STRIPE_SECRET_KEY is absent', async () => {
      delete process.env['STRIPE_SECRET_KEY']
      const req = makePlainReq()
      const { res } = makeRes()

      await handler(req, res)

      expect(mockConstructEvent).not.toHaveBeenCalled()
    })
  })

  // ── B. STRIPE_WEBHOOK_SECRET missing → 500 ───────────────────────────────

  describe('B. STRIPE_WEBHOOK_SECRET missing', () => {
    it('returns 500 when STRIPE_WEBHOOK_SECRET is not set', async () => {
      delete process.env['STRIPE_WEBHOOK_SECRET']
      const req = makePlainReq()
      const { res, statusCode, body } = makeRes()

      await handler(req, res)

      expect(statusCode()).toBe(500)
      expect(body()).toMatchObject({ error: expect.stringContaining('webhook secret') })
    })

    it('does not call constructEvent when STRIPE_WEBHOOK_SECRET is absent', async () => {
      delete process.env['STRIPE_WEBHOOK_SECRET']
      const req = makePlainReq()
      const { res } = makeRes()

      await handler(req, res)

      expect(mockConstructEvent).not.toHaveBeenCalled()
    })
  })

  // ── C. Missing Stripe-Signature header → 400 ─────────────────────────────

  describe('C. Missing Stripe-Signature header', () => {
    it('returns 400 when Stripe-Signature header is absent', async () => {
      const req = makePlainReq({ headers: {} })
      const { res, statusCode, body } = makeRes()

      await handler(req, res)

      expect(statusCode()).toBe(400)
      expect(body()).toMatchObject({ error: expect.stringContaining('Stripe-Signature') })
    })
  })

  // ── D. constructEvent throws → 400 ───────────────────────────────────────

  describe('D. Invalid signature → 400', () => {
    it('returns 400 when constructEvent throws a signature error', async () => {
      mockConstructEvent.mockImplementation(() => {
        throw new Error('No signatures found matching the expected signature for payload')
      })
      const req = makeStreamReq()
      const { res, statusCode, body } = makeRes()

      await handler(req, res)

      expect(statusCode()).toBe(400)
      expect(body()).toMatchObject({ error: expect.stringContaining('signature verification failed') })
    })

    it('calls constructEvent with the raw body buffer and webhook secret', async () => {
      mockConstructEvent.mockImplementation(() => {
        throw new Error('bad signature')
      })
      const req = makeStreamReq('{"test":1}')
      const { res } = makeRes()

      await handler(req, res)

      expect(mockConstructEvent).toHaveBeenCalledWith(
        expect.any(Buffer),
        STRIPE_SIGNATURE,
        'whsec_test',
      )
    })
  })

  // ── E. Supabase unavailable → 200 log-only (Stripe must not retry) ───────

  describe('E. Supabase unavailable → 200 log-only mode', () => {
    it('returns 200 when Supabase admin is unavailable (no reconciliation)', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_test_1',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_test_1', metadata: {} } },
      })
      mockGetSupabaseAdmin.mockReturnValue(null)

      const req = makeStreamReq()
      const { res, statusCode, body } = makeRes()

      await handler(req, res)

      expect(statusCode()).toBe(200)
      expect(body()).toMatchObject({ received: true })
    })

    it('returns 200 (not 500) so Stripe does not retry unreconciled events', async () => {
      // Stripe retries on non-2xx responses — returning 200 in log-only mode
      // prevents infinite retries when Supabase is temporarily unavailable.
      mockConstructEvent.mockReturnValue({
        id: 'evt_test_2',
        type: 'payment_intent.canceled',
        data: { object: { id: 'pi_test_2', metadata: {} } },
      })
      mockGetSupabaseAdmin.mockReturnValue(null)

      const req = makeStreamReq()
      const { res, statusCode } = makeRes()

      await handler(req, res)

      expect(statusCode()).toBe(200)
    })
  })
})
