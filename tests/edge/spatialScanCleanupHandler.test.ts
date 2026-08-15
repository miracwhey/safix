/**
 * `spatial-scan-cleanup` Edge Function — handler + cleanup pipeline tests.
 *
 * Mirrors tests/edge/spatialMeshCleanupHandler.test.ts. Two slices:
 *   1. Source-contract tests — auth/secret/body/bucket/RPC invariants in source.
 *   2. runCleanup() unit tests via a stub admin client (no real Supabase JS):
 *        • RPC routing (orphans first, then expired)
 *        • Batch removal at REMOVE_BATCH_SIZE=500 + budget split
 *        • Expired pass prunes scan_assets rows for removed blobs (rowsPruned)
 *        • Partial-failure isolation + Storage HTTP API failure surfacing
 *        • bytes_freed accumulation, tallied only on successful removal
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('https://esm.sh/@supabase/supabase-js@2', () => ({
  createClient: vi.fn(() => ({
    rpc: vi.fn(),
    storage: { from: vi.fn() },
    from: vi.fn(),
  })),
}))

import { runCleanup } from '../../supabase/functions/spatial-scan-cleanup/index.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')

const source = fs.readFileSync(
  path.resolve(repoRoot, 'supabase/functions/spatial-scan-cleanup/index.ts'),
  'utf-8',
)

// ── Source-contract surface ──────────────────────────────────────────────

describe('spatial-scan-cleanup: source contract', () => {
  it('only accepts POST', () => {
    expect(source).toMatch(/req\.method !== 'POST'/)
    expect(source).toContain("'method_not_allowed'")
  })

  it('requires FIXUP_TRIGGER_SHARED_SECRET and rejects on mismatch', () => {
    expect(source).toContain("'FIXUP_TRIGGER_SHARED_SECRET'")
    expect(source).toContain("'x-fixup-trigger-secret'")
    expect(source).toMatch(/'unauthorized'/)
  })

  it('uses the project-scans bucket constant', () => {
    expect(source).toContain("BUCKET = 'project-scans'")
  })

  it('caps batches at 500 and total at 5000 hard', () => {
    expect(source).toContain('REMOVE_BATCH_SIZE = 500')
    expect(source).toContain('MAX_FILES_HARD_CAP = 5000')
    expect(source).toContain('DEFAULT_RETENTION_DAYS = 90')
  })

  it('routes through the two SECDEF RPCs (orphan + expired)', () => {
    expect(source).toContain("'spatial_scan_cleanup_list_orphans'")
    expect(source).toContain("'spatial_scan_cleanup_list_expired'")
  })

  it('removes via Storage HTTP API and never raw-deletes storage.objects', () => {
    expect(source).toContain('admin.storage.from(BUCKET).remove(')
    expect(source).not.toMatch(/from\(['"]storage\.objects/)
  })

  it('prunes scan_assets rows in the expired pass', () => {
    expect(source).toContain(".from('scan_assets')")
    expect(source).toContain(".in('storage_path'")
  })

  it('writes an audit row to scan_cleanup_log on every run', () => {
    expect(source).toContain("admin.from('scan_cleanup_log').insert")
    expect(source).toContain('files_deleted:')
    expect(source).toContain('bytes_freed:')
    expect(source).toContain('orphan_count:')
    expect(source).toContain('expired_count:')
    expect(source).toContain('rows_pruned:')
    expect(source).toContain('duration_ms:')
    expect(source).toContain('error_detail:')
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
  pruneError?: string
}

function makeStubAdmin(opts: StubOpts) {
  const removeCalls: string[][] = []
  const rpcCalls: Array<{ fn: string; args: unknown }> = []
  const pruneCalls: string[][] = []

  const admin = {
    rpc: (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args })
      if (fn === 'spatial_scan_cleanup_list_orphans') {
        if (opts.orphanError) return Promise.resolve({ data: null, error: { message: opts.orphanError } })
        return Promise.resolve({ data: opts.orphans ?? [], error: null })
      }
      if (fn === 'spatial_scan_cleanup_list_expired') {
        if (opts.expiredError) return Promise.resolve({ data: null, error: { message: opts.expiredError } })
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
          return Promise.resolve({ data: paths.map((p) => ({ name: p, bucket })), error: null })
        },
      }),
    },
    from: (table: string) => {
      if (table !== 'scan_assets') throw new Error(`unexpected from(${table})`)
      return {
        delete: () => ({
          in: (_col: string, paths: string[]) => ({
            select: (_sel: string) => {
              pruneCalls.push([...paths])
              if (opts.pruneError) return Promise.resolve({ data: null, error: { message: opts.pruneError } })
              return Promise.resolve({ data: paths.map((p) => ({ id: p })), error: null })
            },
          }),
        }),
      }
    },
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { admin: admin as any, removeCalls, rpcCalls, pruneCalls }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('spatial-scan-cleanup: runCleanup()', () => {
  it('happy path · zero orphans + zero expired · 0 files, 0 pruned, 0 errors', async () => {
    const stub = makeStubAdmin({ orphans: [], expired: [] })

    const result = await runCleanup(stub.admin, 90, 500)

    expect(result.filesDeleted).toBe(0)
    expect(result.bytesFreed).toBe(0)
    expect(result.orphanCount).toBe(0)
    expect(result.expiredCount).toBe(0)
    expect(result.rowsPruned).toBe(0)
    expect(result.errors).toEqual([])
    expect(stub.removeCalls).toHaveLength(0)
    expect(stub.pruneCalls).toHaveLength(0)
    expect(stub.rpcCalls[0]?.fn).toBe('spatial_scan_cleanup_list_orphans')
    expect(stub.rpcCalls[1]?.fn).toBe('spatial_scan_cleanup_list_expired')
  })

  it('only orphans · 3 removed, no scan_assets prune (orphans have no row)', async () => {
    const stub = makeStubAdmin({
      orphans: [
        { object_name: 'u1/scan-a/usdz/x.usdz', size_bytes: 500_000 },
        { object_name: 'u1/scan-b/usdz/y.usdz', size_bytes: 600_000 },
        { object_name: 'u2/scan-c/usdz/z.usdz', size_bytes: 700_000 },
      ],
      expired: [],
    })

    const result = await runCleanup(stub.admin, 90, 500)

    expect(result.filesDeleted).toBe(3)
    expect(result.bytesFreed).toBe(1_800_000)
    expect(result.orphanCount).toBe(3)
    expect(result.rowsPruned).toBe(0)
    expect(result.errors).toEqual([])
    expect(stub.removeCalls).toHaveLength(1)
    expect(stub.pruneCalls).toHaveLength(0)
  })

  it('expired · removes blob AND prunes scan_assets row · rowsPruned tallies', async () => {
    const stub = makeStubAdmin({
      orphans: [],
      expired: [
        { object_name: 'u1/scan-x/thumbnail/a.png', size_bytes: 100 },
        { object_name: 'u2/scan-y/scan_json/b.json', size_bytes: 200 },
      ],
    })

    const result = await runCleanup(stub.admin, 90, 500)

    expect(result.expiredCount).toBe(2)
    expect(result.filesDeleted).toBe(2)
    expect(result.rowsPruned).toBe(2)
    expect(result.errors).toEqual([])
    expect(stub.pruneCalls).toHaveLength(1)
    expect(stub.pruneCalls[0]).toEqual([
      'u1/scan-x/thumbnail/a.png',
      'u2/scan-y/scan_json/b.json',
    ])
  })

  it('batches at 500 · 1500 orphans → 3 remove() calls of 500', async () => {
    const orphans: RpcRow[] = Array.from({ length: 1500 }, (_, i) => ({
      object_name: `user-1/scan-${i}/usdz/x.usdz`,
      size_bytes: 1000,
    }))
    const stub = makeStubAdmin({ orphans, expired: [] })

    const result = await runCleanup(stub.admin, 90, 5000)

    expect(result.filesDeleted).toBe(1500)
    expect(stub.removeCalls).toHaveLength(3)
    expect(stub.removeCalls.every((c) => c.length === 500)).toBe(true)
  })

  it('budget split · max_files=10 with 8 orphans → expired RPC limited to 2', async () => {
    const stub = makeStubAdmin({
      orphans: Array.from({ length: 8 }, (_, i) => ({ object_name: `u/o-${i}/k/x`, size_bytes: 100 })),
      expired: Array.from({ length: 5 }, (_, i) => ({ object_name: `u/e-${i}/k/x`, size_bytes: 200 })),
    })

    await runCleanup(stub.admin, 90, 10)

    expect(stub.rpcCalls[0]).toMatchObject({
      fn: 'spatial_scan_cleanup_list_orphans',
      args: { p_limit: 10 },
    })
    expect(stub.rpcCalls[1]).toMatchObject({
      fn: 'spatial_scan_cleanup_list_expired',
      args: { p_retention_days: 90, p_limit: 2 },
    })
  })

  it('budget exhausted by orphans · max_files=5 with 5 orphans → no expired RPC', async () => {
    const stub = makeStubAdmin({
      orphans: Array.from({ length: 5 }, (_, i) => ({ object_name: `u/o-${i}/k/x`, size_bytes: 100 })),
      expired: [{ object_name: 'should-not-fetch/k/x', size_bytes: 999 }],
    })

    const result = await runCleanup(stub.admin, 90, 5)

    expect(stub.rpcCalls).toHaveLength(1)
    expect(stub.rpcCalls[0]).toMatchObject({ fn: 'spatial_scan_cleanup_list_orphans' })
    expect(result.expiredCount).toBe(0)
    expect(result.filesDeleted).toBe(5)
  })

  it('orphan RPC fails · expired pipeline still runs · errors[] captures it', async () => {
    const stub = makeStubAdmin({
      orphanError: 'pg connection lost',
      expired: [{ object_name: 'u/e/k/x', size_bytes: 100 }],
    })

    const result = await runCleanup(stub.admin, 90, 500)

    expect(result.errors).toContain('list_orphans: pg connection lost')
    expect(result.filesDeleted).toBe(1)
    expect(result.expiredCount).toBe(1)
    expect(result.rowsPruned).toBe(1)
  })

  it('storage.remove fails · nothing pruned · bytes_freed 0 · errors surfaced', async () => {
    const stub = makeStubAdmin({
      orphans: [{ object_name: 'u/o/k/x', size_bytes: 1_000_000 }],
      expired: [{ object_name: 'u/e/k/x', size_bytes: 2_000_000 }],
      removeError: 'storage rate limit',
    })

    const result = await runCleanup(stub.admin, 90, 500)

    expect(result.filesDeleted).toBe(0)
    expect(result.bytesFreed).toBe(0)
    expect(result.rowsPruned).toBe(0)
    expect(stub.pruneCalls).toHaveLength(0)
    expect(result.errors).toEqual([
      'orphans storage.remove: storage rate limit',
      'expired storage.remove: storage rate limit',
    ])
  })

  it('expired blob removed but prune fails · rowsPruned 0 · error captured · files still counted', async () => {
    const stub = makeStubAdmin({
      orphans: [],
      expired: [{ object_name: 'u/e/k/x.png', size_bytes: 100 }],
      pruneError: 'fk violation',
    })

    const result = await runCleanup(stub.admin, 90, 500)

    expect(result.filesDeleted).toBe(1)
    expect(result.rowsPruned).toBe(0)
    expect(result.errors).toContain('scan_assets prune: fk violation')
  })

  it('size_bytes null · bytes_freed is 0 (no NaN)', async () => {
    const stub = makeStubAdmin({
      orphans: [
        { object_name: 'u/a/k/x', size_bytes: null },
        { object_name: 'u/b/k/x', size_bytes: 0 },
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
        { object_name: 'valid/scan/k/x.usdz', size_bytes: 100 },
      ],
      expired: [],
    })

    await runCleanup(stub.admin, 90, 500)

    expect(stub.removeCalls[0]).toEqual(['valid/scan/k/x.usdz'])
  })
})

// ── handleRequest auth-gate ──────────────────────────────────────────────

type EnvMap = Record<string, string>
let envMap: EnvMap = {}

function installDenoEnv(map: EnvMap) {
  envMap = { ...map }
  ;(globalThis as { Deno?: unknown }).Deno = { env: { get: (k: string) => envMap[k] } }
}

afterEach(() => {
  delete (globalThis as { Deno?: unknown }).Deno
})

async function loadHandler() {
  vi.resetModules()
  const mod = await import('../../supabase/functions/spatial-scan-cleanup/index.ts')
  return mod.handleRequest
}

describe('spatial-scan-cleanup: handleRequest auth', () => {
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
    expect((await res.json()).error).toBe('server_misconfigured')
  })

  it('rejects with 401 when shared-secret header is absent', async () => {
    installDenoEnv({ FIXUP_TRIGGER_SHARED_SECRET: 'secret-1' })
    const handle = await loadHandler()
    const res = await handle(new Request('http://localhost/x', { method: 'POST', body: '{}' }))
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
    expect((await res.json()).error).toBe('invalid_body')
  })

  it('returns 500 when SUPABASE_URL is missing (auth ok, body ok)', async () => {
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
    expect((await res.json()).error).toBe('server_misconfigured')
  })
})
