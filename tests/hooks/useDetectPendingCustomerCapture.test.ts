// @vitest-environment jsdom
/**
 * Spatial V1.6.1 · Item #3 · useDetectPendingCustomerCapture
 *
 * Coverage:
 *   1. no userId → no pending, shouldShow=false
 *   2. no cache entries → loading flips false, pending stays null
 *   3. customer pending entry → pending populated, shouldShow=true
 *   4. dismissForSession() persists + flips shouldShow=false
 *   5. dismissed-flag persisted before mount stays sticky (idempotent)
 *   6. cross-tab cache mutation (subscriber fires) updates pending
 *   7. resume() returns ok=false envelope when the cache blob is missing
 *      (review fix HIGH-2 — consumer toasts on the typed message)
 *   8. discard() returns ok=false envelope when removeCaptureCacheEntry
 *      throws (review fix HIGH-3 — consumer toasts instead of silently
 *      re-arming the sheet)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

// idb-keyval — Map-backed shim so the cache layer is real but offline.
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

// Supabase placeholder — captureScan / repository never call it in the
// InMemory branch but the module-level eval imports it.
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    storage: { from: () => ({ upload: vi.fn(async () => ({ data: { path: 'mock' }, error: null })) }) },
  },
}))

// sessionStorage shim — jsdom's default tends to share across tests, so
// stub a fresh in-memory implementation that we can clear per spec.
const sessionMemory = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (k: string): string | null => (k in store ? store[k] : null),
    setItem: (k: string, v: string): void => { store[k] = v },
    removeItem: (k: string): void => { delete store[k] },
    clear: (): void => { store = {} },
    key: (i: number): string | null => Object.keys(store)[i] ?? null,
    get length(): number { return Object.keys(store).length },
  }
})()
Object.defineProperty(window, 'sessionStorage', {
  configurable: true,
  value: sessionMemory,
})

import {
  InMemorySpatialRepository,
  initializeSpatialRepository,
  resetSpatialRepository,
} from '../../src/lib/spatial'
import {
  cacheCapture,
  removeCaptureCacheEntry,
} from '../../src/lib/spatial/storage'
import {
  useDetectPendingCustomerCapture,
  CUSTOMER_RESUME_DISMISS_KEY,
} from '../../src/hooks/useDetectPendingCustomerCapture'

async function resetStores(): Promise<void> {
  const idb = await import('idb-keyval')
  ;(idb as unknown as { __reset: () => void }).__reset()
  sessionMemory.clear()
}

const USER_A = 'aaaaaaaa-0000-0000-0000-000000000001'

function blob(): Blob {
  return new Blob([new Uint8Array([0x55, 0x53])], { type: 'model/vnd.usdz+zip' })
}

async function seedCustomerPending(repo: InMemorySpatialRepository): Promise<string> {
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
  return scan.id
}

describe('useDetectPendingCustomerCapture', () => {
  let repo: InMemorySpatialRepository

  beforeEach(async () => {
    resetSpatialRepository()
    repo = new InMemorySpatialRepository()
    initializeSpatialRepository(repo)
    await resetStores()
  })

  it('stays inactive while userId is null', async () => {
    const { result } = renderHook(() =>
      useDetectPendingCustomerCapture({ userId: null }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.pending).toBeNull()
    expect(result.current.shouldShow).toBe(false)
  })

  it('returns pending=null when the cache is empty', async () => {
    const { result } = renderHook(() =>
      useDetectPendingCustomerCapture({ userId: USER_A }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.pending).toBeNull()
    expect(result.current.shouldShow).toBe(false)
  })

  it('surfaces a customer pending entry and flips shouldShow=true', async () => {
    const scanId = await seedCustomerPending(repo)
    const { result } = renderHook(() =>
      useDetectPendingCustomerCapture({ userId: USER_A }),
    )
    await waitFor(() => expect(result.current.pending).not.toBeNull())
    expect(result.current.pending?.entry.scanId).toBe(scanId)
    expect(result.current.shouldShow).toBe(true)
  })

  it('dismissForSession() persists the flag and flips shouldShow=false', async () => {
    await seedCustomerPending(repo)
    const { result } = renderHook(() =>
      useDetectPendingCustomerCapture({ userId: USER_A }),
    )
    await waitFor(() => expect(result.current.shouldShow).toBe(true))
    act(() => result.current.dismissForSession())
    expect(window.sessionStorage.getItem(CUSTOMER_RESUME_DISMISS_KEY)).toBe('1')
    expect(result.current.shouldShow).toBe(false)
    // pending stays populated — the cache entry is untouched
    expect(result.current.pending).not.toBeNull()
  })

  it('honours a dismissed flag persisted before mount (sticky)', async () => {
    await seedCustomerPending(repo)
    window.sessionStorage.setItem(CUSTOMER_RESUME_DISMISS_KEY, '1')
    const { result } = renderHook(() =>
      useDetectPendingCustomerCapture({ userId: USER_A }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.pending).not.toBeNull()
    expect(result.current.shouldShow).toBe(false)
  })

  it('cache mutation in another consumer updates pending (subscriber reactivity)', async () => {
    const scanId = await seedCustomerPending(repo)
    const { result } = renderHook(() =>
      useDetectPendingCustomerCapture({ userId: USER_A }),
    )
    await waitFor(() => expect(result.current.pending).not.toBeNull())

    // Simulate a cross-tab discard — another window removed the cache row.
    // The subscriber should fire and the hook should flip pending → null.
    await act(async () => {
      await removeCaptureCacheEntry(scanId)
    })
    await waitFor(() => expect(result.current.pending).toBeNull())
    expect(result.current.shouldShow).toBe(false)
  })

  it('resume() returns ok=false envelope when the cached blob is missing', async () => {
    // Seed a normal customer pending entry, then corrupt the cache so the
    // workflow returns cache_invalid. We rewrite the stored entry with a
    // 0-byte blob via the raw idb mock (no exported helper for this — the
    // bug is by definition off-the-happy-path).
    const scanId = await seedCustomerPending(repo)
    const idb = await import('idb-keyval')
    const key = `spatial:capture-cache:entry:v1:${scanId}`
    const stored = (await (idb as unknown as { get: (k: string) => Promise<unknown> }).get(key)) as {
      usdzBlob: Blob
      bytes: number
    } | undefined
    expect(stored).toBeDefined()
    await (idb as unknown as { set: (k: string, v: unknown) => Promise<void> }).set(
      key,
      {
        ...(stored as object),
        usdzBlob: new Blob([], { type: 'model/vnd.usdz+zip' }),
        bytes: 0,
      },
    )

    const { result } = renderHook(() =>
      useDetectPendingCustomerCapture({ userId: USER_A }),
    )
    await waitFor(() => expect(result.current.pending).not.toBeNull())

    let outcome: Awaited<ReturnType<typeof result.current.resume>> | undefined
    await act(async () => {
      outcome = await result.current.resume()
    })
    expect(outcome).toBeDefined()
    expect(outcome?.ok).toBe(false)
    if (outcome && !outcome.ok) {
      expect(outcome.reason).toBe('cache_invalid')
      expect(outcome.message).toMatch(/lokale[rn]? Cache|leer|beschädigt/i)
    }
  })

  it('discard() returns ok=false envelope when the cache delete throws', async () => {
    await seedCustomerPending(repo)
    const { result } = renderHook(() =>
      useDetectPendingCustomerCapture({ userId: USER_A }),
    )
    await waitFor(() => expect(result.current.pending).not.toBeNull())

    // Force the next del() (the discard path) to throw — exact same shape an
    // IndexedDB quota/IO failure would surface as. We restore the original
    // implementation after the test so other specs aren't affected.
    const idb = await import('idb-keyval')
    const delMock = (idb as unknown as { del: ReturnType<typeof vi.fn> }).del
    const original = delMock.getMockImplementation()
    delMock.mockImplementationOnce(async () => {
      throw new Error('quota_exhausted')
    })

    let outcome: Awaited<ReturnType<typeof result.current.discard>> | undefined
    await act(async () => {
      outcome = await result.current.discard()
    })
    expect(outcome).toEqual({ ok: false, error: expect.any(Error) })
    if (outcome && !outcome.ok) {
      expect(outcome.error.message).toBe('quota_exhausted')
    }

    if (original) delMock.mockImplementation(original)
  })
})
