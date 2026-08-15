/**
 * /api/operator/resolve-attribution — handler tests.
 *
 * Covers:
 *   OR1.  Non-operator caller → 403 (before any RPC call).
 *   OR2.  Valid resolve path → 200 with forwarded RPC outcome.
 *   OR3.  Invalid mode → 400.
 *   OR4.  Missing reason → 400.
 *   OR5.  Invalid toOrigin for resolve/reclassify → 400.
 *   OR6.  toOrigin present on reject → 400.
 *   OR7.  RPC SQLSTATE P0001 → 409 invalid_transition.
 *   OR8.  RPC SQLSTATE P0002 → 404 job_not_found.
 *   OR9.  RPC SQLSTATE 42501 → 403 forbidden.
 *   OR10. Unexpected RPC error → 500 rpc_failed.
 *   OR11. operator_id forwarded is the authenticated user (no spoofing).
 *   OR12. reject path: to_origin=null is sent to RPC.
 */

const { mockRequireAuth } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
}))

const { mockGetSupabaseAdminWithStatus, mockFetchIsOperator } = vi.hoisted(() => ({
  mockGetSupabaseAdminWithStatus: vi.fn(),
  mockFetchIsOperator: vi.fn(),
}))

const { mockRpc } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
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
import handler from '../../api/operator/resolve-attribution'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeReq(body: Record<string, unknown> = {}): VercelRequest {
  return {
    method: 'POST',
    headers: {},
    url: '/api/operator/resolve-attribution',
    body,
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

const OPERATOR_ID = 'user-operator-1'
const JOB_ID = 'job-dlq-1'

// ── fixtures ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireAuth.mockResolvedValue({ userId: OPERATOR_ID })
  mockFetchIsOperator.mockResolvedValue(true)
  mockGetSupabaseAdminWithStatus.mockReturnValue({
    ok: true,
    client: { rpc: mockRpc },
  })
  mockRpc.mockResolvedValue({
    data: {
      outcome: 'resolved',
      mode: 'resolve',
      jobId: JOB_ID,
      fromStatus: 'dlq',
      toStatus: 'finalized',
      fromOrigin: null,
      toOrigin: 'merchant_brought',
    },
    error: null,
  })
})

// ── tests ────────────────────────────────────────────────────────────────────

