/**
 * Release Tranche — Dispute-Split Provider-Quota Math (Patch A2)
 *
 * Validates that api/release-tranche.ts computes the Stripe Transfer amount
 * for a dispute split resolution by accounting for already-released tranches
 * against the provider's split target, so the provider can never receive more
 * than plan.total_amount × splitRatio in total.
 *
 * Scenarios covered:
 *
 *   A. 25% deposit already released, 50/50 split, final tranche:
 *      provider quota exhausted halfway through the final tranche; transfer
 *      is capped so the provider's total ends at 50% (not 62.5%).
 *
 *   B. 25% deposit already released, 75/25 split (75% provider), final:
 *      provider receives 50% of the total in this release so total ends at
 *      75%.
 *
 *   C. alreadyReleased > providerTargetGross (small provider split after
 *      already-larger deposit release): fail-closed with
 *      SPLIT_PROVIDER_QUOTA_EXHAUSTED.
 *
 *   D. No prior release, 50/50 split: provider receives exactly 50% of the
 *      total in a single tranche.
 *
 *   E. Fractional splitRatio with rounding (0.3333): transfer amount is the
 *      smallest-unit rounding of the remaining-quota contribution.
 *
 *   F. Normal (no splitRatio) release: behavior unchanged from pre-patch.
 *
 *   G. Recovery path without splitRatio: unchanged behavior.
 */

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockAuthenticateRequest } = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
}))

const { mockGetSupabaseAdminWithStatus } = vi.hoisted(() => ({
  mockGetSupabaseAdminWithStatus: vi.fn(),
}))

const { mockTransfersCreate, mockPaymentIntentsRetrieve } = vi.hoisted(() => ({
  mockTransfersCreate: vi.fn(),
  mockPaymentIntentsRetrieve: vi.fn(),
}))

vi.mock('../../api/_auth', () => ({
  authenticateRequest: mockAuthenticateRequest,
}))

vi.mock('../../api/_supabase', () => ({
  getSupabaseAdminWithStatus: mockGetSupabaseAdminWithStatus,
  formatAdminUnavailable: (missing: string[]) =>
    missing.length > 0 ? `missing ${missing.join(', ')}.` : 'Supabase credentials missing.',
}))

vi.mock('stripe', () => ({
  default: class MockStripe {
    transfers = { create: mockTransfersCreate }
    paymentIntents = { retrieve: mockPaymentIntentsRetrieve }
  },
}))

vi.mock('../../api/_observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('../../api/_rateLimit', () => ({
  applyRateLimit: vi.fn().mockResolvedValue(false),
}))

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { SupabaseClient } from '@supabase/supabase-js'
import handler from '../../api/release-tranche'

// ── Request / Response helpers ────────────────────────────────────────────────

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

// ── Common test data ──────────────────────────────────────────────────────────

const TRANCHE_FINAL_ID = 'tranche-final-1'
const TRANCHE_DEPOSIT_ID = 'tranche-deposit-1'
const PLAN_ID = 'plan-split-1'
const JOB_ID = 'job-split-1'
const TRANSFER_ID = 'tr_mock_split_transfer'
const DEPOSIT_TRANSFER_ID = 'tr_mock_deposit_transfer'
const CHARGE_ID = 'ch_mock_charge'
const CONNECT_ACCOUNT_ID = 'acct_mock_connect'
const FUNDING_REF = 'pi_mock_funding'

type TrancheRow = {
  id: string
  plan_id?: string
  kind?: string
  status: string
  release_trigger?: string
  released_at: string | null
  external_release_ref: string | null
  transfer_reversal_ref?: string | null
  amount: number
}

function buildFinalTranche(overrides: Partial<TrancheRow> = {}): TrancheRow {
  return {
    id: TRANCHE_FINAL_ID,
    plan_id: PLAN_ID,
    kind: 'final_release',
    status: 'eligible_for_release',
    release_trigger: 'work_completed',
    released_at: null,
    external_release_ref: null,
    amount: 750,
    ...overrides,
  }
}

