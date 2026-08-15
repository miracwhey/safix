/**
 * Refund Escrow — P4 Teil A: destination-charge corridor + consensus-party authz
 *
 * Covers the two A-track changes in api/refund-escrow.ts:
 *
 *  A1. CORRIDOR (FUNDING_DESTINATION_CHARGE_ENABLED-gated, dormant today):
 *      - flag OFF                                → no reverse_transfer / no refund_application_fee
 *                                                  (byte-identical to pre-P4; idempotency key unchanged)
 *      - flag ON + destination charge + FULL     → reverse_transfer:true AND refund_application_fee:true
 *      - flag ON + destination charge + PARTIAL  → reverse_transfer:true, refund_application_fee absent
 *      - flag ON + PI WITHOUT transfer_data      → neither (pre-flip inventory self-handles, no Stripe error)
 *      - idempotency key identical across OFF/ON for the same PI+amount
 *      - guard hardening: external_payout_ref set (status still eligible_for_release) → 409 'payout_created'
 *
 *  A2. CONSENSUS-CONFIRMED-PARTY refund authorization (PRE-release only):
 *      - a dispute PARTY (customer OR craftsman) with an 'accepted' two-party split proposal +
 *        exact customer share is allowed past the canRefund-403 (craftsman) and the C6-409 (customer),
 *        reaching the Stripe refund.
 *      - non-matching amount / already-settled / no-proposal (operator-imposed split) / non-party → denied.
 *      - the operator post-release bypass stays operator-only: a consensus party is denied once a tranche
 *        has been released ('payout_created' / 'tranche_released').
 *
 * Mock shapes mirror the REAL producers: escrow_tranches rows carry external_payout_ref (normally null);
 * an 'accepted' dispute_split_proposals row carries confirmed_by populated AND proposed_by <> confirmed_by
 * (confirm_split_proposal is the only writer of accepted rows, and only the NON-proposing party confirms).
 */

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockRequireAuth } = vi.hoisted(() => ({ mockRequireAuth: vi.fn() }))

const { mockGetSupabaseAdmin } = vi.hoisted(() => ({ mockGetSupabaseAdmin: vi.fn() }))

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

vi.mock('../../api/_supabase', () => ({ getSupabaseAdmin: mockGetSupabaseAdmin }))

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

// ── Identifiers ──────────────────────────────────────────────────────────────

const PAYMENT_INTENT_ID = 'pi_corridor_consensus_test'
const PAYMENT_ID = 'payment-db-id'
const JOB_ID = 'job-corridor-1'
const PLAN_ID = 'plan-corridor-1'
const DISPUTE_ID = 'dispute-consensus-1'
const PROPOSAL_ID = 'proposal-consensus-1'
const CONNECT_ACCOUNT = 'acct_destination_1'
const PROVIDER_DB_ID = 'prov-db-1'

const CUSTOMER_UID = 'customer-uid'
const CRAFTSMAN_UID = 'craftsman-profile-uid'
const STRANGER_UID = 'stranger-uid'
const OPERATOR_UID = 'operator-uid'

const PLAN_TOTAL = 1000

// ── Request / Response helpers ────────────────────────────────────────────────

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

// ── Row shapes (mirror the real producers) ───────────────────────────────────

type TrancheRow = {
  id: string
  status: string | null
  external_release_ref: string | null
  transfer_reversal_ref: string | null
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
  customer_profile_id: string | null
  provider_id: string | null
}

type ProposalRow = {
  id: string
  proposed_by: string | null
  confirmed_by: string | null
  status: string | null
}

function safeTranche(overrides: Partial<TrancheRow> = {}): TrancheRow {
  return {
    id: 'tranche-deposit-1',
    status: 'funded',
    external_release_ref: null,
    transfer_reversal_ref: null,
    external_payout_ref: null,
    ...overrides,
  }
}

