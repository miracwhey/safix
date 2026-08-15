/**
 * Refund Escrow — Tranche-Release Guard + Dispute-Split Bypass (P0)
 *
 * Validates that api/refund-escrow.ts:
 *
 *   1. Blocks every refund by default once any escrow tranche has entered a
 *      state that indicates money has moved — or is in the process of moving
 *      — to the provider. Fail-closed on schema drift and lookup failures.
 *
 *   2. Permits a narrow, server-validated exception for dispute split
 *      settlements: the dispute row must exist, belong to the same job+
 *      payment, be in status='resolved' with decision='split',
 *      settlement_status='pending', a valid split_ratio, and the requested
 *      amount must — after conversion to smallest currency units via
 *      toSmallestUnit — match the server-computed customer share exactly.
 *      Reconciliation states (transfer_reversed), schema drift
 *      (tranche_status_unknown), and lookup failures (guard_lookup_failed)
 *      stay operator-only and cannot be bypassed.
 *
 *   3. Classifies reversed transfers as transfer_reversed even when the
 *      original external_release_ref is still on the row (the reversal
 *      webhook keeps both refs populated).
 */

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockRequireAuth } = vi.hoisted(() => ({ mockRequireAuth: vi.fn() }))

const { mockGetSupabaseAdmin } = vi.hoisted(() => ({
  mockGetSupabaseAdmin: vi.fn(),
}))

const {
  mockLoadPaymentContext,
  mockFetchIsOperator,
  mockCanRefundEscrowForPayment,
} = vi.hoisted(() => ({
  mockLoadPaymentContext: vi.fn(),
  mockFetchIsOperator: vi.fn(),
  mockCanRefundEscrowForPayment: vi.fn(),
}))

const {
  mockPaymentIntentsRetrieve,
  mockPaymentIntentsCancel,
  mockRefundsCreate,
} = vi.hoisted(() => ({
  mockPaymentIntentsRetrieve: vi.fn(),
  mockPaymentIntentsCancel: vi.fn(),
  mockRefundsCreate: vi.fn(),
}))

vi.mock('../../api/_auth', () => ({ requireAuth: mockRequireAuth }))

vi.mock('../../api/_supabase', () => ({
  getSupabaseAdmin: mockGetSupabaseAdmin,
}))

vi.mock('../../api/_paymentAuth', () => ({
  loadPaymentContext: mockLoadPaymentContext,
  fetchIsOperator: mockFetchIsOperator,
  canRefundEscrowForPayment: mockCanRefundEscrowForPayment,
}))

vi.mock('../../api/_observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('../../api/_rateLimit', () => ({
  applyRateLimit: vi.fn().mockResolvedValue(false),
}))

vi.mock('../../api/_cors', () => ({
  applyCors: vi.fn().mockReturnValue(false),
}))

