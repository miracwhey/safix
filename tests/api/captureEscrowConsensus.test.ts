/**
 * Capture Escrow — P4 Teil A: widened authorization (Option B)
 *
 * capture-escrow's authz is byte-identical for the customer (canCaptureEscrowForPayment
 * is the SOLE customer gate). Only a NON-customer caller is considered for the two
 * widened roles:
 *
 *   - OPERATOR (fetchIsOperator) — trusted for dispute money, NOT flag-gated.
 *   - VALIDATED CONSENSUS DISPUTE-PARTY (shared api/_consensusSplitAuth.ts helper,
 *     requireAmountMatch=false) — gated by the CONSENSUS_SPLIT_ENABLED server flag,
 *     which the helper checks BEFORE any DB read. Capture moves no customer-share
 *     amount, so no amount match is required here.
 *
 * This suite exercises the REAL evaluateConsensusSplitParty helper against a mocked
 * service-role admin client (mock rows mirror the real producers — an 'accepted'
 * dispute_split_proposals row carries confirmed_by populated AND proposed_by <>
 * confirmed_by, the only shape confirm_split_proposal writes), covering:
 *
 *   - customer still allowed (canCapture sole gate)               → 200
 *   - operator allowed (non-customer, NOT flag-gated)             → 200
 *   - validated consensus party allowed, flag ON                  → 200
 *       · provider via providers.profile_id (Route C)
 *       · craftsman via jobs.craftsman_user_id, provider_id NULL (Route A)
 *   - non-party denied                                            → 403
 *   - flag OFF → consensus party denied (dormant, no DB read)     → 403
 *   - legacy path retired unless ALLOW_LEGACY_ESCROW=1            → 410
 */

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockRequireAuth } = vi.hoisted(() => ({ mockRequireAuth: vi.fn() }))

const { mockGetSupabaseAdmin } = vi.hoisted(() => ({ mockGetSupabaseAdmin: vi.fn() }))

const {
  mockLoadPaymentContext,
  mockFetchIsOperator,
  mockCanCaptureEscrowForPayment,
} = vi.hoisted(() => ({
  mockLoadPaymentContext: vi.fn(),
  mockFetchIsOperator: vi.fn(),
  mockCanCaptureEscrowForPayment: vi.fn(),
}))

const { mockPaymentIntentsCapture, mockPaymentIntentsRetrieve } = vi.hoisted(() => ({
  mockPaymentIntentsCapture: vi.fn(),
  mockPaymentIntentsRetrieve: vi.fn(),
}))

vi.mock('../../api/_auth', () => ({ requireAuth: mockRequireAuth }))

vi.mock('../../api/_supabase', () => ({ getSupabaseAdmin: mockGetSupabaseAdmin }))

