// @vitest-environment jsdom
/**
 * AppBootstrap boot-window resilience (resume-robustness Block 2, Posten 2+3).
 *
 * Posten 2 — online-reload guard:
 *   iOS WKWebView fires 'online' routinely on foreground / radio handover.
 *   A cold 'online' without a preceding offline signal must NEVER hard-reload
 *   the page mid-boot (double-reload cascade after a WebView memory kill).
 *   Only a real offline→online transition may reload — and once the boot has
 *   finished underneath the offline screen, it unblocks without a reload.
 *
 * Posten 3 — suspension-aware deadline + one silent retry:
 *   The 15s budget counts ACTIVE time only (visible + online, suspension
 *   gaps clamped). The first expiry triggers exactly one silent retry; only
 *   the second shows the fatal screen (which keeps its retry button).
 *
 * All module mocks mirror the real producer shapes: bootstrapRepositories
 * resolves void, bridge starters return cleanup fns (the real
 * startProjectJobSyncBridge is idempotent and returns the SAME stop fn on
 * repeat calls — see tests/bootstrap/bootstrapSyncRace.test.ts), and the
 * auth read goes through the getAuthSession single-flight seam resolving
 * `{ data: { session } }`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  bootstrapRepositories: vi.fn(),
  startProjectJobSyncBridge: vi.fn(),
  syncAllProjectsFromJobs: vi.fn(),
  startNotificationBridge: vi.fn(),
  registerForPushNotifications: vi.fn(),
  startOutboxRunner: vi.fn(),
  initializeInAppNotificationRepository: vi.fn(),
  getSession: vi.fn(),
  logWarning: vi.fn(),
  captureException: vi.fn(),
}))

vi.mock('../../src/lib/bootstrap', () => ({
  bootstrapRepositories: mocks.bootstrapRepositories,
}))
vi.mock('../../src/lib/projects/projectJobSyncBridge', () => ({
  startProjectJobSyncBridge: mocks.startProjectJobSyncBridge,
  syncAllProjectsFromJobs: mocks.syncAllProjectsFromJobs,
}))
vi.mock('../../src/lib/notifications', () => ({
  startNotificationBridge: mocks.startNotificationBridge,
}))
vi.mock('../../src/lib/notifications/pushNotificationBridge', () => ({
  registerForPushNotifications: mocks.registerForPushNotifications,
}))
vi.mock('../../src/lib/media/outboxRunner', () => ({
  startOutboxRunner: mocks.startOutboxRunner,
}))
vi.mock('../../src/lib/inAppNotifications', () => ({
  initializeInAppNotificationRepository: mocks.initializeInAppNotificationRepository,
}))
// AppBootstrap reads the session through the single-flight seam (NOT raw
// supabase.auth.getSession) so the boot-path notification init cannot become
// a navigator.locks contender against the parallel session refresh.
vi.mock('../../src/lib/auth/authSingleFlight', () => ({
  getAuthSession: mocks.getSession,
}))
vi.mock('../../src/lib/observability', () => ({
  logWarning: mocks.logWarning,
  logInfo: vi.fn(),
  logError: vi.fn(),
}))
vi.mock('@sentry/react', () => ({
  captureException: mocks.captureException,
}))

import AppBootstrap from '../../src/components/AppBootstrap'

const TIMEOUT_MS = 15_000

// ── Environment controls ────────────────────────────────────────────────────

let onLine = true
let visibility: DocumentVisibilityState = 'visible'
let reloadSpy: ReturnType<typeof vi.fn>

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Flush microtasks (ms=0) or advance fake timers inside React act(). */
async function flush(ms = 0): Promise<void> {
  await act(async () => {
    if (ms > 0) await vi.advanceTimersByTimeAsync(ms)
    // The boot chain spans several awaits — drain enough microtask rounds
    // for every checkpoint regardless of the timer advancement above.
    for (let i = 0; i < 12; i += 1) await Promise.resolve()
  })
}