function releasedTranche(overrides: Partial<TrancheRow> = {}): TrancheRow {
  return {
    id: 'tranche-deposit-1',
    status: 'released',
    external_release_ref: 'tr_mock_1',
    transfer_reversal_ref: null,
    external_payout_ref: null,
    ...overrides,
  }
}

function consensusDispute(overrides: Partial<DisputeRow> = {}): DisputeRow {
  return {
    id: DISPUTE_ID,
    job_id: JOB_ID,
    payment_id: PAYMENT_ID,
    status: 'resolved',
    decision: 'split',
    split_ratio: 0.7,
    settlement_status: 'pending',
    customer_profile_id: CUSTOMER_UID,
    provider_id: PROVIDER_DB_ID,
    ...overrides,
  }
}

function acceptedProposal(overrides: Partial<ProposalRow> = {}): ProposalRow {
  // Genuine two-party agreement: confirmed_by populated AND proposed_by <> confirmed_by.
  return {
    id: PROPOSAL_ID,
    proposed_by: CRAFTSMAN_UID,
    confirmed_by: CUSTOMER_UID,
    status: 'accepted',
    ...overrides,
  }
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
  job = null as { craftsman_user_id: string | null; provider_id: string | null } | null,
  jobError = null as unknown,
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
  job?: { craftsman_user_id: string | null; provider_id: string | null } | null
  jobError?: unknown
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
      maybeSingle: vi.fn().mockResolvedValue({ data: dispute, error: disputeError ?? null }),
    }),
  })

  // .select(...).eq('dispute_id').eq('status','accepted').not('confirmed_by','is',null).limit(1).maybeSingle()
  const proposalSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        not: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: proposal, error: proposalError ?? null }),
          }),
        }),
      }),
    }),
  })

  // Party resolution reads jobs: .select('craftsman_user_id, provider_id').eq('id', jobId).maybeSingle()
  const jobSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: job, error: jobError ?? null }),
    }),
  })

  // Provider resolution reads providers: .select('id, profile_id').in('id', [...]) → array (no maybeSingle).
  const providerSelect = vi.fn().mockReturnValue({
    in: vi.fn().mockResolvedValue({
      data: providerError ? null : provider ? [{ id: PROVIDER_DB_ID, profile_id: provider.profile_id }] : [],
      error: providerError ?? null,
    }),
  })

  return {
    from: vi.fn((table: string) => {
      if (table === 'escrow_payment_plans') return { select: planSelect }
      if (table === 'escrow_tranches') return { select: trancheSelect }
      if (table === 'disputes') return { select: disputeSelect }
      if (table === 'dispute_split_proposals') return { select: proposalSelect }
      if (table === 'jobs') return { select: jobSelect }
      if (table === 'providers') return { select: providerSelect }
      return {}
    }),
  } as unknown as SupabaseClient
}

function setContext(paymentStatus: string) {
  mockLoadPaymentContext.mockResolvedValue({
    paymentId: PAYMENT_ID,
    paymentIntentId: PAYMENT_INTENT_ID,
    jobId: JOB_ID,
    customerUserId: CUSTOMER_UID,
    craftsmanUserId: CRAFTSMAN_UID,
    paymentStatus,
  })
}

function lastRefundParams(): {
  payment_intent: string
  amount?: number
  reverse_transfer?: boolean
  refund_application_fee?: boolean
  metadata?: Record<string, string>
} {
  const calls = mockRefundsCreate.mock.calls
  return calls[calls.length - 1]?.[0] as ReturnType<typeof lastRefundParams>
}