function buildReleasedDepositSibling(overrides: Partial<TrancheRow> = {}): TrancheRow {
  return {
    id: TRANCHE_DEPOSIT_ID,
    plan_id: PLAN_ID,
    kind: 'deposit_release',
    status: 'released',
    release_trigger: 'work_started',
    released_at: '2026-04-10T10:00:00Z',
    external_release_ref: DEPOSIT_TRANSFER_ID,
    transfer_reversal_ref: null,
    amount: 250,
    ...overrides,
  }
}

// Tests use a 10 % platform fee (netRate = 0.9) because the guard code only
// uses the persisted rate when platform_fee_rate > 0; 10 % also produces
// clean integer cents after toSmallestUnit rounding for every scenario here.
const FUNDED_PLAN = {
  job_id: JOB_ID,
  provider_id: 'provider-db-id',
  customer_user_id: 'customer-user-id',
  external_funding_ref: FUNDING_REF,
  currency: 'EUR',
  platform_fee_rate: 0.1,
  commercial_origin: 'platform_acquired',
  total_amount: 1000,
}

const PROVIDER_ROW = { profile_id: 'provider-user-id' }

const READY_PAYOUT_ACCOUNT = {
  stripe_connect_account_id: CONNECT_ACCOUNT_ID,
  charges_enabled: true,
  payouts_enabled: true,
}

const SUCCEEDED_INTENT = { status: 'succeeded', latest_charge: CHARGE_ID }

const FINALIZED_JOB_ROW = {
  id: JOB_ID,
  status: 'completed',
  commercial_origin: 'platform_acquired',
  attribution_status: 'finalized',
  attribution_dlq_reason: null,
}

type AdminOptions = {
  currentTranche: TrancheRow | null
  siblings?: TrancheRow[]
  siblingsError?: unknown
  plan?: Record<string, unknown> | null
  job?: Record<string, unknown> | null
  dispute?: Record<string, unknown> | null
  rpcResult?: Record<string, unknown> | null
  rpcError?: unknown
  reservationResult?: Record<string, unknown> | null
  reservationError?: unknown
}

// ── Admin mock builder ────────────────────────────────────────────────────────

/**
 * Builds a Supabase admin mock where the handler's single-tranche lookup
 * and sibling-tranches lookup on escrow_tranches both work:
 *   - first `.from('escrow_tranches').select(...)` → chain with .eq(id).eq(plan_id).maybeSingle()
 *   - subsequent `.from('escrow_tranches').select(...)` → chain with .eq(plan_id) awaited as array
 */
function makeAdmin({
  currentTranche,
  siblings = [],
  siblingsError = null as unknown,
  plan = FUNDED_PLAN as Record<string, unknown> | null,
  job = FINALIZED_JOB_ROW,
  dispute = null,
  rpcResult = {
    outcome: 'released',
    plan_status: 'fully_released',
    tranche_count: 2,
    released_count: 2,
  },
  rpcError = null as unknown,
  reservationResult = { outcome: 'reserved', reserved_gross: 1 },
  reservationError = null as unknown,
}: AdminOptions): SupabaseClient {
  let trancheSelectCallCount = 0

  const singleTrancheSelect = () => ({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({ data: currentTranche, error: null }),
      }),
    }),
  })

  const siblingsTrancheSelect = () => ({
    eq: vi.fn().mockResolvedValue({
      data: siblingsError ? null : siblings,
      error: siblingsError ?? null,
    }),
  })

  const trancheSelect = vi.fn().mockImplementation(() => {
    const isFirst = trancheSelectCallCount === 0
    trancheSelectCallCount += 1
    return isFirst ? singleTrancheSelect() : siblingsTrancheSelect()
  })

  const planSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: plan, error: null }),
    }),
  })

  const providerSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: PROVIDER_ROW, error: null }),
    }),
  })

  const payoutSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: READY_PAYOUT_ACCOUNT, error: null }),
    }),
  })

  const jobsSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: job, error: null }),
    }),
  })

  const disputesSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      or: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({ data: dispute, error: null }),
      }),
    }),
  })

  const paymentsSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
  })

  const trancheUpdate = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    }),
  })

  return {
    from: vi.fn((table: string) => {
      if (table === 'escrow_tranches') return { select: trancheSelect, update: trancheUpdate }
      if (table === 'escrow_payment_plans') return { select: planSelect }
      if (table === 'providers') return { select: providerSelect }
      if (table === 'provider_payout_accounts') return { select: payoutSelect }
      if (table === 'jobs') return { select: jobsSelect }
      if (table === 'disputes') return { select: disputesSelect }
      if (table === 'payments') return { select: paymentsSelect }
      return {}
    }),
    rpc: vi.fn().mockImplementation((fn: string) => {
      if (fn === 'reserve_split_release_quota') {
        return Promise.resolve({ data: reservationResult, error: reservationError })
      }
      if (fn === 'release_split_release_reservation') {
        return Promise.resolve({ data: true, error: null })
      }
      return Promise.resolve({ data: rpcResult, error: rpcError })
    }),
  } as unknown as SupabaseClient
}

