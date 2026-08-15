// vi.mock must be hoisted before imports.
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}))

vi.mock('../../api/_subscriptionAuth', () => ({
  requireProEntitlement: vi.fn().mockResolvedValue({ ok: true }),
}))

// confirm-funding.ts verifies the PaymentIntent against Stripe (H9) before
// any DB write — mock the Stripe SDK so the role-gate tests stay offline.
const { mockPaymentIntentsRetrieve } = vi.hoisted(() => ({
  mockPaymentIntentsRetrieve: vi.fn(),
}))

vi.mock('stripe', () => ({
  default: class MockStripe {
    paymentIntents = { retrieve: mockPaymentIntentsRetrieve }
  },
}))

/**
 * Block 7.2.1c-FU — HTTP-layer role guards on the three funding endpoints.
 *
 * Verifies that the api/_authRole.ts gate is wired correctly into:
 *   - api/request-funding.ts   → requireOwner
 *   - api/confirm-funding.ts   → requireCustomer (JWT branch only)
 *   - api/funding-entry.ts     → requireCustomer
 *
 * Each endpoint is exercised three ways:
 *   1. Wrong-role JWT  → 403 with { code: 'forbidden_role' } (role gate)
 *   2. Right role + matching resource → role gate passes, handler runs
 *   3. Right role + mismatched resource → 403 from the resource-level check
 *
 * The "200 / passes role gate" cases assert that the response is NOT a
 * 403 with { code: 'forbidden_role' } — i.e. the gate let the caller
 * through. They do NOT mock the full downstream DB chain; that is covered
 * by the existing endpoint integration suites.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

type ProfileRow = {
  role: 'customer' | 'craftsman' | null
  craftsman_role: 'owner' | 'worker' | null
  is_operator: boolean
} | null

type TableResult = { data: unknown; error: unknown } | undefined

const mockGetUser = vi.fn()
const tableResults: Record<string, TableResult[]> = {}

function queueTableResult(table: string, result: TableResult): void {
  if (!tableResults[table]) tableResults[table] = []
  tableResults[table].push(result)
}

function nextTableResult(table: string): TableResult {
  const queue = tableResults[table]
  if (!queue || queue.length === 0) return { data: null, error: null }
  return queue.shift() ?? { data: null, error: null }
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: (table: string) => buildChain(table),
    rpc: vi.fn(async () => ({
      data: { outcome: 'confirmed', tranches_updated: 0 },
      error: null,
    })),
  })),
}))

function buildChain(table: string): unknown {
  // Capture the result for THIS chain at chain creation time so subsequent
  // chains for the same table get the next queued result.
  const result = nextTableResult(table)
  const chain: Record<string, unknown> = {}
  const passthrough = () => chain
  chain.select = passthrough
  chain.eq = passthrough
  chain.or = passthrough
  chain.not = passthrough
  chain.limit = passthrough
  chain.update = passthrough
  chain.insert = passthrough
  chain.maybeSingle = () => Promise.resolve(result ?? { data: null, error: null })
  chain.single = () => Promise.resolve(result ?? { data: null, error: null })
  // Make the chain itself thenable so `await admin.from('x').insert(...)` works.
  ;(chain as { then: (fn: (v: unknown) => unknown) => Promise<unknown> }).then = (fn) =>
    Promise.resolve(result ?? { data: null, error: null }).then(fn)
  return chain
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const FAKE_USER_OWNER = {
  id: 'owner-uuid',
  email: 'owner@example.com',
  aud: 'authenticated',
  role: 'authenticated',
}
const FAKE_USER_WORKER = { ...FAKE_USER_OWNER, id: 'worker-uuid', email: 'worker@example.com' }
const FAKE_USER_CUSTOMER = { ...FAKE_USER_OWNER, id: 'customer-uuid', email: 'customer@example.com' }

function makeReq(method: 'POST' | 'GET', body: unknown = {}, query: Record<string, string> = {}): VercelRequest {
  return {
    method,
    url: '/api/test',
    headers: { authorization: 'Bearer fake.jwt.token' },
    body,
    query,
  } as unknown as VercelRequest
}

interface CapturedResponse {
  statusCode: number
  body: unknown
  headers: Record<string, string>
}

function makeRes(): { res: VercelResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 0, body: undefined, headers: {} }
  const res = {
    status(code: number) {
      captured.statusCode = code
      return res
    },
    json(payload: unknown) {
      captured.body = payload
      return res
    },
    setHeader(name: string, value: string) {
      captured.headers[name] = value
    },
    end() {
      return res
    },
  } as unknown as VercelResponse
  return { res, captured }
}

function setProfile(profile: ProfileRow): void {
  queueTableResult('profiles', { data: profile, error: null })
}

function setSupabaseEnv(): void {
  process.env.SUPABASE_URL = 'https://test.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
}

function silenceLogs(): { restore: () => void } {
  const origWarn = console.warn
  const origLog = console.log
  const origError = console.error
  console.warn = () => {}
  console.log = () => {}
  console.error = () => {}
  return {
    restore: () => {
      console.warn = origWarn
      console.log = origLog
      console.error = origError
    },
  }
}

function isForbiddenRole(captured: CapturedResponse): boolean {
  if (captured.statusCode !== 403) return false
  const body = captured.body as { code?: string } | undefined
  return body?.code === 'forbidden_role'
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  setSupabaseEnv()
  for (const k of Object.keys(tableResults)) delete tableResults[k]
})

// ---------------------------------------------------------------------------
// /api/request-funding — requireOwner
// ---------------------------------------------------------------------------

describe('api/request-funding — HTTP role gate', () => {
  it('request_funding_403_for_worker_token', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: FAKE_USER_WORKER }, error: null })
    setProfile({ role: 'craftsman', craftsman_role: 'worker', is_operator: false })

    const { default: handler } = await import('../../api/request-funding.js')
    const { res, captured } = makeRes()
    const cap = silenceLogs()
    await handler(makeReq('POST', { jobId: 'job-1' }), res)
    cap.restore()

    expect(isForbiddenRole(captured)).toBe(true)
  })

  it('request_funding_403_for_customer_token', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: FAKE_USER_CUSTOMER }, error: null })
    setProfile({ role: 'customer', craftsman_role: null, is_operator: false })

    const { default: handler } = await import('../../api/request-funding.js')
    const { res, captured } = makeRes()
    const cap = silenceLogs()
    await handler(makeReq('POST', { jobId: 'job-1' }), res)
    cap.restore()

    expect(isForbiddenRole(captured)).toBe(true)
  })

  it('request_funding_200_for_owner_match', async () => {
    // Role gate passes for owner; downstream provider-linkage check
    // confirms the owner is the linked craftsman for this job.
    mockGetUser.mockResolvedValueOnce({ data: { user: FAKE_USER_OWNER }, error: null })
    setProfile({ role: 'craftsman', craftsman_role: 'owner', is_operator: false })

    // Job exists, source_offer_id present, owner is the offer.craftsman_user_id.
    queueTableResult('jobs', {
      data: {
        id: 'job-1',
        status: 'in_progress',
        source_offer_id: 'offer-1',
        customer_user_id: 'customer-uuid',
        provider_id: 'provider-1',
      },
      error: null,
    })
    queueTableResult('offers', {
      data: {
        id: 'offer-1',
        status: 'accepted',
        price: '100',
        customer_user_id: 'customer-uuid',
        craftsman_user_id: FAKE_USER_OWNER.id,
        created_job_id: 'job-1',
        conversation_id: 'conv-1',
      },
      error: null,
    })
    // Existing escrow plan reused (avoids deep insert chain).
    queueTableResult('escrow_payment_plans', {
      data: {
        id: 'plan-1',
        status: 'awaiting_customer_funding',
        total_amount: 100,
        source_offer_id: 'offer-1',
        job_id: 'job-1',
      },
      error: null,
    })
    queueTableResult('escrow_tranches', {
      data: [{ kind: 'deposit_release' }, { kind: 'final_release' }],
      error: null,
    })
    queueTableResult('funding_requests', {
      data: { id: 'fr-1', status: 'sent', amount: 100 },
      error: null,
    })
    queueTableResult('projects', { data: { id: 'project-1' }, error: null })
    queueTableResult('thread_artifacts', { data: { id: 'artifact-1' }, error: null })

    const { default: handler } = await import('../../api/request-funding.js')
    const { res, captured } = makeRes()
    const cap = silenceLogs()
    await handler(makeReq('POST', { jobId: 'job-1' }), res)
    cap.restore()

    // Role gate passed → not a forbidden_role 403.
    expect(isForbiddenRole(captured)).toBe(false)
    expect(captured.statusCode).toBe(200)
  })

  it('request_funding_403_for_owner_wrong_job', async () => {
    // Owner role passes the HTTP gate, but the job is owned by a different
    // craftsman → downstream provider-linkage check returns 403.
    mockGetUser.mockResolvedValueOnce({ data: { user: FAKE_USER_OWNER }, error: null })
    setProfile({ role: 'craftsman', craftsman_role: 'owner', is_operator: false })

    queueTableResult('jobs', {
      data: {
        id: 'job-1',
        status: 'in_progress',
        source_offer_id: 'offer-1',
        customer_user_id: 'customer-uuid',
        provider_id: 'provider-1',
      },
      error: null,
    })
    queueTableResult('offers', {
      data: {
        id: 'offer-1',
        status: 'accepted',
        price: '100',
        customer_user_id: 'customer-uuid',
        craftsman_user_id: 'other-craftsman-uuid',
        created_job_id: 'job-1',
        conversation_id: 'conv-1',
      },
      error: null,
    })
    // 1st providers lookup: provider exists but belongs to a different
    //                       craftsman → first auth branch falls through.
    queueTableResult('providers', {
      data: { id: 'provider-1', profile_id: 'other-craftsman-uuid' },
      error: null,
    })
    // 2nd providers lookup: caller has no provider profile linked → second
    //                       auth branch falls through → 403 PROVIDER_NOT_AUTHORIZED.
    queueTableResult('providers', { data: null, error: null })

    const { default: handler } = await import('../../api/request-funding.js')
    const { res, captured } = makeRes()
    const cap = silenceLogs()
    await handler(makeReq('POST', { jobId: 'job-1' }), res)
    cap.restore()

    expect(captured.statusCode).toBe(403)
    const body = captured.body as { code?: string }
    // Resource-level deny, not the role-level deny.
    expect(body.code).toBe('PROVIDER_NOT_AUTHORIZED')
  })
})

// ---------------------------------------------------------------------------
// /api/confirm-funding — requireCustomer (JWT branch)
// ---------------------------------------------------------------------------

describe('api/confirm-funding — HTTP role gate', () => {
  beforeEach(() => {
    delete process.env.FUNDING_CONFIRM_SECRET
    // H9: handler verifies the PI against Stripe before the RPC — provide a
    // key + a succeeded intent whose metadata matches the fr-1/plan-1 body.
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'
    mockPaymentIntentsRetrieve.mockResolvedValue({
      status: 'succeeded',
      metadata: {
        type: 'escrow_funding',
        fundingRequestId: 'fr-1',
        escrowPlanId: 'plan-1',
      },
    })
  })

  it('confirm_funding_403_for_owner_token', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: FAKE_USER_OWNER }, error: null })
    setProfile({ role: 'craftsman', craftsman_role: 'owner', is_operator: false })

    const { default: handler } = await import('../../api/confirm-funding.js')
    const { res, captured } = makeRes()
    const cap = silenceLogs()
    await handler(makeReq('POST', { paymentIntentId: 'pi_test' }), res)
    cap.restore()

    expect(isForbiddenRole(captured)).toBe(true)
  })

  it('confirm_funding_403_for_worker_token', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: FAKE_USER_WORKER }, error: null })
    setProfile({ role: 'craftsman', craftsman_role: 'worker', is_operator: false })

    const { default: handler } = await import('../../api/confirm-funding.js')
    const { res, captured } = makeRes()
    const cap = silenceLogs()
    await handler(makeReq('POST', { paymentIntentId: 'pi_test' }), res)
    cap.restore()

    expect(isForbiddenRole(captured)).toBe(true)
  })

  it('confirm_funding_200_for_customer_match', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: FAKE_USER_CUSTOMER }, error: null })
    setProfile({ role: 'customer', craftsman_role: null, is_operator: false })

    queueTableResult('funding_requests', {
      data: {
        id: 'fr-1',
        escrow_plan_id: 'plan-1',
        job_id: 'job-1',
        customer_user_id: FAKE_USER_CUSTOMER.id,
        external_funding_ref: 'pi_test',
      },
      error: null,
    })

    const { default: handler } = await import('../../api/confirm-funding.js')
    const { res, captured } = makeRes()
    const cap = silenceLogs()
    await handler(
      makeReq('POST', {
        paymentIntentId: 'pi_test',
        fundingRequestId: 'fr-1',
        escrowPlanId: 'plan-1',
        jobId: 'job-1',
      }),
      res,
    )
    cap.restore()

    expect(isForbiddenRole(captured)).toBe(false)
    expect(captured.statusCode).toBe(200)
  })

  it('confirm_funding_403_for_customer_wrong_job', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: FAKE_USER_CUSTOMER }, error: null })
    setProfile({ role: 'customer', craftsman_role: null, is_operator: false })

    // Funding request belongs to a DIFFERENT customer.
    queueTableResult('funding_requests', {
      data: {
        id: 'fr-1',
        escrow_plan_id: 'plan-1',
        job_id: 'job-1',
        customer_user_id: 'other-customer-uuid',
        external_funding_ref: 'pi_test',
      },
      error: null,
    })

    const { default: handler } = await import('../../api/confirm-funding.js')
    const { res, captured } = makeRes()
    const cap = silenceLogs()
    await handler(
      makeReq('POST', {
        paymentIntentId: 'pi_test',
        fundingRequestId: 'fr-1',
        escrowPlanId: 'plan-1',
        jobId: 'job-1',
      }),
      res,
    )
    cap.restore()

    expect(captured.statusCode).toBe(403)
    // Resource-level deny (ownership mismatch), not role-level.
    const body = captured.body as { code?: string; error?: string }
    expect(body.code).not.toBe('forbidden_role')
    expect(body.error).toMatch(/customer for this funding request/i)
  })
})

// ---------------------------------------------------------------------------
// /api/funding-entry — requireCustomer
// ---------------------------------------------------------------------------

describe('api/funding-entry — HTTP role gate', () => {
  it('funding_entry_403_for_owner_token', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: FAKE_USER_OWNER }, error: null })
    setProfile({ role: 'craftsman', craftsman_role: 'owner', is_operator: false })

    const { default: handler } = await import('../../api/funding-entry.js')
    const { res, captured } = makeRes()
    const cap = silenceLogs()
    await handler(makeReq('GET', undefined, { fundingRequestId: 'fr-1' }), res)
    cap.restore()

    expect(isForbiddenRole(captured)).toBe(true)
  })

  it('funding_entry_403_for_worker_token', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: FAKE_USER_WORKER }, error: null })
    setProfile({ role: 'craftsman', craftsman_role: 'worker', is_operator: false })

    const { default: handler } = await import('../../api/funding-entry.js')
    const { res, captured } = makeRes()
    const cap = silenceLogs()
    await handler(makeReq('GET', undefined, { fundingRequestId: 'fr-1' }), res)
    cap.restore()

    expect(isForbiddenRole(captured)).toBe(true)
  })

  it('funding_entry_200_for_customer_match', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: FAKE_USER_CUSTOMER }, error: null })
    setProfile({ role: 'customer', craftsman_role: null, is_operator: false })

    queueTableResult('funding_requests', {
      data: {
        id: 'fr-1',
        source_offer_id: 'offer-1',
        job_id: 'job-1',
        escrow_plan_id: 'plan-1',
        customer_user_id: FAKE_USER_CUSTOMER.id,
        provider_id: 'provider-1',
        provider_user_id: 'owner-uuid',
        type: 'full_escrow',
        status: 'sent',
        amount: 100,
        currency: 'EUR',
        created_by: 'provider',
        conversation_id: 'conv-1',
        message_id: null,
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
        sent_at: '2026-05-01T00:00:00Z',
        funded_at: null,
        external_funding_ref: null,
        funding_idempotency_key: null,
        failure_reason: null,
      },
      error: null,
    })
    queueTableResult('escrow_payment_plans', {
      data: {
        id: 'plan-1',
        source_offer_id: 'offer-1',
        job_id: 'job-1',
        customer_user_id: FAKE_USER_CUSTOMER.id,
        provider_id: 'provider-1',
        currency: 'EUR',
        total_amount: 100,
        funding_mode: 'full_upfront_escrow',
        release_model: 'start_25_completion_75',
        status: 'awaiting_customer_funding',
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
      },
      error: null,
    })
    queueTableResult('jobs', {
      data: {
        id: 'job-1',
        status: 'in_progress',
        source_offer_id: 'offer-1',
        customer_user_id: FAKE_USER_CUSTOMER.id,
        provider_id: 'provider-1',
      },
      error: null,
    })
    queueTableResult('projects', { data: { id: 'project-1', title: 'Test' }, error: null })

    const { default: handler } = await import('../../api/funding-entry.js')
    const { res, captured } = makeRes()
    const cap = silenceLogs()
    await handler(makeReq('GET', undefined, { fundingRequestId: 'fr-1' }), res)
    cap.restore()

    expect(isForbiddenRole(captured)).toBe(false)
    expect(captured.statusCode).toBe(200)
  })

  it('funding_entry_403_for_customer_wrong_funding_request', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: FAKE_USER_CUSTOMER }, error: null })
    setProfile({ role: 'customer', craftsman_role: null, is_operator: false })

    // Funding request belongs to a DIFFERENT customer.
    queueTableResult('funding_requests', {
      data: {
        id: 'fr-1',
        source_offer_id: 'offer-1',
        job_id: 'job-1',
        escrow_plan_id: 'plan-1',
        customer_user_id: 'other-customer-uuid',
        provider_id: 'provider-1',
        provider_user_id: 'owner-uuid',
        type: 'full_escrow',
        status: 'sent',
        amount: 100,
        currency: 'EUR',
        created_by: 'provider',
        conversation_id: 'conv-1',
        message_id: null,
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
        sent_at: null,
        funded_at: null,
        external_funding_ref: null,
        funding_idempotency_key: null,
        failure_reason: null,
      },
      error: null,
    })

    const { default: handler } = await import('../../api/funding-entry.js')
    const { res, captured } = makeRes()
    const cap = silenceLogs()
    await handler(makeReq('GET', undefined, { fundingRequestId: 'fr-1' }), res)
    cap.restore()

    expect(captured.statusCode).toBe(403)
    const body = captured.body as { errorCode?: string; code?: string }
    expect(body.errorCode).toBe('FUNDING_REQUEST_NOT_ACCESSIBLE')
    expect(body.code).not.toBe('forbidden_role')
  })
})
