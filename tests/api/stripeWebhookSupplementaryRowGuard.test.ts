/**
 * Stripe webhook — supplementary funding row-count guard + claim hardening.
 *
 * Drives the full `api/stripe-webhook` handler (via a mocked Stripe
 * constructEvent + a builder-chain Supabase mock) to lock four fixes:
 *
 *   FIX 1 (H1) reconcileSupplementaryFundingConfirmation must inspect the
 *     guarded UPDATE's affected-row count. 0 rows must NOT be reconciled
 *     blindly — decide idempotent-OK vs terminal-refund from the current row
 *     state, mirroring api/confirm-supplementary-funding.ts. There is NO
 *     downstream heal for supplementary PIs, so a terminal race must refund the
 *     captured money instead of stranding it.
 *       A. UPDATE matches a row                      → reconciled, no refund
 *       B. 0 rows + waived (terminal, no this-PI $)  → refund + 200
 *       C. 0 rows + already funded by the SAME PI    → idempotent, no refund
 *       D. 0 rows + funded by a DIFFERENT PI         → refund + 200
 *       E. 0 rows + refund throws                    → 500 (retryable), no 200
 *
 *   FIX 2 A non-23505 claim INSERT error is no longer swallowed as an
 *     optimistic proceed → the handler returns 500 so Stripe retries.
 *
 *   FIX 3 account.updated is claim/finalize wrapped → a duplicate delivery is
 *     skipped without re-running the Connect-account sync.
 *
 *   FIX 4 claimWebhookEvent re-claims a `processing_expired` row (interrupted
 *     handler) on Stripe re-delivery — not only `failed`.
 */

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockConstructEvent, mockAccountsRetrieve } = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
  mockAccountsRetrieve: vi.fn(),
}))

const { mockGetSupabaseAdmin } = vi.hoisted(() => ({
  mockGetSupabaseAdmin: vi.fn(),
}))

const { mockExecuteEscrowRefundForIntent } = vi.hoisted(() => ({
  mockExecuteEscrowRefundForIntent: vi.fn(),
}))

const { mockReleaseSupplementaryPayout } = vi.hoisted(() => ({
  mockReleaseSupplementaryPayout: vi.fn(),
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
    accounts = { retrieve: mockAccountsRetrieve }
    paymentIntents = { retrieve: vi.fn() }
  },
}))

vi.mock('../../api/_escrowRefundService', () => ({
  executeEscrowRefundForIntent: mockExecuteEscrowRefundForIntent,
  MAX_REFUND_AMOUNTS: {},
}))