vi.mock('../../api/_paymentAuth', () => ({
  loadPaymentContext: mockLoadPaymentContext,
  fetchIsOperator: mockFetchIsOperator,
  canCaptureEscrowForPayment: mockCanCaptureEscrowForPayment,
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
      capture: mockPaymentIntentsCapture,
      retrieve: mockPaymentIntentsRetrieve,
    }
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
import handler from '../../api/capture-escrow'

// ── Identifiers ──────────────────────────────────────────────────────────────

const PAYMENT_INTENT_ID = 'pi_capture_consensus_test'
const PAYMENT_ID = 'payment-db-id'
const JOB_ID = 'job-capture-1'
const DISPUTE_ID = 'dispute-capture-1'
const PROPOSAL_ID = 'proposal-capture-1'
const PROVIDER_DB_ID = 'prov-db-1'

const CUSTOMER_UID = 'customer-uid'
const CRAFTSMAN_UID = 'craftsman-profile-uid'
const STRANGER_UID = 'stranger-uid'
const OPERATOR_UID = 'operator-uid'

// ── Request / Response helpers ────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown> = {}): VercelRequest {
  return {
    method: 'POST',
    headers: {},
    body,
    url: '/api/capture-escrow',
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

type JobRow = { craftsman_user_id: string | null; provider_id: string | null }

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
    proposed_by: CUSTOMER_UID,
    confirmed_by: CRAFTSMAN_UID,
    status: 'accepted',
    ...overrides,
  }
}

function makeAdmin({
  dispute = null as DisputeRow | null,
  disputeError = null as unknown,
  proposal = null as ProposalRow | null,
  proposalError = null as unknown,
  job = null as JobRow | null,
  jobError = null as unknown,
  provider = null as { profile_id: string | null } | null,
  providerError = null as unknown,
}: {
  dispute?: DisputeRow | null
  disputeError?: unknown
  proposal?: ProposalRow | null
  proposalError?: unknown
  job?: JobRow | null
  jobError?: unknown
  provider?: { profile_id: string | null } | null
  providerError?: unknown
} = {}): SupabaseClient {
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

  // Provider resolution reads providers: .select('id, profile_id').in('id', [...]) → array.
  const providerSelect = vi.fn().mockReturnValue({
    in: vi.fn().mockResolvedValue({
      data: providerError ? null : provider ? [{ id: PROVIDER_DB_ID, profile_id: provider.profile_id }] : [],
      error: providerError ?? null,
    }),
  })

  return {
    from: vi.fn((table: string) => {
      if (table === 'disputes') return { select: disputeSelect }
      if (table === 'dispute_split_proposals') return { select: proposalSelect }
      if (table === 'jobs') return { select: jobSelect }
      if (table === 'providers') return { select: providerSelect }
      return {}
    }),
  } as unknown as SupabaseClient
}

function setContext(): void {
  mockLoadPaymentContext.mockResolvedValue({
    paymentId: PAYMENT_ID,
    paymentIntentId: PAYMENT_INTENT_ID,
    jobId: JOB_ID,
    customerUserId: CUSTOMER_UID,
    craftsmanUserId: CRAFTSMAN_UID,
    paymentStatus: 'disputed',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // Reach the authz logic: the destination-charge capture path is retired and
  // 410s unless this legacy escape hatch is set.
  process.env.ALLOW_LEGACY_ESCROW = '1'
  process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
  // Server consensus kill switch defaults OFF; the grant tests pin it ON.
  delete process.env.CONSENSUS_SPLIT_ENABLED

  mockRequireAuth.mockResolvedValue({ ok: true, userId: CUSTOMER_UID })
  setContext()
  mockGetSupabaseAdmin.mockReturnValue(makeAdmin())
  mockCanCaptureEscrowForPayment.mockReturnValue(false)
  mockFetchIsOperator.mockResolvedValue(false)
  mockPaymentIntentsCapture.mockResolvedValue({ id: PAYMENT_INTENT_ID, status: 'succeeded' })
})

afterEach(() => {
  delete process.env.ALLOW_LEGACY_ESCROW
  delete process.env.STRIPE_SECRET_KEY
  delete process.env.CONSENSUS_SPLIT_ENABLED
})

// ── Legacy gate (sanity) ──────────────────────────────────────────────────────

describe('/api/capture-escrow — legacy gate', () => {
  it('410s when ALLOW_LEGACY_ESCROW is not set (path retired)', async () => {
    delete process.env.ALLOW_LEGACY_ESCROW
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expect(statusCode()).toBe(410)
    expect((body() as { error: string }).error).toBe('ESCROW_PATH_RETIRED')
    expect(mockPaymentIntentsCapture).not.toHaveBeenCalled()
  })
})

// ── Customer + operator (existing roles) ──────────────────────────────────────

describe('/api/capture-escrow — customer + operator authorization', () => {
  it('customer (canCapture sole gate) → captured (200), consensus never consulted', async () => {
    mockRequireAuth.mockResolvedValue({ ok: true, userId: CUSTOMER_UID })
    mockCanCaptureEscrowForPayment.mockReturnValue(true)

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expect(statusCode()).toBe(200)
    expect((body() as { captured: boolean }).captured).toBe(true)
    expect(mockPaymentIntentsCapture).toHaveBeenCalledTimes(1)
    // Customer is the sole gate — operator + consensus checks are never reached.
    expect(mockFetchIsOperator).not.toHaveBeenCalled()
  })

  it('operator (non-customer, NOT flag-gated) → captured (200)', async () => {
    // Even with the consensus flag OFF, the operator is trusted for dispute money.
    mockRequireAuth.mockResolvedValue({ ok: true, userId: OPERATOR_UID })
    mockCanCaptureEscrowForPayment.mockReturnValue(false)
    mockFetchIsOperator.mockResolvedValue(true)

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID }), res)

    expect(statusCode()).toBe(200)
    expect((body() as { captured: boolean }).captured).toBe(true)
    expect(mockPaymentIntentsCapture).toHaveBeenCalledTimes(1)
  })
})

// ── Consensus party (flag ON) ─────────────────────────────────────────────────

