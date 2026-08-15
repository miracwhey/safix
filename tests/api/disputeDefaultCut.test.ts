/**
 * Block P · Run 2 — T+80 dispute-default-cut: worker + cron tests.
 *
 * Placed in tests/api/ (NOT api/__tests__/) because vitest's `include` glob only
 * picks up `tests/**\/*.test.ts` — a spec under api/__tests__/ would never run.
 *
 * Coverage:
 *   (a) flag-OFF → cron handler returns skipped/corridor_disabled and makes ZERO
 *       supabase/stripe calls (the admin client + Stripe ctor are never touched).
 *   (b) worker 80-day boundary: funded_at 79d ago → skip; 80d ago → fires
 *       (apply → refund → settle, in that order).
 *   (c) funded_at NULL → anchorMissing + skip (no apply/refund/settle).
 *   (d) the query filter excludes decided disputes (decision IS NULL +
 *       open-family status + default_applied_at IS NULL, oldest-first, capped).
 *   (e) apply RPC returns a non-ours row (operator won) → skippedNotOurs, NO
 *       Stripe call, NO settle.
 *   (f) executeEscrowRefundForIntent ok:false → settle NOT called, failed++.
 *   (+) apply RPC returns an already-settled row → alreadySettled, no Stripe.
 *   (g) in-progress default retry — self-healing (findings 2 & 3).
 *   (h) Run-3 item 2 — party notification: BOTH parties emailed via the shared
 *       channel after a default settles; a notification failure NEVER flips the
 *       default back / increments failed.
 *   (i) Run-3 item 4 — stuck escalation: a 1b in-progress default older than 3d
 *       raises dispute_default.stuck (and is still re-driven idempotently).
 *   (j) Run-3 item 3 — cron emits defaults_fired alert when defaulted > 0.
 *   (k) Batch 2 — 75/25 PARTIAL cut: the refund carries the held snapshot as
 *       `amount` (MAJOR units), refundApplicationFee:true, and a stable
 *       per-dispute idempotency suffix; 0% released → the FULL held snapshot
 *       (never a hardcoded 75%); 100% released → held snapshot 0 → settle WITHOUT
 *       a Stripe refund (no rejected zero-amount refund / infinite-retry strand);
 *       snapshot + stable key → deterministic amount across retries with no second
 *       refund (G1); a half-flipped apply that still stamps refund_full →
 *       skippedNotOurs (lockstep guard).
 *
 * Supabase, Stripe, the shared refund service, the email channel and the
 * observability sink are all mocked.
 */

// ---------------------------------------------------------------------------
// Hoisted mocks (referenced by vi.mock factories below)
// ---------------------------------------------------------------------------

const {
  mockExecuteEscrowRefund,
  mockGetSupabaseAdmin,
  mockStripeCtor,
  mockDeliverEmail,
  mockLogInfo,
  mockLogWarning,
  mockLogError,
} = vi.hoisted(() => ({
  mockExecuteEscrowRefund: vi.fn(),
  mockGetSupabaseAdmin: vi.fn(() => ({})),
  mockStripeCtor: vi.fn(),
  mockDeliverEmail: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogWarning: vi.fn(),
  mockLogError: vi.fn(),
}))

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
  setUser: vi.fn(),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({})),
}))

vi.mock('stripe', () => ({ default: mockStripeCtor }))

vi.mock('../../api/_escrowRefundService', () => ({
  executeEscrowRefundForIntent: mockExecuteEscrowRefund,
  MAX_REFUND_AMOUNTS: {},
}))

// The party-notification channel (item 2) is the shared email pipeline. Mock it
// so the worker's best-effort fan-out is observable without touching Resend.
vi.mock('../../api/_emailDelivery', () => ({
  deliverNotificationEmailServer: mockDeliverEmail,
}))

// Mock the observability sink so the new high-visibility alerts (stuck +
// defaults_fired) are assertable. withSentryFlush is a passthrough wrapper so the
// cron's `export default withSentryFlush(handler)` still resolves to the handler.
vi.mock('../../api/_observability', () => ({
  logInfo: mockLogInfo,
  logWarning: mockLogWarning,
  logError: mockLogError,
  withSentryFlush: (h: (...args: unknown[]) => unknown) => h,
}))

vi.mock('../../api/_supabase', () => ({
  getSupabaseAdmin: mockGetSupabaseAdmin,
}))

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'

import { runDisputeDefaultCut } from '../../api/_disputeDefaultCut'
import cronHandler from '../../api/cron/default-cut-disputes'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type DisputeRow = { id: string; job_id: string; default_applied_at?: string | null }
type JobRow = {
  customer_user_id: string | null
  craftsman_user_id: string | null
  title: string | null
}

