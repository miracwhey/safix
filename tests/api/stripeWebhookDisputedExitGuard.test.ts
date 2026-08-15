/**
 * C2 — Disputed payments must never be auto-exited by Stripe webhooks.
 *
 * Behavioral pins for the webhook layer (api/stripe-webhook.ts), using the
 * REAL _webhookHelpers / _providerRecoveryTransitions modules (NOT mocked —
 * this is the difference to the stripeWebhookGuards / stripeWebhookChargeDispute
 * harnesses, which stub isValidWebhookTransition to true).
 *
 * Pins:
 *   A. charge.refunded on payment.status='disputed'
 *      → no payments write, audit row finalized as 'invalid_transition'
 *        (failure_reason 'invalid_transition:disputed_to_refunded'), 200.
 *      This is the C2 semantics: dispute resolution is the only exit from
 *      'disputed'. If the client dies between refund-escrow success and its
 *      FSM write, the payment stays 'disputed' and surfaces via the
 *      invalid_transition warning — operator reconciliation, never auto-heal.
 *   B. payment_intent.succeeded on payment.status='disputed'
 *      → no payments write, 'invalid_transition:disputed_to_released', 200.
 *      This is the original C2 bug: a Stripe capture must not override a
 *      running dispute by auto-releasing the escrow.
 *   C. Duplicate delivery of a charge.refunded event on a disputed payment
 *      is deduplicated at the claim step (no payments lookup at all).
 *
 * Entry INTO 'disputed' (charge.dispute.created) is unchanged and covered by
 * tests/api/stripeWebhookChargeDispute.test.ts.
 */

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockConstructEvent } = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
}))

const { mockGetSupabaseAdmin } = vi.hoisted(() => ({
  mockGetSupabaseAdmin: vi.fn(),
}))

const { mockLogInfo, mockLogWarning, mockLogError } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogWarning: vi.fn(),
  mockLogError: vi.fn(),
}))

vi.mock('../../api/_supabase', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
  getSupabaseAdminWithStatus: vi.fn(),
  formatAdminUnavailable: (missing: string[]) =>
    missing.length > 0 ? `missing ${missing.join(', ')}.` : 'Supabase credentials missing.',
}))

vi.mock('stripe', () => ({
  default: class MockStripe {
    webhooks = { constructEvent: mockConstructEvent }
    balanceTransactions = {
      list: () => ({
        [Symbol.asyncIterator]() {
          return { next: async () => ({ done: true, value: undefined }) }
        },
      }),
    }
    charges = {
      retrieve: async () => ({ source_transfer: null }),
    }
  },
}))

vi.mock('../../api/_observability', () => ({
  logInfo: (...args: unknown[]) => mockLogInfo(...args),
  logWarning: (...args: unknown[]) => mockLogWarning(...args),
  logError: (...args: unknown[]) => mockLogError(...args),
  withSentryFlush: (h: unknown) => h,
  flushSentry: vi.fn(),
  setSentryRequestUser: vi.fn(),
}))

// NOTE: ../../api/_webhookHelpers is intentionally NOT mocked — these tests
// pin the real provider-recovery transition rules.