vi.mock('stripe', () => {
  class StripeErrorBase extends Error {
    type = 'generic'
  }
  class StripeInvalidRequestError extends StripeErrorBase {
    code?: string
  }
  const MockStripe = class {
    paymentIntents = {
      retrieve: mockPaymentIntentsRetrieve,
      cancel: mockPaymentIntentsCancel,
    }
    refunds = { create: mockRefundsCreate }
  }
  // @ts-expect-error — match the named-error shape the handler uses.
  MockStripe.errors = {
    StripeError: StripeErrorBase,
    StripeInvalidRequestError,
  }
  return { default: MockStripe }
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { SupabaseClient } from '@supabase/supabase-js'
import handler from '../../api/refund-escrow'

// ── Helpers ──────────────────────────────────────────────────────────────────

const PAYMENT_INTENT_ID = 'pi_mock_refund_test'
const PAYMENT_ID = 'payment-db-id'
const JOB_ID = 'job-refund-guard-1'
const PLAN_ID = 'plan-refund-guard-1'
const TRANCHE_DEPOSIT = 'tranche-deposit-1'
const TRANCHE_FINAL = 'tranche-final-1'
const TRANSFER_ID = 'tr_mock_transfer_1'
const DISPUTE_ID = 'dispute-1'
const PLAN_TOTAL = 1000

function makeRequest(body: Record<string, unknown> = {}): VercelRequest {
  return {
    method: 'POST',
    headers: {},
    body,
    url: '/api/refund-escrow',
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

type TrancheRow = {
  id: string
  status: string | null
  external_release_ref: string | null
  transfer_reversal_ref: string | null
  // P4A guard hardening: loadRefundGuardState now also selects external_payout_ref.
  // The real producer (escrow_tranches) always has this column — normally null;
  // omitting it from the mock row would read back as `undefined`, which the
  // handler's `!== null && !== ''` check would misclassify as 'payout_created'.
  external_payout_ref: string | null
}

type DisputeRow = {
  id: string
  job_id: string | null
  payment_id: string | null
  status: string | null
  decision: string | null
  split_ratio: number | string | null
  settlement_status: string | null
  // P4A consensus-split party authz also reads these two columns. Left optional
  // here — the operator-bypass tests in this file never supply a consensus
  // proposal, so the consensus path always denies and these stay undefined.
  customer_profile_id?: string | null
  provider_id?: string | null
}

type ProposalRow = {
  id: string
  proposed_by: string | null
  confirmed_by: string | null
  status: string | null
}

function makeAdmin({
  planId = PLAN_ID as string | null,
  planTotalAmount = PLAN_TOTAL as number | null,
  planCurrency = 'eur' as string | null,
  planError = null as unknown,
  tranches = [] as TrancheRow[],
  trancheError = null as unknown,
  dispute = null as DisputeRow | null,
  disputeError = null as unknown,
  proposal = null as ProposalRow | null,
  proposalError = null as unknown,
  provider = null as { profile_id: string | null } | null,
  providerError = null as unknown,
}: {
  planId?: string | null
  planTotalAmount?: number | null
  planCurrency?: string | null
  planError?: unknown
  tranches?: TrancheRow[]
  trancheError?: unknown
  dispute?: DisputeRow | null
  disputeError?: unknown
  proposal?: ProposalRow | null
  proposalError?: unknown
  provider?: { profile_id: string | null } | null
  providerError?: unknown
} = {}): SupabaseClient {
  const planSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({
        data:
          planId === null
            ? null
            : { id: planId, total_amount: planTotalAmount, currency: planCurrency },
        error: planError ?? null,
      }),
    }),
  })

  const trancheSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({
      data: trancheError ? null : tranches,
      error: trancheError ?? null,
    }),
  })

  const disputeSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({
        data: dispute,
        error: disputeError ?? null,
      }),
    }),
  })

  // P4A consensus authz: .select(...).eq('dispute_id').eq('status','accepted')
  //   .not('confirmed_by','is',null).limit(1).maybeSingle()
  const proposalSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        not: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: proposal,
              error: proposalError ?? null,
            }),
          }),
        }),
      }),
    }),
  })

  const providerSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({
        data: provider,
        error: providerError ?? null,
      }),
    }),
  })

  return {
    from: vi.fn((table: string) => {
      if (table === 'escrow_payment_plans') return { select: planSelect }
      if (table === 'escrow_tranches') return { select: trancheSelect }
      if (table === 'disputes') return { select: disputeSelect }
      if (table === 'dispute_split_proposals') return { select: proposalSelect }
      if (table === 'providers') return { select: providerSelect }
      return {}
    }),
  } as unknown as SupabaseClient
}

function refundSafeTranche(overrides: Partial<TrancheRow> = {}): TrancheRow {
  return {
    id: TRANCHE_DEPOSIT,
    status: 'funded',
    external_release_ref: null,
    transfer_reversal_ref: null,
    external_payout_ref: null,
    ...overrides,
  }
}

function releasedTranche(overrides: Partial<TrancheRow> = {}): TrancheRow {
  return {
    id: TRANCHE_DEPOSIT,
    status: 'released',
    external_release_ref: TRANSFER_ID,
    transfer_reversal_ref: null,
    external_payout_ref: null,
    ...overrides,
  }
}