// Batch 2: the apply RPC now stamps refund_partial + the held-remainder snapshot
// (default_refund_minor, EUR cents). 7500 = €75 held → the normal 75/25 case
// (deposit released, final held). The worker converts to MAJOR (75) for the service.
const PROCEED_ROW = {
  decision: 'refund',
  resolution_type: 'refund_partial',
  default_applied_at: '2026-06-14T00:00:00.000Z',
  settlement_status: 'pending',
  default_refund_minor: 7500,
}
const SETTLED_ROW = {
  decision: 'refund',
  resolution_type: 'refund_partial',
  default_applied_at: '2026-06-14T00:00:00.000Z',
  settlement_status: 'settled',
  default_refund_minor: 7500,
}
const OPERATOR_ROW = {
  decision: 'release',
  resolution_type: 'release_full',
  default_applied_at: null,
  settlement_status: null,
  default_refund_minor: null,
}
// Lockstep skew: a worker on the NEW (refund_partial) gate running against an OLD
// apply RPC that still stamps refund_full. The worker must NOT proceed and skip the
// row as not-ours rather than refunding on a half-flipped deploy (Batch-2 guard).
const REFUND_FULL_PENDING_ROW = {
  decision: 'refund',
  resolution_type: 'refund_full',
  default_applied_at: '2026-06-14T00:00:00.000Z',
  settlement_status: 'pending',
  default_refund_minor: null,
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

// ---------------------------------------------------------------------------
// Supabase fake
// ---------------------------------------------------------------------------

function makeDisputesBuilder(
  primary: { data: unknown; error: unknown },
  retry: { data: unknown; error: unknown },
) {
  const builder: Record<string, unknown> = {}
  builder.select = vi.fn(() => builder)
  builder.is = vi.fn(() => builder)
  builder.in = vi.fn(() => builder)
  builder.eq = vi.fn(() => builder)
  builder.not = vi.fn(() => builder)
  builder.order = vi.fn(() => builder)
  builder.limit = vi.fn(() => builder)
  // The worker runs TWO disputes selections per tick: 1a (still-undecided) then
  // 1b (in-progress AUTO-default retry). Resolve `primary` on the first await,
  // `retry` on the second. Thenable (query awaited whole, no terminal .single()).
  let awaitCount = 0
  builder.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
    const result = awaitCount++ === 0 ? primary : retry
    return Promise.resolve(result).then(onF, onR)
  }
  return builder
}

function makeSingleBuilder(resolver: (filters: Record<string, unknown>) => { data: unknown; error: unknown }) {
  const filters: Record<string, unknown> = {}
  const builder: Record<string, unknown> = {}
  builder.select = vi.fn(() => builder)
  builder.eq = vi.fn((col: string, val: unknown) => {
    filters[col] = val
    return builder
  })
  builder.limit = vi.fn(() => builder)
  builder.maybeSingle = vi.fn(() => Promise.resolve(resolver(filters)))
  return builder
}

// jobs lookup for the party-notification fan-out: select(...).eq('id', jobId)
// .limit(1) awaited whole → { data: [row], error }. Fresh per from('jobs') call
// so accumulated filters never bleed between disputes.
function makeJobsBuilder(jobsByJob: Record<string, JobRow | null>) {
  const filters: Record<string, unknown> = {}
  const builder: Record<string, unknown> = {}
  builder.select = vi.fn(() => builder)
  builder.eq = vi.fn((col: string, val: unknown) => {
    filters[col] = val
    return builder
  })
  builder.limit = vi.fn(() => builder)
  builder.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
    const row = jobsByJob[filters.id as string] ?? null
    return Promise.resolve({ data: row ? [row] : [], error: null }).then(onF, onR)
  }
  return builder
}

function makeSupabase(opts: {
  disputes: DisputeRow[]
  /** Rows returned by the 1b in-progress-default retry selection (default: none). */
  inProgress?: DisputeRow[]
  plansByJob?: Record<string, { funded_at: string | null } | null>
  paymentsByJob?: Record<string, { provider_ref: string | null } | null>
  jobsByJob?: Record<string, JobRow | null>
  applyRow?: unknown
  applyError?: { message: string } | null
  settleRow?: unknown
  settleError?: { message: string } | null
}) {
  const disputesBuilder = makeDisputesBuilder(
    { data: opts.disputes, error: null },
    { data: opts.inProgress ?? [], error: null },
  )

  const rpc = vi.fn((fn: string) => {
    if (fn === 'apply_dispute_default_refund') {
      return Promise.resolve({ data: opts.applyRow ?? null, error: opts.applyError ?? null })
    }
    if (fn === 'settle_dispute_default') {
      return Promise.resolve({ data: opts.settleRow ?? null, error: opts.settleError ?? null })
    }
    return Promise.resolve({ data: null, error: null })
  })

  const from = vi.fn((table: string) => {
    if (table === 'disputes') return disputesBuilder
    if (table === 'escrow_payment_plans') {
      return makeSingleBuilder((f) => ({
        data: (opts.plansByJob ?? {})[f.job_id as string] ?? null,
        error: null,
      }))
    }
    if (table === 'payments') {
      return makeSingleBuilder((f) => ({
        data: (opts.paymentsByJob ?? {})[f.job_id as string] ?? null,
        error: null,
      }))
    }
    if (table === 'jobs') {
      return makeJobsBuilder(opts.jobsByJob ?? {})
    }
    throw new Error(`unexpected table ${table}`)
  })

  const supabase = { from, rpc } as unknown as SupabaseClient
  return { supabase, from, rpc, disputesBuilder }
}

// ---------------------------------------------------------------------------
// Stripe fake (worker is handed the client; no Stripe ctor involved)
// ---------------------------------------------------------------------------

function makeStripe() {
  const retrieve = vi.fn().mockResolvedValue({ id: 'pi_1', status: 'succeeded', currency: 'eur' })
  const stripe = { paymentIntents: { retrieve } } as unknown as Stripe
  return { stripe, retrieve }
}

