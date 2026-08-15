/**
 * /api/operator/list-dlq-attribution — handler tests.
 *
 * Covers:
 *   LD1. Non-operator caller → 403, no jobs query issued.
 *   LD2. Operator caller → 200 with jobs array (service-role bypass of RLS).
 *   LD3. Admin client unavailable → 500.
 *   LD4. DB query error → 500 with surfaced message.
 *   LD5. Filters strictly on attribution_status='dlq'.
 *   LD6. Orders by attribution_last_retry_at ASC (nulls first) and caps at 100.
 *   LD7. Method guard: only GET/POST accepted.
 */

const { mockRequireAuth } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
}))

const { mockGetSupabaseAdminWithStatus, mockFetchIsOperator } = vi.hoisted(() => ({
  mockGetSupabaseAdminWithStatus: vi.fn(),
  mockFetchIsOperator: vi.fn(),
}))

vi.mock('../../api/_auth', () => ({
  requireAuth: mockRequireAuth,
}))

vi.mock('../../api/_supabase', () => ({
  getSupabaseAdminWithStatus: mockGetSupabaseAdminWithStatus,
  formatAdminUnavailable: (missing: string[]) =>
    missing.length > 0 ? `missing ${missing.join(', ')}.` : 'Supabase credentials missing.',
}))

vi.mock('../../api/_paymentAuth', () => ({
  fetchIsOperator: mockFetchIsOperator,
}))

vi.mock('../../api/_observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('../../api/_rateLimit', () => ({
  applyRateLimit: vi.fn().mockResolvedValue(false),
}))

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import handler from '../../api/operator/list-dlq-attribution'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeReq(method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET'): VercelRequest {
  return {
    method,
    headers: {},
    url: '/api/operator/list-dlq-attribution',
  } as unknown as VercelRequest
}

function makeRes(): {
  res: VercelResponse
  statusCode: () => number
  body: () => Record<string, unknown>
} {
  let _status = 0
  let _body: unknown
  const res = {
    setHeader: vi.fn(() => res),
    status: vi.fn((code: number) => { _status = code; return res }),
    json: vi.fn((payload: unknown) => { _body = payload }),
  } as unknown as VercelResponse
  return {
    res,
    statusCode: () => _status,
    body: () => _body as Record<string, unknown>,
  }
}

type QueryShape = {
  table: string | null
  selectedColumns: string | null
  eqCalls: Array<[string, unknown]>
  orderCall: { column: string; options: Record<string, unknown> } | null
  limitValue: number | null
}

function makeAdmin(dlqJobs: Array<Record<string, unknown>>, queryError: unknown = null) {
  const shape: QueryShape = {
    table: null,
    selectedColumns: null,
    eqCalls: [],
    orderCall: null,
    limitValue: null,
  }

  const limit = vi.fn((n: number) => {
    shape.limitValue = n
    return Promise.resolve({ data: dlqJobs, error: queryError })
  })
  const order = vi.fn((col: string, options: Record<string, unknown>) => {
    shape.orderCall = { column: col, options }
    return { limit }
  })
  const eq = vi.fn((col: string, val: unknown) => {
    shape.eqCalls.push([col, val])
    return { order }
  })
  const select = vi.fn((cols: string) => {
    shape.selectedColumns = cols
    return { eq }
  })
  const from = vi.fn((table: string) => {
    shape.table = table
    return { select }
  })

  return {
    client: { from } as unknown as Parameters<typeof mockGetSupabaseAdminWithStatus>[0],
    shape,
  }
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const OPERATOR_ID = 'user-operator-1'

const SAMPLE_DLQ_JOB = {
  id: 'job-dlq-1',
  customer_user_id: 'cust-1',
  craftsman_user_id: 'craft-1',
  attribution_status: 'dlq',
  attribution_dlq_reason: 'MISSING_USER_IDS',
  attribution_retry_count: 0,
  attribution_last_retry_at: '2026-04-20T10:00:00Z',
  commercial_origin: null,
  created_at: '2026-04-19T08:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireAuth.mockResolvedValue({ userId: OPERATOR_ID })
  mockFetchIsOperator.mockResolvedValue(true)
  const admin = makeAdmin([SAMPLE_DLQ_JOB])
  mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })
  // Expose shape on the mock for introspection by individual tests
  ;(mockGetSupabaseAdminWithStatus as unknown as { __shape: QueryShape }).__shape = admin.shape
})

// ── tests ────────────────────────────────────────────────────────────────────

describe('/api/operator/list-dlq-attribution', () => {
  it('LD1: non-operator caller → 403, no query issued', async () => {
    mockFetchIsOperator.mockResolvedValue(false)
    const admin = makeAdmin([])
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })

    const { res, statusCode, body } = makeRes()
    await handler(makeReq('GET'), res)
    expect(statusCode()).toBe(403)
    expect((body() as { error: string }).error).toBe('forbidden')
    expect(admin.shape.table).toBeNull()
  })

  it('LD2: operator caller → 200 with jobs array', async () => {
    const { res, statusCode, body } = makeRes()
    await handler(makeReq('GET'), res)
    expect(statusCode()).toBe(200)
    const payload = body() as { jobs: unknown[] }
    expect(Array.isArray(payload.jobs)).toBe(true)
    expect(payload.jobs).toHaveLength(1)
    expect((payload.jobs[0] as { id: string }).id).toBe('job-dlq-1')
  })

  it('LD3: admin client unavailable → 500 server_misconfiguration', async () => {
    mockGetSupabaseAdminWithStatus.mockReturnValue({
      ok: false,
      missing: ['SUPABASE_SERVICE_ROLE_KEY'],
    })
    const { res, statusCode, body } = makeRes()
    await handler(makeReq('GET'), res)
    expect(statusCode()).toBe(500)
    expect((body() as { error: string }).error).toBe('server_misconfiguration')
  })

  it('LD4: DB query error → 500 query_failed', async () => {
    const admin = makeAdmin([], { message: 'connection reset' })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })

    const { res, statusCode, body } = makeRes()
    await handler(makeReq('GET'), res)
    expect(statusCode()).toBe(500)
    const payload = body() as { error: string; message: string }
    expect(payload.error).toBe('query_failed')
    expect(payload.message).toBe('connection reset')
  })

  it('LD5: query filters strictly on attribution_status=dlq', async () => {
    const { res } = makeRes()
    await handler(makeReq('GET'), res)
    const shape = (mockGetSupabaseAdminWithStatus as unknown as { __shape: QueryShape }).__shape
    expect(shape.table).toBe('jobs')
    expect(shape.eqCalls).toEqual([['attribution_status', 'dlq']])
    expect(shape.selectedColumns).toContain('attribution_dlq_reason')
    expect(shape.selectedColumns).toContain('attribution_retry_count')
  })

  it('LD6: orders by attribution_last_retry_at ASC nullsFirst + limit 100', async () => {
    const { res } = makeRes()
    await handler(makeReq('GET'), res)
    const shape = (mockGetSupabaseAdminWithStatus as unknown as { __shape: QueryShape }).__shape
    expect(shape.orderCall).toEqual({
      column: 'attribution_last_retry_at',
      options: { ascending: true, nullsFirst: true },
    })
    expect(shape.limitValue).toBe(100)
  })

  it('LD7: non-GET/POST method → 405', async () => {
    const { res, statusCode } = makeRes()
    await handler(makeReq('PUT'), res)
    expect(statusCode()).toBe(405)
  })
})
