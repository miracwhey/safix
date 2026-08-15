// @vitest-environment jsdom
/**
 * Kill-detection wiring in the native bootstrap (Block 2, Posten 5).
 *
 * Verifies the integration seams in `bootstrapNativePlatform()`:
 *   - the boot check runs and reports a fresh marker (i.e. detection happens
 *     before deep-link routing could navigate away),
 *   - `appStateChange(isActive=false)` writes the background marker
 *     (producer-true Capacitor event shape `{ isActive: boolean }`),
 *   - `appStateChange(isActive=true)` clears the marker AND still dispatches
 *     the `fixup:app-resume` event session.ts listens for (no regression of
 *     the resume bridge),
 *   - a deep-link `routeDeepLink()` suppresses the marker for the pagehide
 *     its `location.assign` triggers — no false kill report on the next boot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type StateChangeListener = (state: { isActive: boolean }) => void

const { listeners, getLaunchUrlMock } = vi.hoisted(() => ({
  listeners: new Map<string, (payload: never) => void>(),
  getLaunchUrlMock: vi.fn(),
}))

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

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
  },
}))
vi.mock('@capacitor/status-bar', () => ({
  StatusBar: {
    setOverlaysWebView: vi.fn().mockResolvedValue(undefined),
    setBackgroundColor: vi.fn().mockResolvedValue(undefined),
    setStyle: vi.fn().mockResolvedValue(undefined),
    getInfo: vi.fn().mockResolvedValue({}),
  },
  Style: { Dark: 'DARK', Light: 'LIGHT' },
}))
vi.mock('@capacitor/app', () => ({
  App: {
    getLaunchUrl: getLaunchUrlMock,
    addListener: vi.fn((event: string, cb: (payload: never) => void) => {
      listeners.set(event, cb)
      return Promise.resolve({ remove: vi.fn() })
    }),
  },
}))
vi.mock('@fixup/capacitor-roomplan', () => ({
  RoomPlan: { addListener: vi.fn() },
}))
vi.mock('../../src/lib/observability', () => ({
  logWarning: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

import { logWarning } from '../../src/lib/observability'
import { bootstrapNativePlatform, __test__ as nativeTest } from '../../src/lib/native/bootstrap'
import { __test__ as killTest } from '../../src/lib/lifecycle/killDetection'

const logWarningMock = vi.mocked(logWarning)
const { MARKER_KEY } = killTest

let assignSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  listeners.clear()
  getLaunchUrlMock.mockResolvedValue(null)
  window.localStorage.clear()
  killTest.reset()
  logWarningMock.mockClear()
  // routeDeepLink navigates via window.location.assign; the diagnostics in
  // bootstrapNativePlatform read href/origin — stub both.
  assignSpy = vi.fn()
  Object.defineProperty(window, 'location', {
    value: {
      assign: assignSpy,
      href: 'capacitor://localhost/',
      origin: 'capacitor://localhost',
      pathname: '/',
    },
    writable: true,
    configurable: true,
  })
})

afterEach(() => {
  killTest.reset() // detaches the pagehide listener attached during boot
  vi.restoreAllMocks()
})

describe('bootstrapNativePlatform — kill-detection wiring', () => {
  it('runs the boot check: a fresh background marker is reported and consumed', async () => {
    window.localStorage.setItem(
      MARKER_KEY,
      JSON.stringify({ path: '/messages/thread-1', ts: Date.now() - 30_000 })
    )

    await bootstrapNativePlatform()

    expect(logWarningMock).toHaveBeenCalledWith(
      'app.webview_memory_reload',
      expect.objectContaining({ markerPath: '/messages/thread-1' })
    )
    expect(window.localStorage.getItem(MARKER_KEY)).toBeNull()
  })

  it('appStateChange(isActive=false) writes the marker; isActive=true clears it and still dispatches fixup:app-resume', async () => {
    await bootstrapNativePlatform()
    const onStateChange = listeners.get('appStateChange') as StateChangeListener | undefined
    expect(onStateChange).toBeDefined()

    const resumeSpy = vi.fn()
    window.addEventListener('fixup:app-resume', resumeSpy)
    try {
      // Background → marker persisted with the current path.
      onStateChange!({ isActive: false })
      const raw = window.localStorage.getItem(MARKER_KEY)
      expect(raw).not.toBeNull()
      expect(JSON.parse(raw as string)).toEqual({ path: '/', ts: expect.any(Number) })

      // Warm foreground → marker consumed, resume bridge untouched.
      onStateChange!({ isActive: true })
      expect(window.localStorage.getItem(MARKER_KEY)).toBeNull()
      expect(resumeSpy).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('fixup:app-resume', resumeSpy)
    }
  })

  it('deep-link routing suppresses the pagehide marker of its own navigation', async () => {
    await bootstrapNativePlatform() // attaches the pagehide writer

    nativeTest.routeDeepLink('app.fixup.main://projects/abc-123')
    expect(assignSpy).toHaveBeenCalledWith('/projects/abc-123')

    // The assign() above triggers a pagehide in the real WebView — simulate
    // it: no marker may be written, otherwise the next boot reports a fake
    // memory reload for an intentional navigation.
    window.dispatchEvent(new Event('pagehide'))
    expect(window.localStorage.getItem(MARKER_KEY)).toBeNull()

    // A real (non-navigation) pagehide afterwards writes normally again.
    window.dispatchEvent(new Event('pagehide'))
    expect(window.localStorage.getItem(MARKER_KEY)).not.toBeNull()
  })

  it('a rejected deep link does NOT suppress the next pagehide marker', async () => {
    await bootstrapNativePlatform()

    nativeTest.routeDeepLink('app.fixup.main://evil/phish')
    expect(assignSpy).not.toHaveBeenCalled()

    window.dispatchEvent(new Event('pagehide'))
    expect(window.localStorage.getItem(MARKER_KEY)).not.toBeNull()
  })

  it('marker writes survive across the boot seam: background marker is readable by a fresh boot check', async () => {
    await bootstrapNativePlatform()
    const onStateChange = listeners.get('appStateChange') as StateChangeListener
    onStateChange({ isActive: false })

    // Simulate the next JS world after a kill: module guards reset, then the
    // boot check consumes the marker written above.
    killTest.reset()
    logWarningMock.mockClear()
    await bootstrapNativePlatform()
    expect(logWarningMock).toHaveBeenCalledWith(
      'app.webview_memory_reload',
      expect.objectContaining({ markerPath: '/' })
    )
  })
})
