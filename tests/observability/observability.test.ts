import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock @sentry/react before importing the module under test so that Sentry
// calls never reach the real SDK during unit tests.
// ---------------------------------------------------------------------------
vi.mock('@sentry/react', () => ({
  addBreadcrumb: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}))

import * as Sentry from '@sentry/react'
import { logInfo, logWarning, logError, buildEvent } from '../../src/lib/observability'

// ---------------------------------------------------------------------------
// Console spies — verify that console output is suppressed in test mode.
// ---------------------------------------------------------------------------

const consoleSpy = {
  log: vi.spyOn(console, 'log').mockImplementation(() => {}),
  warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
  error: vi.spyOn(console, 'error').mockImplementation(() => {}),
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// buildEvent — payload shape
// ---------------------------------------------------------------------------

describe('buildEvent', () => {
  it('produces a well-formed ObservabilityEvent payload', () => {
    const before = Date.now()
    const payload = buildEvent('workflow.jobs.started', 'info', { jobId: 'job-1' })
    const after = Date.now()

    expect(payload.event).toBe('workflow.jobs.started')
    expect(payload.level).toBe('info')
    expect(payload.timestamp).toBeGreaterThanOrEqual(before)
    expect(payload.timestamp).toBeLessThanOrEqual(after)
    expect(payload.context).toEqual({ jobId: 'job-1' })
  })

  it('works without a context argument', () => {
    const payload = buildEvent('workflow.noop', 'info')
    expect(payload.context).toBeUndefined()
  })

  it('preserves the full dot-separated event name in the payload', () => {
    const payload = buildEvent('workflow.payment.release_failed', 'error', { paymentId: 'pay-1' })
    expect(payload.event).toBe('workflow.payment.release_failed')
  })
})

// ---------------------------------------------------------------------------
// Console suppression in test mode
// ---------------------------------------------------------------------------

describe('console suppression in test mode', () => {
  it('logInfo does not write to console.log in test mode', () => {
    logInfo('workflow.jobs.started', { jobId: 'job-1' })
    expect(consoleSpy.log).not.toHaveBeenCalled()
  })

  it('logWarning does not write to console.warn in test mode', () => {
    logWarning('workflow.payment.guard_rejected', { reason: 'no_escrow' })
    expect(consoleSpy.warn).not.toHaveBeenCalled()
  })

  it('logError does not write to console.error in test mode', () => {
    logError('repository.jobs.update_failed', new Error('db timeout'))
    expect(consoleSpy.error).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// logInfo
// ---------------------------------------------------------------------------

describe('logInfo', () => {
  it('attaches context to the Sentry breadcrumb', () => {
    logInfo('repository.jobs.fetch_ok', { count: 5 })
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith({
      message: 'repository.jobs.fetch_ok',
      level: 'info',
      data: { count: 5 },
    })
  })

  it('works without a context argument', () => {
    expect(() => logInfo('workflow.noop')).not.toThrow()
  })

  it('does not invoke Sentry.captureMessage or captureException', () => {
    logInfo('workflow.test.ok')
    expect(Sentry.captureMessage).not.toHaveBeenCalled()
    expect(Sentry.captureException).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// logWarning
// ---------------------------------------------------------------------------

describe('logWarning', () => {
  it('forwards the event to Sentry.captureMessage at warning level', () => {
    logWarning('workflow.payment.guard_rejected', { jobId: 'job-2' })
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'workflow.payment.guard_rejected',
      { level: 'warning', extra: { jobId: 'job-2' } }
    )
  })

  it('does not invoke Sentry.addBreadcrumb or captureException', () => {
    logWarning('workflow.test.warn')
    expect(Sentry.addBreadcrumb).not.toHaveBeenCalled()
    expect(Sentry.captureException).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// logError – Error instance path
// ---------------------------------------------------------------------------

describe('logError – with Error instance', () => {
  it('forwards the Error to Sentry.captureException', () => {
    const err = new Error('update failed')
    logError('repository.jobs.update_failed', err, { jobId: 'job-3' })
    expect(Sentry.captureException).toHaveBeenCalledWith(err, {
      extra: { event: 'repository.jobs.update_failed', jobId: 'job-3' },
    })
  })

  it('does not call Sentry.captureMessage when an Error object is provided', () => {
    logError('repository.jobs.update_failed', new Error('oops'))
    expect(Sentry.captureMessage).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// logError – non-Error value path
// ---------------------------------------------------------------------------

describe('logError – with non-Error value', () => {
  it('forwards to Sentry.captureMessage at error level when given a string', () => {
    logError('workflow.payment.release_failed', 'unexpected null', { paymentId: 'pay-1' })
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'workflow.payment.release_failed',
      {
        level: 'error',
        extra: { rawError: 'unexpected null', paymentId: 'pay-1' },
      }
    )
  })

  it('forwards to Sentry.captureMessage when no error value is provided', () => {
    logError('workflow.payment.release_failed')
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'workflow.payment.release_failed',
      { level: 'error', extra: { rawError: undefined } }
    )
  })

  it('does not call Sentry.captureException when error is not an Error instance', () => {
    logError('workflow.payment.release_failed', 'string error')
    expect(Sentry.captureException).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Event naming convention
// ---------------------------------------------------------------------------

describe('event naming convention', () => {
  it('handles event names without context gracefully', () => {
    expect(() => logError('repository.jobs.update_failed')).not.toThrow()
  })
})