function lastIdempotencyKey(): string | undefined {
  const calls = mockRefundsCreate.mock.calls
  return calls[calls.length - 1]?.[1]?.idempotencyKey as string | undefined
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
  delete process.env.FUNDING_DESTINATION_CHARGE_ENABLED
  // Server consensus kill switch defaults OFF; the A2 consensus-grant block pins
  // it ON per-test. evaluateConsensusSplitParty checks this BEFORE any DB read.
  delete process.env.CONSENSUS_SPLIT_ENABLED

  mockRequireAuth.mockResolvedValue({ ok: true, userId: OPERATOR_UID })
  setContext('in_escrow')
  mockFetchIsOperator.mockResolvedValue(true)
  mockCanRefundEscrowForPayment.mockReturnValue(true)

  mockPaymentIntentsRetrieve.mockResolvedValue({
    id: PAYMENT_INTENT_ID,
    status: 'succeeded',
    currency: 'eur',
  })
  mockPaymentIntentsCancel.mockResolvedValue({ id: PAYMENT_INTENT_ID, status: 'canceled' })
  mockRefundsCreate.mockResolvedValue({ id: 're_mock_1' })
})

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY
  delete process.env.FUNDING_DESTINATION_CHARGE_ENABLED
  delete process.env.CONSENSUS_SPLIT_ENABLED
})

// ── A1. Destination-charge corridor ───────────────────────────────────────────

describe('/api/refund-escrow — P4A destination-charge corridor', () => {
  it('flag OFF: full refund carries NO reverse_transfer and NO refund_application_fee (byte-identical to today)', async () => {
    // Flag unset; even a destination-charge PI must not gain corridor params.
    mockPaymentIntentsRetrieve.mockResolvedValue({
      id: PAYMENT_INTENT_ID,
      status: 'succeeded',
      currency: 'eur',
      transfer_data: { destination: CONNECT_ACCOUNT },
    })
    mockGetSupabaseAdmin.mockReturnValue(makeAdmin({ tranches: [safeTranche()] }))

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expect(statusCode()).toBe(200)
    expect((body() as { refunded: boolean }).refunded).toBe(true)
    const params = lastRefundParams()
    expect(params.reverse_transfer).toBeUndefined()
    expect(params.refund_application_fee).toBeUndefined()
    expect(params.amount).toBeUndefined()
    expect(lastIdempotencyKey()).toBe(`refund_${PAYMENT_INTENT_ID}_full`)
  })

  it('flag ON + destination charge + FULL refund → reverse_transfer:true AND refund_application_fee:true', async () => {
    process.env.FUNDING_DESTINATION_CHARGE_ENABLED = 'true'
    mockPaymentIntentsRetrieve.mockResolvedValue({
      id: PAYMENT_INTENT_ID,
      status: 'succeeded',
      currency: 'eur',
      transfer_data: { destination: CONNECT_ACCOUNT },
    })
    mockGetSupabaseAdmin.mockReturnValue(makeAdmin({ tranches: [safeTranche()] }))

    const { res, statusCode } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expect(statusCode()).toBe(200)
    const params = lastRefundParams()
    expect(params.reverse_transfer).toBe(true)
    expect(params.refund_application_fee).toBe(true)
    expect(params.amount).toBeUndefined()
  })

  it('flag ON + destination charge + PARTIAL (dispute-split) refund → reverse_transfer:true, refund_application_fee absent', async () => {
    process.env.FUNDING_DESTINATION_CHARGE_ENABLED = 'true'
    mockPaymentIntentsRetrieve.mockResolvedValue({
      id: PAYMENT_INTENT_ID,
      status: 'succeeded',
      currency: 'eur',
      transfer_data: { destination: CONNECT_ACCOUNT },
    })
    mockGetSupabaseAdmin.mockReturnValue(makeAdmin({ tranches: [safeTranche()] }))

    const { res, statusCode } = makeResponse()
    // operator caller → C6 skipped; safe tranches → no guard block; amount present → partial.
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID, amount: 300 }), res)

    expect(statusCode()).toBe(200)
    const params = lastRefundParams()
    expect(params.reverse_transfer).toBe(true)
    // Platform keeps its fee on a partial split refund.
    expect(params.refund_application_fee).toBeUndefined()
    expect(params.amount).toBe(30_000)
    expect(lastIdempotencyKey()).toBe(`refund_${PAYMENT_INTENT_ID}_30000`)
  })

  it('flag ON + PI WITHOUT transfer_data (pre-flip inventory) → no reverse_transfer, no refund_application_fee', async () => {
    process.env.FUNDING_DESTINATION_CHARGE_ENABLED = 'true'
    // Separate-charge PI: no transfer_data.destination → corridor stays inert (Stripe would
    // error on reverse_transfer for a plain charge); mixed pre/post-flip inventory self-handles.
    mockPaymentIntentsRetrieve.mockResolvedValue({
      id: PAYMENT_INTENT_ID,
      status: 'succeeded',
      currency: 'eur',
    })
    mockGetSupabaseAdmin.mockReturnValue(makeAdmin({ tranches: [safeTranche()] }))

    const { res, statusCode } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expect(statusCode()).toBe(200)
    const params = lastRefundParams()
    expect(params.reverse_transfer).toBeUndefined()
    expect(params.refund_application_fee).toBeUndefined()
  })

  it('idempotency key is identical across flag OFF and flag ON for the same PI + amount', async () => {
    mockPaymentIntentsRetrieve.mockResolvedValue({
      id: PAYMENT_INTENT_ID,
      status: 'succeeded',
      currency: 'eur',
      transfer_data: { destination: CONNECT_ACCOUNT },
    })
    mockGetSupabaseAdmin.mockReturnValue(makeAdmin({ tranches: [safeTranche()] }))

    // OFF
    delete process.env.FUNDING_DESTINATION_CHARGE_ENABLED
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), makeResponse().res)
    const keyOff = mockRefundsCreate.mock.calls[0]?.[1]?.idempotencyKey

    // ON
    process.env.FUNDING_DESTINATION_CHARGE_ENABLED = 'true'
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), makeResponse().res)
    const keyOn = mockRefundsCreate.mock.calls[1]?.[1]?.idempotencyKey

    expect(keyOff).toBe(`refund_${PAYMENT_INTENT_ID}_full`)
    expect(keyOn).toBe(keyOff)
  })

  it('guard hardening: external_payout_ref set while status still eligible_for_release → 409 payout_created (no refund)', async () => {
    // Post-payout split-brain: payouts.create succeeded but the DB status write lagged.
    // Funds are en route to the provider bank — refund must be blocked.
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [
          safeTranche({ status: 'eligible_for_release', external_payout_ref: 'po_mock_1' }),
        ],
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expect(statusCode()).toBe(409)
    const payload = body() as { code: string; reason: string }
    expect(payload.code).toBe('REFUND_BLOCKED_RELEASED_TRANCHE')
    expect(payload.reason).toBe('payout_created')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })
})

