/**
 * Block 2 — Stripe Chargeback + Transfer/Refund/Payout Failure Awareness
 *
 * Verifies the webhook handler correctly processes:
 *   A. charge.dispute.created — valid state transition (payment in release_pending → disputed)
 *   B. charge.dispute.created — released payment (no state rollback, dispute record still created)
 *   C. charge.dispute.created — duplicate/retry webhook is idempotent (duplicate claim returns 200)
 *   D. charge.dispute.created — already disputed payment (idempotent, no double dispute)
 *   E. charge.dispute.created — payment not found (orphaned chargeback, logs critical alert)
 *   F. charge.dispute.closed  — lost chargeback (critical alert, log_only audit)
 *   G. charge.dispute.closed  — won chargeback (warning log, log_only audit)
 *   H. charge.dispute.updated — audited as log_only, not silently swallowed by default
 *   I. refund.failed          — outcome=failed (not log_only), critical alert
 *   J. refund.failed duplicate — claim dedup works (already claimed → 200, no double processing)
 *   K. payout.paid            — bank delivery confirmed (log_only, no state change)
 *   L. payout.failed          — bank delivery failed (outcome=failed, critical alert)
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
    // Block 2 payout trust layer: the production path walks
    // `balanceTransactions.list(...)` as an async iterator. Stub it to
    // return an empty sequence so payout.paid / payout.failed tests can
    // exercise the finalize path without providing per-tranche fixtures.
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

vi.mock('../../api/_webhookHelpers', () => ({
  isValidWebhookTransition: vi.fn().mockReturnValue(true),
}))

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

// ── Request / Response helpers ─────────────────────────────────────────────────

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

// ── Supabase mock builder ─────────────────────────────────────────────────────
//
// Each call to `from(table)` returns the next result in the sequence.
// The chain is thenable so both `await from().insert(...)` and
// `await from().select().eq().maybeSingle()` patterns work correctly.

type MockResult = { data?: unknown; error?: { code?: string; message: string } | null }

function makeChain(result: MockResult): ReturnType<SupabaseClient['from']> {
  const chain: Record<string, unknown> = {}
  const resolved = { data: result.data ?? null, error: result.error ?? null }

  const returnSelf = vi.fn().mockReturnValue(chain)
  chain['select']      = returnSelf
  chain['eq']          = returnSelf
  chain['neq']         = returnSelf
  chain['in']          = returnSelf
  chain['lt']          = returnSelf
  chain['gt']          = returnSelf
  chain['limit']       = returnSelf
  chain['order']       = returnSelf
  chain['update']      = returnSelf
  chain['insert']      = returnSelf
  chain['upsert']      = returnSelf
  chain['maybeSingle'] = vi.fn().mockResolvedValue(resolved)
  chain['single']      = vi.fn().mockResolvedValue(resolved)
  chain['then']        = (
    onFulfilled?: ((v: unknown) => unknown) | null,
    onRejected?: ((e: unknown) => unknown) | null,
  ) => Promise.resolve(resolved).then(onFulfilled, onRejected ?? undefined)
  chain['catch']       = (onRejected?: ((e: unknown) => unknown) | null) =>
    Promise.resolve(resolved).catch(onRejected ?? undefined)

  return chain as unknown as ReturnType<SupabaseClient['from']>
}

function buildSequenceMock(results: MockResult[]): SupabaseClient {
  let idx = 0
  return {
    from: vi.fn().mockImplementation((_table: string) => {
      const result = results[idx++] ?? { data: null, error: null }
      return makeChain(result)
    }),
  } as unknown as SupabaseClient
}

// ── Env + cleanup helpers ─────────────────────────────────────────────────────

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

// ── Stripe dispute factory ────────────────────────────────────────────────────

function makeStripeDispute(overrides: {
  id?: string
  payment_intent?: string
  status?: string
  reason?: string
  amount?: number
  currency?: string
} = {}) {
  return {
    id: overrides.id ?? 'dp_test_001',
    payment_intent: overrides.payment_intent ?? 'pi_test_001',
    status: overrides.status ?? 'needs_response',
    reason: overrides.reason ?? 'general',
    amount: overrides.amount ?? 10000,
    currency: overrides.currency ?? 'eur',
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Block 2 — Stripe Chargeback + Transfer/Refund Failure Awareness', () => {
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

  // ── A. charge.dispute.created — valid state transition ──────────────────────

  describe('A. charge.dispute.created — valid state transition (release_pending → disputed)', () => {
    it('returns 200 and transitions payment to disputed', async () => {
      const dispute = makeStripeDispute({ payment_intent: 'pi_001' })
      mockConstructEvent.mockReturnValue({
        id: 'evt_A',
        type: 'charge.dispute.created',
        data: { object: dispute },
      })

      // Sequence: claim INSERT, payment SELECT, payment UPDATE, dispute UPSERT, finalize UPDATE
      const supabase = buildSequenceMock([
        { data: null, error: null },                               // claim INSERT → success
        { data: { id: 'pay_001', job_id: 'job_001', status: 'release_pending', total_amount: 10000 }, error: null }, // payment SELECT
        { data: null, error: null },                               // payment UPDATE → success
        { data: null, error: null },                               // dispute UPSERT
        { data: null, error: null },                               // finalize UPDATE
      ])
      mockGetSupabaseAdmin.mockReturnValue(supabase)

      const req = makeStreamReq()
      const { res, statusCode, body } = makeRes()
      await handler(req, res)

      expect(statusCode()).toBe(200)
      expect(body()).toMatchObject({ received: true })
    })

    it('emits a critical logError for the chargeback', async () => {
      const dispute = makeStripeDispute({ payment_intent: 'pi_001' })
      mockConstructEvent.mockReturnValue({
        id: 'evt_A2',
        type: 'charge.dispute.created',
        data: { object: dispute },
      })

      const supabase = buildSequenceMock([
        { data: null, error: null },
        { data: { id: 'pay_001', job_id: 'job_001', status: 'release_pending', total_amount: 10000 }, error: null },
        { data: null, error: null },
        { data: null, error: null },
        { data: null, error: null },
      ])
      mockGetSupabaseAdmin.mockReturnValue(supabase)

      const req = makeStreamReq()
      const { res } = makeRes()
      await handler(req, res)

      expect(mockLogError).toHaveBeenCalledWith(
        'webhook.stripe.chargeback.created',
        undefined,
        expect.objectContaining({
          stripeDisputeId: 'dp_test_001',
          paymentStatus: 'release_pending',
        }),
      )
    })
  })

  // ── B. charge.dispute.created — released payment, no rollback ───────────────

  describe('B. charge.dispute.created — released payment (no state rollback)', () => {
    it('returns 200 without transitioning the payment state', async () => {
      const dispute = makeStripeDispute({ payment_intent: 'pi_released' })
      mockConstructEvent.mockReturnValue({
        id: 'evt_B',
        type: 'charge.dispute.created',
        data: { object: dispute },
      })

      // No payment UPDATE in this sequence (released is terminal)
      const supabase = buildSequenceMock([
        { data: null, error: null },  // claim INSERT
        { data: { id: 'pay_rel', job_id: 'job_rel', status: 'released', total_amount: 10000 }, error: null }, // payment SELECT
        { data: null, error: null },  // dispute UPSERT
        { data: null, error: null },  // finalize UPDATE
      ])
      mockGetSupabaseAdmin.mockReturnValue(supabase)

      const req = makeStreamReq()
      const { res, statusCode, body } = makeRes()
      await handler(req, res)

      expect(statusCode()).toBe(200)
      expect(body()).toMatchObject({ received: true })
    })

    it('logs that released payment is NOT being rolled back', async () => {
      const dispute = makeStripeDispute({ payment_intent: 'pi_released' })
      mockConstructEvent.mockReturnValue({
        id: 'evt_B2',
        type: 'charge.dispute.created',
        data: { object: dispute },
      })

      const supabase = buildSequenceMock([
        { data: null, error: null },
        { data: { id: 'pay_rel', job_id: 'job_rel', status: 'released', total_amount: 10000 }, error: null },
        { data: null, error: null },
        { data: null, error: null },
      ])
      mockGetSupabaseAdmin.mockReturnValue(supabase)

      const req = makeStreamReq()
      const { res } = makeRes()
      await handler(req, res)

      expect(mockLogError).toHaveBeenCalledWith(
        'webhook.stripe.chargeback.created',
        undefined,
        expect.objectContaining({
          paymentStatus: 'released',
          note: expect.stringContaining('no state rollback'),
        }),
      )
    })
  })

  // ── C. charge.dispute.created — duplicate webhook (idempotent) ──────────────

  describe('C. charge.dispute.created — duplicate webhook is idempotent', () => {
    it('returns 200 on duplicate claim without processing twice', async () => {
      const dispute = makeStripeDispute({ payment_intent: 'pi_dup' })
      mockConstructEvent.mockReturnValue({
        id: 'evt_C',
        type: 'charge.dispute.created',
        data: { object: dispute },
      })

      // Claim INSERT returns PK conflict (duplicate delivery)
      const supabase = buildSequenceMock([
        { data: null, error: { code: '23505', message: 'duplicate key value' } }, // claim INSERT conflict
        // Re-claim check: UPDATE where outcome='failed' → 0 rows (event was reconciled)
        { data: [], error: null },
      ])
      mockGetSupabaseAdmin.mockReturnValue(supabase)

      const req = makeStreamReq()
      const { res, statusCode, body } = makeRes()
      await handler(req, res)

      expect(statusCode()).toBe(200)
      expect(body()).toMatchObject({ received: true })
    })

    it('does not emit a chargeback.created alert on duplicate claim', async () => {
      const dispute = makeStripeDispute({ payment_intent: 'pi_dup2' })
      mockConstructEvent.mockReturnValue({
        id: 'evt_C2',
        type: 'charge.dispute.created',
        data: { object: dispute },
      })

      const supabase = buildSequenceMock([
        { data: null, error: { code: '23505', message: 'duplicate key value' } },
        { data: [], error: null },
      ])
      mockGetSupabaseAdmin.mockReturnValue(supabase)

      const req = makeStreamReq()
      const { res } = makeRes()
      await handler(req, res)

      const chargebackCalls = mockLogError.mock.calls.filter(
        (c) => c[0] === 'webhook.stripe.chargeback.created',
      )
      expect(chargebackCalls).toHaveLength(0)
    })
  })

  // ── D. charge.dispute.created — already disputed payment ────────────────────

  describe('D. charge.dispute.created — already disputed payment (idempotent)', () => {
    it('returns 200 and does not double-transition the payment', async () => {
      const dispute = makeStripeDispute({ payment_intent: 'pi_already_disputed' })
      mockConstructEvent.mockReturnValue({
        id: 'evt_D',
        type: 'charge.dispute.created',
        data: { object: dispute },
      })

      // Payment already in 'disputed' — no UPDATE should happen, just upsert dispute + finalize
      const supabase = buildSequenceMock([
        { data: null, error: null },  // claim INSERT
        { data: { id: 'pay_dis', job_id: 'job_dis', status: 'disputed', total_amount: 10000 }, error: null }, // payment SELECT
        { data: null, error: null },  // dispute UPSERT
        { data: null, error: null },  // finalize UPDATE
      ])
      mockGetSupabaseAdmin.mockReturnValue(supabase)

      const req = makeStreamReq()
      const { res, statusCode, body } = makeRes()
      await handler(req, res)

      expect(statusCode()).toBe(200)
      expect(body()).toMatchObject({ received: true })
    })
  })

  // ── E. charge.dispute.created — payment not found ───────────────────────────

  describe('E. charge.dispute.created — payment not found (orphaned chargeback)', () => {
    it('returns 200 and logs a critical orphaned alert', async () => {
      const dispute = makeStripeDispute({ payment_intent: 'pi_unknown' })
      mockConstructEvent.mockReturnValue({
        id: 'evt_E',
        type: 'charge.dispute.created',
        data: { object: dispute },
      })

      const supabase = buildSequenceMock([
        { data: null, error: null },   // claim INSERT
        { data: null, error: null },   // payment SELECT → not found
        { data: null, error: null },   // finalize UPDATE (not_found)
      ])
      mockGetSupabaseAdmin.mockReturnValue(supabase)

      const req = makeStreamReq()
      const { res, statusCode, body } = makeRes()
      await handler(req, res)

      expect(statusCode()).toBe(200)
      expect(body()).toMatchObject({ received: true })
      expect(mockLogError).toHaveBeenCalledWith(
        'webhook.stripe.chargeback.orphaned',
        undefined,
        expect.objectContaining({
          paymentIntentId: 'pi_unknown',
          stripeDisputeId: 'dp_test_001',
        }),
      )
    })
  })

  // ── F. charge.dispute.closed — lost (critical alert) ────────────────────────

  describe('F. charge.dispute.closed — lost (critical alert)', () => {
    it('returns 200 and emits a critical logError for lost chargeback', async () => {
      const dispute = makeStripeDispute({ status: 'lost', payment_intent: 'pi_lost' })
      mockConstructEvent.mockReturnValue({
        id: 'evt_F',
        type: 'charge.dispute.closed',
        data: { object: dispute },
      })

      const supabase = buildSequenceMock([
        { data: null, error: null },  // claim INSERT
        { data: { id: 'pay_lost', job_id: 'job_lost' }, error: null }, // payment SELECT
        { data: null, error: null },  // finalize UPDATE
      ])
      mockGetSupabaseAdmin.mockReturnValue(supabase)

      const req = makeStreamReq()
      const { res, statusCode, body } = makeRes()
      await handler(req, res)

      expect(statusCode()).toBe(200)
      expect(body()).toMatchObject({ received: true })
      expect(mockLogError).toHaveBeenCalledWith(
        'webhook.stripe.chargeback.closed',
        undefined,
        expect.objectContaining({
          stripeDisputeStatus: 'lost',
          note: expect.stringContaining('MANUAL REVIEW REQUIRED'),
        }),
      )
    })
  })

  // ── G. charge.dispute.closed — won ──────────────────────────────────────────

  describe('G. charge.dispute.closed — won (warning log)', () => {
    it('returns 200 and emits a logWarning (not logError) for won chargeback', async () => {
      const dispute = makeStripeDispute({ status: 'won', payment_intent: 'pi_won' })
      mockConstructEvent.mockReturnValue({
        id: 'evt_G',
        type: 'charge.dispute.closed',
        data: { object: dispute },
      })

      const supabase = buildSequenceMock([
        { data: null, error: null },
        { data: { id: 'pay_won', job_id: 'job_won' }, error: null },
        { data: null, error: null },
      ])
      mockGetSupabaseAdmin.mockReturnValue(supabase)

      const req = makeStreamReq()
      const { res, statusCode } = makeRes()
      await handler(req, res)

      expect(statusCode()).toBe(200)
      const wonErrorCalls = mockLogError.mock.calls.filter(
        (c) => c[0] === 'webhook.stripe.chargeback.closed',
      )
      expect(wonErrorCalls).toHaveLength(0)
      expect(mockLogWarning).toHaveBeenCalledWith(
        'webhook.stripe.chargeback.closed',
        expect.objectContaining({ stripeDisputeStatus: 'won' }),
      )
    })
  })

  // ── H. charge.dispute.updated — audited as log_only, not silently swallowed ─

  describe('H. charge.dispute.updated — explicitly audited, not silent default', () => {
    it('returns 200 and logs the event (not silently swallowed)', async () => {
      const dispute = makeStripeDispute({ status: 'under_review', payment_intent: 'pi_updated' })
      mockConstructEvent.mockReturnValue({
        id: 'evt_H',
        type: 'charge.dispute.updated',
        data: { object: dispute },
      })

      const supabase = buildSequenceMock([
        { data: null, error: null },  // auditLogOnly upsert
      ])
      mockGetSupabaseAdmin.mockReturnValue(supabase)

      const req = makeStreamReq()
      const { res, statusCode, body } = makeRes()
      await handler(req, res)

      expect(statusCode()).toBe(200)
      expect(body()).toMatchObject({ received: true })
      expect(mockLogInfo).toHaveBeenCalledWith(
        'webhook.stripe.chargeback.updated',
        expect.objectContaining({
          stripeDisputeId: 'dp_test_001',
          stripeDisputeStatus: 'under_review',
        }),
      )
    })
  })

  // ── I. refund.failed — outcome=failed (not log_only) ────────────────────────

  describe('I. refund.failed — records outcome=failed with enriched context', () => {
    it('returns 200 and emits a critical logError with payment/job context', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_J',
        type: 'refund.failed',
        data: {
          object: {
            id: 're_failed_001',
            payment_intent: 'pi_refund_001',
            amount: 10000,
            failure_reason: 'lost_or_stolen_card',
          },
        },
      })

      const supabase = buildSequenceMock([
        { data: null, error: null },  // claim INSERT
        { data: { id: 'pay_ref_001', job_id: 'job_ref_001' }, error: null }, // payment SELECT for context
        { data: null, error: null },  // finalize UPDATE
      ])
      mockGetSupabaseAdmin.mockReturnValue(supabase)

      const req = makeStreamReq()
      const { res, statusCode, body } = makeRes()
      await handler(req, res)

      expect(statusCode()).toBe(200)
      expect(body()).toMatchObject({ received: true })
      expect(mockLogError).toHaveBeenCalledWith(
        'webhook.stripe.refund.failed',
        undefined,
        expect.objectContaining({
          refundId: 're_failed_001',
          failureReason: 'lost_or_stolen_card',
          paymentId: 'pay_ref_001',
          jobId: 'job_ref_001',
          note: expect.stringContaining('MANUAL REVIEW REQUIRED'),
        }),
      )
    })

    it('does NOT use log_only outcome — failure is queryable', async () => {
      // The finalize call must use outcome='failed', not 'log_only'.
      // We verify this by checking that the Supabase `update` receives the correct payload.
      const fromCalls: string[] = []
      let updatePayload: Record<string, unknown> | null = null

      const supabase = {
        from: vi.fn().mockImplementation((table: string) => {
          fromCalls.push(table)
          const callIdx = fromCalls.length

          if (callIdx === 1) {
            // Claim INSERT (stripe_webhook_events)
            const chain = makeChain({ data: null, error: null })
            return chain
          }
          if (callIdx === 2) {
            // Payment SELECT
            return makeChain({ data: { id: 'pay_x', job_id: 'job_x' }, error: null })
          }
          // Finalize UPDATE — capture the update payload
          const captureChain: Record<string, unknown> = {}
          const self = captureChain
          self['update'] = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
            updatePayload = payload
            return self
          })
          self['eq'] = vi.fn().mockReturnValue(self)
          self['then'] = (fn?: ((v: unknown) => unknown) | null) =>
            Promise.resolve({ data: null, error: null }).then(fn ?? undefined)
          return self as unknown as ReturnType<SupabaseClient['from']>
        }),
      } as unknown as SupabaseClient

      mockConstructEvent.mockReturnValue({
        id: 'evt_J2',
        type: 'refund.failed',
        data: {
          object: {
            id: 're_failed_002',
            payment_intent: 'pi_refund_002',
            amount: 5000,
            failure_reason: 'insufficient_funds',
          },
        },
      })
      mockGetSupabaseAdmin.mockReturnValue(supabase)

      const req = makeStreamReq()
      const { res } = makeRes()
      await handler(req, res)

      expect(updatePayload).not.toBeNull()
      expect(updatePayload?.['outcome']).toBe('failed')
      expect(updatePayload?.['failure_reason']).toBe('insufficient_funds')
    })
  })

  // ── J. refund.failed — duplicate claim is idempotent ────────────────────────

  describe('J. refund.failed duplicate claim — idempotent', () => {
    it('returns 200 on duplicate refund.failed webhook without double-processing', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_K',
        type: 'refund.failed',
        data: {
          object: {
            id: 're_dup_001',
            payment_intent: 'pi_dup_ref',
            amount: 5000,
            failure_reason: 'unknown',
          },
        },
      })

      const supabase = buildSequenceMock([
        { data: null, error: { code: '23505', message: 'duplicate key value' } },
        { data: [], error: null },  // re-claim check: already reconciled (not failed)
      ])
      mockGetSupabaseAdmin.mockReturnValue(supabase)

      const req = makeStreamReq()
      const { res, statusCode, body } = makeRes()
      await handler(req, res)

      expect(statusCode()).toBe(200)
      expect(body()).toMatchObject({ received: true })

      const refundFailedErrors = mockLogError.mock.calls.filter(
        (c) => c[0] === 'webhook.stripe.refund.failed',
      )
      expect(refundFailedErrors).toHaveLength(0)
    })
  })

  // ── K. payout.paid — bank delivery confirmed (log_only) ─────────────────────

  describe('K. payout.paid — bank delivery confirmed for Connected Account', () => {
    it('returns 200 and logs payout.paid as log_only with Connect account context', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_K',
        type: 'payout.paid',
        account: 'acct_connect_001',
        data: {
          object: {
            id: 'po_paid_001',
            amount: 15000,
            currency: 'eur',
            arrival_date: 1713312000,
          },
        },
      })

      const supabase = buildSequenceMock([
        { data: null, error: null },  // auditLogOnly INSERT
        { data: null, error: null },  // auditLogOnly UPDATE
      ])
      mockGetSupabaseAdmin.mockReturnValue(supabase)

      const req = makeStreamReq()
      const { res, statusCode, body } = makeRes()
      await handler(req, res)

      expect(statusCode()).toBe(200)
      expect(body()).toMatchObject({ received: true })
      expect(mockLogInfo).toHaveBeenCalledWith(
        'webhook.stripe.payout.paid',
        expect.objectContaining({
          payoutId: 'po_paid_001',
          connectAccountId: 'acct_connect_001',
          amount: 15000,
        }),
      )
      expect(mockLogError).not.toHaveBeenCalledWith(
        'webhook.stripe.payout.paid',
        expect.anything(),
        expect.anything(),
      )
    })
  })

  // ── L. payout.failed — bank delivery failed (outcome=failed) ────────────────

  describe('L. payout.failed — bank delivery failed for Connected Account', () => {
    it('returns 200 and records outcome=failed with critical logError', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_L',
        type: 'payout.failed',
        account: 'acct_connect_002',
        data: {
          object: {
            id: 'po_failed_001',
            amount: 9500,
            currency: 'eur',
            arrival_date: 1713312000,
            failure_code: 'account_closed',
            failure_message: 'The destination bank account has been closed.',
          },
        },
      })

      const supabase = buildSequenceMock([
        { data: null, error: null },  // claim INSERT
        { data: null, error: null },  // finalize UPDATE (outcome=failed)
      ])
      mockGetSupabaseAdmin.mockReturnValue(supabase)

      const req = makeStreamReq()
      const { res, statusCode, body } = makeRes()
      await handler(req, res)

      expect(statusCode()).toBe(200)
      expect(body()).toMatchObject({ received: true })
      expect(mockLogError).toHaveBeenCalledWith(
        'webhook.stripe.payout.failed',
        undefined,
        expect.objectContaining({
          payoutId: 'po_failed_001',
          connectAccountId: 'acct_connect_002',
          failureCode: 'account_closed',
          note: expect.stringContaining('MANUAL REVIEW REQUIRED'),
        }),
      )
    })

    it('is idempotent — duplicate payout.failed webhook is skipped', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_L2',
        type: 'payout.failed',
        account: 'acct_connect_003',
        data: {
          object: {
            id: 'po_failed_002',
            amount: 9500,
            currency: 'eur',
            arrival_date: 1713312000,
            failure_code: 'insufficient_funds',
            failure_message: null,
          },
        },
      })

      const supabase = buildSequenceMock([
        { data: null, error: { code: '23505', message: 'duplicate key value' } },
        { data: [], error: null },  // re-claim check: already reconciled
      ])
      mockGetSupabaseAdmin.mockReturnValue(supabase)

      const req = makeStreamReq()
      const { res, statusCode, body } = makeRes()
      await handler(req, res)

      expect(statusCode()).toBe(200)
      expect(body()).toMatchObject({ received: true })

      const payoutFailedErrors = mockLogError.mock.calls.filter(
        (c) => c[0] === 'webhook.stripe.payout.failed',
      )
      expect(payoutFailedErrors).toHaveLength(0)
    })
  })
})