// ---------------------------------------------------------------------------
// Vercel req/res fakes (cron handler)
// ---------------------------------------------------------------------------

function makeRequest(method: string, headers: Record<string, string | undefined> = {}): VercelRequest {
  return { method, headers, url: '/api/cron/default-cut-disputes' } as unknown as VercelRequest
}

function makeResponse(): { res: VercelResponse; statusCode: () => number; body: () => unknown } {
  let _statusCode = 0
  let _body: unknown = null
  const res = {
    status: vi.fn((code: number) => {
      _statusCode = code
      return res
    }),
    json: vi.fn((b: unknown) => {
      _body = b
    }),
  } as unknown as VercelResponse
  return { res, statusCode: () => _statusCode, body: () => _body }
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockExecuteEscrowRefund.mockResolvedValue({ ok: true, mode: 'refunded' })
  mockDeliverEmail.mockResolvedValue({ success: true })
  delete process.env.CRON_SECRET
  delete process.env.FUNDING_DESTINATION_CHARGE_ENABLED
  delete process.env.STRIPE_SECRET_KEY
})

// ---------------------------------------------------------------------------
// (a) flag-OFF cron — byte-identical dormant no-op
// ---------------------------------------------------------------------------

describe('default-cut-disputes cron — flag-OFF dormant', () => {
  it('returns corridor_disabled and makes ZERO supabase/stripe calls', async () => {
    delete process.env.FUNDING_DESTINATION_CHARGE_ENABLED
    delete process.env.CRON_SECRET

    const { res, statusCode, body } = makeResponse()
    await cronHandler(makeRequest('GET'), res)

    expect(statusCode()).toBe(200)
    expect(body()).toEqual({ ok: true, skipped: true, reason: 'corridor_disabled' })
    // No Supabase admin client constructed, no Stripe client constructed.
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockStripeCtor).not.toHaveBeenCalled()
  })

  it('still returns corridor_disabled for the empty-string flag value', async () => {
    process.env.FUNDING_DESTINATION_CHARGE_ENABLED = ''

    const { res, statusCode, body } = makeResponse()
    await cronHandler(makeRequest('POST'), res)

    expect(statusCode()).toBe(200)
    expect((body() as Record<string, unknown>).reason).toBe('corridor_disabled')
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockStripeCtor).not.toHaveBeenCalled()
  })

  it('rejects non-GET/POST before the flag gate', async () => {
    const { res, statusCode } = makeResponse()
    await cronHandler(makeRequest('DELETE'), res)
    expect(statusCode()).toBe(405)
  })
})

// ---------------------------------------------------------------------------
// (b) worker — 80-day boundary
// ---------------------------------------------------------------------------

describe('runDisputeDefaultCut — T+80 boundary', () => {
  it('funded_at 79d ago → skippedNotEligible, no apply/refund/settle', async () => {
    const { supabase, rpc } = makeSupabase({
      disputes: [{ id: 'd1', job_id: 'j1' }],
      plansByJob: { j1: { funded_at: isoDaysAgo(79) } },
    })
    const { stripe, retrieve } = makeStripe()

    const summary = await runDisputeDefaultCut(supabase, stripe)

    expect(summary.checked).toBe(1)
    expect(summary.skippedNotEligible).toBe(1)
    expect(summary.defaulted).toBe(0)
    expect(rpc).not.toHaveBeenCalled()
    expect(retrieve).not.toHaveBeenCalled()
    expect(mockExecuteEscrowRefund).not.toHaveBeenCalled()
  })

  it('funded_at 80d ago → fires apply → refund → settle in order', async () => {
    const { supabase, rpc } = makeSupabase({
      disputes: [{ id: 'd1', job_id: 'j1' }],
      plansByJob: { j1: { funded_at: isoDaysAgo(80) } },
      paymentsByJob: { j1: { provider_ref: 'pi_1' } },
      applyRow: PROCEED_ROW,
      settleRow: SETTLED_ROW,
    })
    const { stripe, retrieve } = makeStripe()

    const summary = await runDisputeDefaultCut(supabase, stripe)

    expect(summary.defaulted).toBe(1)
    expect(summary.failed).toBe(0)

    // Stripe PARTIAL refund: amount = held snapshot (7500 cents → €75 MAJOR),
    // refundApplicationFee:true, stable per-dispute idempotency suffix.
    expect(retrieve).toHaveBeenCalledWith('pi_1')
    expect(mockExecuteEscrowRefund).toHaveBeenCalledTimes(1)
    const refundParams = mockExecuteEscrowRefund.mock.calls[0][2] as {
      amount?: number
      destinationChargeEnabled: boolean
      refundApplicationFee?: boolean
      idempotencySuffix?: string
    }
    expect(refundParams.amount).toBe(75)
    expect(refundParams.refundApplicationFee).toBe(true)
    expect(refundParams.idempotencySuffix).toBe('default_d1')
    expect(refundParams.destinationChargeEnabled).toBe(false)

    // Strict ordering: apply < refund < settle (global invocation order).
    const applyIdx = rpc.mock.calls.findIndex((c) => c[0] === 'apply_dispute_default_refund')
    const settleIdx = rpc.mock.calls.findIndex((c) => c[0] === 'settle_dispute_default')
    expect(applyIdx).toBeGreaterThanOrEqual(0)
    expect(settleIdx).toBeGreaterThanOrEqual(0)

    const applyOrder = rpc.mock.invocationCallOrder[applyIdx]
    const settleOrder = rpc.mock.invocationCallOrder[settleIdx]
    const refundOrder = mockExecuteEscrowRefund.mock.invocationCallOrder[0]
    expect(applyOrder).toBeLessThan(refundOrder)
    expect(refundOrder).toBeLessThan(settleOrder)
  })
})