describe('/api/operator/resolve-attribution', () => {
  // OR1
  it('OR1: non-operator caller → 403, no RPC invoked', async () => {
    mockFetchIsOperator.mockResolvedValue(false)
    const { res, statusCode, body } = makeRes()
    await handler(
      makeReq({ jobId: JOB_ID, mode: 'resolve', toOrigin: 'merchant_brought', reason: 'ok' }),
      res,
    )
    expect(statusCode()).toBe(403)
    expect((body() as { error: string }).error).toBe('forbidden')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  // OR2
  it('OR2: valid resolve path → 200 with RPC outcome', async () => {
    const { res, statusCode, body } = makeRes()
    await handler(
      makeReq({ jobId: JOB_ID, mode: 'resolve', toOrigin: 'merchant_brought', reason: 'legitimate invite' }),
      res,
    )
    expect(statusCode()).toBe(200)
    const payload = body()
    expect(payload.outcome).toBe('resolved')
    expect(payload.mode).toBe('resolve')
    expect(payload.toOrigin).toBe('merchant_brought')
  })

  // OR3
  it('OR3: invalid mode → 400', async () => {
    const { res, statusCode, body } = makeRes()
    await handler(
      makeReq({ jobId: JOB_ID, mode: 'noop', toOrigin: 'merchant_brought', reason: 'x' }),
      res,
    )
    expect(statusCode()).toBe(400)
    expect((body() as { error: string }).error).toBe('validation_error')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  // OR4
  it('OR4: missing reason → 400', async () => {
    const { res, statusCode, body } = makeRes()
    await handler(
      makeReq({ jobId: JOB_ID, mode: 'resolve', toOrigin: 'merchant_brought', reason: '   ' }),
      res,
    )
    expect(statusCode()).toBe(400)
    expect((body() as { message: string }).message).toMatch(/reason is required/i)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  // OR5
  it('OR5: invalid toOrigin for resolve → 400', async () => {
    const { res, statusCode, body } = makeRes()
    await handler(
      makeReq({ jobId: JOB_ID, mode: 'resolve', toOrigin: 'something_else', reason: 'r' }),
      res,
    )
    expect(statusCode()).toBe(400)
    expect((body() as { error: string }).error).toBe('validation_error')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  // OR6
  it('OR6: toOrigin present on reject → 400', async () => {
    const { res, statusCode, body } = makeRes()
    await handler(
      makeReq({ jobId: JOB_ID, mode: 'reject', toOrigin: 'merchant_brought', reason: 'bad data' }),
      res,
    )
    expect(statusCode()).toBe(400)
    expect((body() as { message: string }).message).toMatch(/toOrigin must be omitted/)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  // OR7
  it('OR7: RPC SQLSTATE P0001 → 409 invalid_transition', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'invalid_transition: resolve requires pending|retrying|dlq' },
    })
    const { res, statusCode, body } = makeRes()
    await handler(
      makeReq({ jobId: JOB_ID, mode: 'resolve', toOrigin: 'merchant_brought', reason: 'r' }),
      res,
    )
    expect(statusCode()).toBe(409)
    expect((body() as { error: string }).error).toBe('invalid_transition')
  })

  // OR8
  it('OR8: RPC SQLSTATE P0002 → 404 job_not_found', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: 'P0002', message: 'job_not_found: abc' },
    })
    const { res, statusCode, body } = makeRes()
    await handler(
      makeReq({ jobId: JOB_ID, mode: 'resolve', toOrigin: 'merchant_brought', reason: 'r' }),
      res,
    )
    expect(statusCode()).toBe(404)
    expect((body() as { error: string }).error).toBe('job_not_found')
  })

  // OR9
  it('OR9: RPC SQLSTATE 42501 → 403 forbidden (DB-level double-check)', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'unauthorized: caller is not an operator' },
    })
    const { res, statusCode, body } = makeRes()
    await handler(
      makeReq({ jobId: JOB_ID, mode: 'resolve', toOrigin: 'merchant_brought', reason: 'r' }),
      res,
    )
    expect(statusCode()).toBe(403)
    expect((body() as { error: string }).error).toBe('forbidden')
  })

  // OR10
  it('OR10: unexpected RPC error → 500 rpc_failed', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '40001', message: 'serialization_failure' },
    })
    const { res, statusCode, body } = makeRes()
    await handler(
      makeReq({ jobId: JOB_ID, mode: 'resolve', toOrigin: 'merchant_brought', reason: 'r' }),
      res,
    )
    expect(statusCode()).toBe(500)
    expect((body() as { error: string }).error).toBe('rpc_failed')
  })

  // OR11
  it('OR11: operator_id forwarded to RPC is the authenticated user (no spoofing)', async () => {
    const { res } = makeRes()
    await handler(
      makeReq({
        jobId: JOB_ID,
        mode: 'resolve',
        toOrigin: 'merchant_brought',
        reason: 'legit',
        // Spoof attempt: body carries a different operatorId
        operatorId: 'spoofed-user-id',
      }),
      res,
    )
    expect(mockRpc).toHaveBeenCalledWith(
      'operator_resolve_attribution',
      expect.objectContaining({
        p_operator_id: OPERATOR_ID, // authenticated session user, NOT body value
      }),
    )
  })

  // OR12
  it('OR12: reject mode forwards p_to_origin=null to RPC', async () => {
    mockRpc.mockResolvedValue({
      data: {
        outcome: 'resolved',
        mode: 'reject',
        jobId: JOB_ID,
        fromStatus: 'pending',
        toStatus: 'dlq',
        fromOrigin: null,
        toOrigin: null,
      },
      error: null,
    })
    const { res, statusCode } = makeRes()
    await handler(
      makeReq({ jobId: JOB_ID, mode: 'reject', reason: 'data anomaly' }),
      res,
    )
    expect(statusCode()).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith(
      'operator_resolve_attribution',
      expect.objectContaining({ p_mode: 'reject', p_to_origin: null }),
    )
  })

  // OR13 — reject on a row already in dlq succeeds (migration 20260420000005).
  // The RPC widening means the handler no longer sees P0001 for the "keep
  // frozen / re-affirm" action from the DLQ screen.  Response payload surfaces
  // fromStatus='dlq' / toStatus='dlq' so the UI can render a non-transition
  // confirmation.
  it('OR13: reject on dlq returns 200 with fromStatus=dlq toStatus=dlq', async () => {
    mockRpc.mockResolvedValue({
      data: {
        outcome: 'resolved',
        mode: 'reject',
        jobId: JOB_ID,
        fromStatus: 'dlq',
        toStatus: 'dlq',
        fromOrigin: null,
        toOrigin: null,
      },
      error: null,
    })
    const { res, statusCode, body } = makeRes()
    await handler(
      makeReq({ jobId: JOB_ID, mode: 'reject', reason: 'reviewed — keep frozen, waiting customer contact' }),
      res,
    )
    expect(statusCode()).toBe(200)
    const payload = body()
    expect(payload.outcome).toBe('resolved')
    expect(payload.mode).toBe('reject')
    expect(payload.fromStatus).toBe('dlq')
    expect(payload.toStatus).toBe('dlq')
  })
})