function validSplitDispute(overrides: Partial<DisputeRow> = {}): DisputeRow {
  return {
    id: DISPUTE_ID,
    job_id: JOB_ID,
    payment_id: PAYMENT_ID,
    status: 'resolved',
    decision: 'split',
    split_ratio: 0.7,
    settlement_status: 'pending',
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('/api/refund-escrow — tranche-release guard + dispute-split bypass', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock'

    mockRequireAuth.mockResolvedValue({ ok: true, userId: 'customer-user-id' })
    mockLoadPaymentContext.mockResolvedValue({
      paymentId: PAYMENT_ID,
      paymentIntentId: PAYMENT_INTENT_ID,
      jobId: JOB_ID,
      customerUserId: 'customer-user-id',
      craftsmanUserId: 'craftsman-user-id',
      paymentStatus: 'in_escrow',
    })
    // Default caller is operator: all bypass-allowed and most bypass-deny
    // tests assume operator context (see bypass_operator_only gate). The
    // dedicated customer-caller test overrides this in-place.
    mockFetchIsOperator.mockResolvedValue(true)
    mockCanRefundEscrowForPayment.mockReturnValue(true)

    mockPaymentIntentsRetrieve.mockResolvedValue({
      id: PAYMENT_INTENT_ID,
      status: 'succeeded',
      currency: 'eur',
    })
    mockPaymentIntentsCancel.mockResolvedValue({ id: PAYMENT_INTENT_ID, status: 'canceled' })
    mockRefundsCreate.mockResolvedValue({ id: 're_mock_refund_1' })
  })

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY
  })

  // ── Blocking paths (no bypass context) ────────────────────────────────────

  it('blocks full refund with 409 when a tranche status is "released"', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [
          releasedTranche({ id: TRANCHE_DEPOSIT }),
          refundSafeTranche({ id: TRANCHE_FINAL, status: 'funded' }),
        ],
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expect(statusCode()).toBe(409)
    const payload = body() as {
      code: string
      reason: string
      bypassDenyReason: string
      message: string
    }
    expect(payload.code).toBe('REFUND_BLOCKED_RELEASED_TRANCHE')
    expect(payload.reason).toBe('tranche_released')
    expect(payload.bypassDenyReason).toBe('no_dispute_id')
    expect(payload.message).toMatch(/Rückerstattung ist nicht mehr möglich/)
    expect(mockPaymentIntentsRetrieve).not.toHaveBeenCalled()
    expect(mockRefundsCreate).not.toHaveBeenCalled()
    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled()
  })

  it('blocks refund when a tranche status is "release_pending"', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [refundSafeTranche({ status: 'release_pending' })],
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expect(statusCode()).toBe(409)
    expect((body() as { reason: string }).reason).toBe('tranche_release_pending')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('blocks refund when external_release_ref is set (split-brain: Stripe transfer created, DB lags)', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [
          refundSafeTranche({
            status: 'eligible_for_release',
            external_release_ref: TRANSFER_ID,
          }),
        ],
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expect(statusCode()).toBe(409)
    expect((body() as { reason: string }).reason).toBe('transfer_created')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('classifies a reversed transfer as transfer_reversed even when external_release_ref is still populated', async () => {
    // The reversal webhook keeps the original external_release_ref and adds
    // transfer_reversal_ref. Order matters: reversed must be detected before
    // the plain transfer_created branch so the row is routed to operator
    // reconciliation rather than treated as a bypassable live transfer.
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [
          refundSafeTranche({
            status: 'funded',
            external_release_ref: TRANSFER_ID,
            transfer_reversal_ref: 'trr_mock_reversal_1',
          }),
        ],
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expect(statusCode()).toBe(409)
    expect((body() as { reason: string }).reason).toBe('transfer_reversed')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('blocks refund (fail-closed) when a tranche carries an unknown status (schema drift)', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [refundSafeTranche({ status: 'some_future_status_not_yet_known' })],
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expect(statusCode()).toBe(409)
    expect((body() as { reason: string }).reason).toBe('tranche_status_unknown')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('blocks refund (fail-closed) when the plan lookup errors', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        planError: { message: 'db connection lost' },
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expect(statusCode()).toBe(409)
    expect((body() as { reason: string }).reason).toBe('guard_lookup_failed')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('blocks refund (fail-closed) when the tranche lookup errors', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        planId: PLAN_ID,
        trancheError: { message: 'tranche query failed' },
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expect(statusCode()).toBe(409)
    expect((body() as { reason: string }).reason).toBe('guard_lookup_failed')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  // ── Bypass-DENY paths (looks like dispute context but server rejects) ─────

  it('denies bypass when disputeId references a non-existent dispute', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [releasedTranche()],
        dispute: null,
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount: 300,
        disputeId: 'dispute-fake',
      }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { bypassDenyReason: string }).bypassDenyReason).toBe('dispute_not_found')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('denies bypass when the dispute belongs to a different job', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [releasedTranche()],
        dispute: validSplitDispute({ job_id: 'some-other-job' }),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount: 300,
        disputeId: DISPUTE_ID,
      }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { bypassDenyReason: string }).bypassDenyReason).toBe('dispute_wrong_job')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('denies bypass when dispute.payment_id is populated but does not match the current payment', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [releasedTranche()],
        dispute: validSplitDispute({ payment_id: 'different-payment-id' }),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount: 300,
        disputeId: DISPUTE_ID,
      }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { bypassDenyReason: string }).bypassDenyReason).toBe('dispute_wrong_payment')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('denies bypass when dispute is not in status=resolved with decision=split', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [releasedTranche()],
        dispute: validSplitDispute({ status: 'open', decision: null }),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount: 300,
        disputeId: DISPUTE_ID,
      }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { bypassDenyReason: string }).bypassDenyReason).toBe('dispute_not_resolved_split')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('denies bypass when the dispute is already settled (replay prevention)', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [releasedTranche()],
        dispute: validSplitDispute({ settlement_status: 'settled' }),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount: 300,
        disputeId: DISPUTE_ID,
      }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { bypassDenyReason: string }).bypassDenyReason).toBe('dispute_already_settled')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('denies bypass when split_ratio is null', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [releasedTranche()],
        dispute: validSplitDispute({ split_ratio: null }),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount: 300,
        disputeId: DISPUTE_ID,
      }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { bypassDenyReason: string }).bypassDenyReason).toBe('dispute_split_ratio_missing')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('denies bypass when amount exceeds the customer share (500 > 300)', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [releasedTranche()],
        dispute: validSplitDispute({ split_ratio: 0.7 }),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount: 500,
        disputeId: DISPUTE_ID,
      }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { bypassDenyReason: string }).bypassDenyReason).toBe('amount_mismatches_customer_share')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('denies bypass when amount is below the exact customer share (no partial-of-partial refunds)', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [releasedTranche()],
        dispute: validSplitDispute({ split_ratio: 0.7 }),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount: 100,
        disputeId: DISPUTE_ID,
      }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { bypassDenyReason: string }).bypassDenyReason).toBe('amount_mismatches_customer_share')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('denies bypass when requested amount is one cent above the customer share (cents-exact comparison)', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [releasedTranche()],
        dispute: validSplitDispute({ split_ratio: 0.7 }),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount: 300.01,
        disputeId: DISPUTE_ID,
      }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { bypassDenyReason: string }).bypassDenyReason).toBe('amount_mismatches_customer_share')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('denies bypass when requested amount is a half cent above the customer share (no major-unit tolerance leak)', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [releasedTranche()],
        dispute: validSplitDispute({ split_ratio: 0.7 }),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount: 300.005,
        disputeId: DISPUTE_ID,
      }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { bypassDenyReason: string }).bypassDenyReason).toBe('amount_mismatches_customer_share')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('denies bypass when plan.currency is missing (server cannot compute smallest-unit share)', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        planCurrency: null,
        tranches: [releasedTranche()],
        dispute: validSplitDispute(),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount: 300,
        disputeId: DISPUTE_ID,
      }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { bypassDenyReason: string }).bypassDenyReason).toBe('plan_currency_missing')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('denies bypass when plan.total_amount is null', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        planTotalAmount: null,
        tranches: [releasedTranche()],
        dispute: validSplitDispute(),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount: 300,
        disputeId: DISPUTE_ID,
      }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { bypassDenyReason: string }).bypassDenyReason).toBe('plan_total_missing')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('denies bypass when disputeId is supplied but amount is missing (no full-refund loophole)', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [releasedTranche()],
        dispute: validSplitDispute(),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({
        paymentIntentId: PAYMENT_INTENT_ID,
        disputeId: DISPUTE_ID,
      }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { bypassDenyReason: string }).bypassDenyReason).toBe('amount_missing')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  // ── Bypass NOT-APPLICABLE for non-release block reasons ───────────────────

  it('denies bypass for non-bypassable reason transfer_reversed even with a valid dispute', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [
          refundSafeTranche({
            status: 'funded',
            external_release_ref: null,
            transfer_reversal_ref: 'trr_mock_reversal_2',
          }),
        ],
        dispute: validSplitDispute(),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount: 300,
        disputeId: DISPUTE_ID,
      }),
      res,
    )

    expect(statusCode()).toBe(409)
    const payload = body() as { reason: string; bypassDenyReason: string }
    expect(payload.reason).toBe('transfer_reversed')
    expect(payload.bypassDenyReason).toBe('bypass_not_applicable')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('denies bypass for non-bypassable reason tranche_status_unknown even with a valid dispute', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [refundSafeTranche({ status: 'some_unknown_status_42' })],
        dispute: validSplitDispute(),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount: 300,
        disputeId: DISPUTE_ID,
      }),
      res,
    )

    expect(statusCode()).toBe(409)
    const payload = body() as { reason: string; bypassDenyReason: string }
    expect(payload.reason).toBe('tranche_status_unknown')
    expect(payload.bypassDenyReason).toBe('bypass_not_applicable')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('denies bypass for non-bypassable reason guard_lookup_failed even with a valid dispute', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        planError: { message: 'lookup failed' },
        dispute: validSplitDispute(),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount: 300,
        disputeId: DISPUTE_ID,
      }),
      res,
    )

    expect(statusCode()).toBe(409)
    const payload = body() as { reason: string; bypassDenyReason: string }
    expect(payload.reason).toBe('guard_lookup_failed')
    expect(payload.bypassDenyReason).toBe('bypass_not_applicable')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('fail-closed on dispute lookup error during bypass check', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [releasedTranche()],
        dispute: null,
        disputeError: { message: 'dispute query failed' },
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount: 300,
        disputeId: DISPUTE_ID,
      }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { bypassDenyReason: string }).bypassDenyReason).toBe('bypass_lookup_failed')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  // ── Operator-only bypass gate ─────────────────────────────────────────────

  it('denies bypass when the caller is authenticated as a customer (not operator)', async () => {
    // Customer knows a valid disputeId but cannot self-service post-release
    // refunds — settlement is an operator-controlled money action.
    // Since C6 this scenario models a split-brain state: payments.status still
    // 'in_escrow' (passes the C6 whitelist) while a tranche is already
    // released — the tranche guard remains the backstop that fires here.
    mockFetchIsOperator.mockResolvedValue(false)
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [releasedTranche()],
        dispute: validSplitDispute({ split_ratio: 0.7 }),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount: 300,
        disputeId: DISPUTE_ID,
      }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { bypassDenyReason: string }).bypassDenyReason).toBe('bypass_operator_only')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  // ── Bypass-ALLOW paths (valid split settlement — operator only) ───────────

  it('allows split refund after prior release when amount matches customer share exactly', async () => {
    mockFetchIsOperator.mockResolvedValue(true)
    // split_ratio=0.75 → customerShare = 1000 * 0.25 = 250 (25000 cents).
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [releasedTranche()],
        dispute: validSplitDispute({ split_ratio: 0.75 }),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount: 250,
        disputeId: DISPUTE_ID,
      }),
      res,
    )

    expect(statusCode()).toBe(200)
    expect((body() as { refunded: boolean }).refunded).toBe(true)
    expect(mockRefundsCreate).toHaveBeenCalledTimes(1)
    const params = mockRefundsCreate.mock.calls[0]?.[0] as {
      payment_intent: string
      amount?: number
      metadata?: Record<string, string>
    }
    expect(params.amount).toBe(25_000)
    expect(params.metadata?.disputeId).toBe(DISPUTE_ID)
  })

  it('allows split refund when dispute.payment_id is legacy NULL (falls back to job linkage)', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [releasedTranche()],
        dispute: validSplitDispute({ payment_id: null }),
      }),
    )

    const { res, statusCode } = makeResponse()
    await handler(
      makeRequest({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount: 300,
        disputeId: DISPUTE_ID,
      }),
      res,
    )

    expect(statusCode()).toBe(200)
    expect(mockRefundsCreate).toHaveBeenCalledTimes(1)
  })

  // ── Allowed pre-release paths (no tranche has moved) ──────────────────────

  it('allows refund when no escrow plan exists yet (pre-funding state)', async () => {
    mockGetSupabaseAdmin.mockReturnValue(makeAdmin({ planId: null }))

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expect(statusCode()).toBe(200)
    expect((body() as { refunded: boolean }).refunded).toBe(true)
    expect(mockRefundsCreate).toHaveBeenCalledTimes(1)
  })

  it('allows refund when all tranches are in safe pre-release states', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [
          refundSafeTranche({ id: TRANCHE_DEPOSIT, status: 'funded' }),
          refundSafeTranche({ id: TRANCHE_FINAL, status: 'eligible_for_release' }),
        ],
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expect(statusCode()).toBe(200)
    expect((body() as { refunded: boolean }).refunded).toBe(true)
    expect(mockRefundsCreate).toHaveBeenCalledTimes(1)
  })

  it('allows cancel path for a requires_capture PaymentIntent when tranches are safe', async () => {
    mockPaymentIntentsRetrieve.mockResolvedValue({
      id: PAYMENT_INTENT_ID,
      status: 'requires_capture',
      currency: 'eur',
    })
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [refundSafeTranche({ status: 'pending_funding' })],
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expect(statusCode()).toBe(200)
    expect((body() as { refunded: boolean }).refunded).toBe(true)
    expect(mockPaymentIntentsCancel).toHaveBeenCalledTimes(1)
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('preserves stable idempotency key on allowed refund retries (no duplicate Stripe refund on double-submit)', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [refundSafeTranche({ status: 'funded' })],
      }),
    )

    const { res: res1 } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res1)
    const { res: res2 } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res2)

    expect(mockRefundsCreate).toHaveBeenCalledTimes(2)
    const firstKey = mockRefundsCreate.mock.calls[0]?.[1]?.idempotencyKey
    const secondKey = mockRefundsCreate.mock.calls[1]?.[1]?.idempotencyKey
    expect(firstKey).toBeDefined()
    expect(firstKey).toBe(secondKey)
    expect(firstKey).toBe(`refund_${PAYMENT_INTENT_ID}_full`)
  })
})

