/**
 * Release Tranche — Payout Handoff Guards
 *
 * Validates that api/release-tranche.ts:
 *
 * A. Returns 500 when STRIPE_SECRET_KEY is not configured
 * B. Returns 409 when tranche status is not eligible for release
 * C. Returns 200 (idempotent) when tranche is already released
 * D. Returns 409 when provider has no Stripe Connect account
 * E. Returns 409 when provider chargesEnabled=false
 * F. Returns 409 when provider payoutsEnabled=false
 * G. Returns 409 when escrow plan has no external_funding_ref
 * H. Returns 409 when funding PaymentIntent is not in succeeded state
 * I. Returns 502 when Stripe transfer creation fails
 * J. Returns 200 with Transfer ID when everything succeeds
 * K. Stores Transfer ID as external_release_ref (not request-body value)
 * L. Updates plan rollup status on success
 */

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

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

vi.mock('../../api/_subscriptionAuth', () => ({
  requireProEntitlement: vi.fn().mockResolvedValue({ ok: true }),
}))

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { SupabaseClient } from '@supabase/supabase-js'
import handler from '../../api/release-tranche'

// ── Request / Response helpers ────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown> = {}): VercelRequest {
  return {
    method: 'POST',
    headers: {},
    body,
    url: '/api/release-tranche',
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

// ── DB mock builder ──────────────────────────────────────────────────────────

/**
 * Default finalized job row returned for the attribution gate lookup.  The
 * gate requires attribution_status='finalized' AND a valid commercial_origin.
 * Tests that exercise non-finalized paths override `job` explicitly.
 */
const FINALIZED_JOB_ROW = {
  id: 'job-123',
  commercial_origin: 'platform_acquired',
  attribution_status: 'finalized',
  attribution_dlq_reason: null,
}

/**
 * Builds a minimal Supabase admin mock that returns the provided rows for
 * each table. The atomic release RPC is mocked via the `rpcResult` / `rpcError`
 * parameters (replacing the former trancheUpdateError / planUpdateError).
 */
function makeAdmin({
  tranche,
  plan,
  provider,
  payoutAccount,
  profiles,
  job = FINALIZED_JOB_ROW,
  jobError = null,
  dispute = null,
  payment = null,
  rpcResult = { outcome: 'released', plan_status: 'fully_released', tranche_count: 1, released_count: 1 },
  rpcError = null,
  reservationResult,
  reservationError = null,
}: {
  tranche?: Record<string, unknown> | null
  plan?: Record<string, unknown> | null
  provider?: Record<string, unknown> | null
  payoutAccount?: Record<string, unknown> | null
  profiles?: Record<string, unknown> | null
  job?: Record<string, unknown> | null
  jobError?: unknown
  dispute?: Record<string, unknown> | null
  payment?: Record<string, unknown> | null
  rpcResult?: Record<string, unknown> | null
  rpcError?: unknown
  reservationResult?: Record<string, unknown> | null
  reservationError?: unknown
}): SupabaseClient {
  const trancheSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({ data: tranche ?? null, error: null }),
      }),
    }),
  })

  const planSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: plan ?? null, error: null }),
    }),
  })

  const providerSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: provider ?? null, error: null }),
    }),
  })

  const payoutSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: payoutAccount ?? null, error: null }),
    }),
  })

  // The jobs table is hit twice in the happy path:
  //   1. Stale-tranche reconciliation reads jobs.status
  //   2. Attribution guard reads commercial_origin + attribution_status
  // Both use .eq(...).maybeSingle().  The mock returns `job` for every call
  // (including the reconciliation path, where status='in_progress' satisfies
  // the trigger check).
  const jobsReconcilePayload = { status: 'in_progress' }
  const jobsMerged = { ...jobsReconcilePayload, ...(job ?? {}) }
  const jobsSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({
        data: job === null ? null : jobsMerged,
        error: jobError ?? null,
      }),
    }),
  })

  const disputesSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      or: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({ data: dispute ?? null, error: null }),
      }),
    }),
  })

  const paymentsSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: payment ?? null, error: null }),
    }),
  })

  const trancheUpdate = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    }),
  })

  // Table dispatch
  const admin = {
    from: vi.fn((table: string) => {
      if (table === 'escrow_tranches') return { select: trancheSelect, update: trancheUpdate }
      if (table === 'escrow_payment_plans') return { select: planSelect }
      if (table === 'providers') return { select: providerSelect }
      if (table === 'provider_payout_accounts') return { select: payoutSelect }
      if (table === 'jobs') return { select: jobsSelect }
      if (table === 'disputes') return { select: disputesSelect }
      if (table === 'payments') return { select: paymentsSelect }
      if (table === 'profiles') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: profiles ?? null, error: null }),
              }),
            }),
          }),
        }
      }
      return {}
    }),
    // Atomic split reservation runs before Stripe; the release/ledger RPC runs
    // after the idempotent Stripe movement.
    rpc: vi.fn().mockImplementation((fn: string) => {
      if (fn === 'reserve_split_release_quota') {
        return Promise.resolve({
          data: reservationResult ?? {
            outcome: 'reserved',
            reserved_gross: Number(tranche?.amount ?? 0),
            provider_target_gross: Number(plan?.total_amount ?? 0),
            committed_gross: 0,
          },
          error: reservationError,
        })
      }
      if (fn === 'release_split_release_reservation') {
        return Promise.resolve({ data: true, error: null })
      }
      return Promise.resolve({ data: rpcResult, error: rpcError })
    }),
  } as unknown as SupabaseClient
  return admin
}

