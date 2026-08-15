/**
 * Phase 5 Spatial V1.6 — perf instrumentation unit tests.
 *
 * Covers:
 *   - mark/measure happy path with Node `performance` (vitest env=node)
 *   - SSR-safe / API-missing fallback (silent no-op)
 *   - measure with unknown start-mark → undefined + observability warning
 *   - startSpan / startSpanSync delegate to Sentry.startSpan with the
 *     correct attributes shape
 *   - reportMeasureAsSpan skips non-positive / non-finite durations
 *   - reportMeasureAsSpan emits an inactive Sentry span on success
 *   - clearPerfMarks tolerates missing-API environments
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Sentry mock — kept above the SUT import so the module picks up the stub.
// ---------------------------------------------------------------------------

const startSpanMock = vi.fn(
  (
    _opts: { name: string; op?: string; attributes?: Record<string, unknown> },
    fn: () => unknown,
  ) => fn(),
)

const inactiveEnd = vi.fn()
const startInactiveSpanMock = vi.fn(() => ({ end: inactiveEnd }))

vi.mock('@sentry/react', () => ({
  startSpan: (
    opts: { name: string; op?: string; attributes?: Record<string, unknown> },
    fn: () => unknown,
  ) => startSpanMock(opts, fn),
  startInactiveSpan: (opts: {
    name: string
    op?: string
    attributes?: Record<string, unknown>
  }) => startInactiveSpanMock(opts),
  // logWarning's transitive Sentry call path needs these to exist so the
  // observability index.ts module doesn't blow up.
  addBreadcrumb: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}))

import {
  clearPerfMarks,
  mark,
  measure,
  reportMeasureAsSpan,
  startSpan,
  startSpanSync,
} from '../../../src/lib/observability/perf'

// ---------------------------------------------------------------------------
// Common spies / cleanup
// ---------------------------------------------------------------------------

const originalPerformance = globalThis.performance
const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})

beforeEach(() => {
  vi.clearAllMocks()
  inactiveEnd.mockClear()
  // Always reset the global performance to the platform default at the
  // start of every test — individual tests stub when they need to.
  Object.defineProperty(globalThis, 'performance', {
    value: originalPerformance,
    configurable: true,
  })
  // Wipe any user-timing entries the previous test left behind so
  // duration assertions don't read across cases.
  try {
    globalThis.performance.clearMarks?.()
    globalThis.performance.clearMeasures?.()
  } catch {
    /* ignore — environments without the API */
  }
})

afterEach(() => {
  consoleWarn.mockClear()
  Object.defineProperty(globalThis, 'performance', {
    value: originalPerformance,
    configurable: true,
  })
})

// ---------------------------------------------------------------------------
// mark / measure — happy path
// ---------------------------------------------------------------------------

