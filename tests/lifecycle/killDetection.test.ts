// @vitest-environment jsdom
/**
 * WebView kill detection — unit tests (resume-robustness Block 2, Posten 5).
 *
 * Covers:
 *   - marker writers (recordBackgroundMarker, pagehide listener) persist the
 *     exact `{ path, ts }` shape the boot check consumes,
 *   - boot check: fresh marker → `app.webview_memory_reload` with the
 *     navigation type; stale / future / corrupt / missing marker → silent,
 *   - marker is always consumed by the boot check (fresh AND stale),
 *   - one-shot semantics per JS world (boot check + pagehide listener),
 *   - intentional-navigation suppression (deep-link `location.assign`),
 *   - foreground clear is gated until the boot check has run,
 *   - storage failures (quota / private mode) never throw into the boot path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// In-memory localStorage stub — the vitest-jsdom localStorage in this repo
// has no functional methods (Node `--localstorage-file` warning); same
// pattern as tests/chat/chatComposerDraftPersistence.test.ts.
const memoryStorage = (() => {
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
vi.stubGlobal('localStorage', memoryStorage)
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: memoryStorage,
})

vi.mock('../../src/lib/observability', () => ({
  logWarning: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

import { logWarning } from '../../src/lib/observability'
import {
  recordBackgroundMarker,
  clearBackgroundMarkerOnForeground,
  markIntentionalNavigation,
  intentionalReload,
  startKillDetection,
  detectWebViewKillOnBoot,
  __test__,
} from '../../src/lib/lifecycle/killDetection'

const { MARKER_KEY, FRESH_WINDOW_MS } = __test__
const logWarningMock = vi.mocked(logWarning)

const BASE_TIME = new Date('2026-06-11T12:00:00.000Z').getTime()

function readStoredMarker(): { path: string; ts: number } | null {
  const raw = window.localStorage.getItem(MARKER_KEY)
  return raw ? (JSON.parse(raw) as { path: string; ts: number }) : null
}

/** Stub the PerformanceNavigationTiming entry the boot check reads. */
function stubNavigationType(type: string | null): void {
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue(
    type === null ? [] : ([{ type }] as unknown as PerformanceEntry[])
  )
}

let detachPagehide: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(BASE_TIME)
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  __test__.reset()
  logWarningMock.mockClear()
})

afterEach(() => {
  detachPagehide?.()
  detachPagehide = null
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('marker writers', () => {
  it('recordBackgroundMarker persists { path, ts } with the current pathname only', () => {
    window.history.replaceState(null, '', '/messages/thread-1?token=secret#x')
    recordBackgroundMarker()
    expect(readStoredMarker()).toEqual({ path: '/messages/thread-1', ts: BASE_TIME })
  })

  it('pagehide writes the marker once detection is started', () => {
    detachPagehide = startKillDetection()
    window.dispatchEvent(new Event('pagehide'))
    expect(readStoredMarker()).toEqual({ path: '/', ts: BASE_TIME })
  })

  it('startKillDetection is idempotent — a second init never doubles the listener', () => {
    detachPagehide = startKillDetection()
    const second = startKillDetection()
    const setItemSpy = vi.spyOn(memoryStorage, 'setItem')
    window.dispatchEvent(new Event('pagehide'))
    expect(setItemSpy).toHaveBeenCalledTimes(1)
    second()
  })

  it('markIntentionalNavigation suppresses exactly the next pagehide', () => {
    detachPagehide = startKillDetection()
    markIntentionalNavigation()
    window.dispatchEvent(new Event('pagehide'))
    expect(readStoredMarker()).toBeNull()
    // The suppression is one-shot — a later real pagehide writes again.
    window.dispatchEvent(new Event('pagehide'))
    expect(readStoredMarker()).not.toBeNull()
  })

  it('never throws when localStorage writes fail (quota / private mode)', () => {
    vi.spyOn(memoryStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => recordBackgroundMarker()).not.toThrow()
  })

  it('intentionalReload reloads, suppresses the teardown pagehide, and the next boot logs NO kill', () => {
    // WebKit fires pagehide on EVERY document teardown — including a
    // programmatic window.location.reload() (error-retry button, reconnect
    // during boot). Without suppression that pagehide writes a marker and
    // the post-reload boot misreports navigationType='reload' as a
    // high-confidence memory kill.
    const originalLocation = window.location
    const reloadSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, pathname: '/', reload: reloadSpy },
    })
    try {
      detachPagehide = startKillDetection()
      intentionalReload()
      expect(reloadSpy).toHaveBeenCalledTimes(1)

      // The pagehide the reload triggers must NOT write a marker …
      window.dispatchEvent(new Event('pagehide'))
      expect(readStoredMarker()).toBeNull()

      // … so the post-reload boot reports nothing.
      stubNavigationType('reload')
      detectWebViewKillOnBoot()
      expect(logWarningMock).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      })
    }
  })
})