function renderApp() {
  return render(
    createElement(AppBootstrap, null, createElement('div', { 'data-testid': 'booted-children' }))
  )
}

function dispatchWindowEvent(name: 'online' | 'offline', nowOnline: boolean): void {
  act(() => {
    onLine = nowOnline
    window.dispatchEvent(new Event(name))
  })
}

const childrenVisible = () => screen.queryByTestId('booted-children') !== null
const errorScreenVisible = () => screen.queryByText('App konnte nicht gestartet werden') !== null
const offlineScreenVisible = () => screen.queryByText('Keine Internetverbindung') !== null

beforeEach(() => {
  // Leave MessageChannel/queueMicrotask real so React's scheduler keeps
  // working — only timers + Date are faked for the deadline ticker.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })

  onLine = true
  visibility = 'visible'
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => onLine,
  })
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
  reloadSpy = vi.fn()
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { reload: reloadSpy },
  })

  mocks.bootstrapRepositories.mockReset().mockResolvedValue(undefined)
  mocks.startProjectJobSyncBridge.mockReset().mockReturnValue(() => {})
  mocks.syncAllProjectsFromJobs.mockReset().mockResolvedValue(undefined)
  mocks.startNotificationBridge.mockReset()
  mocks.registerForPushNotifications.mockReset().mockResolvedValue(undefined)
  mocks.startOutboxRunner.mockReset().mockReturnValue(() => {})
  mocks.initializeInAppNotificationRepository.mockReset().mockResolvedValue(undefined)
  mocks.getSession.mockReset().mockResolvedValue({ data: { session: null } })
  mocks.logWarning.mockReset()
  mocks.captureException.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// ── Baseline ────────────────────────────────────────────────────────────────

describe('baseline boot', () => {
  it('renders children once the chain resolves — no reload, no timeout', async () => {
    renderApp()
    await flush()
    expect(childrenVisible()).toBe(true)
    expect(reloadSpy).not.toHaveBeenCalled()

    // The deadline must be fully disarmed after success: a long idle period
    // afterwards must never resurrect the timeout/error path.
    await flush(60_000)
    expect(errorScreenVisible()).toBe(false)
    expect(mocks.logWarning).not.toHaveBeenCalled()
    expect(mocks.bootstrapRepositories).toHaveBeenCalledTimes(1)
  })
})

// ── Posten 2: online-reload guard ───────────────────────────────────────────