// ── C6: payment-status whitelist for non-operator refunds ────────────────────

describe('/api/refund-escrow — payment-status whitelist (C6)', () => {
  function mockContextWithStatus(paymentStatus: string | null) {
    mockLoadPaymentContext.mockResolvedValue({
      paymentId: PAYMENT_ID,
      paymentIntentId: PAYMENT_INTENT_ID,
      jobId: JOB_ID,
      customerUserId: 'customer-user-id',
      craftsmanUserId: 'craftsman-user-id',
      paymentStatus,
    })
  }

  function expectBlockedByPaymentStatus(
    statusCode: () => number,
    body: () => unknown,
    reason: string,
  ) {
    expect(statusCode()).toBe(409)
    const payload = body() as { code: string; reason: string }
    expect(payload.code).toBe('REFUND_BLOCKED_PAYMENT_STATUS')
    expect(payload.reason).toBe(reason)
    expect(mockPaymentIntentsRetrieve).not.toHaveBeenCalled()
    expect(mockRefundsCreate).not.toHaveBeenCalled()
    expect(mockPaymentIntentsCancel).not.toHaveBeenCalled()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock'

    mockRequireAuth.mockResolvedValue({ ok: true, userId: 'customer-user-id' })
    mockContextWithStatus('in_escrow')
    // Whitelist applies to NON-operators only — default to customer here.
    mockFetchIsOperator.mockResolvedValue(false)
    mockCanRefundEscrowForPayment.mockReturnValue(true)

    mockPaymentIntentsRetrieve.mockResolvedValue({
      id: PAYMENT_INTENT_ID,
      status: 'succeeded',
      currency: 'eur',
    })
    mockPaymentIntentsCancel.mockResolvedValue({ id: PAYMENT_INTENT_ID, status: 'canceled' })
    mockRefundsCreate.mockResolvedValue({ id: 're_mock_refund_1' })
  })

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY
  })

  it('blocks customer refund from work_in_progress even when all tranches are refund-safe (core repro)', async () => {
    // Tranche guard alone would let this through: 'funded'/'locked' are
    // REFUND_SAFE — only the C6 whitelist closes the mid-work hole.
    mockContextWithStatus('work_in_progress')
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [
          refundSafeTranche({ id: TRANCHE_DEPOSIT, status: 'funded' }),
          refundSafeTranche({ id: TRANCHE_FINAL, status: 'locked' }),
        ],
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expectBlockedByPaymentStatus(statusCode, body, 'payment_status_not_refundable')
  })

  it('blocks customer refund from release_pending (whitelist, not !canTransition)', async () => {
    mockContextWithStatus('release_pending')
    mockGetSupabaseAdmin.mockReturnValue(makeAdmin({ tranches: [refundSafeTranche()] }))

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expectBlockedByPaymentStatus(statusCode, body, 'payment_status_not_refundable')
  })

  it('blocks customer refund from disputed (dispute refunds are operator-only)', async () => {
    mockContextWithStatus('disputed')
    mockGetSupabaseAdmin.mockReturnValue(makeAdmin({ tranches: [refundSafeTranche()] }))

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expectBlockedByPaymentStatus(statusCode, body, 'payment_status_not_refundable')
  })

  it('blocks customer refund from diagnosis_payment_pending (operator-only by decision)', async () => {
    mockContextWithStatus('diagnosis_payment_pending')
    mockGetSupabaseAdmin.mockReturnValue(makeAdmin({ tranches: [refundSafeTranche()] }))

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expectBlockedByPaymentStatus(statusCode, body, 'payment_status_not_refundable')
  })

  it('fails closed with payment_status_missing when status is null (drift row)', async () => {
    mockContextWithStatus(null)
    mockGetSupabaseAdmin.mockReturnValue(makeAdmin({ tranches: [refundSafeTranche()] }))

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expectBlockedByPaymentStatus(statusCode, body, 'payment_status_missing')
  })

  it('fails closed for legacy prod status values like "pending"', async () => {
    mockContextWithStatus('pending')
    mockGetSupabaseAdmin.mockReturnValue(makeAdmin({ tranches: [refundSafeTranche()] }))

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expectBlockedByPaymentStatus(statusCode, body, 'payment_status_not_refundable')
  })

  it('allows customer cancel from deposit_paid (pre-work storno stays possible)', async () => {
    mockContextWithStatus('deposit_paid')
    mockPaymentIntentsRetrieve.mockResolvedValue({
      id: PAYMENT_INTENT_ID,
      status: 'requires_capture',
      currency: 'eur',
    })
    mockGetSupabaseAdmin.mockReturnValue(makeAdmin({ tranches: [refundSafeTranche()] }))

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expect(statusCode()).toBe(200)
    expect((body() as { refunded: boolean }).refunded).toBe(true)
    expect(mockPaymentIntentsCancel).toHaveBeenCalledTimes(1)
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('allows customer refund from in_escrow (fully-held funds)', async () => {
    mockContextWithStatus('in_escrow')
    mockGetSupabaseAdmin.mockReturnValue(makeAdmin({ tranches: [refundSafeTranche()] }))

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expect(statusCode()).toBe(200)
    expect((body() as { refunded: boolean }).refunded).toBe(true)
    expect(mockRefundsCreate).toHaveBeenCalledTimes(1)
  })

  it('does not gate operators: refund from work_in_progress with safe tranches succeeds', async () => {
    mockContextWithStatus('work_in_progress')
    mockFetchIsOperator.mockResolvedValue(true)
    mockGetSupabaseAdmin.mockReturnValue(makeAdmin({ tranches: [refundSafeTranche()] }))

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expect(statusCode()).toBe(200)
    expect((body() as { refunded: boolean }).refunded).toBe(true)
    expect(mockRefundsCreate).toHaveBeenCalledTimes(1)
  })

  it('C6 still precedes the tranche-block action: work_in_progress + released tranche → C6 code wins', async () => {
    // P4A reorder: loadRefundGuardState now runs UP FRONT (its plan total/currency
    // feed the consensus-split party authorization that must compute the customer
    // share before the canRefund/C6 gates). So the guard DOES read the plan/tranche
    // rows now — the prior "no tranche reads" assertion no longer holds. The
    // behavioral contract that still matters: C6 fires and RETURNS before the
    // tranche-release block is ever acted on, so a non-operator sees the C6 code
    // (REFUND_BLOCKED_PAYMENT_STATUS), NOT the tranche code, and no Stripe call runs.
    mockContextWithStatus('work_in_progress')
    const admin = makeAdmin({ tranches: [releasedTranche()] })
    mockGetSupabaseAdmin.mockReturnValue(admin)

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expectBlockedByPaymentStatus(statusCode, body, 'payment_status_not_refundable')
    // The C6 code wins over the tranche-release block (which would be the 409
    // REFUND_BLOCKED_RELEASED_TRANCHE if it had been acted on first).
    expect((body() as { code: string }).code).toBe('REFUND_BLOCKED_PAYMENT_STATUS')
  })
})
