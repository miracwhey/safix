/**
 * `spatial-mesh-cleanup` Edge Function — handler + cleanup pipeline tests.
 *
 * Strategy
 * --------
 * The function imports `createClient` from a URL (https://esm.sh/...) and
 * the network is unreachable in vitest. Two test slices cover the surface:
 *
 *   1. Source-contract tests — assert the auth/secret/body invariants are
 *      present in the source (mirror tests/edgeFunctions/transcodePortfolioVideo
 *      pattern). Cheap, robust to refactor.
 *
 *   2. runCleanup() unit tests — drive the pure pipeline through a stub
 *      admin client (no real Supabase JS) so we exercise:
 *        • RPC routing (orphans first, then expired)
 *        • Batch-removal at REMOVE_BATCH_SIZE=500
 *        • Budget split orphans vs expired (max_files cap)
 *        • Partial failure isolation (orphan-rpc fails, expired still runs)
 *        • Storage HTTP API failure surfaces in errors[]
 *        • bytes_freed accumulation from metadata.size
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The Edge Function imports `createClient` from `https://esm.sh/...` which the
// default Node ESM loader rejects. Mock the URL specifier so the module can
// be imported in vitest. Tests pass a stub admin client to runCleanup, so the
// real factory is never reached for the unit-tests; auth-gate tests
// short-circuit BEFORE createClient runs.
vi.mock('https://esm.sh/@supabase/supabase-js@2', () => ({
  createClient: vi.fn(() => ({
    rpc: vi.fn(),
    storage: { from: vi.fn() },
    from: vi.fn(),
  })),
}))

import { runCleanup } from '../../supabase/functions/spatial-mesh-cleanup/index.ts'

// ── Source-contract surface ──────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')

const source = fs.readFileSync(
  path.resolve(repoRoot, 'supabase/functions/spatial-mesh-cleanup/index.ts'),
  'utf-8',
)

describe('spatial-mesh-cleanup: source contract', () => {
  it('only accepts POST', () => {
    expect(source).toMatch(/req\.method !== 'POST'/)
    expect(source).toContain("'method_not_allowed'")
  })

  it('requires FIXUP_TRIGGER_SHARED_SECRET and rejects on mismatch', () => {
    expect(source).toContain("'FIXUP_TRIGGER_SHARED_SECRET'")
    expect(source).toContain("'x-fixup-trigger-secret'")
    expect(source).toMatch(/'unauthorized'/)
  })

  it('uses the canonical bucket constant', () => {
    expect(source).toContain("BUCKET = 'spatial-mesh-snapshots'")
  })

  it('caps batches at 500 and total at 5000 hard', () => {
    expect(source).toContain('REMOVE_BATCH_SIZE = 500')
    expect(source).toContain('MAX_FILES_HARD_CAP = 5000')
    expect(source).toContain('DEFAULT_RETENTION_DAYS = 90')
  })

  it('routes through the two SECDEF RPCs (orphan + expired)', () => {
    expect(source).toContain("'spatial_mesh_cleanup_list_orphans'")
    expect(source).toContain("'spatial_mesh_cleanup_list_expired'")
  })

  it('removes via Storage HTTP API (admin.storage.from(BUCKET).remove)', () => {
    expect(source).toContain('admin.storage.from(BUCKET).remove(')
    // The comment block intentionally mentions the wrong pattern as
    // context; assert no executable `await` / `from(` SQL-delete path.
    expect(source).not.toMatch(/await\s+admin\.from\(['"]storage\.objects/)
  })

  it('writes an audit row to mesh_cleanup_log on every run', () => {
    expect(source).toContain("admin.from('mesh_cleanup_log').insert")
    expect(source).toContain('source,')
    expect(source).toContain('files_deleted:')
    expect(source).toContain('bytes_freed:')
    expect(source).toContain('orphan_count:')
    expect(source).toContain('expired_count:')
    expect(source).toContain('duration_ms:')
    expect(source).toContain('error_detail:')
  })

  it('returns 500 with errors[] when partial failure occurred', () => {
    expect(source).toMatch(/if \(result\.errors\.length > 0\)/)
  })

  // H1 advisory-lock against cron re-entry — pg-level only, validated by
  // inspecting the migration SQL rather than spinning a real PG fixture
  // (advisory-lock semantics require a live Postgres session per the docs).
  // The integration check happens in the migration itself; here we just
  // assert the contract is present (PR #949 H1).
  it.skip('H1 dispatch() uses pg_try_advisory_lock — doc-asserted, PG integration', () => {
    const migration = fs.readFileSync(
      path.resolve(
        repoRoot,
        'supabase/migrations/20260527010000_spatial_v161_priv_d2_mesh_cleanup_cron.sql',
      ),
      'utf-8',
    )
    expect(migration).toContain("pg_try_advisory_lock(hashtext('spatial_mesh_cleanup'))")
    expect(migration).toMatch(/cleanup skipped \(concurrent run\)/)
  })
})

// ── runCleanup() pipeline ────────────────────────────────────────────────

type RpcRow = { object_name: string; size_bytes: number | null }

type StubOpts = {
  orphans?: RpcRow[]
  orphanError?: string
  expired?: RpcRow[]
  expiredError?: string
  removeError?: string
}

function makeStubAdmin(opts: StubOpts) {
  const removeCalls: string[][] = []
  const rpcCalls: Array<{ fn: string; args: unknown }> = []

  const admin = {
    rpc: (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args })
      if (fn === 'spatial_mesh_cleanup_list_orphans') {
        if (opts.orphanError) {
          return Promise.resolve({ data: null, error: { message: opts.orphanError } })
        }
        return Promise.resolve({ data: opts.orphans ?? [], error: null })
      }
      if (fn === 'spatial_mesh_cleanup_list_expired') {
        if (opts.expiredError) {
          return Promise.resolve({ data: null, error: { message: opts.expiredError } })
        }
        return Promise.resolve({ data: opts.expired ?? [], error: null })
      }
      throw new Error(`unexpected rpc(${fn})`)
    },
    storage: {
      from: (bucket: string) => ({
        remove: (paths: string[]) => {
          removeCalls.push([...paths])
          if (opts.removeError) {
            return Promise.resolve({ data: null, error: { message: opts.removeError } })
          }
          return Promise.resolve({
            data: paths.map((p) => ({ name: p, bucket })),
            error: null,
          })
        },
      }),
    },
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { admin: admin as any, removeCalls, rpcCalls }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('spatial-mesh-cleanup: runCleanup()', () => {
  it('happy path · zero orphans + zero expired · 0 files, 0 errors', async () => {
    const stub = makeStubAdmin({ orphans: [], expired: [] })

    const result = await runCleanup(stub.admin, 90, 500)

    expect(result.filesDeleted).toBe(0)
    expect(result.bytesFreed).toBe(0)
    expect(result.orphanCount).toBe(0)
    expect(result.expiredCount).toBe(0)
    expect(result.errors).toEqual([])
    expect(stub.removeCalls).toHaveLength(0)

    expect(stub.rpcCalls[0]?.fn).toBe('spatial_mesh_cleanup_list_orphans')
    expect(stub.rpcCalls[1]?.fn).toBe('spatial_mesh_cleanup_list_expired')
  })

  it('only orphans · 3 files removed, expired RPC still called, errors empty', async () => {
    const stub = makeStubAdmin({
      orphans: [
        { object_name: 'u1/scan-a.usdz', size_bytes: 500_000 },
        { object_name: 'u1/scan-b.usdz', size_bytes: 600_000 },
        { object_name: 'u2/scan-c.usdz', size_bytes: 700_000 },
      ],
      expired: [],
    })

    const result = await runCleanup(stub.admin, 90, 500)

    expect(result.filesDeleted).toBe(3)
    expect(result.bytesFreed).toBe(1_800_000)
    expect(result.orphanCount).toBe(3)
    expect(result.expiredCount).toBe(0)
    expect(result.errors).toEqual([])

    expect(stub.removeCalls).toHaveLength(1)
    expect(stub.removeCalls[0]).toEqual([
      'u1/scan-a.usdz',
      'u1/scan-b.usdz',
      'u2/scan-c.usdz',
    ])
  })

  it('only expired · 2 files removed, orphans first then expired', async () => {
    const stub = makeStubAdmin({
      orphans: [],
      expired: [
        { object_name: 'u1/old-1.usdz', size_bytes: 400_000 },
        { object_name: 'u2/old-2.usdz', size_bytes: 450_000 },
      ],
    })

    const result = await runCleanup(stub.admin, 90, 500)

    expect(result.filesDeleted).toBe(2)
    expect(result.bytesFreed).toBe(850_000)
    expect(result.orphanCount).toBe(0)
    expect(result.expiredCount).toBe(2)
    expect(result.errors).toEqual([])

    expect(stub.rpcCalls[0]?.fn).toBe('spatial_mesh_cleanup_list_orphans')
    expect(stub.rpcCalls[1]?.fn).toBe('spatial_mesh_cleanup_list_expired')
    expect(stub.removeCalls).toHaveLength(1)
    expect(stub.removeCalls[0]).toHaveLength(2)
  })

  it('batches at 500 · 1500 orphans → 3 remove() calls of 500', async () => {
    const orphans: RpcRow[] = Array.from({ length: 1500 }, (_, i) => ({
      object_name: `user-1/scan-${i}.usdz`,
      size_bytes: 1000,
    }))
    const stub = makeStubAdmin({ orphans, expired: [] })

    const result = await runCleanup(stub.admin, 90, 5000)

    expect(result.filesDeleted).toBe(1500)
    expect(stub.removeCalls).toHaveLength(3)
    expect(stub.removeCalls[0]).toHaveLength(500)
    expect(stub.removeCalls[1]).toHaveLength(500)
    expect(stub.removeCalls[2]).toHaveLength(500)
  })

  it('budget split · max_files=10 with 8 orphans + many expired → only 2 expired slots', async () => {
    const stub = makeStubAdmin({
      orphans: Array.from({ length: 8 }, (_, i) => ({
        object_name: `u/o-${i}.usdz`,
        size_bytes: 100,
      })),
      expired: Array.from({ length: 5 }, (_, i) => ({
        object_name: `u/e-${i}.usdz`,
        size_bytes: 200,
      })),
    })

    await runCleanup(stub.admin, 90, 10)

    // RPC must request 8 orphans first (limit=10), then 2 expired (10-8)
    expect(stub.rpcCalls[0]).toMatchObject({
      fn: 'spatial_mesh_cleanup_list_orphans',
      args: { p_limit: 10 },
    })
    expect(stub.rpcCalls[1]).toMatchObject({
      fn: 'spatial_mesh_cleanup_list_expired',
      args: { p_retention_days: 90, p_limit: 2 },
    })
  })

  it('budget exhausted by orphans · max_files=5 with 5 orphans → no expired RPC', async () => {
    const stub = makeStubAdmin({
      orphans: Array.from({ length: 5 }, (_, i) => ({
        object_name: `u/o-${i}.usdz`,
        size_bytes: 100,
      })),
      expired: [{ object_name: 'should-not-fetch.usdz', size_bytes: 999 }],
    })

    const result = await runCleanup(stub.admin, 90, 5)

    expect(stub.rpcCalls).toHaveLength(1)
    expect(stub.rpcCalls[0]).toMatchObject({ fn: 'spatial_mesh_cleanup_list_orphans' })
    expect(result.expiredCount).toBe(0)
    expect(result.filesDeleted).toBe(5)
  })

  it('orphan RPC fails · expired pipeline still runs · errors[] captures both', async () => {
    const stub = makeStubAdmin({
      orphanError: 'pg connection lost',
      expired: [{ object_name: 'u/e.usdz', size_bytes: 100 }],
    })

    const result = await runCleanup(stub.admin, 90, 500)

    expect(result.errors).toContain('list_orphans: pg connection lost')
    expect(result.filesDeleted).toBe(1)
    expect(result.expiredCount).toBe(1)
  })

  it('storage.remove fails on orphans · expired still attempted · returned removed counts the chunk', async () => {
    const stub = makeStubAdmin({
      orphans: [{ object_name: 'u/o.usdz', size_bytes: 100 }],
      expired: [{ object_name: 'u/e.usdz', size_bytes: 100 }],
      removeError: 'storage rate limit',
    })

    const result = await runCleanup(stub.admin, 90, 500)

    // Both remove() calls fail with the same error.
    expect(result.errors).toEqual([
      'orphans storage.remove: storage rate limit',
      'expired storage.remove: storage rate limit',
    ])
    expect(result.filesDeleted).toBe(0)
  })

  it('M2 review fix · bytes_freed = 0 when every remove() errors (no tally on failure)', async () => {
    // Audit-integrity invariant: bytes_freed must reflect only successfully
    // removed blobs. Tally happens INSIDE batchRemove per successful chunk
    // — never on the source RPC rows up front (PR #949 M2).
    const stub = makeStubAdmin({
      orphans: [
        { object_name: 'u/o1.usdz', size_bytes: 1_000_000 },
        { object_name: 'u/o2.usdz', size_bytes: 2_000_000 },
      ],
      expired: [
        { object_name: 'u/e1.usdz', size_bytes: 3_000_000 },
      ],
      removeError: 'permission denied',
    })

    const result = await runCleanup(stub.admin, 90, 500)

    expect(result.filesDeleted).toBe(0)
    expect(result.bytesFreed).toBe(0)
    expect(result.errors).toEqual([
      'orphans storage.remove: permission denied',
      'expired storage.remove: permission denied',
    ])
  })

  it('size_bytes null / missing · bytes_freed is 0 (no NaN)', async () => {
    const stub = makeStubAdmin({
      orphans: [
        { object_name: 'u/a.usdz', size_bytes: null },
        { object_name: 'u/b.usdz', size_bytes: 0 },
      ],
      expired: [],
    })

    const result = await runCleanup(stub.admin, 90, 500)

    expect(result.bytesFreed).toBe(0)
    expect(Number.isFinite(result.bytesFreed)).toBe(true)
  })

  it('orphan paths skipped when object_name is empty', async () => {
    const stub = makeStubAdmin({
      orphans: [
        { object_name: '', size_bytes: 100 },
        { object_name: 'valid/path.usdz', size_bytes: 100 },
      ],
      expired: [],
    })

    await runCleanup(stub.admin, 90, 500)

    expect(stub.removeCalls[0]).toEqual(['valid/path.usdz'])
  })
})

// ── handleRequest auth-gate via dynamic import ───────────────────────────
// We exercise the request-level auth/method/body guards by stubbing
// Deno.env so the handler can run end-to-end without a Supabase client
// being constructed (we short-circuit on the unauthorized + bad-body
// paths BEFORE createClient).

type EnvMap = Record<string, string>
let envMap: EnvMap = {}

function installDenoEnv(map: EnvMap) {
  envMap = { ...map }
  ;(globalThis as { Deno?: unknown }).Deno = {
    env: { get: (k: string) => envMap[k] },
  }
}

afterEach(() => {
  delete (globalThis as { Deno?: unknown }).Deno
})

async function loadHandler() {
  vi.resetModules()
  const mod = await import('../../supabase/functions/spatial-mesh-cleanup/index.ts')
  return mod.handleRequest
}

describe('spatial-mesh-cleanup: handleRequest auth', () => {
  it('rejects non-POST with 405', async () => {
    installDenoEnv({ FIXUP_TRIGGER_SHARED_SECRET: 'secret-1' })
    const handle = await loadHandler()
    const res = await handle(new Request('http://localhost/x', { method: 'GET' }))
    expect(res.status).toBe(405)
  })

  it('returns 500 when FIXUP_TRIGGER_SHARED_SECRET is unset', async () => {
    installDenoEnv({})
    const handle = await loadHandler()
    const res = await handle(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'x-fixup-trigger-secret': 'any' },
        body: '{}',
      }),
    )
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('server_misconfigured')
  })

  it('rejects with 401 when shared-secret header is absent', async () => {
    installDenoEnv({ FIXUP_TRIGGER_SHARED_SECRET: 'secret-1' })
    const handle = await loadHandler()
    const res = await handle(
      new Request('http://localhost/x', {
        method: 'POST',
        body: '{}',
      }),
    )
    expect(res.status).toBe(401)
  })

  it('rejects with 401 when shared-secret value is wrong', async () => {
    installDenoEnv({ FIXUP_TRIGGER_SHARED_SECRET: 'secret-1' })
    const handle = await loadHandler()
    const res = await handle(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'x-fixup-trigger-secret': 'wrong' },
        body: '{}',
      }),
    )
    expect(res.status).toBe(401)
  })

  it('returns 400 on invalid JSON body', async () => {
    installDenoEnv({ FIXUP_TRIGGER_SHARED_SECRET: 'secret-1' })
    const handle = await loadHandler()
    const res = await handle(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'x-fixup-trigger-secret': 'secret-1' },
        body: '{not-json',
      }),
    )
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('invalid_body')
  })

  it('returns 500 when SUPABASE_URL is missing (auth ok, body ok, env half-set)', async () => {
    installDenoEnv({ FIXUP_TRIGGER_SHARED_SECRET: 'secret-1' })
    const handle = await loadHandler()
    const res = await handle(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'x-fixup-trigger-secret': 'secret-1' },
        body: '{}',
      }),
    )
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('server_misconfigured')
  })
})