describe('online-reload guard (Posten 2)', () => {
  it('a cold online event during boot does NOT reload (iOS foreground pattern)', async () => {
    mocks.bootstrapRepositories.mockReturnValue(deferred().promise)
    renderApp()

    dispatchWindowEvent('online', true)
    dispatchWindowEvent('online', true)

    expect(reloadSpy).not.toHaveBeenCalled()
    expect(errorScreenVisible()).toBe(false)
  })

  it('a real offline→online transition during boot reloads exactly once', async () => {
    mocks.bootstrapRepositories.mockReturnValue(deferred().promise)
    renderApp()

    dispatchWindowEvent('offline', false)
    expect(offlineScreenVisible()).toBe(true)

    dispatchWindowEvent('online', true)
    expect(reloadSpy).toHaveBeenCalledTimes(1)

    // Duplicate online events (flaky radio) must not stack reloads.
    dispatchWindowEvent('online', true)
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  it('boot finishing under the offline screen → online unblocks WITHOUT reload', async () => {
    const boot = deferred()
    mocks.bootstrapRepositories.mockReturnValue(boot.promise)
    renderApp()

    dispatchWindowEvent('offline', false)
    expect(offlineScreenVisible()).toBe(true)

    // Chain completes while the offline screen is up.
    boot.resolve()
    await flush()
    expect(offlineScreenVisible()).toBe(true) // still gated on connectivity

    dispatchWindowEvent('online', true)
    expect(reloadSpy).not.toHaveBeenCalled()
    expect(childrenVisible()).toBe(true)
  })
})

// ── Posten 3: suspension-aware deadline + silent retry ──────────────────────

describe('bootstrap deadline (Posten 3)', () => {
  it('first timeout triggers exactly one SILENT retry — loading stays, Sentry event fires', async () => {
    mocks.bootstrapRepositories.mockImplementation(() => deferred().promise)
    renderApp()
    expect(mocks.bootstrapRepositories).toHaveBeenCalledTimes(1)

    await flush(TIMEOUT_MS)

    expect(mocks.bootstrapRepositories).toHaveBeenCalledTimes(2)
    expect(mocks.logWarning).toHaveBeenCalledWith(
      'app.bootstrap.timeout',
      expect.objectContaining({ attempt: 1, retrying: true, timeoutMs: TIMEOUT_MS })
    )
    expect(errorScreenVisible()).toBe(false)
    expect(childrenVisible()).toBe(false)
  })

  it('second timeout shows the error screen with a working retry button', async () => {
    mocks.bootstrapRepositories.mockImplementation(() => deferred().promise)
    renderApp()

    await flush(TIMEOUT_MS) // attempt 1 → silent retry
    await flush(TIMEOUT_MS) // attempt 2 → fatal

    expect(mocks.bootstrapRepositories).toHaveBeenCalledTimes(2)
    expect(errorScreenVisible()).toBe(true)
    expect(mocks.logWarning).toHaveBeenCalledWith(
      'app.bootstrap.timeout',
      expect.objectContaining({ attempt: 2, retrying: false })
    )

    // Manual retry affordance is preserved.
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }))
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  it('the silent retry can succeed — app boots without any error UI', async () => {
    mocks.bootstrapRepositories
      .mockImplementationOnce(() => deferred().promise) // attempt 1 hangs
      .mockResolvedValueOnce(undefined) // attempt 2 succeeds
    renderApp()

    await flush(TIMEOUT_MS)
    await flush()

    expect(childrenVisible()).toBe(true)
    expect(errorScreenVisible()).toBe(false)
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('hidden time does NOT count against the deadline (iOS background)', async () => {
    mocks.bootstrapRepositories.mockImplementation(() => deferred().promise)
    renderApp()

    await flush(10_000) // 10s active — 5s budget left
    visibility = 'hidden'
    await flush(60_000) // a minute in background — must be free
    expect(mocks.bootstrapRepositories).toHaveBeenCalledTimes(1)
    expect(errorScreenVisible()).toBe(false)

    visibility = 'visible'
    await flush(4_000) // 14s consumed — still under budget
    expect(mocks.bootstrapRepositories).toHaveBeenCalledTimes(1)

    await flush(1_000) // 15s consumed — NOW the silent retry fires
    expect(mocks.bootstrapRepositories).toHaveBeenCalledTimes(2)
    expect(errorScreenVisible()).toBe(false)
  })

  it('offline time does NOT count against the deadline', async () => {
    mocks.bootstrapRepositories.mockImplementation(() => deferred().promise)
    renderApp()

    await flush(10_000)
    onLine = false
    await flush(60_000) // offline — the boot cannot progress, budget pauses
    expect(mocks.bootstrapRepositories).toHaveBeenCalledTimes(1)

    onLine = true
    await flush(5_000)
    expect(mocks.bootstrapRepositories).toHaveBeenCalledTimes(2)
  })

  it('a suspension gap without visibilitychange charges at most one tick', async () => {
    mocks.bootstrapRepositories.mockImplementation(() => deferred().promise)
    renderApp()

    await flush(5_000) // 5s consumed
    // Simulate iOS freezing the JS world for 10 minutes: wall clock jumps,
    // the next tick sees a huge delta. The old wall-clock setTimeout fired
    // immediately here and showed the fatal screen — the active-time budget
    // must charge at most one tick instead.
    vi.setSystemTime(Date.now() + 600_000)
    await flush(1_000)
    expect(mocks.bootstrapRepositories).toHaveBeenCalledTimes(1)
    expect(errorScreenVisible()).toBe(false)

    await flush(9_000) // 5s + 1s clamped + 9s = 15s → silent retry
    expect(mocks.bootstrapRepositories).toHaveBeenCalledTimes(2)
    expect(errorScreenVisible()).toBe(false)
  })

  it('a superseded attempt completing late cannot double-start the bridges', async () => {
    const attempt1 = deferred()
    const attempt2 = deferred()
    mocks.bootstrapRepositories
      .mockImplementationOnce(() => attempt1.promise)
      .mockImplementationOnce(() => attempt2.promise)
    renderApp()

    await flush(TIMEOUT_MS) // attempt 1 timed out, attempt 2 in flight
    expect(mocks.bootstrapRepositories).toHaveBeenCalledTimes(2)

    // The hung first attempt wakes up AFTER being superseded — it must abort
    // at its checkpoint instead of starting bridges a second time.
    attempt1.resolve()
    await flush()
    expect(mocks.startProjectJobSyncBridge).not.toHaveBeenCalled()
    expect(childrenVisible()).toBe(false)

    // The live attempt finishes normally — bridges start exactly once.
    attempt2.resolve()
    await flush()
    expect(mocks.startProjectJobSyncBridge).toHaveBeenCalledTimes(1)
    expect(mocks.startNotificationBridge).toHaveBeenCalledTimes(1)
    expect(mocks.startOutboxRunner).toHaveBeenCalledTimes(1)
    expect(childrenVisible()).toBe(true)
  })

  it('attempt 1 hanging in syncAllProjectsFromJobs AFTER the bridge started → silent retry boots; the re-invoked starter is the idempotent one', async () => {
    // Post-checkpoint hang: bootstrapRepositories resolved, the bridge is
    // already live, then syncAllProjectsFromJobs() hangs (hung PostgREST
    // write — the exact class this block targets). The deadline fires and
    // the retry re-runs the WHOLE boot sequence, including the bridge
    // starter. Single-subscription safety lives in the starter itself
    // (idempotent, same stop fn — proven in bootstrapSyncRace.test.ts);
    // this test pins the producer reality that the retry path DOES call it
    // once per attempt.
    mocks.syncAllProjectsFromJobs
      .mockImplementationOnce(() => deferred().promise) // attempt 1 hangs here
      .mockResolvedValueOnce(undefined) // attempt 2 completes
    renderApp()

    await flush() // attempt 1 reaches the hang — bridge already started
    expect(mocks.startProjectJobSyncBridge).toHaveBeenCalledTimes(1)

    await flush(TIMEOUT_MS) // deadline → silent retry
    await flush()

    expect(childrenVisible()).toBe(true)
    expect(errorScreenVisible()).toBe(false)
    // One starter call per attempt — the second call must join the live
    // bridge (idempotent starter) instead of stacking a second subscription.
    expect(mocks.startProjectJobSyncBridge).toHaveBeenCalledTimes(2)
    // Late completion of the superseded attempt is inert.
    expect(mocks.startNotificationBridge).toHaveBeenCalledTimes(1)
    expect(mocks.startOutboxRunner).toHaveBeenCalledTimes(1)
  })

  it('a hard (non-timeout) bootstrap failure shows the error screen without burning the retry on it', async () => {
    mocks.bootstrapRepositories.mockRejectedValue(new Error('env validation failed'))
    renderApp()
    await flush()

    expect(errorScreenVisible()).toBe(true)
    expect(mocks.bootstrapRepositories).toHaveBeenCalledTimes(1)
    expect(mocks.captureException).toHaveBeenCalledTimes(1)
    // The deadline is dead after a hard failure — no late timeout events.
    await flush(60_000)
    expect(mocks.logWarning).not.toHaveBeenCalledWith(
      'app.bootstrap.timeout',
      expect.anything()
    )
  })

  it('non-critical notification init failure never blocks the boot', async () => {
    mocks.getSession.mockRejectedValue(new Error('auth callback still processing'))
    renderApp()
    await flush()
    expect(childrenVisible()).toBe(true)
    expect(errorScreenVisible()).toBe(false)
  })
})