function makeSplitAdmin(splitRatio: number, options: Omit<AdminOptions, 'dispute'>): SupabaseClient {
  const planTotal = Number((options.plan ?? FUNDED_PLAN)?.total_amount ?? NaN)
  const currentId = options.currentTranche?.id
  const committedGross = (options.siblings ?? [])
    .filter((row) => row.id !== currentId)
    .filter((row) => !row.transfer_reversal_ref)
    .filter((row) => Boolean(row.external_release_ref) || row.status === 'released' || row.status === 'release_pending')
    .reduce((sum, row) => sum + Number(row.amount), 0)
  const providerTargetGross = Number.isFinite(planTotal)
    ? Number((planTotal * splitRatio).toFixed(2))
    : 0
  const remainingGross = Math.max(0, providerTargetGross - committedGross)
  const computedReservation = !Number.isFinite(planTotal) || planTotal <= 0
    ? { outcome: 'plan_total_missing' }
    : remainingGross <= 0
      ? {
          outcome: 'quota_exhausted',
          provider_target_gross: providerTargetGross,
          committed_gross: committedGross,
        }
      : {
          outcome: 'reserved',
          reserved_gross: Math.min(Number(options.currentTranche?.amount ?? 0), remainingGross),
          provider_target_gross: providerTargetGross,
          committed_gross: committedGross,
          idempotent: false,
        }

  return makeAdmin({
    ...options,
    reservationResult: options.reservationResult ?? computedReservation,
    reservationError: options.reservationError ?? options.siblingsError,
    dispute: {
      id: 'dispute-split-1',
      status: 'resolved',
      decision: 'split',
      split_ratio: splitRatio,
      settlement_status: 'pending',
    },
  })
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('/api/release-tranche — dispute-split provider-quota math', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
    process.env.RELEASE_CONFIRM_SECRET = 'secret-mock'
    mockAuthenticateRequest.mockResolvedValue({ ok: true, userId: 'customer-user-id' })
    mockPaymentIntentsRetrieve.mockResolvedValue(SUCCEEDED_INTENT)
    mockTransfersCreate.mockResolvedValue({ id: TRANSFER_ID })
  })

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY
    delete process.env.RELEASE_CONFIRM_SECRET
  })

  function makeRequestWithSecret(body: Record<string, unknown>): VercelRequest {
    return {
      method: 'POST',
      headers: { 'x-release-confirm-secret': 'secret-mock' },
      body,
      url: '/api/release-tranche',
    } as unknown as VercelRequest
  }

  // ── A. 25% released + 50/50 split → quota caps final tranche to 25% ───────

  it('A: caps the final tranche transfer to the remaining provider quota after a prior deposit release (50/50 split)', async () => {
    // total=1000, deposit=250 released, final=750, splitRatio=0.5
    // providerTargetGross = 1000 * 0.5 = 500
    // alreadyReleased = 250
    // remainingQuota = 250
    // effectiveGross = min(750, 250) = 250
    // net = 250 × NET_RATE (0.9) = 225 EUR → 22500 cents
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeSplitAdmin(0.5, {
        currentTranche: buildFinalTranche(),
        siblings: [buildFinalTranche(), buildReleasedDepositSibling()],
      }),
    })

    const { res, statusCode } = makeResponse()
    await handler(
      makeRequestWithSecret({
        trancheId: TRANCHE_FINAL_ID,
        planId: PLAN_ID,
        actor: 'operator',
        splitRatio: 0.5,
      }),
      res,
    )

    expect(statusCode()).toBe(200)
    expect(mockTransfersCreate).toHaveBeenCalledTimes(1)
    const transferParams = mockTransfersCreate.mock.calls[0]?.[0] as { amount: number }
    expect(transferParams.amount).toBe(22_500)
  })

  // ── B. 25% released + 75/25 split → provider total = 75% ──────────────────

  it('B: correct contribution when splitRatio favours provider (0.75) after a prior deposit release', async () => {
    // providerTargetGross = 1000 * 0.75 = 750
    // alreadyReleased = 250
    // remainingQuota = 500
    // effectiveGross = min(750, 500) = 500
    // net = 500 × 0.9 = 450 EUR → 45000 cents
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeSplitAdmin(0.75, {
        currentTranche: buildFinalTranche(),
        siblings: [buildFinalTranche(), buildReleasedDepositSibling()],
      }),
    })

    const { res, statusCode } = makeResponse()
    await handler(
      makeRequestWithSecret({
        trancheId: TRANCHE_FINAL_ID,
        planId: PLAN_ID,
        actor: 'operator',
        splitRatio: 0.75,
      }),
      res,
    )

    expect(statusCode()).toBe(200)
    const transferParams = mockTransfersCreate.mock.calls[0]?.[0] as { amount: number }
    expect(transferParams.amount).toBe(45_000)
  })

  // ── C. alreadyReleased > target → fail-closed ─────────────────────────────

  it('C: fails closed with SPLIT_PROVIDER_QUOTA_EXHAUSTED when prior releases already exceed the split target', async () => {
    // providerTargetGross = 1000 * 0.1 = 100
    // alreadyReleased = 250 (deposit)
    // remainingQuota = max(0, 100 - 250) = 0
    // → no Stripe transfer, 409 + code
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeSplitAdmin(0.1, {
        currentTranche: buildFinalTranche(),
        siblings: [buildFinalTranche(), buildReleasedDepositSibling()],
      }),
    })

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequestWithSecret({
        trancheId: TRANCHE_FINAL_ID,
        planId: PLAN_ID,
        actor: 'operator',
        splitRatio: 0.1,
      }),
      res,
    )

    expect(statusCode()).toBe(409)
    const payload = body() as {
      code: string
      providerTargetGross: number
      alreadyReleasedProviderGross: number
    }
    expect(payload.code).toBe('SPLIT_PROVIDER_QUOTA_EXHAUSTED')
    expect(payload.providerTargetGross).toBe(100)
    expect(payload.alreadyReleasedProviderGross).toBe(250)
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  // ── D. No prior release, 50/50 split → provider gets 50% in one tranche ───

  it('D: no prior release — single-tranche plan receives exactly the split target (50% of total)', async () => {
    // Single-tranche plan: total=1000, tranche gross=1000, splitRatio=0.5
    // providerTargetGross = 500, alreadyReleased = 0, remainingQuota = 500
    // effectiveGross = min(1000, 500) = 500 × 0.9 = 450 → 45000 cents
    const singleTranche = buildFinalTranche({
      id: 'tranche-full-plan',
      kind: 'full_release',
      amount: 1000,
    })
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeSplitAdmin(0.5, {
        currentTranche: singleTranche,
        siblings: [singleTranche],
      }),
    })

    const { res, statusCode } = makeResponse()
    await handler(
      makeRequestWithSecret({
        trancheId: 'tranche-full-plan',
        planId: PLAN_ID,
        actor: 'operator',
        splitRatio: 0.5,
      }),
      res,
    )

    expect(statusCode()).toBe(200)
    const transferParams = mockTransfersCreate.mock.calls[0]?.[0] as { amount: number }
    expect(transferParams.amount).toBe(45_000)
  })

  // ── E. Rounding (0.3333) stays cent-precise via toSmallestUnit ────────────

  it('E: fractional splitRatio rounds via toSmallestUnit; no floating-point overpay', async () => {
    // splitRatio=0.3333 → providerTargetGross = 1000 * 0.3333 = 333.3
    // alreadyReleased = 250 → remainingQuota = 83.3
    // effectiveGross = min(750, 83.3) = 83.3
    // net = Math.round(83.3 * 0.9 * 100) = Math.round(7497) = 7497 cents
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeSplitAdmin(0.3333, {
        currentTranche: buildFinalTranche(),
        siblings: [buildFinalTranche(), buildReleasedDepositSibling()],
      }),
    })

    const { res, statusCode } = makeResponse()
    await handler(
      makeRequestWithSecret({
        trancheId: TRANCHE_FINAL_ID,
        planId: PLAN_ID,
        actor: 'operator',
        splitRatio: 0.3333,
      }),
      res,
    )

    expect(statusCode()).toBe(200)
    const transferParams = mockTransfersCreate.mock.calls[0]?.[0] as { amount: number }
    expect(transferParams.amount).toBe(7_497)
  })

  // ── F. Normal release (no splitRatio) unchanged ───────────────────────────

  it('F: without splitRatio, the transfer uses the full tranche gross unchanged', async () => {
    // No splitRatio → effectiveGross = trancheGross = 750 × 0.9 = 675 → 67500 cents
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        currentTranche: buildFinalTranche(),
        siblings: [buildFinalTranche(), buildReleasedDepositSibling()],
      }),
    })

    const { res, statusCode } = makeResponse()
    await handler(
      makeRequestWithSecret({
        trancheId: TRANCHE_FINAL_ID,
        planId: PLAN_ID,
        actor: 'operator',
      }),
      res,
    )

    expect(statusCode()).toBe(200)
    const transferParams = mockTransfersCreate.mock.calls[0]?.[0] as { amount: number }
    expect(transferParams.amount).toBe(67_500)
  })

  // ── G. Plan total missing → fail-closed ───────────────────────────────────

  it('G: fails closed with SPLIT_PLAN_TOTAL_MISSING when plan.total_amount is null', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeSplitAdmin(0.5, {
        currentTranche: buildFinalTranche(),
        siblings: [buildFinalTranche(), buildReleasedDepositSibling()],
        plan: { ...FUNDED_PLAN, total_amount: null },
      }),
    })

    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequestWithSecret({
        trancheId: TRANCHE_FINAL_ID,
        planId: PLAN_ID,
        actor: 'operator',
        splitRatio: 0.5,
      }),
      res,
    )

    expect(statusCode()).toBe(409)
    expect((body() as { code: string }).code).toBe('SPLIT_PLAN_TOTAL_MISSING')
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  // ── H. Atomic reservation RPC error → fail-closed ─────────────────────────

  it('H: fails closed when the atomic quota reservation errors', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeSplitAdmin(0.5, {
        currentTranche: buildFinalTranche(),
        siblingsError: { message: 'tranches query failed' },
      }),
    })

    const { res, statusCode } = makeResponse()
    await handler(
      makeRequestWithSecret({
        trancheId: TRANCHE_FINAL_ID,
        planId: PLAN_ID,
        actor: 'operator',
        splitRatio: 0.5,
      }),
      res,
    )

    expect(statusCode()).toBe(500)
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  // ── I. Stable idempotency key is preserved for split transfers ────────────

  it('I: preserves stable per-tranche idempotency key on split transfers', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeSplitAdmin(0.5, {
        currentTranche: buildFinalTranche(),
        siblings: [buildFinalTranche(), buildReleasedDepositSibling()],
      }),
    })

    const { res, statusCode } = makeResponse()
    await handler(
      makeRequestWithSecret({
        trancheId: TRANCHE_FINAL_ID,
        planId: PLAN_ID,
        actor: 'operator',
        splitRatio: 0.5,
      }),
      res,
    )

    expect(statusCode()).toBe(200)
    const opts = mockTransfersCreate.mock.calls[0]?.[1] as { idempotencyKey?: string }
    expect(opts.idempotencyKey).toBe(`tranche_release_${TRANCHE_FINAL_ID}`)
  })

  // ── K. Recovery-path sibling (released + no ref) counts as already paid ──

  it('K: counts a sibling in recovery state (status=released, external_release_ref=null) as already-released against the split quota', async () => {
    // Sibling deposit is in recovery state: Stripe succeeded, DB lost the
    // ref. The provider actually holds the 250, so the final tranche must
    // still be capped to 250 (not 500) under 50/50 split.
    const recoveryDeposit = buildReleasedDepositSibling({ external_release_ref: null })
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeSplitAdmin(0.5, {
        currentTranche: buildFinalTranche(),
        siblings: [buildFinalTranche(), recoveryDeposit],
      }),
    })

    const { res, statusCode } = makeResponse()
    await handler(
      makeRequestWithSecret({
        trancheId: TRANCHE_FINAL_ID,
        planId: PLAN_ID,
        actor: 'operator',
        splitRatio: 0.5,
      }),
      res,
    )

    expect(statusCode()).toBe(200)
    // quota = 500 - 250 (recovery still counts) = 250 → 250 × 0.9 = 22500
    const transferParams = mockTransfersCreate.mock.calls[0]?.[0] as { amount: number }
    expect(transferParams.amount).toBe(22_500)
  })

  // ── L. Reversed sibling does NOT count against the quota ──────────────────

  it('L: excludes a sibling with transfer_reversal_ref from alreadyReleased (money was returned to platform)', async () => {
    // Deposit was released and then reversed. Both external_release_ref and
    // transfer_reversal_ref are populated. The reversal means the provider
    // does not hold the 250 anymore, so the full tranche quota (500) is
    // available for the split release.
    const reversedDeposit = buildReleasedDepositSibling({
      transfer_reversal_ref: 'trr_mock_reversal_L',
    })
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeSplitAdmin(0.5, {
        currentTranche: buildFinalTranche(),
        siblings: [buildFinalTranche(), reversedDeposit],
      }),
    })

    const { res, statusCode } = makeResponse()
    await handler(
      makeRequestWithSecret({
        trancheId: TRANCHE_FINAL_ID,
        planId: PLAN_ID,
        actor: 'operator',
        splitRatio: 0.5,
      }),
      res,
    )

    expect(statusCode()).toBe(200)
    // quota = 500 - 0 (reversed excluded) = 500 → min(750, 500) × 0.9 = 45000
    const transferParams = mockTransfersCreate.mock.calls[0]?.[0] as { amount: number }
    expect(transferParams.amount).toBe(45_000)
  })

  // ── M. Sibling in release_pending counts as already-released ──────────────

  it('M: counts a sibling in status=release_pending as already-released even without a Stripe transfer ref', async () => {
    // release_pending means the transfer has been initiated; funds are
    // committed to the provider. Must count against the quota.
    const pendingDeposit = buildReleasedDepositSibling({
      status: 'release_pending',
      external_release_ref: null,
    })
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeSplitAdmin(0.5, {
        currentTranche: buildFinalTranche(),
        siblings: [buildFinalTranche(), pendingDeposit],
      }),
    })

    const { res, statusCode } = makeResponse()
    await handler(
      makeRequestWithSecret({
        trancheId: TRANCHE_FINAL_ID,
        planId: PLAN_ID,
        actor: 'operator',
        splitRatio: 0.5,
      }),
      res,
    )

    expect(statusCode()).toBe(200)
    const transferParams = mockTransfersCreate.mock.calls[0]?.[0] as { amount: number }
    expect(transferParams.amount).toBe(22_500)
  })

  // ── J. Current tranche is NOT counted against its own quota ───────────────

  it('J: excludes the current tranche from alreadyReleased when both single-lookup and siblings return it', async () => {
    // Edge case: the siblings query naturally returns the current tranche too.
    // The filter must exclude it so its own external_release_ref (if any, in
    // a recovery scenario) does not pre-count against the quota.
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeSplitAdmin(0.5, {
        currentTranche: buildFinalTranche(),
        // Include the current tranche in siblings WITHOUT external_release_ref
        // plus the released deposit.
        siblings: [buildFinalTranche(), buildReleasedDepositSibling()],
      }),
    })

    const { res, statusCode } = makeResponse()
    await handler(
      makeRequestWithSecret({
        trancheId: TRANCHE_FINAL_ID,
        planId: PLAN_ID,
        actor: 'operator',
        splitRatio: 0.5,
      }),
      res,
    )

    // providerTargetGross=500, alreadyReleased=250 (deposit only), effective=250.
    // If the filter did NOT exclude the current tranche and it had external_ref,
    // alreadyReleased would be higher. Here external_ref is null so it's moot,
    // but the exclusion rule prevents future recovery-path regressions.
    expect(statusCode()).toBe(200)
    const transferParams = mockTransfersCreate.mock.calls[0]?.[0] as { amount: number }
    expect(transferParams.amount).toBe(22_500)
  })
})