// ── Common test data ──────────────────────────────────────────────────────────

const TRANCHE_ID = 'tranche-abc-123'
const PLAN_ID = 'plan-abc-123'
const TRANSFER_ID = 'tr_mock_transfer_id'
const CHARGE_ID = 'ch_mock_charge_id'
const CONNECT_ACCOUNT_ID = 'acct_mock_connect'
const FUNDING_REF = 'pi_mock_funding_ref'

const ELIGIBLE_TRANCHE = {
  id: TRANCHE_ID,
  plan_id: PLAN_ID,
  kind: 'deposit_release',
  status: 'eligible_for_release',
  released_at: null,
  external_release_ref: null,
  amount: 250.00, // €250 gross (25% of €1000 plan)
}

const JOB_ID = 'job-123'

const FUNDED_PLAN = {
  job_id: JOB_ID,
  provider_id: 'provider-db-id',
  customer_user_id: 'user-123',
  external_funding_ref: FUNDING_REF,
  currency: 'EUR',
  platform_fee_rate: null,
  commercial_origin: null,
}

const PROVIDER_ROW = {
  profile_id: 'provider-user-id',
}

const READY_PAYOUT_ACCOUNT = {
  stripe_connect_account_id: CONNECT_ACCOUNT_ID,
  charges_enabled: true,
  payouts_enabled: true,
}

const SUCCEEDED_INTENT = {
  status: 'succeeded',
  latest_charge: CHARGE_ID,
}

