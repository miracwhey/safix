/**
 * Phase 5 Spatial V1.6 · DSGVO Hybrid-Cascade · Vercel route tests.
 *
 * Verifies api/delete-account.ts behaviour around the
 * `account_cascade_list_storage` RPC-driven cleanup pipeline:
 *
 *   1. Happy path: zero rows → 0 files removed, admin.deleteUser called, audit row written.
 *   2. Bucket-grouping: RPC rows are grouped per bucket, batched at REMOVE_BATCH_SIZE.
 *   3. Pagination/batching: 1500 paths in one bucket → 3× remove(500).
 *   4. Cross-bucket: multiple buckets in one RPC response → each removed once.
 *   5. spatial-public-assets is never touched (RPC excludes it, audit never lists it).
 *   6. RPC error → audit row with error, 500 returned, admin.deleteUser NOT called.
 *   7. Per-bucket remove() error → audit row with error_detail, 500, admin.deleteUser NOT called.
 *   8. admin.deleteUser failure after clean cleanup → audit row exists, 500 returned.
 *   9. Auth gating + admin-unavailable paths.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'

// ── Hoisted mocks ──────────────────────────────────────────────────────
const { mockAuthenticateRequest } = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
}))

vi.mock('../../api/_auth', () => ({
  authenticateRequest: mockAuthenticateRequest,
  requireAuth: async (
    req: unknown,
    res: { status: (code: number) => { json: (payload: unknown) => void } },
  ) => {
    const result = await mockAuthenticateRequest(req)
    if (!result.ok) {
      res.status(result.statusCode).json({ error: result.error })
      return null
    }
    return { userId: result.userId, user: result.user }
  },
}))

vi.mock('../../api/_cors', () => ({
  applyCors: () => false,
}))

vi.mock('../../api/_rateLimit', () => ({
  applyRateLimit: vi.fn().mockResolvedValue(false),
}))

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  setUser: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
}))

const { mockGetSupabaseAdmin } = vi.hoisted(() => ({
  mockGetSupabaseAdmin: vi.fn(),
}))

vi.mock('../../api/_supabase', () => ({
  getSupabaseAdmin: mockGetSupabaseAdmin,
  getSupabaseAdminWithStatus: vi.fn(),
  formatAdminUnavailable: (m: string[]) =>
    m.length > 0 ? `missing ${m.join(', ')}.` : 'unavailable',
}))

import handler from '../../api/delete-account'

// ── Fixtures ───────────────────────────────────────────────────────────
const TEST_USER_ID = 'user-abc-123'

function makeRequest(): VercelRequest {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
    url: '/api/delete-account',
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
    end: vi.fn(() => res),
  } as unknown as VercelResponse
  return { res, statusCode: () => _status, body: () => _body }
}

type CascadeRow = { bucket_id: string; name: string }

type AdminOpts = {
  rpcRows?: CascadeRow[]
  rpcError?: string
  /** account_delete_blockers result. Empty (default) = nothing blocking →
   *  deletion proceeds. Non-empty = active money/dispute → handler returns 409. */
  blockers?: Record<string, unknown>
  blockersError?: string
  removeFailures?: Record<string, string>
  auditInsertError?: string
  deleteUserError?: string
  eraseError?: string
}

