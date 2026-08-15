/**
 * Block P · Batch 4 — corridor split-settle relocation (A1-b) + G7 double-count.
 *
 * Behavioral pins for the two TS changes in api/stripe-webhook.ts:
 *
 *   G7 (double-count hardening): the two ''-movement-ref 'refund' ledger writers
 *   (reconcilePaymentState + reconcileChargeRefunded) must SKIP the 'refund'
 *   upsert when a corridor `refund_partial` ledger row already exists for the
 *   payment — IN ADDITION to the existing payment.status !== 'disputed' guard.
 *   The unique index (payment_id, entry_type, movement_ref) does NOT dedup
 *   across 'refund'/'' vs 'refund_partial'/<disputeId>, so without this skip a
 *   late/redelivered charge.refunded landing after the payment leaves 'disputed'
 *   would write a SECOND refund row = double count.
 *     · A. refund_partial EXISTS  → no 'refund' upsert (skip).
 *     · B. refund_partial ABSENT  → 'refund' upsert proceeds (dormant / flag-OFF
 *          byte-identical: no refund_partial rows exist → helper false → write).
 *
 *   A1-b (settlement-leak close): completePayoutCorridorTranche, after the
 *   tranche payout lands, settles a resolved-but-pending corridor DISPUTE via the
 *   ONE shared settler settle_dispute_resolution — regardless of plan.status, so
 *   a corridor SPLIT (partially_released, never fully_released) settles too.
 *     · C. a resolved + pending SPLIT dispute (terminal at partially_released)
 *          → supabase.rpc('settle_dispute_resolution', {p_dispute_id}) is called.
 *     · D. no pending dispute → the settle RPC is NOT called (no-op).
 *     · E. the dispute lookup EXCLUDES decision='refund' (BLOCKER regression):
 *          a cron/synchronous-owned refund must never be settled by the webhook.
 *     · F. a RELEASE/REJECT dispute defers until plan.status='fully_released'
 *          (no premature settle at partially_released over an un-released tranche).
 *
 * Harness mirrors stripeWebhookDisputedExitGuard.test.ts (real _webhookHelpers,
 * recording Supabase mock) and additionally records supabase.rpc() calls.
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

// _webhookHelpers is intentionally NOT mocked — the G7 cases rely on the real
// provider-recovery transition rule (in_escrow → refunded is valid).

vi.mock('../../api/_releaseSupplementaryPayout', () => ({
  releaseSupplementaryPayout: vi.fn(),
}))

vi.mock('../../api/_emailDelivery', () => ({
  deliverNotificationEmailServer: vi.fn(async () => ({ ok: true })),
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

// ── Recording Supabase mock (from() writes + rpc() calls) ─────────────────────

type MockResult = { data?: unknown; error?: { code?: string; message: string } | null }

interface RecordedWrite {
  table: string
  method: 'insert' | 'update' | 'upsert'
  payload: unknown
}

interface RecordedRpc {
  fn: string
  args: unknown
}

function buildRecordingMock(
  results: MockResult[],
  rpcResults: Record<string, MockResult> = {},
): {
  client: SupabaseClient
  writes: RecordedWrite[]
  rpcCalls: RecordedRpc[]
  tablesQueried: string[]
  inFilters: { table: string; column: string; values: unknown }[]
} {
  const writes: RecordedWrite[] = []
  const rpcCalls: RecordedRpc[] = []
  const tablesQueried: string[] = []
  const inFilters: { table: string; column: string; values: unknown }[] = []
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
      chain['in'] = (column: string, values: unknown) => {
        inFilters.push({ table, column, values })
        return chain
      }
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
    rpc: (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args })
      const r = rpcResults[fn] ?? { data: null, error: null }
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null })
    },
  }

  return { client: client as unknown as SupabaseClient, writes, rpcCalls, tablesQueried, inFilters }
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

// A non-disputed, refundable payment (in_escrow → refunded is a valid provider-
// recovery transition).
const REFUNDABLE_PAYMENT_ROW = {
  id: 'pay_g7',
  job_id: 'job_g7',
  status: 'in_escrow',
  total_amount: 1000,
}

const JOB_ROW = { status: 'in_progress', project_id: null }

describe('Block P · Batch 4 — G7 double-count + split-settle relocation', () => {
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

  // ── G7 · reconcileChargeRefunded ───────────────────────────────────────────

  function chargeRefundedEvent() {
    mockConstructEvent.mockReturnValue({
      id: 'evt_g7_refund',
      type: 'charge.refunded',
      data: {
        object: { id: 'ch_g7', payment_intent: 'pi_g7', amount_refunded: 100000 },
      },
    })
  }

  // Sequence of from() calls for a non-disputed, non-already-refunded
  // charge.refunded that validly transitions in_escrow → refunded:
  //   [0] claim INSERT (stripe_webhook_events)
  //   [1] payments SELECT (maybeSingle)
  //   [2] payments UPDATE
  //   [3] finalize UPDATE (stripe_webhook_events)
  //   [4] jobs SELECT (reconcileJobFromPayment)
  //   [5] jobs UPDATE
  //   [6] ledger_entries SELECT (corridorRefundPartialExists helper)
  //   [7] ledger_entries UPSERT (only when the helper found no refund_partial)
  function chargeRefundedResults(refundPartialRows: unknown[]): MockResult[] {
    return [
      { data: null, error: null },
      { data: REFUNDABLE_PAYMENT_ROW, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: JOB_ROW, error: null },
      { data: null, error: null },
      { data: refundPartialRows, error: null },
      { data: null, error: null },
    ]
  }

  it('A. skips the refund ledger write when a refund_partial row already exists', async () => {
    chargeRefundedEvent()
    const mock = buildRecordingMock(chargeRefundedResults([{ id: 'le_partial_1' }]))
    mockGetSupabaseAdmin.mockReturnValue(mock.client)

    const { res, statusCode } = makeRes()
    await handler(makeStreamReq(), res)

    expect(statusCode()).toBe(200)
    // The corridor already booked the customer refund as refund_partial → the
    // ''-movement-ref 'refund' upsert must NOT run (no double count).
    const ledgerUpserts = mock.writes.filter(
      (w) => w.table === 'ledger_entries' && w.method === 'upsert',
    )
    expect(ledgerUpserts).toHaveLength(0)
    // The guard DID consult the ledger (the helper's existence read ran).
    expect(mock.tablesQueried).toContain('ledger_entries')
  })

  it('B. writes the refund ledger row when no refund_partial row exists (dormant / flag-OFF)', async () => {
    chargeRefundedEvent()
    const mock = buildRecordingMock(chargeRefundedResults([]))
    mockGetSupabaseAdmin.mockReturnValue(mock.client)

    const { res, statusCode } = makeRes()
    await handler(makeStreamReq(), res)

    expect(statusCode()).toBe(200)
    const ledgerUpserts = mock.writes.filter(
      (w) => w.table === 'ledger_entries' && w.method === 'upsert',
    )
    expect(ledgerUpserts).toHaveLength(1)
    expect(ledgerUpserts[0]!.payload).toMatchObject({
      payment_id: 'pay_g7',
      entry_type: 'refund',
      movement_ref: '',
      amount: 1000,
    })
  })

  // ── A1-b · completePayoutCorridorTranche dispute settle ────────────────────

  function payoutPaidCorridorEvent() {
    mockConstructEvent.mockReturnValue({
      id: 'evt_reloc_1',
      type: 'payout.paid',
      account: 'acct_1',
      data: {
        object: {
          id: 'po_1',
          amount: 25000,
          currency: 'eur',
          arrival_date: 1000,
          metadata: { tranche_id: 'tr_1' },
        },
      },
    })
  }

  // from() sequence for a corridor payout.paid (metadata.tranche_id present),
  // plan partially_released (a SPLIT — never fully_released):
  //   [0] claim INSERT
  //   [1] escrow_tranches SELECT (resolvePayoutCorridorTranche, maybeSingle)
  //       → rpc complete_tranche_payout
  //   [2] escrow_payment_plans SELECT (job + status, maybeSingle)
  //   [3] disputes SELECT (the new pending-dispute lookup, limit 1)
  //       → rpc settle_dispute_resolution (only when a row was returned)
  //   [...] timeline_signals upsert + email fan-out (best-effort, default null)
  function payoutResults(pendingDisputeRows: unknown[]): MockResult[] {
    return [
      { data: null, error: null },
      { data: { id: 'tr_1', status: 'release_pending', plan_id: 'plan_1', payout_attempt_count: 0 }, error: null },
      { data: { job_id: 'job_1', status: 'partially_released' }, error: null },
      { data: pendingDisputeRows, error: null },
    ]
  }

  const payoutRpcResults = {
    complete_tranche_payout: {
      data: { outcome: 'released', plan_status: 'partially_released' },
      error: null,
    },
    settle_dispute_resolution: { data: { id: 'disp_1', settlement_status: 'settled' }, error: null },
  }

  it('C. settles a resolved-but-pending corridor dispute via settle_dispute_resolution', async () => {
    payoutPaidCorridorEvent()
    const mock = buildRecordingMock(
      payoutResults([{ id: 'disp_1', decision: 'split' }]),
      payoutRpcResults,
    )
    mockGetSupabaseAdmin.mockReturnValue(mock.client)

    const { res, statusCode } = makeRes()
    await handler(makeStreamReq(), res)

    expect(statusCode()).toBe(200)
    // The shared settler was invoked with the pending dispute id, even though the
    // plan is only partially_released (a SPLIT is terminal there) — closing the
    // leak for non-cron corridor resolutions.
    const settleCall = mock.rpcCalls.find((r) => r.fn === 'settle_dispute_resolution')
    expect(settleCall).toBeDefined()
    expect(settleCall!.args).toMatchObject({ p_dispute_id: 'disp_1' })
  })

  it('D. does not call the settle RPC when no resolved-pending dispute exists', async () => {
    payoutPaidCorridorEvent()
    const mock = buildRecordingMock(payoutResults([]), payoutRpcResults)
    mockGetSupabaseAdmin.mockReturnValue(mock.client)

    const { res, statusCode } = makeRes()
    await handler(makeStreamReq(), res)

    expect(statusCode()).toBe(200)
    // complete_tranche_payout still ran (the tranche released)...
    expect(mock.rpcCalls.some((r) => r.fn === 'complete_tranche_payout')).toBe(true)
    // ...but with no pending dispute the settle RPC is a no-op.
    expect(mock.rpcCalls.some((r) => r.fn === 'settle_dispute_resolution')).toBe(false)
  })

  it('E. the corridor dispute lookup EXCLUDES decision=refund (cron/synchronous-owned)', async () => {
    // BLOCKER regression guard: the webhook owns ONLY async-payout-driven
    // resolutions. A decision='refund' dispute is settled by whoever issued the
    // Stripe refund (T+80 cron via the settle_dispute_default delegate, or the
    // synchronous client refund path). If 'refund' ever re-enters this lookup, a
    // redelivered deposit payout.paid could force-settle a default whose refund
    // FAILED → false refund_partial row + abandoned retry. Pin the exact filter.
    payoutPaidCorridorEvent()
    const mock = buildRecordingMock(payoutResults([]), payoutRpcResults)
    mockGetSupabaseAdmin.mockReturnValue(mock.client)

    const { res } = makeRes()
    await handler(makeStreamReq(), res)

    const decisionFilter = mock.inFilters.find(
      (f) => f.table === 'disputes' && f.column === 'decision',
    )
    expect(decisionFilter).toBeDefined()
    expect(decisionFilter!.values).toEqual(['split', 'release', 'reject'])
    expect(decisionFilter!.values as unknown[]).not.toContain('refund')
  })

  it('F. defers a RELEASE/REJECT dispute until fully_released (no premature settle at partially_released)', async () => {
    payoutPaidCorridorEvent()
    // A resolved+pending RELEASE dispute on a plan that is only partially_released
    // (a multi-tranche bridge where another craftsman tranche is still un-released).
    // Settling now would seal the dispute over the un-released tranche.
    const mock = buildRecordingMock(
      payoutResults([{ id: 'disp_rel', decision: 'release' }]),
      payoutRpcResults,
    )
    mockGetSupabaseAdmin.mockReturnValue(mock.client)

    const { res, statusCode } = makeRes()
    await handler(makeStreamReq(), res)

    expect(statusCode()).toBe(200)
    // The tranche payout completed, but the release dispute is NOT settled yet —
    // it waits for plan.status='fully_released' (a later payout.paid settles it).
    expect(mock.rpcCalls.some((r) => r.fn === 'complete_tranche_payout')).toBe(true)
    expect(mock.rpcCalls.some((r) => r.fn === 'settle_dispute_resolution')).toBe(false)
  })
})
