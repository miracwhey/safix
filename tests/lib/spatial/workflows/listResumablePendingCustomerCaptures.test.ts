/**
 * Spatial V1.6.1 · Item #3 · listResumablePendingCustomerCaptures tests
 *
 * Covers the two-layer owner-filter:
 *   1. local userId match    — cross-account leftover never surfaces
 *   2. server ownerType check — HW scans never bleed into the customer sheet
 *
 * Plus null-safety: no userId / empty cache / repo-error short-circuits.
 *
 * idb-keyval is mocked with a Map-backed shim — same pattern the existing
 * `uploadOutbox.test.ts` uses. Avoids the real IndexedDB browser API.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Module-scope Map-backed idb-keyval mock — exposed `__reset()` so each
// `beforeEach` starts with a clean cache. The real `idb-keyval` API surface
// we use is `get / set / del / keys`.
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>()
  return {
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value)
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key)
    }),
    keys: vi.fn(async () => Array.from(store.keys())),
    __reset: () => store.clear(),
  }
})

// Supabase stub — cache writes don't touch network but captureScan internals
// re-export the client so the module-level eval needs a placeholder.
vi.mock('../../../../src/lib/supabase', () => ({
  supabase: {
    storage: { from: () => ({ upload: vi.fn(async () => ({ data: { path: 'mock' }, error: null })) }) },
  },
}))

import {
  InMemorySpatialRepository,
  initializeSpatialRepository,
  resetSpatialRepository,
} from '../../../../src/lib/spatial'
import {
  cacheCapture,
  markCaptureUploaded,
} from '../../../../src/lib/spatial/storage'
import { listResumablePendingCustomerCaptures } from '../../../../src/lib/spatial/workflow/listResumablePendingCustomerCaptures'

async function resetCacheStore(): Promise<void> {
  const idb = await import('idb-keyval')
  ;(idb as unknown as { __reset: () => void }).__reset()
}

const USER_A = 'aaaaaaaa-0000-0000-0000-000000000001'
const USER_B = 'bbbbbbbb-0000-0000-0000-000000000002'

function blob(): Blob {
  return new Blob([new Uint8Array([0x55, 0x53])], { type: 'model/vnd.usdz+zip' })
}

describe('listResumablePendingCustomerCaptures', () => {
  let repo: InMemorySpatialRepository

  beforeEach(async () => {
    resetSpatialRepository()
    repo = new InMemorySpatialRepository()
    initializeSpatialRepository(repo)
    await resetCacheStore()
  })

  it('returns [] when callerUserId is null (RBAC short-circuit)', async () => {
    const list = await listResumablePendingCustomerCaptures(null)
    expect(list).toEqual([])
  })

  it('returns [] when callerUserId is empty string', async () => {
    const list = await listResumablePendingCustomerCaptures('')
    expect(list).toEqual([])
  })

  it('returns [] when cache has no entries', async () => {
    const list = await listResumablePendingCustomerCaptures(USER_A)
    expect(list).toEqual([])
  })

  it('drops uploaded entries (terminal state)', async () => {
    const scan = await repo.createScan({
      projectId: null,
      jobId: null,
      presalesProjectId: null,
      parentScanId: null,
      source: 'roomplan',
      capturedBy: USER_A,
      deviceMeta: {},
      scanStartedAt: Date.now(),
      ownerType: 'customer',
    })
    await cacheCapture({
      scanId: scan.id,
      userId: USER_A,
      usdzBlob: blob(),
    })
    await markCaptureUploaded(scan.id)
    const list = await listResumablePendingCustomerCaptures(USER_A)
    expect(list).toEqual([])
  })

  it('owner-filters out cache rows belonging to a different user', async () => {
    const scan = await repo.createScan({
      projectId: null,
      jobId: null,
      presalesProjectId: null,
      parentScanId: null,
      source: 'roomplan',
      capturedBy: USER_B,
      deviceMeta: {},
      scanStartedAt: Date.now(),
      ownerType: 'customer',
    })
    await cacheCapture({
      scanId: scan.id,
      userId: USER_B,
      usdzBlob: blob(),
    })
    const list = await listResumablePendingCustomerCaptures(USER_A)
    expect(list).toEqual([])
  })

  it('owner-filters out HW (craftsman) cache rows even when userId matches', async () => {
    const jobId = 'jjjjjjjj-0000-0000-0000-000000000001'
    const scan = await repo.createScan({
      projectId: null,
      jobId,
      presalesProjectId: null,
      parentScanId: null,
      source: 'roomplan',
      capturedBy: USER_A,
      deviceMeta: {},
      scanStartedAt: Date.now(),
      ownerType: 'craftsman',
    })
    await cacheCapture({
      scanId: scan.id,
      jobId,
      userId: USER_A,
      usdzBlob: blob(),
    })
    const list = await listResumablePendingCustomerCaptures(USER_A)
    expect(list).toEqual([])
  })

  it('surfaces a customer-owned pending entry for the matching user', async () => {
    const scan = await repo.createScan({
      projectId: null,
      jobId: null,
      presalesProjectId: null,
      parentScanId: null,
      source: 'roomplan',
      capturedBy: USER_A,
      deviceMeta: {},
      scanStartedAt: Date.now(),
      ownerType: 'customer',
    })
    await cacheCapture({
      scanId: scan.id,
      userId: USER_A,
      usdzBlob: blob(),
    })
    const list = await listResumablePendingCustomerCaptures(USER_A)
    expect(list).toHaveLength(1)
    expect(list[0]?.entry.scanId).toBe(scan.id)
    expect(list[0]?.scan.ownerType).toBe('customer')
  })

  it('drops cache entries whose backing scan row was deleted (orphan)', async () => {
    // No `createScan` call — cache row points at a phantom scanId. The repo
    // returns null, so the workflow drops the entry.
    await cacheCapture({
      scanId: 'ssssssss-0000-0000-0000-deadbeefdead',
      userId: USER_A,
      usdzBlob: blob(),
    })
    const list = await listResumablePendingCustomerCaptures(USER_A)
    expect(list).toEqual([])
  })

  it('sorts multiple resumable customer entries oldest-first', async () => {
    const oldScan = await repo.createScan({
      projectId: null,
      jobId: null,
      presalesProjectId: null,
      parentScanId: null,
      source: 'roomplan',
      capturedBy: USER_A,
      deviceMeta: {},
      scanStartedAt: Date.now(),
      ownerType: 'customer',
    })
    await cacheCapture({
      scanId: oldScan.id,
      userId: USER_A,
      usdzBlob: blob(),
    })
    // Force a measurable delay so capturedAt differs even on a fast machine.
    await new Promise((r) => setTimeout(r, 5))
    const newScan = await repo.createScan({
      projectId: null,
      jobId: null,
      presalesProjectId: null,
      parentScanId: null,
      source: 'roomplan',
      capturedBy: USER_A,
      deviceMeta: {},
      scanStartedAt: Date.now(),
      ownerType: 'customer',
    })
    await cacheCapture({
      scanId: newScan.id,
      userId: USER_A,
      usdzBlob: blob(),
    })

    const list = await listResumablePendingCustomerCaptures(USER_A)
    expect(list).toHaveLength(2)
    expect(list[0]?.entry.scanId).toBe(oldScan.id)
    expect(list[1]?.entry.scanId).toBe(newScan.id)
  })
})