const BASE_BODY = {
  trancheId: TRANCHE_ID,
  planId: PLAN_ID,
  actor: 'customer',
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('/api/release-tranche', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
    process.env.RELEASE_CONFIRM_SECRET = undefined as unknown as string
    mockAuthenticateRequest.mockResolvedValue({ ok: true, userId: 'user-123' })
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
      }),
    })
    mockPaymentIntentsRetrieve.mockResolvedValue(SUCCEEDED_INTENT)
    mockTransfersCreate.mockResolvedValue({ id: TRANSFER_ID })
  })

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY
    delete process.env.RELEASE_CONFIRM_SECRET
  })

  // ── A. Stripe key missing ──────────────────────────────────────────────────
  it('A: returns 500 when STRIPE_SECRET_KEY is not configured', async () => {
    delete process.env.STRIPE_SECRET_KEY
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(500)
    expect((body() as { error: string }).error).toMatch(/Stripe secret key/)
  })

  // ── B. Tranche not in eligible state ──────────────────────────────────────
  it('B: returns 409 when tranche status is funded (not eligible)', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: { ...ELIGIBLE_TRANCHE, status: 'funded' },
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(409)
    expect((body() as { currentStatus: string }).currentStatus).toBe('funded')
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  // ── C. Already released (idempotent) ──────────────────────────────────────
  it('C: returns 200 idempotent when tranche is already released', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: {
          ...ELIGIBLE_TRANCHE,
          status: 'released',
          released_at: '2026-04-11T10:00:00Z',
          external_release_ref: TRANSFER_ID,
        },
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(200)
    expect((body() as { idempotent: boolean }).idempotent).toBe(true)
    expect((body() as { externalReleaseRef: string }).externalReleaseRef).toBe(TRANSFER_ID)
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  // ── D. Provider has no Connect account ────────────────────────────────────
  it('D: returns 409 when provider has no Stripe Connect account', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: { stripe_connect_account_id: null, charges_enabled: false, payouts_enabled: false },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(409)
    expect((body() as { code: string }).code).toBe('PROVIDER_NOT_PAYOUT_READY')
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  // ── E. chargesEnabled false ───────────────────────────────────────────────
  it('E: returns 409 when charges_enabled is false', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: { ...READY_PAYOUT_ACCOUNT, charges_enabled: false },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(409)
    expect((body() as { code: string }).code).toBe('PROVIDER_NOT_PAYOUT_READY')
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  // ── F. payoutsEnabled false ───────────────────────────────────────────────
  it('F: returns 409 when payouts_enabled is false', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: { ...READY_PAYOUT_ACCOUNT, payouts_enabled: false },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(409)
    expect((body() as { code: string }).code).toBe('PROVIDER_NOT_PAYOUT_READY')
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  // ── G. No external_funding_ref on plan ────────────────────────────────────
  it('G: returns 409 when escrow plan has no external_funding_ref', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: { ...FUNDED_PLAN, external_funding_ref: null },
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(409)
    expect((body() as { code: string }).code).toBe('MISSING_FUNDING_REF')
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  // ── H. PI not in succeeded state ─────────────────────────────────────────
  it('H: returns 409 when funding PI is not succeeded (e.g. requires_capture)', async () => {
    mockPaymentIntentsRetrieve.mockResolvedValue({
      status: 'requires_capture',
      latest_charge: null,
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(409)
    expect((body() as { code: string }).code).toBe('INTENT_NOT_CAPTURED')
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  // ── I. Transfer fails ────────────────────────────────────────────────────
  it('I: returns 502 when Stripe transfer creation fails', async () => {
    mockTransfersCreate.mockRejectedValue(new Error('Stripe: insufficient_funds'))
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(502)
    expect((body() as { error: string }).error).toMatch(/transfer failed/i)
  })

  // ── J. Success path ───────────────────────────────────────────────────────
  it('J: returns 200 with Transfer ID on full success', async () => {
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(200)
    const result = body() as Record<string, unknown>
    expect(result.status).toBe('released')
    expect(result.externalReleaseRef).toBe(TRANSFER_ID)
    expect(result.trancheId).toBe(TRANCHE_ID)
    expect(result.planId).toBe(PLAN_ID)
  })

  // ── K. Transfer ID is server-generated, not taken from request body ────────
  it('K: Transfer ID in response is from Stripe, not from request body', async () => {
    const { res, statusCode, body } = makeResponse()
    await handler(
      makeRequest({ ...BASE_BODY, externalReleaseRef: 'caller_provided_ref' }),
      res,
    )
    expect(statusCode()).toBe(200)
    // Must be the Stripe transfer ID, not the caller-provided value
    expect((body() as { externalReleaseRef: string }).externalReleaseRef).toBe(TRANSFER_ID)
    expect((body() as { externalReleaseRef: string }).externalReleaseRef).not.toBe('caller_provided_ref')
  })

  // ── L. Transfer idempotency key format ───────────────────────────────────
  it('L: uses stable idempotency key derived from trancheId', async () => {
    await handler(makeRequest(BASE_BODY), makeResponse().res)
    expect(mockTransfersCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: CONNECT_ACCOUNT_ID,
        source_transaction: CHARGE_ID,
      }),
      expect.objectContaining({
        idempotencyKey: `tranche_release_${TRANCHE_ID}`,
      }),
    )
  })

  // ── M. Transfer amount is net (gross × 0.91) ─────────────────────────────
  it('M: transfer amount is 91% of tranche gross in smallest unit (9% default fee)', async () => {
    await handler(makeRequest(BASE_BODY), makeResponse().res)
    // Tranche gross = €250.00; fee = 9% (no commercial_origin on plan); net = €227.50; in cents = 22750
    expect(mockTransfersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 22750, currency: 'eur' }),
      expect.anything(),
    )
  })

  // ── M2. Transfer uses persisted platform_fee_rate when present ────────────
  it('M2: uses persisted 5% fee rate from plan instead of default', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: {
          ...FUNDED_PLAN,
          platform_fee_rate: 0.05,
          commercial_origin: 'merchant_brought',
        },
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
      }),
    })
    mockPaymentIntentsRetrieve.mockResolvedValue(SUCCEEDED_INTENT)
    mockTransfersCreate.mockResolvedValue({ id: TRANSFER_ID })

    await handler(makeRequest(BASE_BODY), makeResponse().res)
    // Tranche gross = €250.00; fee = 5% (merchant_brought); net = €237.50; in cents = 23750
    expect(mockTransfersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 23750, currency: 'eur' }),
      expect.anything(),
    )
  })

  // ── N. Valid actor values: customer, provider, operator, system ─────────────
  // Unknown actor values fall back to 'system' (no hard 400 rejection).
  it('N: provider actor is accepted — release proceeds normally', async () => {
    // beforeEach already sets up full happy-path mocks (eligible tranche, funded plan, etc.)
    const { res, statusCode } = makeResponse()
    await handler(makeRequest({ ...BASE_BODY, actor: 'provider' }), res)
    expect(statusCode()).toBe(200)
    expect(mockTransfersCreate).toHaveBeenCalled()
  })

  // ── O. Provider authorization via providers.profile_id resolution ────────
  // The provider's auth.users.id (profile_id) differs from providers.id (DB PK).
  // Authorization must resolve providers.profile_id to compare against the JWT caller.
  it('O: provider-authenticated user (profile_id match) passes authorization', async () => {
    // Authenticate as the provider (profile_id), NOT the customer
    mockAuthenticateRequest.mockResolvedValue({ ok: true, userId: 'provider-user-id' })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ ...BASE_BODY, actor: 'provider' }), res)
    expect(statusCode()).toBe(200)
    expect((body() as Record<string, unknown>).status).toBe('released')
    expect(mockTransfersCreate).toHaveBeenCalled()
  })

  // ── P. Unrelated user rejected (not customer, not provider, not operator) ─
  it('P: unrelated user who is neither customer nor provider nor operator gets 403', async () => {
    mockAuthenticateRequest.mockResolvedValue({ ok: true, userId: 'random-unrelated-user' })
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        profiles: { is_operator: false },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(403)
    expect((body() as { error: string }).error).toMatch(/not authorized/)
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  // ── R. Released without external_release_ref → healing path succeeds ────────
  // When tranche.status='released' but external_release_ref is null, the prior
  // DB write failed after a successful Stripe Transfer. The server must NOT
  // return 409 forever. It re-issues the Stripe transfer with the same
  // idempotency key (returns existing transfer, no duplicate), persists the
  // Transfer ID, and returns 200 with healedInconsistency=true.
  it('R: released+null-ref triggers healing path → 200 with healedInconsistency', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: {
          ...ELIGIBLE_TRANCHE,
          status: 'released',
          released_at: '2026-04-11T10:00:00Z',
          external_release_ref: null,
        },
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(200)
    const payload = body() as {
      status?: string
      externalReleaseRef?: string
      healedInconsistency?: boolean
    }
    expect(payload.status).toBe('released')
    expect(payload.externalReleaseRef).toBe(TRANSFER_ID)
    expect(payload.healedInconsistency).toBe(true)
    // Stripe transfer called with stable idempotency key — returns existing
    // transfer without duplication.
    expect(mockTransfersCreate).toHaveBeenCalledTimes(1)
    expect(mockTransfersCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: `tranche_release_${TRANCHE_ID}` }),
    )
  })

  // ── T. Healing path: Stripe fails → 502 (retryable) ──────────────────────
  // When the healing attempt for released+null-ref cannot retrieve/create the
  // Stripe transfer, the server returns 502. The state is still inconsistent
  // but the caller can retry — the idempotency key prevents double-transfer.
  it('T: released+null-ref healing path returns 502 when Stripe transfer fails', async () => {
    mockTransfersCreate.mockRejectedValue(new Error('Stripe: network error'))
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: {
          ...ELIGIBLE_TRANCHE,
          status: 'released',
          released_at: '2026-04-11T10:00:00Z',
          external_release_ref: null,
        },
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(502)
    expect((body() as { error: string }).error).toMatch(/transfer failed/i)
    expect(mockTransfersCreate).toHaveBeenCalledTimes(1)
  })

  // ── S. DB write fails after successful Stripe Transfer ─────────────────────
  // The Connect Transfer has executed (money moved), but the canonical
  // Supabase row could not be updated. The server returns 500 with the
  // Transfer ID AND requiresReconciliation=true so the client knows money
  // moved but state is inconsistent. Operator must reconcile manually.
  it('S: returns 500 with requiresReconciliation when atomic DB write fails after transfer success', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        rpcResult: null,
        rpcError: { message: 'simulated DB failure' },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(500)
    const payload = body() as {
      error?: string
      externalReleaseRef?: string
      requiresReconciliation?: boolean
    }
    expect(payload.error).toBe('DB_WRITE_FAILED')
    expect(payload.externalReleaseRef).toBe(TRANSFER_ID)
    expect(payload.requiresReconciliation).toBe(true)
    // Transfer was attempted exactly once (idempotency key prevents duplicates)
    expect(mockTransfersCreate).toHaveBeenCalledTimes(1)
  })


  // ── Q. Provider authorization fails if profile_id doesn't match ──────────
  // Ensures the fix actually resolves profile_id, not providers.id
  it('Q: user whose ID matches providers.id (DB PK) but NOT profile_id gets 403', async () => {
    // Authenticate as providers.id (DB PK) — this was the old broken comparison
    mockAuthenticateRequest.mockResolvedValue({ ok: true, userId: 'provider-db-id' })
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        profiles: { is_operator: false },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ ...BASE_BODY, actor: 'provider' }), res)
    expect(statusCode()).toBe(403)
    expect((body() as { error: string }).error).toMatch(/not authorized/)
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  // ──────────────────────────────────────────────────────────────────────────
  //  Attribution Gate (Block 1 — Attribution Hardening)
  //  release-tranche MUST enforce jobs.attribution_status='finalized' + valid
  //  commercial_origin before any Stripe call.  Parity with create-escrow.
  // ──────────────────────────────────────────────────────────────────────────

  // ── AG1. Attribution pending → 402 retryable, no Stripe call ──────────────
  it('AG1: returns 402 PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED when attribution_status=pending', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        job: {
          id: JOB_ID,
          commercial_origin: null,
          attribution_status: 'pending',
          attribution_dlq_reason: null,
        },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(402)
    const payload = body() as { error: string; retryable: boolean; jobId: string }
    expect(payload.error).toBe('PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED')
    expect(payload.retryable).toBe(true)
    expect(payload.jobId).toBe(JOB_ID)
    expect(mockPaymentIntentsRetrieve).not.toHaveBeenCalled()
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  // ── AG2. Attribution retrying → 402 retryable, no Stripe call ─────────────
  it('AG2: returns 402 PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED when attribution_status=retrying', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        job: {
          id: JOB_ID,
          commercial_origin: null,
          attribution_status: 'retrying',
          attribution_dlq_reason: null,
        },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(402)
    const payload = body() as { error: string; retryable: boolean }
    expect(payload.error).toBe('PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED')
    expect(payload.retryable).toBe(true)
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  // ── AG3. Attribution DLQ → 402 non-retryable with reason ──────────────────
  it('AG3: returns 402 PAYMENT_BLOCKED_ATTRIBUTION_DLQ with dlqReason when status=dlq', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        job: {
          id: JOB_ID,
          commercial_origin: null,
          attribution_status: 'dlq',
          attribution_dlq_reason: 'MAX_RETRY_EXCEEDED',
        },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(402)
    const payload = body() as { error: string; retryable: boolean; dlqReason: string }
    expect(payload.error).toBe('PAYMENT_BLOCKED_ATTRIBUTION_DLQ')
    expect(payload.retryable).toBe(false)
    expect(payload.dlqReason).toBe('MAX_RETRY_EXCEEDED')
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  // ── AG4. Attribution finalized but origin invalid → 402 ───────────────────
  it('AG4: returns 402 PAYMENT_BLOCKED_ATTRIBUTION_INVALID when finalized with bad origin', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        job: {
          id: JOB_ID,
          commercial_origin: null, // finalized + null is the invariant violation
          attribution_status: 'finalized',
          attribution_dlq_reason: null,
        },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(402)
    const payload = body() as { error: string; retryable: boolean }
    expect(payload.error).toBe('PAYMENT_BLOCKED_ATTRIBUTION_INVALID')
    expect(payload.retryable).toBe(false)
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  // ── AG5. Job missing → 402 JOB_NOT_FOUND ──────────────────────────────────
  it('AG5: returns 402 PAYMENT_BLOCKED_JOB_NOT_FOUND when jobs row is absent', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        job: null,
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(402)
    expect((body() as { error: string }).error).toBe('PAYMENT_BLOCKED_JOB_NOT_FOUND')
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  // ── AG6. Attribution lookup DB error → 500, release blocked ───────────────
  it('AG6: returns 500 ATTRIBUTION_LOOKUP_FAILED when attribution query fails', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        job: null,
        jobError: { message: 'connection reset' },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(500)
    expect((body() as { error: string }).error).toBe('ATTRIBUTION_LOOKUP_FAILED')
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  // ── AG7. Plan has no job_id → 402 JOB_NOT_FOUND (fail-closed) ─────────────
  // A plan without job_id can never be verified.  The guard MUST block; this
  // prevents a data-corruption escape route from reaching Stripe.
  it('AG7: returns 402 when escrow_payment_plan has no job_id (fail-closed)', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: { ...FUNDED_PLAN, job_id: null },
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(402)
    expect((body() as { error: string }).error).toBe('PAYMENT_BLOCKED_JOB_NOT_FOUND')
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  // ── AG8. Recovery path (released+null-ref) BYPASSES attribution gate ──────
  // A prior DB write failed after a successful Stripe Transfer.  Money already
  // moved.  The recovery path exists solely to persist the missing Transfer ID.
  // Blocking it on attribution would leave the DB permanently inconsistent.
  it('AG8: recovery path with pending attribution still heals (transfer already executed)', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: {
          ...ELIGIBLE_TRANCHE,
          status: 'released',
          released_at: '2026-04-11T10:00:00Z',
          external_release_ref: null,
        },
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        job: {
          id: JOB_ID,
          commercial_origin: null,
          attribution_status: 'pending',
          attribution_dlq_reason: null,
        },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(200)
    const payload = body() as { healedInconsistency?: boolean }
    expect(payload.healedInconsistency).toBe(true)
    expect(mockTransfersCreate).toHaveBeenCalledTimes(1)
  })

  // ──────────────────────────────────────────────────────────────────────────
  //  TOCTOU Drift — DB-defense trigger fires AFTER a successful Stripe Transfer.
  //  This is the split-brain window: app-guard passed, Stripe moved money,
  //  then attribution transitioned (e.g. operator moved job to DLQ
  //  concurrently).  Response shape must surface `attributionDrift: true` so
  //  operator reconciliation kicks in, and a distinct Sentry event is emitted.
  // ──────────────────────────────────────────────────────────────────────────

  it('AG9: detects SQLSTATE P0004 from the DB trigger and flags attributionDrift', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        rpcResult: null,
        rpcError: {
          code: 'P0004',
          message: 'ATTRIBUTION_NOT_FINALIZED: dlq',
        },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(500)
    const payload = body() as {
      error?: string
      externalReleaseRef?: string
      requiresReconciliation?: boolean
      attributionDrift?: boolean
    }
    expect(payload.error).toBe('DB_WRITE_FAILED')
    expect(payload.externalReleaseRef).toBe(TRANSFER_ID)
    expect(payload.requiresReconciliation).toBe(true)
    expect(payload.attributionDrift).toBe(true)
    expect(mockTransfersCreate).toHaveBeenCalledTimes(1)
  })

  it('AG10: detects ATTRIBUTION_NOT_FINALIZED message even without SQLSTATE code', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        rpcResult: null,
        rpcError: {
          code: undefined,
          message: 'ATTRIBUTION_NOT_FINALIZED: unresolved',
        },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(500)
    const payload = body() as { attributionDrift?: boolean }
    expect(payload.attributionDrift).toBe(true)
  })

  it('AG11: non-drift DB error does NOT set attributionDrift', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        rpcResult: null,
        rpcError: { code: '40001', message: 'serialization_failure' },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(500)
    const payload = body() as { error?: string; attributionDrift?: boolean }
    expect(payload.error).toBe('DB_WRITE_FAILED')
    expect(payload.attributionDrift).toBeUndefined()
  })

  // ── DI. Dispute blocking (active states + resolved refund, C5) ─────────────
  // The PostgREST .or() filter string IS the contract: the mock does not filter
  // rows itself.  A resolved+reject dispute is NOT returned by the server-side
  // filter (reject settlement releases money to the provider via this very
  // endpoint — blocking it would deadlock the reject leg); the happy-path
  // cases (dispute=null) cover that branch.
  it('DI1: returns 409 DISPUTE_BLOCKING with decision for resolved+refund dispute', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        dispute: { id: 'dispute-1', status: 'resolved', decision: 'refund' },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(409)
    const payload = body() as Record<string, unknown>
    expect(payload.error).toBe('DISPUTE_BLOCKING')
    expect(payload.disputeId).toBe('dispute-1')
    expect(payload.disputeStatus).toBe('resolved')
    expect(payload.disputeDecision).toBe('refund')
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  it('DI2: returns 409 DISPUTE_BLOCKING with null decision for active dispute', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: FUNDED_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        dispute: { id: 'dispute-2', status: 'under_review' },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(409)
    const payload = body() as Record<string, unknown>
    expect(payload.error).toBe('DISPUTE_BLOCKING')
    expect(payload.disputeDecision).toBeNull()
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  it('DI3: dispute lookup uses the exact server-side .or() filter (contract pin)', async () => {
    const client = makeAdmin({
      tranche: ELIGIBLE_TRANCHE,
      plan: FUNDED_PLAN,
      provider: PROVIDER_ROW,
      payoutAccount: READY_PAYOUT_ACCOUNT,
    })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client })
    const { res, statusCode } = makeResponse()
    await handler(makeRequest(BASE_BODY), res)
    expect(statusCode()).toBe(200)

    const disputesTable = (client.from as ReturnType<typeof vi.fn>)('disputes') as {
      select: ReturnType<typeof vi.fn>
    }
    // split_ratio and settlement_status are selected so the C2 split gate can
    // prove both the server-persisted ratio and that the money leg is pending.
    expect(disputesTable.select).toHaveBeenCalledWith(
      'id, status, decision, split_ratio, settlement_status',
    )
    const eqChain = disputesTable.select.mock.results[0].value.eq as ReturnType<typeof vi.fn>
    const orFn = eqChain.mock.results[0].value.or as ReturnType<typeof vi.fn>
    expect(orFn).toHaveBeenCalledWith(
      'status.in.(open,under_review,customer_waiting,provider_waiting),and(status.eq.resolved,decision.in.(refund,split))',
    )
  })

  // ──────────────────────────────────────────────────────────────────────────
  //  Split-ratio guard (Block P · #5) — a genuine split is STRICTLY inside (0,1).
  //  0 % = full refund, 100 % = full release. An out-of-(0,1) value provided in
  //  the body used to be silently coerced to a FULL provider release, which —
  //  paired with service.ts's full (1 − ratio) customer refund — double-paid at
  //  ratio=0. The handler now fail-fasts with 400 before any Stripe call.
  // ──────────────────────────────────────────────────────────────────────────
  it.each([0, 1, -0.5, 1.5, Number.NaN, 'abc'])(
    'SR: returns 400 INVALID_SPLIT_RATIO for provided splitRatio=%p (no transfer)',
    async (bad) => {
      const { res, statusCode, body } = makeResponse()
      await handler(makeRequest({ ...BASE_BODY, splitRatio: bad }), res)
      expect(statusCode()).toBe(400)
      expect((body() as { code: string }).code).toBe('INVALID_SPLIT_RATIO')
      expect(mockTransfersCreate).not.toHaveBeenCalled()
    },
  )

  it('SR2: ABSENT splitRatio still releases normally (200, full release)', async () => {
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res) // BASE_BODY carries no splitRatio
    expect(statusCode()).toBe(200)
    expect((body() as { status: string }).status).toBe('released')
  })

  it('SR3: interior splitRatio without a resolved split dispute is rejected before Stripe', async () => {
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ ...BASE_BODY, splitRatio: 0.6 }), res)
    expect(statusCode()).toBe(409)
    expect((body() as { error?: string }).error).toBe('DISPUTE_SPLIT_NOT_AUTHORIZED')
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  // ──────────────────────────────────────────────────────────────────────────
  //  C2 — resolved split dispute pins the split ratio server-side.
  //  disputes.split_ratio is the authoritative value: a caller-supplied
  //  splitRatio that deviates (or is absent — full-release math) must 409,
  //  otherwise the tranche leg here plus refund-escrow's independent
  //  customer-share leg (computed from the SAME disputes.split_ratio) would
  //  sum to >100 % of the escrow.
  // ──────────────────────────────────────────────────────────────────────────

  const RESOLVED_SPLIT_DISPUTE = {
    id: 'dispute-split-1',
    status: 'resolved',
    decision: 'split',
    split_ratio: 0.1,
    settlement_status: 'pending',
  }

  const SPLIT_PLAN = { ...FUNDED_PLAN, total_amount: 1000 }

  it('C2a: resolved split (0.1) + splitRatio=0.99 → 409 DISPUTE_SPLIT_RATIO_MISMATCH, no transfer', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: SPLIT_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        dispute: RESOLVED_SPLIT_DISPUTE,
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ ...BASE_BODY, splitRatio: 0.99 }), res)
    expect(statusCode()).toBe(409)
    const payload = body() as Record<string, unknown>
    expect(payload.error).toBe('DISPUTE_SPLIT_RATIO_MISMATCH')
    expect(payload.disputeId).toBe('dispute-split-1')
    expect(payload.disputeDecision).toBe('split')
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  it('C2b: resolved split (0.1) + ABSENT splitRatio → 409 DISPUTE_SPLIT_RATIO_MISMATCH (no full release)', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: SPLIT_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        dispute: RESOLVED_SPLIT_DISPUTE,
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(BASE_BODY), res) // BASE_BODY carries no splitRatio
    expect(statusCode()).toBe(409)
    const payload = body() as Record<string, unknown>
    expect(payload.error).toBe('DISPUTE_SPLIT_RATIO_MISMATCH')
    expect(payload.disputeId).toBe('dispute-split-1')
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  it('C2c: resolved split (0.6) + EXACT splitRatio=0.6 passes the guard → 200 released', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: SPLIT_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        dispute: { ...RESOLVED_SPLIT_DISPUTE, split_ratio: 0.6 },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ ...BASE_BODY, splitRatio: 0.6 }), res)
    expect(statusCode()).toBe(200)
    const payload = body() as Record<string, unknown>
    expect(payload.status).toBe('released')
    // Split quota: providerTargetGross = 1000 × 0.6 = 600 ≥ tranche gross 250
    // → effectiveGross = 250; default 9 % fee → net €227.50 = 22750 cents.
    expect(mockTransfersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 22750, currency: 'eur' }),
      expect.anything(),
    )
  })

  it('C2d: numeric-as-string split_ratio ("0.60") from PostgREST matches splitRatio=0.6', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: SPLIT_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        dispute: { ...RESOLVED_SPLIT_DISPUTE, split_ratio: '0.60' },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ ...BASE_BODY, splitRatio: 0.6 }), res)
    expect(statusCode()).toBe(200)
    expect((body() as { status: string }).status).toBe('released')
    expect(mockTransfersCreate).toHaveBeenCalledTimes(1)
  })

  it('C2e: resolved split with NULL split_ratio fails closed → 409 DISPUTE_SPLIT_RATIO_MISSING', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: SPLIT_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        dispute: { ...RESOLVED_SPLIT_DISPUTE, split_ratio: null },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ ...BASE_BODY, splitRatio: 0.5 }), res)
    expect(statusCode()).toBe(409)
    const payload = body() as Record<string, unknown>
    expect(payload.error).toBe('DISPUTE_SPLIT_RATIO_MISSING')
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })

  it('C2f: settled split cannot issue another provider release', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: true,
      client: makeAdmin({
        tranche: ELIGIBLE_TRANCHE,
        plan: SPLIT_PLAN,
        provider: PROVIDER_ROW,
        payoutAccount: READY_PAYOUT_ACCOUNT,
        dispute: { ...RESOLVED_SPLIT_DISPUTE, split_ratio: 0.6, settlement_status: 'settled' },
      }),
    })
    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest({ ...BASE_BODY, splitRatio: 0.6 }), res)
    expect(statusCode()).toBe(409)
    expect((body() as { error?: string }).error).toBe('DISPUTE_SPLIT_NOT_PENDING')
    expect(mockTransfersCreate).not.toHaveBeenCalled()
  })
})