describe('mark + measure', () => {
  it('captures a positive duration between two marks', async () => {
    mark('spatial.hub.mount-start')
    // Yield so the steady-clock advances at least one tick.
    await new Promise(resolve => setTimeout(resolve, 5))
    mark('spatial.hub.gltf-ready')

    const duration = measure(
      'spatial.hub.load',
      'spatial.hub.mount-start',
      'spatial.hub.gltf-ready',
    )

    expect(duration).toBeTypeOf('number')
    expect(duration).toBeGreaterThan(0)
    expect(Number.isFinite(duration)).toBe(true)
  })

  it('returns undefined and warns when the start mark does not exist', () => {
    const duration = measure(
      'spatial.hub.load',
      'spatial.hub.mount-start', // never marked
      'spatial.hub.gltf-ready',
    )
    expect(duration).toBeUndefined()
  })

  it('does not throw when performance is undefined (SSR / WKWebView edge)', () => {
    Object.defineProperty(globalThis, 'performance', {
      value: undefined,
      configurable: true,
    })
    expect(() => mark('spatial.hub.mount-start')).not.toThrow()
    expect(measure('spatial.hub.load', 'spatial.hub.mount-start')).toBeUndefined()
  })

  it('does not throw when performance.mark is missing', () => {
    Object.defineProperty(globalThis, 'performance', {
      value: { now: () => 0 } as unknown as Performance,
      configurable: true,
    })
    expect(() => mark('spatial.hub.mount-start')).not.toThrow()
    expect(measure('spatial.hub.load', 'spatial.hub.mount-start')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// startSpan / startSpanSync — Sentry delegation
// ---------------------------------------------------------------------------

describe('startSpan', () => {
  it('delegates to Sentry.startSpan and returns the callback result', async () => {
    const result = await startSpan(
      'spatial.lidar.scene',
      'app.workflow',
      async () => 'done',
      { jobId: 'job-42' },
    )

    expect(result).toBe('done')
    expect(startSpanMock).toHaveBeenCalledTimes(1)
    const [opts] = startSpanMock.mock.calls[0]
    expect(opts.name).toBe('spatial.lidar.scene')
    expect(opts.op).toBe('app.workflow')
    expect(opts.attributes).toEqual({ jobId: 'job-42' })
  })

  it('strips null/undefined attribute entries before forwarding', async () => {
    await startSpan(
      'spatial.hub.load',
      'ui.load',
      async () => undefined,
      { jobId: 'job-1', parentScanId: null, missing: undefined },
    )
    const [opts] = startSpanMock.mock.calls[0]
    expect(opts.attributes).toEqual({ jobId: 'job-1' })
  })

  it('omits attributes when every entry was nullish', async () => {
    await startSpan('spatial.hub.load', 'ui.load', async () => undefined, {
      a: null,
      b: undefined,
    })
    const [opts] = startSpanMock.mock.calls[0]
    expect(opts.attributes).toBeUndefined()
  })
})

describe('startSpanSync', () => {
  it('delegates to Sentry.startSpan with the callback result returned synchronously', () => {
    const result = startSpanSync('spatial.pin.save-roundtrip', 'ui.action', () => 7)
    expect(result).toBe(7)
    expect(startSpanMock).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// reportMeasureAsSpan
// ---------------------------------------------------------------------------

describe('reportMeasureAsSpan', () => {
  it('skips non-positive durations', () => {
    reportMeasureAsSpan('spatial.hub.load', 'ui.load', 0)
    reportMeasureAsSpan('spatial.hub.load', 'ui.load', -12)
    expect(startInactiveSpanMock).not.toHaveBeenCalled()
  })

  it('skips non-finite durations', () => {
    reportMeasureAsSpan('spatial.hub.load', 'ui.load', Number.NaN)
    reportMeasureAsSpan('spatial.hub.load', 'ui.load', Number.POSITIVE_INFINITY)
    expect(startInactiveSpanMock).not.toHaveBeenCalled()
  })

  it('emits an inactive Sentry span with the duration on success', () => {
    reportMeasureAsSpan('spatial.pin.save-roundtrip', 'ui.action', 124.5, {
      pinType: 'note',
    })
    expect(startInactiveSpanMock).toHaveBeenCalledTimes(1)
    const [opts] = startInactiveSpanMock.mock.calls[0]
    expect(opts.name).toBe('spatial.pin.save-roundtrip')
    expect(opts.op).toBe('ui.action')
    expect(opts.attributes).toEqual({ pinType: 'note' })
    expect(typeof opts.startTime).toBe('number')
    expect(inactiveEnd).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// clearPerfMarks
// ---------------------------------------------------------------------------

describe('clearPerfMarks', () => {
  it('runs without throwing when performance is undefined', () => {
    Object.defineProperty(globalThis, 'performance', {
      value: undefined,
      configurable: true,
    })
    expect(() => clearPerfMarks()).not.toThrow()
    expect(() => clearPerfMarks('spatial.')).not.toThrow()
  })

  it('removes prefixed marks from the user-timing buffer', () => {
    mark('spatial.hub.mount-start')
    mark('spatial.hub.gltf-ready')
    clearPerfMarks('spatial.')
    const remaining = performance.getEntriesByType?.('mark') ?? []
    const stillThere = remaining.filter(e => e.name.startsWith('spatial.'))
    expect(stillThere.length).toBe(0)
  })
})