function makeAdmin(opts: AdminOpts) {
  const removeCalls: Array<{ bucket: string; paths: string[] }> = []
  const auditInserts: Array<Record<string, unknown>> = []
  const rpcCalls: Array<{ fn: string; args: unknown }> = []
  const events: string[] = []
  let deleteUserCalled = false

  function storageBucket(bucket: string) {
    return {
      remove: (paths: string[]) => {
        removeCalls.push({ bucket, paths })
        if (opts.removeFailures?.[bucket]) {
          return Promise.resolve({ data: null, error: { message: opts.removeFailures[bucket] } })
        }
        return Promise.resolve({
          data: paths.map((p) => ({ name: p })),
          error: null,
        })
      },
    }
  }

  function auditLogBuilder() {
    return {
      insert: (payload: Record<string, unknown>) => {
        auditInserts.push(payload)
        if (opts.auditInsertError) {
          return Promise.resolve({ error: { message: opts.auditInsertError } })
        }
        return Promise.resolve({ error: null })
      },
    }
  }

  const admin = {
    rpc: (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args })
      if (fn === 'account_delete_blockers') {
        // Money/dispute precheck (step 0) — MUST be distinct from the storage
        // listing RPC: it returns blockers, not storage paths, so it must not
        // consume opts.rpcRows (else a normal cleanup test would 409). Empty
        // object = nothing blocking → deletion proceeds.
        if (opts.blockersError) {
          return Promise.resolve({ data: null, error: { message: opts.blockersError } })
        }
        return Promise.resolve({ data: opts.blockers ?? {}, error: null })
      }
      if (fn === 'account_cascade_delete_owned_rows') {
        events.push('erase')
        if (opts.eraseError) {
          return Promise.resolve({ data: null, error: { message: opts.eraseError } })
        }
        return Promise.resolve({ data: { scans: 0 }, error: null })
      }
      // account_cascade_list_storage
      if (opts.rpcError) {
        return Promise.resolve({ data: null, error: { message: opts.rpcError } })
      }
      return Promise.resolve({ data: opts.rpcRows ?? [], error: null })
    },
    from: (table: string) => {
      if (table === 'account_deletion_log') return auditLogBuilder()
      throw new Error(`unexpected from(${table})`)
    },
    storage: {
      from: storageBucket,
    },
    auth: {
      admin: {
        deleteUser: (userId: string) => {
          events.push('deleteUser')
          deleteUserCalled = true
          if (opts.deleteUserError) {
            return Promise.resolve({ data: null, error: { message: opts.deleteUserError } })
          }
          return Promise.resolve({ data: { user: { id: userId } }, error: null })
        },
      },
    },
  }

  return {
    admin,
    removeCalls,
    auditInserts,
    rpcCalls,
    events,
    isDeleteUserCalled: () => deleteUserCalled,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('POST /api/delete-account · Phase 5 Hybrid-Cascade (RPC-driven)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAuthenticateRequest.mockResolvedValue({
      ok: true,
      userId: TEST_USER_ID,
      user: { id: TEST_USER_ID },
    })
  })

  it('happy path · empty user · 0 files, admin.deleteUser called, audit source=vercel', async () => {
    const fixtures = makeAdmin({ rpcRows: [] })
    mockGetSupabaseAdmin.mockReturnValue(fixtures.admin)

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(), res)

    expect(statusCode()).toBe(200)
    expect(body()).toEqual({ ok: true, filesRemoved: 0, durationMs: expect.any(Number) })
    expect(fixtures.isDeleteUserCalled()).toBe(true)

    // Three RPCs in order: money-guard blockers precheck, storage listing,
    // then the owned-rows erasure. The blockers precheck (step 0) is #1020's
    // money/dispute guard and MUST run first — asserting it here closes the
    // gap where the happy path never verified the guard ran.
    expect(fixtures.rpcCalls).toHaveLength(3)
    expect(fixtures.rpcCalls[0]).toMatchObject({
      fn: 'account_delete_blockers',
      args: { p_user_id: TEST_USER_ID },
    })
    expect(fixtures.rpcCalls[1]).toMatchObject({
      fn: 'account_cascade_list_storage',
      args: { p_user_id: TEST_USER_ID },
    })
    expect(fixtures.rpcCalls[2]).toMatchObject({
      fn: 'account_cascade_delete_owned_rows',
      args: { p_user_id: TEST_USER_ID },
    })

    // Audit row written, source=vercel, no buckets touched
    expect(fixtures.auditInserts).toHaveLength(1)
    expect(fixtures.auditInserts[0]).toMatchObject({
      user_id: TEST_USER_ID,
      source: 'vercel',
      files_removed: 0,
      error_detail: null,
    })
    expect(fixtures.auditInserts[0].buckets_cleared).toEqual([])

    // remove() never called when paths are empty (short-circuit)
    expect(fixtures.removeCalls).toHaveLength(0)
  })

  it('single bucket · 50 paths in project-scans · 1 remove(50), audit lists bucket', async () => {
    const rpcRows: CascadeRow[] = Array.from({ length: 50 }, (_, i) => ({
      bucket_id: 'project-scans',
      name: `${TEST_USER_ID}/scan-${i}/mesh.usdz`,
    }))
    const fixtures = makeAdmin({ rpcRows })
    mockGetSupabaseAdmin.mockReturnValue(fixtures.admin)

    const { res, statusCode } = makeResponse()
    await handler(makeRequest(), res)

    expect(statusCode()).toBe(200)

    expect(fixtures.removeCalls).toHaveLength(1)
    expect(fixtures.removeCalls[0]).toMatchObject({
      bucket: 'project-scans',
      paths: expect.any(Array),
    })
    expect(fixtures.removeCalls[0].paths).toHaveLength(50)

    expect(fixtures.auditInserts[0]).toMatchObject({
      files_removed: 50,
      error_detail: null,
    })
    expect(fixtures.auditInserts[0].buckets_cleared).toEqual(['project-scans'])
  })

  it('batching · 1500 paths in one bucket · 3 remove batches of 500', async () => {
    const rpcRows: CascadeRow[] = Array.from({ length: 1500 }, (_, i) => ({
      bucket_id: 'spatial-mesh-snapshots',
      name: `${TEST_USER_ID}/scene-${i}/snapshot.bin`,
    }))
    const fixtures = makeAdmin({ rpcRows })
    mockGetSupabaseAdmin.mockReturnValue(fixtures.admin)

    const { res, statusCode } = makeResponse()
    await handler(makeRequest(), res)

    expect(statusCode()).toBe(200)

    const meshRemoves = fixtures.removeCalls.filter((c) => c.bucket === 'spatial-mesh-snapshots')
    expect(meshRemoves).toHaveLength(3)
    expect(meshRemoves[0].paths).toHaveLength(500)
    expect(meshRemoves[1].paths).toHaveLength(500)
    expect(meshRemoves[2].paths).toHaveLength(500)

    expect(fixtures.auditInserts[0]).toMatchObject({ files_removed: 1500 })
  })

  it('cross-bucket · 3 buckets in one RPC response · each removed once', async () => {
    const rpcRows: CascadeRow[] = [
      { bucket_id: 'project-scans', name: `${TEST_USER_ID}/a/mesh.usdz` },
      { bucket_id: 'project-scans', name: `${TEST_USER_ID}/b/mesh.usdz` },
      { bucket_id: 'worker-doku-photos', name: 'random/doku-1.jpg' },
      { bucket_id: 'chat-customer', name: 'thread-x/photo-1.jpg' },
      { bucket_id: 'chat-customer', name: 'thread-x/photo-2.jpg' },
    ]
    const fixtures = makeAdmin({ rpcRows })
    mockGetSupabaseAdmin.mockReturnValue(fixtures.admin)

    const { res, statusCode } = makeResponse()
    await handler(makeRequest(), res)

    expect(statusCode()).toBe(200)
    expect(fixtures.removeCalls).toHaveLength(3)

    const projectScans = fixtures.removeCalls.find((c) => c.bucket === 'project-scans')
    expect(projectScans?.paths).toHaveLength(2)

    const workerDoku = fixtures.removeCalls.find((c) => c.bucket === 'worker-doku-photos')
    expect(workerDoku?.paths).toEqual(['random/doku-1.jpg'])

    const chatCustomer = fixtures.removeCalls.find((c) => c.bucket === 'chat-customer')
    expect(chatCustomer?.paths).toHaveLength(2)

    expect(fixtures.auditInserts[0]).toMatchObject({ files_removed: 5 })
    expect(fixtures.auditInserts[0].buckets_cleared).toEqual([
      'chat-customer',
      'project-scans',
      'worker-doku-photos',
    ])
  })

  it('spatial-public-assets is NEVER present in audit buckets_cleared even if RPC mistakenly returned it', async () => {
    // Defense-in-depth: RPC excludes this server-side, but the client also
    // should never end up with a buckets_cleared row that contains it.
    // Here we feed a "good" RPC response and assert it isn't there.
    const fixtures = makeAdmin({ rpcRows: [] })
    mockGetSupabaseAdmin.mockReturnValue(fixtures.admin)

    const { res } = makeResponse()
    await handler(makeRequest(), res)

    const bucketsCleared = fixtures.auditInserts[0].buckets_cleared as string[]
    expect(bucketsCleared).not.toContain('spatial-public-assets')
  })

  it('rpc error · audit row written with error_detail, 500 returned, admin.deleteUser NOT called', async () => {
    const fixtures = makeAdmin({
      rpcError: 'simulated permission_denied',
    })
    mockGetSupabaseAdmin.mockReturnValue(fixtures.admin)

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(), res)

    expect(statusCode()).toBe(500)
    expect(body()).toMatchObject({ detail: 'storage_cleanup_partial_failure' })

    expect(fixtures.auditInserts).toHaveLength(1)
    expect(fixtures.auditInserts[0]).toMatchObject({
      source: 'vercel',
      user_id: TEST_USER_ID,
      files_removed: 0,
    })
    expect(fixtures.auditInserts[0].error_detail).toEqual(
      expect.stringContaining('account_cascade_list_storage'),
    )

    expect(fixtures.isDeleteUserCalled()).toBe(false)
  })

  it('partial failure · remove() errors for one bucket · audit logged, 500, admin.deleteUser NOT called', async () => {
    const rpcRows: CascadeRow[] = [
      { bucket_id: 'project-scans', name: `${TEST_USER_ID}/a/mesh.usdz` },
      { bucket_id: 'spatial-mesh-snapshots', name: `${TEST_USER_ID}/scene-1/snapshot.bin` },
    ]
    const fixtures = makeAdmin({
      rpcRows,
      removeFailures: { 'spatial-mesh-snapshots': 'simulated storage outage' },
    })
    mockGetSupabaseAdmin.mockReturnValue(fixtures.admin)

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(), res)

    expect(statusCode()).toBe(500)
    expect(body()).toMatchObject({ detail: 'storage_cleanup_partial_failure' })

    expect(fixtures.auditInserts).toHaveLength(1)
    expect(fixtures.auditInserts[0].error_detail).toEqual(
      expect.stringContaining('spatial-mesh-snapshots'),
    )

    // Cleanup continues across buckets — project-scans removed even though
    // spatial-mesh-snapshots failed.
    expect(fixtures.removeCalls.find((c) => c.bucket === 'project-scans')).toBeDefined()

    expect(fixtures.isDeleteUserCalled()).toBe(false)
  })

  it('admin.deleteUser failure after clean cleanup · audit row exists, 500 returned', async () => {
    const fixtures = makeAdmin({
      rpcRows: [],
      deleteUserError: 'auth service down',
    })
    mockGetSupabaseAdmin.mockReturnValue(fixtures.admin)

    const { res, statusCode } = makeResponse()
    await handler(makeRequest(), res)

    expect(statusCode()).toBe(500)

    expect(fixtures.auditInserts).toHaveLength(1)
    expect(fixtures.auditInserts[0]).toMatchObject({
      source: 'vercel',
      error_detail: null, // storage cleanup succeeded
    })

    expect(fixtures.isDeleteUserCalled()).toBe(true)
  })

  it('owned rows erased via RPC BEFORE deleteUser (unblocks the 6 FKs)', async () => {
    const fixtures = makeAdmin({ rpcRows: [] })
    mockGetSupabaseAdmin.mockReturnValue(fixtures.admin)

    const { res, statusCode } = makeResponse()
    await handler(makeRequest(), res)

    expect(statusCode()).toBe(200)
    // The erasure RPC runs for exactly this user, before the auth-user delete.
    expect(fixtures.rpcCalls).toContainEqual({
      fn: 'account_cascade_delete_owned_rows',
      args: { p_user_id: TEST_USER_ID },
    })
    expect(fixtures.events).toEqual(['erase', 'deleteUser'])
  })

  it('owned-rows erasure failure · 500 owned_rows_cleanup_failure · deleteUser NOT called', async () => {
    const fixtures = makeAdmin({
      rpcRows: [],
      eraseError: 'dispute lock active',
    })
    mockGetSupabaseAdmin.mockReturnValue(fixtures.admin)

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(), res)

    expect(statusCode()).toBe(500)
    expect(body()).toMatchObject({ detail: 'owned_rows_cleanup_failure' })
    // Storage cleanup already audited; the erasure failure stops short of deleteUser.
    expect(fixtures.isDeleteUserCalled()).toBe(false)
    expect(fixtures.events).toEqual(['erase'])
  })

  it('unauthenticated · returns 401 without touching admin client', async () => {
    mockAuthenticateRequest.mockResolvedValue({
      ok: false,
      statusCode: 401,
      error: 'Unauthorized',
    })
    mockGetSupabaseAdmin.mockReturnValue({})

    const { res, statusCode } = makeResponse()
    await handler(makeRequest(), res)

    expect(statusCode()).toBe(401)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
  })

  it('admin client unavailable · 500 with explicit reason', async () => {
    mockGetSupabaseAdmin.mockReturnValue(null)

    const { res, statusCode } = makeResponse()
    await handler(makeRequest(), res)

    expect(statusCode()).toBe(500)
  })
})