vi.mock('../../api/_releaseSupplementaryPayout', () => ({
  releaseSupplementaryPayout: mockReleaseSupplementaryPayout,
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

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import handler from '../../api/stripe-webhook'

// ── Request / Response helpers ────────────────────────────────────────────────

const STRIPE_SIGNATURE = 't=1000,v1=abc123'

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

// ── Builder-chain Supabase mock (FIFO per table, one queue item per from()) ────

type TableResult = { data: unknown; error: unknown }

const tableQueues: Record<string, TableResult[]> = {}
const fromCalls: string[] = []
const inFilters: Array<{ col: string; vals: unknown }> = []
const updatePayloads: Array<{ table: string; payload: unknown }> = []
const upsertPayloads: Array<{ table: string; payload: unknown }> = []

function queue(table: string, result: TableResult): void {
  ;(tableQueues[table] ??= []).push(result)
}

function buildChain(table: string): Record<string, unknown> {
  fromCalls.push(table)
  const result = tableQueues[table]?.shift() ?? { data: null, error: null }
  const chain: Record<string, unknown> = {}
  const pass = () => chain
  chain.select = pass
  chain.eq = pass
  chain.order = pass
  chain.limit = pass
  chain.in = (col: string, vals: unknown) => {
    inFilters.push({ col, vals })
    return chain
  }
  chain.update = (payload: unknown) => {
    updatePayloads.push({ table, payload })
    return chain
  }
  chain.insert = pass
  chain.upsert = (payload: unknown) => {
    upsertPayloads.push({ table, payload })
    return chain
  }
  chain.maybeSingle = () => Promise.resolve(result)
  chain.single = () => Promise.resolve(result)
  ;(chain as { then?: (fn: (v: unknown) => unknown) => Promise<unknown> }).then = (fn) =>
    Promise.resolve(result).then(fn)
  return chain
}

const adminClient = { from: (table: string) => buildChain(table) }

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SPR_ID = 'spr-1'
const PI_ID = 'pi_supp'
const JOB_ID = 'job-1'
const EVENT_ID = 'evt_supp_1'

function suppEvent(): Record<string, unknown> {
  return {
    id: EVENT_ID,
    type: 'payment_intent.succeeded',
    account: null,
    data: {
      object: {
        id: PI_ID,
        status: 'succeeded',
        amount: 5000,
        amount_received: 5000,
        currency: 'eur',
        metadata: {
          type: 'supplementary_funding',
          supplementaryPaymentId: SPR_ID,
          jobId: JOB_ID,
        },
      },
    },
  }
}

function accountEvent(): Record<string, unknown> {
  return {
    id: 'evt_acc_1',
    type: 'account.updated',
    account: 'acct_1',
    data: { object: { id: 'acct_1', charges_enabled: true, payouts_enabled: true } },
  }
}

/** Claim INSERT succeeds (no PK conflict). */
function queueClaimOk(): void {
  queue('stripe_webhook_events', { data: null, error: null })
}

/** Guarded UPDATE .select('id') → affected rows. */
function queueSuppUpdate(rows: unknown[], error: unknown = null): void {
  queue('supplementary_payment_requests', { data: rows, error })
}

/** Current-state fetch after 0-row update. */
function queueSuppCurrent(row: Record<string, unknown> | null): void {
  queue('supplementary_payment_requests', { data: row, error: null })
}

/** finalizeWebhookEvent UPDATE. */
function queueFinalizeOk(): void {
  queue('stripe_webhook_events', { data: null, error: null })
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(tableQueues)) delete tableQueues[k]
  fromCalls.length = 0
  inFilters.length = 0
  updatePayloads.length = 0
  upsertPayloads.length = 0

  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x'
  delete process.env.FUNDING_DESTINATION_CHARGE_ENABLED

  mockGetSupabaseAdmin.mockReturnValue(adminClient)
  mockConstructEvent.mockReturnValue(suppEvent())
  mockExecuteEscrowRefundForIntent.mockResolvedValue({ ok: true, mode: 'refunded' })
  mockReleaseSupplementaryPayout.mockResolvedValue({ ok: false, outcome: 'SKIPPED' })
})

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY
  delete process.env.STRIPE_WEBHOOK_SECRET
  delete process.env.FUNDING_DESTINATION_CHARGE_ENABLED
})

// ── FIX 1 — row-count guard ────────────────────────────────────────────────────

describe('stripe-webhook supplementary funding — UPDATE row-count guard (H1)', () => {
  it('A: UPDATE transitions the row → reconciled, no refund', async () => {
    queueClaimOk()
    queueSuppUpdate([{ id: SPR_ID }])
    queueFinalizeOk()

    const { res, statusCode } = makeRes()
    await handler(makeStreamReq(), res)

    expect(statusCode()).toBe(200)
    expect(mockExecuteEscrowRefundForIntent).not.toHaveBeenCalled()
  })

  it('B: waived race — 0 rows updated → refunds the captured PI, returns 200 (handled)', async () => {
    queueClaimOk()
    queueSuppUpdate([])
    queueSuppCurrent({ status: 'waived', external_ref: null, original_payment_id: 'pay-1', job_id: JOB_ID })
    queueFinalizeOk()

    const { res, statusCode } = makeRes()
    await handler(makeStreamReq(), res)

    expect(statusCode()).toBe(200)
    expect(mockExecuteEscrowRefundForIntent).toHaveBeenCalledTimes(1)
    // Refund targets the retrieved intent
    expect((mockExecuteEscrowRefundForIntent.mock.calls[0][1] as { id?: string }).id).toBe(PI_ID)
    // Refund is journaled into the ledger (captured-then-reversed money)
    expect(upsertPayloads.some((u) => u.table === 'ledger_entries')).toBe(true)
  })

  it('C: already funded by the SAME PI → idempotent, no refund', async () => {
    queueClaimOk()
    queueSuppUpdate([])
    queueSuppCurrent({ status: 'funded', external_ref: PI_ID, original_payment_id: 'pay-1', job_id: JOB_ID })
    queueFinalizeOk()

    const { res, statusCode } = makeRes()
    await handler(makeStreamReq(), res)

    expect(statusCode()).toBe(200)
    expect(mockExecuteEscrowRefundForIntent).not.toHaveBeenCalled()
  })

  it('D: funded by a DIFFERENT PI (duplicate capture) → refund + 200', async () => {
    queueClaimOk()
    queueSuppUpdate([])
    queueSuppCurrent({ status: 'funded', external_ref: 'pi_other', original_payment_id: 'pay-1', job_id: JOB_ID })
    queueFinalizeOk()

    const { res, statusCode } = makeRes()
    await handler(makeStreamReq(), res)

    expect(statusCode()).toBe(200)
    expect(mockExecuteEscrowRefundForIntent).toHaveBeenCalledTimes(1)
  })

  it('E: refund failure on terminal state → 500 (retryable), never a false 200', async () => {
    queueClaimOk()
    queueSuppUpdate([])
    queueSuppCurrent({ status: 'waived', external_ref: null, original_payment_id: 'pay-1', job_id: JOB_ID })
    queueFinalizeOk()
    mockExecuteEscrowRefundForIntent.mockRejectedValue(new Error('stripe down'))

    const { res, statusCode, body } = makeRes()
    await handler(makeStreamReq(), res)

    expect(statusCode()).toBe(500)
    expect((body() as { received?: boolean }).received).toBeUndefined()
  })
})