describe('/api/capture-escrow — consensus-party authorization (flag ON)', () => {
  beforeEach(() => {
    process.env.CONSENSUS_SPLIT_ENABLED = 'true'
  })

  it('craftsman confirmer via providers.profile_id (Route C) → captured (200)', async () => {
    mockRequireAuth.mockResolvedValue({ ok: true, userId: CRAFTSMAN_UID })
    mockCanCaptureEscrowForPayment.mockReturnValue(false)
    mockFetchIsOperator.mockResolvedValue(false)
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        dispute: consensusDispute({ split_ratio: 0.7 }),
        proposal: acceptedProposal({ proposed_by: CUSTOMER_UID, confirmed_by: CRAFTSMAN_UID }),
        provider: { profile_id: CRAFTSMAN_UID },
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID, disputeId: DISPUTE_ID }), res)

    expect(statusCode()).toBe(200)
    expect((body() as { captured: boolean }).captured).toBe(true)
    expect(mockPaymentIntentsCapture).toHaveBeenCalledTimes(1)
  })

  it('craftsman bound via jobs.craftsman_user_id, disputes.provider_id NULL (Route A) → captured (200)', async () => {
    // Route A: the craftsman is bound ONLY through jobs.craftsman_user_id. This is
    // the membership the prior helper missed; capture must grant it.
    mockRequireAuth.mockResolvedValue({ ok: true, userId: CRAFTSMAN_UID })
    mockCanCaptureEscrowForPayment.mockReturnValue(false)
    mockFetchIsOperator.mockResolvedValue(false)
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        dispute: consensusDispute({ split_ratio: 0.7, provider_id: null }),
        proposal: acceptedProposal({ proposed_by: CUSTOMER_UID, confirmed_by: CRAFTSMAN_UID }),
        job: { craftsman_user_id: CRAFTSMAN_UID, provider_id: null },
      }),
    )

    const { res, statusCode } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID, disputeId: DISPUTE_ID }), res)

    expect(statusCode()).toBe(200)
    expect(mockPaymentIntentsCapture).toHaveBeenCalledTimes(1)
  })

  it('non-party (knows disputeId) → 403 (party membership enforced, no capture)', async () => {
    mockRequireAuth.mockResolvedValue({ ok: true, userId: STRANGER_UID })
    mockCanCaptureEscrowForPayment.mockReturnValue(false)
    mockFetchIsOperator.mockResolvedValue(false)
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        dispute: consensusDispute({ split_ratio: 0.7 }),
        proposal: acceptedProposal(),
        job: { craftsman_user_id: null, provider_id: PROVIDER_DB_ID },
        provider: { profile_id: CRAFTSMAN_UID }, // not the stranger
      }),
    )

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID, disputeId: DISPUTE_ID }), res)

    expect(statusCode()).toBe(403)
    expect((body() as { error: string }).error).toMatch(/not authorized/)
    expect(mockPaymentIntentsCapture).not.toHaveBeenCalled()
  })

  it('operator-imposed split (NO accepted proposal row) → consensus denied → 403', async () => {
    // No dispute_split_proposals row → the two-party-consensus proof fails, so a
    // non-operator party cannot self-drive the capture leg.
    mockRequireAuth.mockResolvedValue({ ok: true, userId: CRAFTSMAN_UID })
    mockCanCaptureEscrowForPayment.mockReturnValue(false)
    mockFetchIsOperator.mockResolvedValue(false)
    mockGetSupabaseAdmin.mockReturnValue(
      makeAdmin({
        dispute: consensusDispute({ split_ratio: 0.7 }),
        proposal: null,
        provider: { profile_id: CRAFTSMAN_UID },
      }),
    )

    const { res, statusCode } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID, disputeId: DISPUTE_ID }), res)

    expect(statusCode()).toBe(403)
    expect(mockPaymentIntentsCapture).not.toHaveBeenCalled()
  })
})

// ── Server-flag dormancy (flag OFF) ───────────────────────────────────────────

describe('/api/capture-escrow — consensus dormancy (server flag OFF)', () => {
  it('flag unset: an otherwise-valid consensus party is denied (403) BEFORE any dispute read', async () => {
    delete process.env.CONSENSUS_SPLIT_ENABLED
    mockRequireAuth.mockResolvedValue({ ok: true, userId: CRAFTSMAN_UID })
    mockCanCaptureEscrowForPayment.mockReturnValue(false)
    mockFetchIsOperator.mockResolvedValue(false)
    const admin = makeAdmin({
      dispute: consensusDispute({ split_ratio: 0.7 }),
      proposal: acceptedProposal({ proposed_by: CUSTOMER_UID, confirmed_by: CRAFTSMAN_UID }),
      provider: { profile_id: CRAFTSMAN_UID },
    })
    mockGetSupabaseAdmin.mockReturnValue(admin)

    const { res, statusCode } = makeResponse()
    await handler(makeRequest({ paymentIntentId: PAYMENT_INTENT_ID, disputeId: DISPUTE_ID }), res)

    expect(statusCode()).toBe(403)
    expect(mockPaymentIntentsCapture).not.toHaveBeenCalled()
    // Dormant: the consensus helper short-circuited before any DB read.
    const fromMock = (admin as unknown as { from: ReturnType<typeof vi.fn> }).from
    expect(fromMock).not.toHaveBeenCalledWith('disputes')
    expect(fromMock).not.toHaveBeenCalledWith('dispute_split_proposals')
  })
})