// ── A2. Consensus-confirmed-party authorization (PRE-release) ─────────────────

describe('/api/refund-escrow — P4A consensus-party authorization (pre-release)', () => {
  // Server flag pinned ON for the grant block — the helper denies
  // ('consensus_disabled') BEFORE any DB read while it is OFF (see the dormancy
  // block below for that byte-identical path).
  beforeEach(() => {
    process.env.CONSENSUS_SPLIT_ENABLED = 'true'
  })

  it('customer party + accepted proposal + exact share + payment disputed → allowed past C6 (200)', async () => {
    // Payment status 'disputed' is OUTSIDE the C6 whitelist → without consensus this 409s.
    setContext('disputed')
    mockRequireAuth.mockResolvedValue({ ok: true, userId: CUSTOMER_UID })
    mockFetchIsOperator.mockResolvedValue(false)
    mockCanRefundEscrowForPayment.mockReturnValue(true) // customer owns the payment
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [safeTranche()],
        dispute: consensusDispute({ split_ratio: 0.7 }),
        proposal: acceptedProposal(),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    // split 0.7 → customer share = 1000 * 0.3 = 300 → 30000 minor.
    await handler(
      makeRequest({ paymentIntentId: PAYMENT_INTENT_ID, amount: 300, disputeId: DISPUTE_ID }),
      res,
    )

    expect(statusCode()).toBe(200)
    expect((body() as { refunded: boolean }).refunded).toBe(true)
    expect(mockRefundsCreate).toHaveBeenCalledTimes(1)
    const params = lastRefundParams()
    expect(params.amount).toBe(30_000)
    expect(params.metadata?.disputeId).toBe(DISPUTE_ID)
  })

  it('craftsman confirmer + accepted proposal + exact share → allowed past the canRefund-403 (200)', async () => {
    // Craftsman is not the payment owner → canRefundEscrowForPayment returns false (403 normally).
    setContext('disputed')
    mockRequireAuth.mockResolvedValue({ ok: true, userId: CRAFTSMAN_UID })
    mockFetchIsOperator.mockResolvedValue(false)
    mockCanRefundEscrowForPayment.mockReturnValue(false)
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [safeTranche()],
        dispute: consensusDispute({ split_ratio: 0.7, customer_profile_id: CUSTOMER_UID }),
        // proposed_by <> confirmed_by, craftsman is the confirmer.
        proposal: acceptedProposal({ proposed_by: CUSTOMER_UID, confirmed_by: CRAFTSMAN_UID }),
        // Party resolution for the provider side: providers.profile_id === caller.
        provider: { profile_id: CRAFTSMAN_UID },
      }),
    )

    const { res, statusCode } = makeResponse()
    await handler(
      makeRequest({ paymentIntentId: PAYMENT_INTENT_ID, amount: 300, disputeId: DISPUTE_ID }),
      res,
    )

    expect(statusCode()).toBe(200)
    expect(mockRefundsCreate).toHaveBeenCalledTimes(1)
  })

  it('craftsman bound via jobs.craftsman_user_id (disputes.provider_id NULL) → Route-A party grant (200)', async () => {
    // Route A: the craftsman is bound ONLY through jobs.craftsman_user_id; the
    // dispute carries NO provider_id. confirm_split_proposal admits this craftsman,
    // so the settlement leg must too (the gap the prior helper missed).
    setContext('disputed')
    mockRequireAuth.mockResolvedValue({ ok: true, userId: CRAFTSMAN_UID })
    mockFetchIsOperator.mockResolvedValue(false)
    mockCanRefundEscrowForPayment.mockReturnValue(false)
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [safeTranche()],
        dispute: consensusDispute({ split_ratio: 0.7, provider_id: null }),
        proposal: acceptedProposal({ proposed_by: CUSTOMER_UID, confirmed_by: CRAFTSMAN_UID }),
        // Resolves provider via jobs.craftsman_user_id (Route A), not providers.
        job: { craftsman_user_id: CRAFTSMAN_UID, provider_id: null },
      }),
    )

    const { res, statusCode } = makeResponse()
    await handler(
      makeRequest({ paymentIntentId: PAYMENT_INTENT_ID, amount: 300, disputeId: DISPUTE_ID }),
      res,
    )

    expect(statusCode()).toBe(200)
    expect(mockRefundsCreate).toHaveBeenCalledTimes(1)
  })

  it('plan currency ≠ PI currency on a consensus split → 409 REFUND_BLOCKED_PLAN_CURRENCY_MISMATCH (no refund)', async () => {
    // Consensus authz matches the amount in the plan currency (eur), but the
    // Stripe refund converts in the PI currency. A mismatch makes the minor-unit
    // equality meaningless → the R2 currency assert must block the refund.
    setContext('disputed')
    mockRequireAuth.mockResolvedValue({ ok: true, userId: CUSTOMER_UID })
    mockFetchIsOperator.mockResolvedValue(false)
    mockCanRefundEscrowForPayment.mockReturnValue(true)
    mockPaymentIntentsRetrieve.mockResolvedValue({
      id: PAYMENT_INTENT_ID,
      status: 'succeeded',
      currency: 'usd', // ≠ plan currency 'eur'
    })
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        planCurrency: 'eur',
        tranches: [safeTranche()],
        dispute: consensusDispute({ split_ratio: 0.7 }),
        proposal: acceptedProposal(),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({ paymentIntentId: PAYMENT_INTENT_ID, amount: 300, disputeId: DISPUTE_ID }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { code: string }).code).toBe('REFUND_BLOCKED_PLAN_CURRENCY_MISMATCH')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('non-matching amount → consensus denied → C6 blocks (409, no refund)', async () => {
    setContext('disputed')
    mockRequireAuth.mockResolvedValue({ ok: true, userId: CUSTOMER_UID })
    mockFetchIsOperator.mockResolvedValue(false)
    mockCanRefundEscrowForPayment.mockReturnValue(true)
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [safeTranche()],
        dispute: consensusDispute({ split_ratio: 0.7 }),
        proposal: acceptedProposal(),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    // 250 ≠ exact customer share 300 → consensus rejects → C6 (disputed) blocks.
    await handler(
      makeRequest({ paymentIntentId: PAYMENT_INTENT_ID, amount: 250, disputeId: DISPUTE_ID }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { code: string }).code).toBe('REFUND_BLOCKED_PAYMENT_STATUS')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('already-settled dispute → consensus denied → C6 blocks (409, replay prevention)', async () => {
    setContext('disputed')
    mockRequireAuth.mockResolvedValue({ ok: true, userId: CUSTOMER_UID })
    mockFetchIsOperator.mockResolvedValue(false)
    mockCanRefundEscrowForPayment.mockReturnValue(true)
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [safeTranche()],
        dispute: consensusDispute({ split_ratio: 0.7, settlement_status: 'settled' }),
        proposal: acceptedProposal(),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({ paymentIntentId: PAYMENT_INTENT_ID, amount: 300, disputeId: DISPUTE_ID }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { code: string }).code).toBe('REFUND_BLOCKED_PAYMENT_STATUS')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('non-party knowing disputeId + exact amount → 403 (party-membership enforced)', async () => {
    setContext('disputed')
    mockRequireAuth.mockResolvedValue({ ok: true, userId: STRANGER_UID })
    mockFetchIsOperator.mockResolvedValue(false)
    mockCanRefundEscrowForPayment.mockReturnValue(false) // stranger is not the payment owner
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [safeTranche()],
        dispute: consensusDispute({ split_ratio: 0.7 }),
        proposal: acceptedProposal(),
        provider: { profile_id: CRAFTSMAN_UID }, // not the stranger
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({ paymentIntentId: PAYMENT_INTENT_ID, amount: 300, disputeId: DISPUTE_ID }),
      res,
    )

    expect(statusCode()).toBe(403)
    expect((body() as { error: string }).error).toMatch(/not authorized/)
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('operator-imposed split (NO accepted proposal row) → consensus party denied → C6 blocks', async () => {
    // An operator split produces NO dispute_split_proposals row, so step (2) of the
    // consensus authz never passes — the customer cannot self-drive the refund.
    setContext('disputed')
    mockRequireAuth.mockResolvedValue({ ok: true, userId: CUSTOMER_UID })
    mockFetchIsOperator.mockResolvedValue(false)
    mockCanRefundEscrowForPayment.mockReturnValue(true)
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [safeTranche()],
        dispute: consensusDispute({ split_ratio: 0.7 }),
        proposal: null, // operator-imposed → no proposal
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({ paymentIntentId: PAYMENT_INTENT_ID, amount: 300, disputeId: DISPUTE_ID }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { code: string }).code).toBe('REFUND_BLOCKED_PAYMENT_STATUS')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })

  it('operator path still works on an operator-imposed split (post-release bypass, no proposal needed)', async () => {
    // The operator dispute-split bypass does NOT require a proposal row — only an
    // operator + a resolved=split dispute + exact customer share.
    setContext('disputed')
    mockRequireAuth.mockResolvedValue({ ok: true, userId: OPERATOR_UID })
    mockFetchIsOperator.mockResolvedValue(true)
    mockCanRefundEscrowForPayment.mockReturnValue(true)
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [releasedTranche()], // post-release block (tranche_released)
        dispute: consensusDispute({ split_ratio: 0.7 }),
        proposal: null,
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({ paymentIntentId: PAYMENT_INTENT_ID, amount: 300, disputeId: DISPUTE_ID }),
      res,
    )

    expect(statusCode()).toBe(200)
    expect((body() as { refunded: boolean }).refunded).toBe(true)
    expect(mockRefundsCreate).toHaveBeenCalledTimes(1)
  })

  it('post-release: consensus party is denied (bypass stays operator-only)', async () => {
    // The party authz grants PRE-release, but a released tranche routes through the
    // operator-only bypass. A non-operator consensus party can never self-trigger a
    // payout clawback → bypass_operator_only.
    setContext('disputed')
    mockRequireAuth.mockResolvedValue({ ok: true, userId: CUSTOMER_UID })
    mockFetchIsOperator.mockResolvedValue(false)
    mockCanRefundEscrowForPayment.mockReturnValue(true)
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        tranches: [releasedTranche()],
        dispute: consensusDispute({ split_ratio: 0.7 }),
        proposal: acceptedProposal(),
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({ paymentIntentId: PAYMENT_INTENT_ID, amount: 300, disputeId: DISPUTE_ID }),
      res,
    )

    expect(statusCode()).toBe(409)
    const payload = body() as { code: string; reason: string; bypassDenyReason: string }
    expect(payload.code).toBe('REFUND_BLOCKED_RELEASED_TRANCHE')
    expect(payload.reason).toBe('tranche_released')
    expect(payload.bypassDenyReason).toBe('bypass_operator_only')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
  })
})