describe('boot check — detectWebViewKillOnBoot', () => {
  it('fresh marker + reload navigation → logs app.webview_memory_reload and consumes the marker', () => {
    window.history.replaceState(null, '', '/messages/thread-1')
    recordBackgroundMarker()
    vi.setSystemTime(BASE_TIME + 60_000)
    stubNavigationType('reload')

    detectWebViewKillOnBoot()

    expect(logWarningMock).toHaveBeenCalledTimes(1)
    expect(logWarningMock).toHaveBeenCalledWith('app.webview_memory_reload', {
      navigationType: 'reload',
      markerPath: '/messages/thread-1',
      markerAgeMs: 60_000,
    })
    expect(readStoredMarker()).toBeNull()
  })

  it('fresh marker + navigate type → logged with that type (Jetsam / force-quit segmentation)', () => {
    recordBackgroundMarker()
    vi.setSystemTime(BASE_TIME + 1_000)
    stubNavigationType('navigate')

    detectWebViewKillOnBoot()

    expect(logWarningMock).toHaveBeenCalledWith(
      'app.webview_memory_reload',
      expect.objectContaining({ navigationType: 'navigate' })
    )
  })

  it('marker exactly at the freshness edge still counts; one ms past does not', () => {
    recordBackgroundMarker()
    vi.setSystemTime(BASE_TIME + FRESH_WINDOW_MS)
    stubNavigationType('reload')
    detectWebViewKillOnBoot()
    expect(logWarningMock).toHaveBeenCalledTimes(1)

    __test__.reset()
    logWarningMock.mockClear()
    vi.setSystemTime(BASE_TIME)
    recordBackgroundMarker()
    vi.setSystemTime(BASE_TIME + FRESH_WINDOW_MS + 1)
    detectWebViewKillOnBoot()
    expect(logWarningMock).not.toHaveBeenCalled()
  })

  it('stale marker → no log, but the marker is still consumed', () => {
    recordBackgroundMarker()
    vi.setSystemTime(BASE_TIME + FRESH_WINDOW_MS + 60_000)
    detectWebViewKillOnBoot()
    expect(logWarningMock).not.toHaveBeenCalled()
    expect(readStoredMarker()).toBeNull()
  })

  it('future-dated marker (clock skew) → no log', () => {
    recordBackgroundMarker()
    vi.setSystemTime(BASE_TIME - 1_000)
    detectWebViewKillOnBoot()
    expect(logWarningMock).not.toHaveBeenCalled()
    expect(readStoredMarker()).toBeNull()
  })

  it('no marker → no log', () => {
    detectWebViewKillOnBoot()
    expect(logWarningMock).not.toHaveBeenCalled()
  })

  it('is one-shot per JS world — a second call never double-reports', () => {
    recordBackgroundMarker()
    stubNavigationType('reload')
    detectWebViewKillOnBoot()
    expect(logWarningMock).toHaveBeenCalledTimes(1)

    // Even with a brand-new fresh marker the boot check stays consumed.
    recordBackgroundMarker()
    detectWebViewKillOnBoot()
    expect(logWarningMock).toHaveBeenCalledTimes(1)
  })

  it('missing navigation entries → navigationType "unknown"', () => {
    recordBackgroundMarker()
    stubNavigationType(null)
    detectWebViewKillOnBoot()
    expect(logWarningMock).toHaveBeenCalledWith(
      'app.webview_memory_reload',
      expect.objectContaining({ navigationType: 'unknown' })
    )
  })

  it('corrupt marker JSON → silent, no throw', () => {
    window.localStorage.setItem(MARKER_KEY, '{not json')
    expect(() => detectWebViewKillOnBoot()).not.toThrow()
    expect(logWarningMock).not.toHaveBeenCalled()
  })

  it('marker with a wrong shape → silent', () => {
    window.localStorage.setItem(MARKER_KEY, JSON.stringify({ path: 5, ts: 'later' }))
    detectWebViewKillOnBoot()
    expect(logWarningMock).not.toHaveBeenCalled()
  })

  it('localStorage reads throwing → silent, no throw', () => {
    vi.spyOn(memoryStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(() => detectWebViewKillOnBoot()).not.toThrow()
    expect(logWarningMock).not.toHaveBeenCalled()
  })
})

describe('foreground clear gating', () => {
  it('does NOT clear the marker before the boot check ran (evidence protection)', () => {
    recordBackgroundMarker()
    clearBackgroundMarkerOnForeground()
    expect(readStoredMarker()).not.toBeNull()
  })

  it('clears the marker on warm foreground after the boot check ran', () => {
    detectWebViewKillOnBoot() // no marker — just marks the check as done
    recordBackgroundMarker()
    clearBackgroundMarkerOnForeground()
    expect(readStoredMarker()).toBeNull()
  })
})