// ---------------------------------------------------------------------------
// (c) anchor missing
// ---------------------------------------------------------------------------

describe('runDisputeDefaultCut — anchor', () => {
  it('funded_at NULL → anchorMissing + skip', async () => {
    const { supabase, rpc } = makeSupabase({
      disputes: [{ id: 'd1', job_id: 'j1' }],
      plansByJob: { j1: { funded_at: null } },
    })
    const { stripe, retrieve } = makeStripe()

    const summary = await runDisputeDefaultCut(supabase, stripe)

    expect(summary.anchorMissing).toBe(1)
    expect(summary.defaulted).toBe(0)
    expect(rpc).not.toHaveBeenCalled()
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('no plan row at all → anchorMissing + skip', async () => {
    const { supabase, rpc } = makeSupabase({
      disputes: [{ id: 'd1', job_id: 'j1' }],
      plansByJob: {},
    })
    const { stripe } = makeStripe()

    const summary = await runDisputeDefaultCut(supabase, stripe)

    expect(summary.anchorMissing).toBe(1)
    expect(rpc).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// (d) query filter excludes decided disputes
// ---------------------------------------------------------------------------

describe('runDisputeDefaultCut — query filter (scope-leak guard)', () => {
  it('selects only undecided open-family disputes, oldest first, capped at 50', async () => {
    const { supabase, disputesBuilder, from } = makeSupabase({ disputes: [] })
    const { stripe } = makeStripe()

    await runDisputeDefaultCut(supabase, stripe)

    // decision IS NULL → a dispute with decision != null is excluded by the DB.
    expect(disputesBuilder.is).toHaveBeenCalledWith('decision', null)
    // default_applied_at IS NULL → already-defaulted rows excluded (idempotency).
    expect(disputesBuilder.is).toHaveBeenCalledWith('default_applied_at', null)
    // open-family status only → terminal disputes excluded.
    expect(disputesBuilder.in).toHaveBeenCalledWith('status', [
      'open',
      'under_review',
      'customer_waiting',
      'provider_waiting',
    ])
    expect(disputesBuilder.order).toHaveBeenCalledWith('opened_at', { ascending: true })
    expect(disputesBuilder.limit).toHaveBeenCalledWith(50)

    // SCOPE-LEAK GUARD: drives ONLY off disputes — never reads acceptances.
    const tablesTouched = from.mock.calls.map((c) => c[0])
    expect(tablesTouched).toContain('disputes')
    expect(tablesTouched).not.toContain('acceptances')
  })
})

// ---------------------------------------------------------------------------
// (e) operator/consensus won the race
// ---------------------------------------------------------------------------

describe('runDisputeDefaultCut — race with operator/consensus', () => {
  it('apply returns a non-ours row → skippedNotOurs, NO Stripe call, NO settle', async () => {
    const { supabase, rpc } = makeSupabase({
      disputes: [{ id: 'd1', job_id: 'j1' }],
      plansByJob: { j1: { funded_at: isoDaysAgo(85) } },
      paymentsByJob: { j1: { provider_ref: 'pi_1' } },
      applyRow: OPERATOR_ROW,
    })
    const { stripe, retrieve } = makeStripe()

    const summary = await runDisputeDefaultCut(supabase, stripe)

    expect(summary.skippedNotOurs).toBe(1)
    expect(summary.defaulted).toBe(0)
    expect(retrieve).not.toHaveBeenCalled()
    expect(mockExecuteEscrowRefund).not.toHaveBeenCalled()
    expect(rpc.mock.calls.some((c) => c[0] === 'settle_dispute_default')).toBe(false)
  })

  it('apply returns an already-settled row → alreadySettled, NO Stripe call', async () => {
    const { supabase, rpc } = makeSupabase({
      disputes: [{ id: 'd1', job_id: 'j1' }],
      plansByJob: { j1: { funded_at: isoDaysAgo(85) } },
      paymentsByJob: { j1: { provider_ref: 'pi_1' } },
      applyRow: SETTLED_ROW,
    })
    const { stripe, retrieve } = makeStripe()

    const summary = await runDisputeDefaultCut(supabase, stripe)

    expect(summary.alreadySettled).toBe(1)
    expect(summary.defaulted).toBe(0)
    expect(retrieve).not.toHaveBeenCalled()
    expect(mockExecuteEscrowRefund).not.toHaveBeenCalled()
    expect(rpc.mock.calls.some((c) => c[0] === 'settle_dispute_default')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (f) Stripe refund returns ok:false
// ---------------------------------------------------------------------------

describe('runDisputeDefaultCut — refund failure', () => {
  it('executeEscrowRefundForIntent ok:false → settle NOT called, failed++', async () => {
    mockExecuteEscrowRefund.mockResolvedValueOnce({ ok: false, httpStatus: 400, body: { error: 'too big' } })

    const { supabase, rpc } = makeSupabase({
      disputes: [{ id: 'd1', job_id: 'j1' }],
      plansByJob: { j1: { funded_at: isoDaysAgo(90) } },
      paymentsByJob: { j1: { provider_ref: 'pi_1' } },
      applyRow: PROCEED_ROW,
      settleRow: SETTLED_ROW,
    })
    const { stripe, retrieve } = makeStripe()

    const summary = await runDisputeDefaultCut(supabase, stripe)

    expect(summary.failed).toBe(1)
    expect(summary.defaulted).toBe(0)
    expect(retrieve).toHaveBeenCalledWith('pi_1')
    expect(mockExecuteEscrowRefund).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls.some((c) => c[0] === 'apply_dispute_default_refund')).toBe(true)
    expect(rpc.mock.calls.some((c) => c[0] === 'settle_dispute_default')).toBe(false)
    // No default fired → no party notification.
    expect(mockDeliverEmail).not.toHaveBeenCalled()
  })

  it('missing provider_ref → failed++ and settle NOT called', async () => {
    const { supabase, rpc } = makeSupabase({
      disputes: [{ id: 'd1', job_id: 'j1' }],
      plansByJob: { j1: { funded_at: isoDaysAgo(90) } },
      paymentsByJob: { j1: { provider_ref: null } },
      applyRow: PROCEED_ROW,
    })
    const { stripe, retrieve } = makeStripe()

    const summary = await runDisputeDefaultCut(supabase, stripe)

    expect(summary.failed).toBe(1)
    expect(summary.defaulted).toBe(0)
    expect(retrieve).not.toHaveBeenCalled()
    expect(mockExecuteEscrowRefund).not.toHaveBeenCalled()
    expect(rpc.mock.calls.some((c) => c[0] === 'settle_dispute_default')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (g) in-progress default retry — self-healing (findings 2 & 3)
// ---------------------------------------------------------------------------

describe('runDisputeDefaultCut — in-progress default retry (self-healing)', () => {
  it('re-picks a resolved/refund/pending AUTO-default (1b) and drives refund→settle to completion', async () => {
    // 1a returns nothing (no still-undecided disputes); 1b returns the stranded
    // in-progress default left by a prior tick whose refund/settle failed after
    // apply already committed (decision=refund / status=resolved / default_applied_at set).
    const { supabase, rpc } = makeSupabase({
      disputes: [],
      inProgress: [{ id: 'd9', job_id: 'j9', default_applied_at: isoDaysAgo(1) }],
      plansByJob: { j9: { funded_at: isoDaysAgo(120) } },
      paymentsByJob: { j9: { provider_ref: 'pi_9' } },
      applyRow: PROCEED_ROW, // re-call of apply returns the same pending row → proceed
      settleRow: SETTLED_ROW,
    })
    const { stripe, retrieve } = makeStripe()

    const summary = await runDisputeDefaultCut(supabase, stripe)

    expect(summary.checked).toBe(1)
    expect(summary.defaulted).toBe(1)
    expect(summary.failed).toBe(0)
    expect(retrieve).toHaveBeenCalledWith('pi_9')
    expect(mockExecuteEscrowRefund).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls.some((c) => c[0] === 'settle_dispute_default')).toBe(true)
  })

  it('1b retry selects default_applied_at + uses the resolved/refund/pending filters', async () => {
    const { supabase, disputesBuilder } = makeSupabase({ disputes: [], inProgress: [] })
    const { stripe } = makeStripe()

    await runDisputeDefaultCut(supabase, stripe)

    // 1b scopes strictly to the AUTO-default (never an operator refund) and now
    // selects default_applied_at so the stuck check can age it (no new column).
    expect(disputesBuilder.select).toHaveBeenCalledWith('id, job_id, default_applied_at')
    expect(disputesBuilder.eq).toHaveBeenCalledWith('status', 'resolved')
    expect(disputesBuilder.eq).toHaveBeenCalledWith('decision', 'refund')
    expect(disputesBuilder.eq).toHaveBeenCalledWith('settlement_status', 'pending')
    expect(disputesBuilder.not).toHaveBeenCalledWith('default_applied_at', 'is', null)
  })

  it('does not double-process a dispute returned by both 1a and 1b (defensive dedupe)', async () => {
    const { supabase, rpc } = makeSupabase({
      disputes: [{ id: 'd1', job_id: 'j1' }],
      inProgress: [{ id: 'd1', job_id: 'j1' }],
      plansByJob: { j1: { funded_at: isoDaysAgo(90) } },
      paymentsByJob: { j1: { provider_ref: 'pi_1' } },
      applyRow: PROCEED_ROW,
      settleRow: SETTLED_ROW,
    })
    const { stripe } = makeStripe()

    const summary = await runDisputeDefaultCut(supabase, stripe)

    expect(summary.checked).toBe(1)
    expect(summary.defaulted).toBe(1)
    expect(rpc.mock.calls.filter((c) => c[0] === 'settle_dispute_default').length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// (h) party notification on default-fire (Run-3 item 2)
// ---------------------------------------------------------------------------

describe('runDisputeDefaultCut — party notification on default-fire', () => {
  it('emails BOTH customer and craftsman via the shared channel after settle', async () => {
    const { supabase } = makeSupabase({
      disputes: [{ id: 'd1', job_id: 'j1' }],
      plansByJob: { j1: { funded_at: isoDaysAgo(85) } },
      paymentsByJob: { j1: { provider_ref: 'pi_1' } },
      jobsByJob: { j1: { customer_user_id: 'cust_1', craftsman_user_id: 'craft_1', title: 'Heizung' } },
      applyRow: PROCEED_ROW,
      settleRow: SETTLED_ROW,
    })
    const { stripe } = makeStripe()

    const summary = await runDisputeDefaultCut(supabase, stripe)

    expect(summary.defaulted).toBe(1)
    expect(mockDeliverEmail).toHaveBeenCalledTimes(2)

    const payloads = mockDeliverEmail.mock.calls.map((c) => c[1] as {
      type: string
      recipientRole: string
      recipientUserId: string
      jobId: string
    })
    // Same provisional-default template for both parties.
    expect(payloads.every((p) => p.type === 'dispute_default_refund_applied')).toBe(true)
    expect(payloads.every((p) => p.jobId === 'j1')).toBe(true)
    // BOTH roles notified.
    expect(payloads.map((p) => p.recipientRole).sort()).toEqual(['craftsman', 'customer'])
    // Recipients resolve from the JOB's AUTH user ids (NOT dispute profile/provider FKs).
    expect(payloads.map((p) => p.recipientUserId).sort()).toEqual(['craft_1', 'cust_1'])
  })

  it('only emails the present party when one job auth-id is missing', async () => {
    const { supabase } = makeSupabase({
      disputes: [{ id: 'd1', job_id: 'j1' }],
      plansByJob: { j1: { funded_at: isoDaysAgo(85) } },
      paymentsByJob: { j1: { provider_ref: 'pi_1' } },
      jobsByJob: { j1: { customer_user_id: 'cust_1', craftsman_user_id: null, title: 'Bad' } },
      applyRow: PROCEED_ROW,
      settleRow: SETTLED_ROW,
    })
    const { stripe } = makeStripe()

    const summary = await runDisputeDefaultCut(supabase, stripe)

    expect(summary.defaulted).toBe(1)
    expect(mockDeliverEmail).toHaveBeenCalledTimes(1)
    expect((mockDeliverEmail.mock.calls[0][1] as { recipientRole: string }).recipientRole).toBe('customer')
  })

  it('a notification throw NEVER flips the default back or increments failed', async () => {
    mockDeliverEmail.mockRejectedValue(new Error('resend down'))

    const { supabase } = makeSupabase({
      disputes: [{ id: 'd1', job_id: 'j1' }],
      plansByJob: { j1: { funded_at: isoDaysAgo(85) } },
      paymentsByJob: { j1: { provider_ref: 'pi_1' } },
      jobsByJob: { j1: { customer_user_id: 'cust_1', craftsman_user_id: 'craft_1', title: 'Bad' } },
      applyRow: PROCEED_ROW,
      settleRow: SETTLED_ROW,
    })
    const { stripe } = makeStripe()

    const summary = await runDisputeDefaultCut(supabase, stripe)

    // Money moved correctly; the notification failure is swallowed.
    expect(summary.defaulted).toBe(1)
    expect(summary.failed).toBe(0)
  })

  it('a jobs lookup error is swallowed — default stays counted, batch continues', async () => {
    // jobsByJob has no row for j1 → notify logs job_missing, never throws.
    const { supabase } = makeSupabase({
      disputes: [{ id: 'd1', job_id: 'j1' }],
      plansByJob: { j1: { funded_at: isoDaysAgo(85) } },
      paymentsByJob: { j1: { provider_ref: 'pi_1' } },
      applyRow: PROCEED_ROW,
      settleRow: SETTLED_ROW,
    })
    const { stripe } = makeStripe()

    const summary = await runDisputeDefaultCut(supabase, stripe)

    expect(summary.defaulted).toBe(1)
    expect(summary.failed).toBe(0)
    expect(mockDeliverEmail).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// (i) stuck escalation (Run-3 item 4)
// ---------------------------------------------------------------------------

describe('runDisputeDefaultCut — stuck escalation', () => {
  it('1b in-progress default older than 3d → dispute_default.stuck alert, still re-driven', async () => {
    const { supabase } = makeSupabase({
      disputes: [],
      inProgress: [{ id: 'd9', job_id: 'j9', default_applied_at: isoDaysAgo(4) }],
      plansByJob: { j9: { funded_at: isoDaysAgo(120) } },
      paymentsByJob: { j9: { provider_ref: 'pi_9' } },
      jobsByJob: { j9: { customer_user_id: 'c', craftsman_user_id: 'k', title: 'X' } },
      applyRow: PROCEED_ROW,
      settleRow: SETTLED_ROW,
    })
    const { stripe } = makeStripe()

    const summary = await runDisputeDefaultCut(supabase, stripe)

    // Still driven to completion idempotently — the alert is additive, not a halt.
    expect(summary.defaulted).toBe(1)

    const stuckCalls = mockLogError.mock.calls.filter((c) => c[0] === 'dispute_default.stuck')
    expect(stuckCalls.length).toBe(1)
    const ctx = stuckCalls[0][2] as { disputeId: string; ageDays: number }
    expect(ctx.disputeId).toBe('d9')
    expect(ctx.ageDays).toBeGreaterThanOrEqual(3)
  })

  it('1b in-progress default younger than 3d → NO stuck alert', async () => {
    const { supabase } = makeSupabase({
      disputes: [],
      inProgress: [{ id: 'd9', job_id: 'j9', default_applied_at: isoDaysAgo(1) }],
      plansByJob: { j9: { funded_at: isoDaysAgo(120) } },
      paymentsByJob: { j9: { provider_ref: 'pi_9' } },
      jobsByJob: { j9: { customer_user_id: 'c', craftsman_user_id: 'k', title: 'X' } },
      applyRow: PROCEED_ROW,
      settleRow: SETTLED_ROW,
    })
    const { stripe } = makeStripe()

    await runDisputeDefaultCut(supabase, stripe)

    const stuckCalls = mockLogError.mock.calls.filter((c) => c[0] === 'dispute_default.stuck')
    expect(stuckCalls.length).toBe(0)
  })

  it('a fresh 1a dispute (no default_applied_at) never raises a stuck alert', async () => {
    const { supabase } = makeSupabase({
      disputes: [{ id: 'd1', job_id: 'j1' }],
      plansByJob: { j1: { funded_at: isoDaysAgo(85) } },
      paymentsByJob: { j1: { provider_ref: 'pi_1' } },
      applyRow: PROCEED_ROW,
      settleRow: SETTLED_ROW,
    })
    const { stripe } = makeStripe()

    await runDisputeDefaultCut(supabase, stripe)

    const stuckCalls = mockLogError.mock.calls.filter((c) => c[0] === 'dispute_default.stuck')
    expect(stuckCalls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// (j) cron — defaults_fired alert (Run-3 item 3)
// ---------------------------------------------------------------------------

describe('default-cut-disputes cron — flag-ON alerting', () => {
  it('emits defaults_fired when real money moved (summary.defaulted > 0)', async () => {
    process.env.FUNDING_DESTINATION_CHARGE_ENABLED = 'true'
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'
    delete process.env.CRON_SECRET

    const { supabase } = makeSupabase({
      disputes: [{ id: 'd1', job_id: 'j1' }],
      plansByJob: { j1: { funded_at: isoDaysAgo(85) } },
      paymentsByJob: { j1: { provider_ref: 'pi_1' } },
      jobsByJob: { j1: { customer_user_id: 'cust_1', craftsman_user_id: 'craft_1', title: 'Heizung' } },
      applyRow: PROCEED_ROW,
      settleRow: SETTLED_ROW,
    })
    mockGetSupabaseAdmin.mockReturnValueOnce(supabase)

    const { stripe } = makeStripe()
    // Regular function (not arrow) so `new Stripe()` in getStripe can construct
    // it; returning an object makes `new` yield our fake client.
    mockStripeCtor.mockImplementation(function () { return stripe })

    const { res, statusCode, body } = makeResponse()
    await cronHandler(makeRequest('GET'), res)

    expect(statusCode()).toBe(200)
    const b = body() as Record<string, unknown>
    expect(b.ok).toBe(true)
    expect(b.defaulted).toBe(1)

    const firedCalls = mockLogError.mock.calls.filter((c) => c[0] === 'cron.dispute_default.defaults_fired')
    expect(firedCalls.length).toBe(1)
    expect(firedCalls[0][2]).toMatchObject({ defaulted: 1, severity: 'dispute_default_cut_money_moved' })
  })
})

// ---------------------------------------------------------------------------
// (k) Batch 2 — 75/25 PARTIAL held-snapshot cut
// ---------------------------------------------------------------------------

type RefundCallParams = {
  amount?: number
  destinationChargeEnabled: boolean
  refundApplicationFee?: boolean
  idempotencySuffix?: string
}

describe('runDisputeDefaultCut — 75/25 partial held-snapshot cut (Batch 2)', () => {
  it('0% released → refunds the FULL held snapshot (100%), never a hardcoded 75%', async () => {
    // apply stamped the held remainder = the WHOLE escrow (nothing released yet):
    // €100 total → snapshot 10000 cents. The worker must forward exactly that
    // (amount 100 MAJOR), not a fixed 75% of any total it cannot even see.
    const fullHeldRow = { ...PROCEED_ROW, default_refund_minor: 10_000 }
    const { supabase } = makeSupabase({
      disputes: [{ id: 'd1', job_id: 'j1' }],
      plansByJob: { j1: { funded_at: isoDaysAgo(85) } },
      paymentsByJob: { j1: { provider_ref: 'pi_1' } },
      jobsByJob: { j1: { customer_user_id: 'c', craftsman_user_id: 'k', title: 'X' } },
      applyRow: fullHeldRow,
      settleRow: SETTLED_ROW,
    })
    const { stripe } = makeStripe()

    const summary = await runDisputeDefaultCut(supabase, stripe)

    expect(summary.defaulted).toBe(1)
    const params = mockExecuteEscrowRefund.mock.calls[0][2] as RefundCallParams
    expect(params.amount).toBe(100) // full held remainder, NOT 75
    expect(params.refundApplicationFee).toBe(true)
    expect(params.idempotencySuffix).toBe('default_d1')
  })

  it('snapshot + stable per-dispute key → deterministic amount across ticks, no second refund (G1)', async () => {
    // Tick 1: the default fires and the Stripe refund succeeds, but settle FAILS
    // → the dispute is left in-progress (resolved/refund/pending) for the 1b retry.
    const tick1 = makeSupabase({
      disputes: [{ id: 'd1', job_id: 'j1' }],
      plansByJob: { j1: { funded_at: isoDaysAgo(85) } },
      paymentsByJob: { j1: { provider_ref: 'pi_1' } },
      jobsByJob: { j1: { customer_user_id: 'c', craftsman_user_id: 'k', title: 'X' } },
      applyRow: PROCEED_ROW,
      settleError: { message: 'settle boom' },
    })
    const { stripe: stripe1 } = makeStripe()
    const s1 = await runDisputeDefaultCut(tick1.supabase, stripe1)
    expect(s1.failed).toBe(1)
    expect(s1.defaulted).toBe(0)

    // Tick 2: the SAME dispute returns via the 1b in-progress retry. apply re-returns
    // the SAME already-stamped snapshot (the worker never recomputes the held set),
    // even though the live tranche state may have moved on. Settle now succeeds.
    const tick2 = makeSupabase({
      disputes: [],
      inProgress: [{ id: 'd1', job_id: 'j1', default_applied_at: isoDaysAgo(1) }],
      plansByJob: { j1: { funded_at: isoDaysAgo(85) } },
      paymentsByJob: { j1: { provider_ref: 'pi_1' } },
      jobsByJob: { j1: { customer_user_id: 'c', craftsman_user_id: 'k', title: 'X' } },
      applyRow: PROCEED_ROW,
      settleRow: SETTLED_ROW,
    })
    const { stripe: stripe2 } = makeStripe()
    const s2 = await runDisputeDefaultCut(tick2.supabase, stripe2)
    expect(s2.defaulted).toBe(1)

    // Both ticks issued the refund with the IDENTICAL snapshot amount and the SAME
    // per-dispute idempotency suffix (NOT amount-derived) → Stripe dedups the second
    // on the stable key, so no second refund actually moves money.
    expect(mockExecuteEscrowRefund).toHaveBeenCalledTimes(2)
    const call1 = mockExecuteEscrowRefund.mock.calls[0][2] as RefundCallParams
    const call2 = mockExecuteEscrowRefund.mock.calls[1][2] as RefundCallParams
    expect(call1.amount).toBe(75)
    expect(call2.amount).toBe(call1.amount)
    expect(call1.idempotencySuffix).toBe('default_d1')
    expect(call2.idempotencySuffix).toBe('default_d1')
    expect(call1.refundApplicationFee).toBe(true)
  })

  it('100% released → held snapshot 0 → settles WITHOUT a Stripe refund (no zero-amount refund)', async () => {
    // The escrow was fully released before T+80, so apply stamped a held
    // remainder of 0 (nothing left in escrow). A zero-amount Stripe refund is
    // rejected ("amount must be greater than 0"), which would strand the dispute
    // in an endless 1b retry — so the worker must skip the money move entirely
    // and settle directly. The default still converges; NO Stripe call is made.
    const zeroHeldRow = { ...PROCEED_ROW, default_refund_minor: 0 }
    const { supabase, rpc } = makeSupabase({
      disputes: [{ id: 'd1', job_id: 'j1' }],
      plansByJob: { j1: { funded_at: isoDaysAgo(85) } },
      paymentsByJob: { j1: { provider_ref: 'pi_1' } },
      jobsByJob: { j1: { customer_user_id: 'c', craftsman_user_id: 'k', title: 'X' } },
      applyRow: zeroHeldRow,
      settleRow: SETTLED_ROW,
    })
    const { stripe, retrieve } = makeStripe()

    const summary = await runDisputeDefaultCut(supabase, stripe)

    // Default converges: apply + settle ran, dispute counted defaulted, no fail.
    expect(summary.defaulted).toBe(1)
    expect(summary.failed).toBe(0)
    // No money move: neither the PI retrieve nor the shared refund service is hit.
    expect(retrieve).not.toHaveBeenCalled()
    expect(mockExecuteEscrowRefund).not.toHaveBeenCalled()
    // settle still ran so the dispute is driven terminal.
    expect(rpc.mock.calls.some((c) => c[0] === 'settle_dispute_default')).toBe(true)
    // Both parties still notified that the provisional default applied.
    expect(mockDeliverEmail).toHaveBeenCalledTimes(2)
  })

  it('lockstep skew — apply still stamps refund_full → skippedNotOurs, NO refund/settle', async () => {
    const { supabase, rpc } = makeSupabase({
      disputes: [{ id: 'd1', job_id: 'j1' }],
      plansByJob: { j1: { funded_at: isoDaysAgo(85) } },
      paymentsByJob: { j1: { provider_ref: 'pi_1' } },
      applyRow: REFUND_FULL_PENDING_ROW,
    })
    const { stripe, retrieve } = makeStripe()

    const summary = await runDisputeDefaultCut(supabase, stripe)

    // Worker requires resolution_type='refund_partial'; an un-flipped refund_full
    // row is treated as not-ours and skipped — never refunded on a half-flipped deploy.
    expect(summary.skippedNotOurs).toBe(1)
    expect(summary.defaulted).toBe(0)
    expect(retrieve).not.toHaveBeenCalled()
    expect(mockExecuteEscrowRefund).not.toHaveBeenCalled()
    expect(rpc.mock.calls.some((c) => c[0] === 'settle_dispute_default')).toBe(false)
  })
})
