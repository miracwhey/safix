// vi.mock is hoisted before imports — mock @sentry/node before _observability loads.
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}))

/**
 * Server-side observability helper tests.
 *
 * Verifies that api/_observability.ts emits structured JSON events to the
 * correct console channel for each log level, and that the event payload
 * shape (event name, level, timestamp, context) is correct.
 *
 * Sentry is mocked so no real captures occur during tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as Sentry from '@sentry/node'
import { logInfo, logWarning, logError } from '../../api/_observability'
import type { ServerObservabilityEvent } from '../../api/_observability'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureConsoleOutput(): {
  info: ServerObservabilityEvent[]
  warn: ServerObservabilityEvent[]
  error: ServerObservabilityEvent[]
  restore: () => void
} {
  const info: ServerObservabilityEvent[] = []
  const warn: ServerObservabilityEvent[] = []
  const error: ServerObservabilityEvent[] = []

  const origLog = console.log
  const origWarn = console.warn
  const origError = console.error

  console.log = (_prefix: string, json: string) => {
    info.push(JSON.parse(json) as ServerObservabilityEvent)
  }
  console.warn = (_prefix: string, json: string) => {
    warn.push(JSON.parse(json) as ServerObservabilityEvent)
  }
  console.error = (_prefix: string, json: string) => {
    error.push(JSON.parse(json) as ServerObservabilityEvent)
  }

  return {
    info,
    warn,
    error,
    restore: () => {
      console.log = origLog
      console.warn = origWarn
      console.error = origError
    },
  }
}

// ---------------------------------------------------------------------------
// logInfo
// ---------------------------------------------------------------------------

describe('logInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits a structured JSON payload to console.log', () => {
    const cap = captureConsoleOutput()
    logInfo('webhook.stripe.received', { eventId: 'evt_001', eventType: 'payment_intent.succeeded' })
    cap.restore()

    expect(cap.info).toHaveLength(1)
    const payload = cap.info[0]
    expect(payload.event).toBe('webhook.stripe.received')
    expect(payload.level).toBe('info')
    expect(typeof payload.timestamp).toBe('number')
    expect(payload.context?.eventId).toBe('evt_001')
    expect(payload.context?.eventType).toBe('payment_intent.succeeded')
  })

  it('emits nothing to console.warn or console.error', () => {
    const cap = captureConsoleOutput()
    logInfo('webhook.stripe.verified', { eventId: 'evt_002' })
    cap.restore()

    expect(cap.warn).toHaveLength(0)
    expect(cap.error).toHaveLength(0)
  })

  it('works without context', () => {
    const cap = captureConsoleOutput()
    logInfo('webhook.stripe.processed')
    cap.restore()

    expect(cap.info).toHaveLength(1)
    expect(cap.info[0].event).toBe('webhook.stripe.processed')
    expect(cap.info[0].context).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// logWarning
// ---------------------------------------------------------------------------

describe('logWarning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits a structured JSON payload to console.warn', () => {
    const cap = captureConsoleOutput()
    logWarning('webhook.stripe.failed', { reason: 'missing signature' })
    cap.restore()

    expect(cap.warn).toHaveLength(1)
    const payload = cap.warn[0]
    expect(payload.event).toBe('webhook.stripe.failed')
    expect(payload.level).toBe('warning')
    expect(typeof payload.timestamp).toBe('number')
    expect(payload.context?.reason).toBe('missing signature')
  })

  it('emits nothing to console.log or console.error', () => {
    const cap = captureConsoleOutput()
    logWarning('webhook.stripe.duplicate', { eventId: 'evt_003' })
    cap.restore()

    expect(cap.info).toHaveLength(0)
    expect(cap.error).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// logError
// ---------------------------------------------------------------------------

describe('logError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits a structured JSON payload to console.error', () => {
    const cap = captureConsoleOutput()
    logError('webhook.stripe.failed', new Error('DB timeout'), { eventId: 'evt_004' })
    cap.restore()

    expect(cap.error).toHaveLength(1)
    const payload = cap.error[0]
    expect(payload.event).toBe('webhook.stripe.failed')
    expect(payload.level).toBe('error')
    expect(typeof payload.timestamp).toBe('number')
    expect(payload.context?.eventId).toBe('evt_004')
  })

  it('includes error message and stack in context when error is an Error instance', () => {
    const cap = captureConsoleOutput()
    const err = new Error('DB write failed')
    logError('webhook.stripe.failed', err, { paymentId: 'pay_123' })
    cap.restore()

    const errorCtx = cap.error[0].context?.error as Record<string, unknown>
    expect(errorCtx?.message).toBe('DB write failed')
    expect(typeof errorCtx?.stack).toBe('string')
  })

  it('includes raw string in context when error is not an Error instance', () => {
    const cap = captureConsoleOutput()
    logError('webhook.stripe.failed', 'unexpected string error')
    cap.restore()

    const errorCtx = cap.error[0].context?.error as Record<string, unknown>
    expect(errorCtx?.raw).toBe('unexpected string error')
  })

  it('works when error is undefined', () => {
    const cap = captureConsoleOutput()
    logError('webhook.stripe.failed', undefined, { reason: 'config missing' })
    cap.restore()

    expect(cap.error).toHaveLength(1)
    expect(cap.error[0].context?.reason).toBe('config missing')
    expect(cap.error[0].context?.error).toBeUndefined()
  })

  it('emits nothing to console.log or console.warn', () => {
    const cap = captureConsoleOutput()
    logError('webhook.stripe.failed', new Error('test'))
    cap.restore()

    expect(cap.info).toHaveLength(0)
    expect(cap.warn).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Sentry forwarding
// ---------------------------------------------------------------------------

describe('Sentry integration (SENTRY_DSN absent in test environment)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not call Sentry.captureException when SENTRY_DSN is not set', () => {
    const cap = captureConsoleOutput()
    logError('webhook.stripe.failed', new Error('test'))
    cap.restore()

    // sentryDsn is undefined in test environment — no Sentry calls expected.
    expect(Sentry.captureException).not.toHaveBeenCalled()
  })

  it('does not call Sentry.captureMessage for warnings when SENTRY_DSN is not set', () => {
    const cap = captureConsoleOutput()
    logWarning('webhook.stripe.failed', { reason: 'test' })
    cap.restore()

    expect(Sentry.captureMessage).not.toHaveBeenCalled()
  })

  it('does not call Sentry.addBreadcrumb for info events when SENTRY_DSN is not set', () => {
    const cap = captureConsoleOutput()
    logInfo('webhook.stripe.received', { eventId: 'evt_005' })
    cap.restore()

    expect(Sentry.addBreadcrumb).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Event shape
// ---------------------------------------------------------------------------

describe('event payload shape', () => {
  it('timestamp is a recent Unix millisecond value', () => {
    const before = Date.now()
    const cap = captureConsoleOutput()
    logInfo('test.event')
    cap.restore()
    const after = Date.now()

    const ts = cap.info[0].timestamp
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('level matches the call for each helper', () => {
    const cap = captureConsoleOutput()
    logInfo('a')
    logWarning('b')
    logError('c')
    cap.restore()

    expect(cap.info[0].level).toBe('info')
    expect(cap.warn[0].level).toBe('warning')
    expect(cap.error[0].level).toBe('error')
  })
})