// ── FIX 2 — claim INSERT non-23505 error is a hard 500 ─────────────────────────

describe('stripe-webhook claim — non-PK-conflict DB error → 500 (FIX 2)', () => {
  it('does not swallow the error; returns 500 so Stripe retries', async () => {
    // Claim INSERT fails with a real (non-23505) DB error.
    queue('stripe_webhook_events', { data: null, error: { code: '40001', message: 'deadlock detected' } })

    const { res, statusCode } = makeRes()
    await handler(makeStreamReq(), res)

    expect(statusCode()).toBe(500)
    // No supplementary write was attempted after the failed claim.
    expect(fromCalls.filter((t) => t === 'supplementary_payment_requests')).toHaveLength(0)
  })
})

// ── FIX 3 — account.updated is claim/finalize wrapped (idempotent) ─────────────

describe('stripe-webhook account.updated — idempotency wrap (FIX 3)', () => {
  it('duplicate delivery is skipped without re-running the Connect sync', async () => {
    mockConstructEvent.mockReturnValue(accountEvent())
    // Claim hits PK conflict; reclaim UPDATE matches 0 rows (already terminal) → duplicate.
    queue('stripe_webhook_events', { data: null, error: { code: '23505', message: 'dup' } })
    queue('stripe_webhook_events', { data: [], error: null }) // reclaim select → 0 rows

    const { res, statusCode } = makeRes()
    await handler(makeStreamReq(), res)

    expect(statusCode()).toBe(200)
    // reconcileConnectAccount must NOT run on a duplicate.
    expect(fromCalls).not.toContain('provider_payout_accounts')
    expect(mockAccountsRetrieve).not.toHaveBeenCalled()
  })

  it('fresh claim runs the Connect sync and finalizes', async () => {
    mockConstructEvent.mockReturnValue(accountEvent())
    queueClaimOk()
    queue('provider_payout_accounts', { data: { provider_user_id: 'p1', onboarding_completed_at: null }, error: null })
    mockAccountsRetrieve.mockResolvedValue({ id: 'acct_1', charges_enabled: true, payouts_enabled: true, requirements: { currently_due: [] } })
    queue('provider_payout_accounts', { data: null, error: null }) // update
    queueFinalizeOk()

    const { res, statusCode } = makeRes()
    await handler(makeStreamReq(), res)

    expect(statusCode()).toBe(200)
    expect(mockAccountsRetrieve).toHaveBeenCalledTimes(1)
    // Finalize UPDATE on the audit row ran.
    expect(updatePayloads.some((u) => u.table === 'stripe_webhook_events')).toBe(true)
  })
})

// ── FIX 4 — processing_expired rows are re-claimable ───────────────────────────

describe('stripe-webhook claim — re-claims processing_expired (FIX 4)', () => {
  it('reclaim UPDATE targets both failed AND processing_expired outcomes', async () => {
    // Claim hits PK conflict; reclaim UPDATE matches a row (was processing_expired).
    queue('stripe_webhook_events', { data: null, error: { code: '23505', message: 'dup' } })
    queue('stripe_webhook_events', { data: [{ event_id: EVENT_ID }], error: null }) // reclaim → 1 row
    queueSuppUpdate([{ id: SPR_ID }])
    queueFinalizeOk()

    const { res, statusCode } = makeRes()
    await handler(makeStreamReq(), res)

    expect(statusCode()).toBe(200)
    // The reclaim filter must include processing_expired (not just failed).
    const reclaimFilter = inFilters.find(
      (f) => f.col === 'outcome' && Array.isArray(f.vals),
    )
    expect(reclaimFilter?.vals).toEqual(['failed', 'processing_expired'])
    // Re-claim allowed processing to continue → supplementary reconcile ran.
    expect(fromCalls).toContain('supplementary_payment_requests')
  })
})