// ── A2b. Server-flag dormancy (CONSENSUS_SPLIT_ENABLED unset) ──────────────────

describe('/api/refund-escrow — P4A consensus dormancy (server flag OFF)', () => {
  it('flag unset: an otherwise-valid consensus party is denied (consensus_disabled) BEFORE any dispute read → C6 blocks (409)', async () => {
    // Identical to the customer-party-200 case, EXCEPT CONSENSUS_SPLIT_ENABLED is
    // unset. evaluateConsensusSplitParty returns 'consensus_disabled' before any
    // DB read, so the party never grants and the existing C6 guard blocks the
    // refund — byte-identical to pre-P4 for every existing caller.
    delete process.env.CONSENSUS_SPLIT_ENABLED
    setContext('disputed')
    mockRequireAuth.mockResolvedValue({ ok: true, userId: CUSTOMER_UID })
    mockFetchIsOperator.mockResolvedValue(false)
    mockCanRefundEscrowForPayment.mockReturnValue(true)
    const admin = makeAdmin({
      tranches: [safeTranche()],
      dispute: consensusDispute({ split_ratio: 0.7 }),
      proposal: acceptedProposal(),
    })
    mockGetSupabaseAdmin.mockReturnValue(admin)

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({ paymentIntentId: PAYMENT_INTENT_ID, amount: 300, disputeId: DISPUTE_ID }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { code: string }).code).toBe('REFUND_BLOCKED_PAYMENT_STATUS')
    expect(mockRefundsCreate).not.toHaveBeenCalled()
    // Proven dormant: the consensus helper short-circuited before reading the
    // disputes table at all.
    const fromMock = (admin as unknown as { from: ReturnType<typeof vi.fn> }).from
    expect(fromMock).not.toHaveBeenCalledWith('disputes')
    expect(fromMock).not.toHaveBeenCalledWith('dispute_split_proposals')
  })
})
