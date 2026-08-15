// vi.mock must be hoisted before imports.
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}))

/**
 * Tests for the job ownership authorization check in
 * /api/send-notification-email.
 *
 * Verifies that only job participants (customer or craftsman) can trigger
 * notification emails — preventing authenticated non-participants from
 * sending spoofed emails under SaFix's brand.
 *
 * Tests use the Supabase admin mock pattern established in paymentAuth.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Mock external dependencies before importing the handler
// ---------------------------------------------------------------------------

vi.mock('../../api/_supabase', () => ({
  getSupabaseAdmin: vi.fn(),
}))

const { mockAuthenticateRequest } = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
}))

vi.mock('../../api/_auth', () => ({
  authenticateRequest: mockAuthenticateRequest,
  requireAuth: async (req: unknown, res: { status: (code: number) => { json: (payload: unknown) => void } }) => {
    const result = await mockAuthenticateRequest(req)
    if (!result.ok) {
      res.status(result.statusCode).json({ error: result.error })
      return null
    }
    return { userId: result.userId, user: result.user }
  },
}))

vi.mock('../../api/_cors', () => ({
  applyCors: vi.fn().mockReturnValue(false),
}))

vi.mock('../../api/_observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('../../api/_rateLimit', () => ({
  applyRateLimit: vi.fn().mockResolvedValue(false),
}))

import { getSupabaseAdmin } from '../../api/_supabase'
import handler from '../../api/send-notification-email'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: Record<string, unknown> = {}): VercelRequest {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
    body,
    url: '/api/send-notification-email',
  } as unknown as VercelRequest
}

function makeResponse() {
  const captured: { status: number | null; body: unknown } = {
    status: null,
    body: null,
  }

  const jsonFn = vi.fn((data: unknown) => {
    captured.body = data
  })

  const statusChain = { json: jsonFn }

  const resMock = {
    status: vi.fn((code: number) => {
      captured.status = code
      return statusChain
    }),
    setHeader: vi.fn(),
  } as unknown as VercelResponse

  return { res: resMock, captured }
}

/**
 * Builds a minimal mock Supabase admin client that returns the given job row
 * for .from('jobs').select(...).eq(...).limit(1) calls.
 *
 * Table-aware: 'jobs' returns a select/eq/limit chain; all other tables
 * (e.g. 'email_delivery_log') return an insert-capable no-op chain so that
 * best-effort logging inside the handler does not throw.
 */
function makeAdminWithJob(
  jobRow: { customer_user_id: string | null; craftsman_user_id: string | null } | null,
  error: object | null = null,
): SupabaseClient {
  const jobsChain = {
    select: () => jobsChain,
    eq: () => jobsChain,
    limit: () =>
      Promise.resolve({
        data: jobRow ? [jobRow] : [],
        error,
      }),
  }

  const defaultChain = {
    insert: () => Promise.resolve({ data: null, error: null }),
  }

  return {
    from: (table: string) => (table === 'jobs' ? jobsChain : defaultChain),
    auth: {
      admin: {
        getUserById: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'not needed for ownership tests' },
        }),
      },
    },
  } as unknown as SupabaseClient
}

const VALID_PAYLOAD = {
  type: 'work_completed',
  jobId: 'job-123',
  recipientUserId: 'recipient-user',
  recipientRole: 'customer',
  context: {},
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('send-notification-email — job ownership authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns 403 when authenticated user is not a job participant', async () => {
    mockAuthenticateRequest.mockResolvedValue({
      ok: true,
      userId: 'attacker-user',
      user: {} as never,
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      makeAdminWithJob({
        customer_user_id: 'real-customer',
        craftsman_user_id: 'real-craftsman',
      }),
    )

    const { res, captured } = makeResponse()
    await handler(makeRequest(VALID_PAYLOAD), res)

    expect(captured.status).toBe(403)
    expect((captured.body as Record<string, unknown>).success).toBe(false)
    expect((captured.body as Record<string, unknown>).error).toContain('not a participant')
  })

  it('allows the customer to trigger a notification email', async () => {
    mockAuthenticateRequest.mockResolvedValue({
      ok: true,
      userId: 'real-customer',
      user: {} as never,
    })
    // Admin: job found, caller is customer; email lookup fails (acceptable for
    // this test — we only care that the ownership check passes, not email send)
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      makeAdminWithJob({
        customer_user_id: 'real-customer',
        craftsman_user_id: 'real-craftsman',
      }),
    )

    const { res, captured } = makeResponse()
    // Recipient must be the caller's counterparty (the craftsman); the recipient
    // lockdown rejects anything else with 403.
    await handler(
      makeRequest({ ...VALID_PAYLOAD, recipientUserId: 'real-craftsman', recipientRole: 'craftsman' }),
      res,
    )

    // Should NOT be 403 — ownership + recipient checks passed
    expect(captured.status).not.toBe(403)
  })

  it('allows the craftsman to trigger a notification email', async () => {
    mockAuthenticateRequest.mockResolvedValue({
      ok: true,
      userId: 'real-craftsman',
      user: {} as never,
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      makeAdminWithJob({
        customer_user_id: 'real-customer',
        craftsman_user_id: 'real-craftsman',
      }),
    )

    const { res, captured } = makeResponse()
    // Caller is the craftsman → recipient must be the customer counterparty.
    await handler(
      makeRequest({ ...VALID_PAYLOAD, recipientUserId: 'real-customer', recipientRole: 'customer' }),
      res,
    )

    expect(captured.status).not.toBe(403)
  })

  it('returns 404 when the job does not exist', async () => {
    mockAuthenticateRequest.mockResolvedValue({
      ok: true,
      userId: 'some-user',
      user: {} as never,
    })
    // Empty results → job not found
    vi.mocked(getSupabaseAdmin).mockReturnValue(makeAdminWithJob(null))

    const { res, captured } = makeResponse()
    await handler(makeRequest(VALID_PAYLOAD), res)

    expect(captured.status).toBe(404)
    expect((captured.body as Record<string, unknown>).success).toBe(false)
    expect((captured.body as Record<string, unknown>).error).toContain('Job not found')
  })

  it('returns 500 when the job DB lookup fails', async () => {
    mockAuthenticateRequest.mockResolvedValue({
      ok: true,
      userId: 'some-user',
      user: {} as never,
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      makeAdminWithJob(null, { message: 'DB connection failed' }),
    )

    const { res, captured } = makeResponse()
    await handler(makeRequest(VALID_PAYLOAD), res)

    expect(captured.status).toBe(500)
    expect((captured.body as Record<string, unknown>).success).toBe(false)
    expect((captured.body as Record<string, unknown>).error).toContain('verify job ownership')
  })

  it('returns 401 when the caller is not authenticated', async () => {
    mockAuthenticateRequest.mockResolvedValue({
      ok: false,
      statusCode: 401,
      error: 'Unauthorized: missing or malformed Authorization header.',
    })

    const { res, captured } = makeResponse()
    await handler(makeRequest(VALID_PAYLOAD), res)

    expect(captured.status).toBe(401)
  })

  it('returns 403 when customer_user_id is null and caller does not match craftsman', async () => {
    mockAuthenticateRequest.mockResolvedValue({
      ok: true,
      userId: 'attacker-user',
      user: {} as never,
    })
    vi.mocked(getSupabaseAdmin).mockReturnValue(
      makeAdminWithJob({
        customer_user_id: null,
        craftsman_user_id: 'real-craftsman',
      }),
    )

    const { res, captured } = makeResponse()
    await handler(makeRequest(VALID_PAYLOAD), res)

    expect(captured.status).toBe(403)
  })
})
