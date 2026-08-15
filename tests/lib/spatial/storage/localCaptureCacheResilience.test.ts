/**
 * localCaptureCache — fire-and-forget paths must never produce unhandled
 * rejections (Sentry FIXUP-WEB-6Q/6T: unhandled InvalidStateError /
 * UnknownError on /customer/spatial/list, mechanism=onunhandledrejection).
 *
 * The two producers were:
 *   1. subscribeToCaptureCache's initial `void listAll().then(listener)`
 *   2. `void notifyListeners()` after every write
 *
 * idb-keyval is mocked with the same Map-backed shim the existing suite uses
 * (uploadOutbox.test.ts pattern), extended with injectable failures using the
 * real DOMException names/messages from the Sentry events. The wrapper's
 * reopen/retry behaviour itself is covered in tests/lib/idb/resilientIdb.test.ts —
 * here we prove the module-level swallow/propagate contract.
 *
 * Note: vitest fails the run on any unhandled rejection, so these tests are
 * regression-proof against reintroducing the `void`-without-catch paths.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

interface MockState {
  getCalls: number
  /** Gets beyond this count fail with `getError` (when set). */
  failGetsAfter: number
  getError: Error | null
  setError: Error | null
}

vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>()
  const state: MockState = {
    getCalls: 0,
    failGetsAfter: Number.POSITIVE_INFINITY,
    getError: null,
    setError: null,
  }
  return {
    get: vi.fn(async (key: string) => {
      state.getCalls += 1
      if (state.getError && state.getCalls > state.failGetsAfter) {
        throw state.getError
      }
      return store.get(key)
    }),
    set: vi.fn(async (key: string, value: unknown) => {
      if (state.setError) throw state.setError
      store.set(key, value)
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key)
    }),
    keys: vi.fn(async () => Array.from(store.keys())),
    __mock: { store, state },
  }
})

vi.mock('../../../../src/lib/observability', () => ({
  logWarning: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

beforeEach(async () => {
  vi.resetModules()
  // The vi.mock factory result is cached — reset its shared state explicitly
  // so failure modes configured in one test never leak into the next.
  const { store, state } = await importMockState()
  store.clear()
  state.getCalls = 0
  state.failGetsAfter = Number.POSITIVE_INFINITY
  state.getError = null
  state.setError = null
})

async function importCache() {
  return import('../../../../src/lib/spatial/storage/localCaptureCache')
}

async function importMockState(): Promise<{ store: Map<string, unknown>; state: MockState }> {
  const idb = await import('idb-keyval')
  return (idb as unknown as { __mock: { store: Map<string, unknown>; state: MockState } }).__mock
}

async function importLogWarning() {
  const observability = await import('../../../../src/lib/observability')
  return vi.mocked(observability.logWarning)
}

function connectionLostError(): DOMException {
  return new DOMException(
    'Connection to Indexed Database server lost. Refresh the page to try again',
    'UnknownError',
  )
}

const USER = 'aaaaaaaa-0000-0000-0000-000000000001'

function captureInput(scanId = 'scan-1') {
  return {
    scanId,
    presalesProjectId: 'pp-1',
    userId: USER,
    usdzBlob: new Blob([new Uint8Array([0x55, 0x53])], { type: 'model/vnd.usdz+zip' }),
    deviceMeta: {},
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('subscribeToCaptureCache initial emit', () => {
  it('does not produce an unhandled rejection when IDB is dead — logs and stays subscribed', async () => {
    const { subscribeToCaptureCache } = await importCache()
    const { state } = await importMockState()
    const logWarning = await importLogWarning()

    state.failGetsAfter = 0
    state.getError = connectionLostError()

    const listener = vi.fn()
    const unsubscribe = subscribeToCaptureCache(listener)
    await flush()

    expect(listener).not.toHaveBeenCalled()
    expect(logWarning).toHaveBeenCalledWith(
      'spatial.capture_cache.subscribe_initial_list_failed',
      expect.objectContaining({ error: expect.stringContaining('UnknownError') }),
    )
    unsubscribe()
  })

  it('delivers the initial state when IDB is healthy', async () => {
    const { subscribeToCaptureCache, cacheCapture } = await importCache()
    await cacheCapture(captureInput())

    const listener = vi.fn()
    const unsubscribe = subscribeToCaptureCache(listener)
    await flush()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0]).toHaveLength(1)
    unsubscribe()
  })
})

describe('notifyListeners after writes', () => {
  it('a listAll failure inside the fire-and-forget notify is swallowed — the write itself resolves', async () => {
    const { subscribeToCaptureCache, cacheCapture, removeCacheEntry } = await importCache()
    const { state } = await importMockState()
    const logWarning = await importLogWarning()

    const listener = vi.fn()
    const unsubscribe = subscribeToCaptureCache(listener)
    await flush()
    await cacheCapture(captureInput())
    await flush()
    const callsAfterSetup = listener.mock.calls.length
    expect(callsAfterSetup).toBeGreaterThanOrEqual(2) // initial emit + post-cache notify

    // Allow exactly ONE more get (removeCacheEntry's own index read), then
    // kill the connection — only the notify-path listAll fails.
    state.failGetsAfter = state.getCalls + 1
    state.getError = connectionLostError()

    await expect(removeCacheEntry('scan-1')).resolves.toBeUndefined()
    await flush()

    expect(logWarning).toHaveBeenCalledWith(
      'spatial.capture_cache.notify_list_failed',
      expect.objectContaining({ error: expect.stringContaining('UnknownError') }),
    )
    // No further listener delivery — but also no unhandled rejection.
    expect(listener.mock.calls.length).toBe(callsAfterSetup)
    unsubscribe()
  })
})

describe('write-path natural failure propagation (unchanged)', () => {
  it('cacheCapture still rejects to the caller when the entry write fails (quota path)', async () => {
    const { cacheCapture } = await importCache()
    const { state } = await importMockState()

    state.setError = new DOMException(
      'The quota has been exceeded.',
      'QuotaExceededError',
    )

    await expect(cacheCapture(captureInput())).rejects.toMatchObject({
      name: 'QuotaExceededError',
    })
  })

  it('round-trip stays intact: cacheCapture → listResumable → markUploaded', async () => {
    const { cacheCapture, listResumable, markUploaded } = await importCache()

    await cacheCapture(captureInput())
    expect(await listResumable()).toHaveLength(1)

    await markUploaded('scan-1')
    expect(await listResumable()).toHaveLength(0)
  })
})