vi.mock('../../api/_releaseSupplementaryPayout', () => ({
  releaseSupplementaryPayout: vi.fn(),
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
import type { SupabaseClient } from '@supabase/supabase-js'
import handler from '../../api/stripe-webhook'

// ── Request / Response helpers ────────────────────────────────────────────────

const STRIPE_SIGNATURE = 't=1000,v1=abc123'

function makeStreamReq(body = '{}'): VercelRequest {
  const emitter = new EventEmitter()
  const req = Object.assign(emitter, {
    method: 'POST',
    headers: { 'stripe-signature': STRIPE_SIGNATURE },
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

// ── Recording Supabase mock ───────────────────────────────────────────────────
//
// Like the sequence mock in stripeWebhookChargeDispute.test.ts, but records
// every from(table) call and every write payload (insert/update/upsert) so
// the tests can assert WHAT was written, not only that the handler returned 200.

type MockResult = { data?: unknown; error?: { code?: string; message: string } | null }

interface RecordedWrite {
  table: string
  method: 'insert' | 'update' | 'upsert'
  payload: unknown
}

function buildRecordingMock(results: MockResult[]): {
  client: SupabaseClient
  writes: RecordedWrite[]
  tablesQueried: string[]
} {
  const writes: RecordedWrite[] = []
  const tablesQueried: string[] = []
  let idx = 0

  const client = {
    from: (table: string) => {
      tablesQueried.push(table)
      const result = results[idx++] ?? { data: null, error: null }
      const resolved = { data: result.data ?? null, error: result.error ?? null }

      const chain: Record<string, unknown> = {}
      const returnSelf = () => chain
      const recordWrite = (method: RecordedWrite['method']) => (payload: unknown) => {
        writes.push({ table, method, payload })
        return chain
      }

      chain['insert'] = recordWrite('insert')
      chain['update'] = recordWrite('update')
      chain['upsert'] = recordWrite('upsert')
      chain['select'] = returnSelf
      chain['eq'] = returnSelf
      chain['neq'] = returnSelf
      chain['in'] = returnSelf
      chain['lt'] = returnSelf
      chain['gt'] = returnSelf
      chain['limit'] = returnSelf
      chain['order'] = returnSelf
      chain['maybeSingle'] = async () => resolved
      chain['single'] = async () => resolved
      chain['then'] = (
        onFulfilled?: ((v: unknown) => unknown) | null,
        onRejected?: ((e: unknown) => unknown) | null,
      ) => Promise.resolve(resolved).then(onFulfilled, onRejected ?? undefined)
      chain['catch'] = (onRejected?: ((e: unknown) => unknown) | null) =>
        Promise.resolve(resolved).catch(onRejected ?? undefined)

      return chain
    },
  }

  return { client: client as unknown as SupabaseClient, writes, tablesQueried }
}

// ── Env helpers ───────────────────────────────────────────────────────────────

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

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DISPUTED_PAYMENT_ROW = {
  id: 'pay_disputed_1',
  job_id: 'job_disputed_1',
  status: 'disputed',
  total_amount: 1000,
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('C2 — webhook must not auto-exit disputed payments', () => {
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    vi.clearAllMocks()
    savedEnv = saveEnv(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'])
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_abc'
    process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_test'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    restoreEnv(savedEnv)
  })

  // ── A. charge.refunded on disputed payment ─────────────────────────────────

  describe('A. charge.refunded on disputed payment', () => {
    function setup() {
      mockConstructEvent.mockReturnValue({
        id: 'evt_c2_refund',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_c2_1',
            payment_intent: 'pi_c2_disputed',
            amount_refunded: 100000,
          },
        },
      })
      // Sequence: claim INSERT → payments SELECT → finalize UPDATE
      const mock = buildRecordingMock([
        { data: null, error: null },
        { data: DISPUTED_PAYMENT_ROW, error: null },
        { data: null, error: null },
      ])
      mockGetSupabaseAdmin.mockReturnValue(mock.client)
      return mock
    }

    it('returns 200 (Stripe must not retry) without writing to payments', async () => {
      const { writes } = setup()

      const { res, statusCode, body } = makeRes()
      await handler(makeStreamReq(), res)

      expect(statusCode()).toBe(200)
      expect(body()).toMatchObject({ received: true })

      const paymentWrites = writes.filter((w) => w.table === 'payments')
      expect(paymentWrites).toHaveLength(0)
    })

    it('finalizes the audit row as invalid_transition:disputed_to_refunded', async () => {
      const { writes } = setup()

      const { res } = makeRes()
      await handler(makeStreamReq(), res)

      const finalize = writes.find(
        (w) => w.table === 'stripe_webhook_events' && w.method === 'update',
      )
      expect(finalize).toBeDefined()
      expect(finalize!.payload).toMatchObject({
        outcome: 'invalid_transition',
        payment_id: 'pay_disputed_1',
        job_id: 'job_disputed_1',
        previous_state: 'disputed',
        new_state: null,
        failure_reason: 'invalid_transition:disputed_to_refunded',
      })
    })

    it('emits a warning so the stuck-disputed payment is operator-visible', async () => {
      setup()

      const { res } = makeRes()
      await handler(makeStreamReq(), res)

      expect(mockLogWarning).toHaveBeenCalledWith(
        'webhook.stripe.failed',
        expect.objectContaining({
          currentState: 'disputed',
          targetState: 'refunded',
          reason: expect.stringContaining('invalid state-machine transition'),
        }),
      )
    })
  })

  // ── B. payment_intent.succeeded on disputed payment ────────────────────────

  describe('B. payment_intent.succeeded on disputed payment (the C2 bug)', () => {
    function setup() {
      mockConstructEvent.mockReturnValue({
        id: 'evt_c2_succeeded',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_c2_disputed',
            metadata: {},
          },
        },
      })
      // Sequence: claim INSERT → payments SELECT → finalize UPDATE
      const mock = buildRecordingMock([
        { data: null, error: null },
        { data: DISPUTED_PAYMENT_ROW, error: null },
        { data: null, error: null },
      ])
      mockGetSupabaseAdmin.mockReturnValue(mock.client)
      return mock
    }

    it('does not auto-release: no payments write, 200 returned', async () => {
      const { writes } = setup()

      const { res, statusCode, body } = makeRes()
      await handler(makeStreamReq(), res)

      expect(statusCode()).toBe(200)
      expect(body()).toMatchObject({ received: true })

      const paymentWrites = writes.filter((w) => w.table === 'payments')
      expect(paymentWrites).toHaveLength(0)
    })

    it('finalizes the audit row as invalid_transition:disputed_to_released', async () => {
      const { writes } = setup()

      const { res } = makeRes()
      await handler(makeStreamReq(), res)

      const finalize = writes.find(
        (w) => w.table === 'stripe_webhook_events' && w.method === 'update',
      )
      expect(finalize).toBeDefined()
      expect(finalize!.payload).toMatchObject({
        outcome: 'invalid_transition',
        payment_id: 'pay_disputed_1',
        previous_state: 'disputed',
        new_state: null,
        failure_reason: 'invalid_transition:disputed_to_released',
      })
    })
  })

  // ── C. duplicate delivery is deduplicated before the payment lookup ────────

  describe('C. duplicate charge.refunded delivery on disputed payment', () => {
    it('skips at the claim step — payments table is never queried', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_c2_dup',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_c2_dup',
            payment_intent: 'pi_c2_disputed',
            amount_refunded: 100000,
          },
        },
      })
      // Sequence: claim INSERT → PK conflict, re-claim UPDATE → no failed row
      const { client, tablesQueried, writes } = buildRecordingMock([
        { data: null, error: { code: '23505', message: 'duplicate key value' } },
        { data: [], error: null },
      ])
      mockGetSupabaseAdmin.mockReturnValue(client)

      const { res, statusCode, body } = makeRes()
      await handler(makeStreamReq(), res)

      expect(statusCode()).toBe(200)
      expect(body()).toMatchObject({ received: true })
      expect(tablesQueried).not.toContain('payments')
      expect(writes.filter((w) => w.table === 'payments')).toHaveLength(0)
    })
  })
})
