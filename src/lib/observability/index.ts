/**
 * Observability & Failure Tracking
 *
 * Provides structured logging helpers for info, warnings, and errors.
 * In development, events are written to the console.
 * When Sentry is available (already initialized via src/lib/sentry.ts),
 * messages and exceptions are also forwarded to Sentry.
 *
 * Console output is suppressed when running under Vitest so that pending
 * stdout/stderr flushes cannot race with the test worker teardown
 * (EnvironmentTeardownError: "Closing rpc while onUserConsoleLog was pending").
 *
 * Event naming convention: `<layer>.<domain>.<event_name>`
 *   e.g. `workflow.payment.release_blocked_by_dispute`
 *        `repository.jobs.update_failed`
 */

import * as Sentry from '@sentry/react'

export interface ObservabilityEvent {
  event: string
  level: 'info' | 'warning' | 'error'
  timestamp: number
  context?: Record<string, unknown>
}

/**
 * Suppress console output when running inside Vitest.
 * `import.meta.env.MODE` is `'test'` in the default Vitest configuration.
 */
const _isTestEnv = import.meta.env.MODE === 'test'

export function buildEvent(
  event: string,
  level: ObservabilityEvent['level'],
  context?: Record<string, unknown>
): ObservabilityEvent {
  return { event, level, timestamp: Date.now(), context }
}

/**
 * Log an informational lifecycle event (e.g. workflow started, entity created).
 */
export function logInfo(event: string, context?: Record<string, unknown>): void {
  const payload = buildEvent(event, 'info', context)
  if (import.meta.env.DEV && !_isTestEnv) {
    console.log('[observability]', payload)
  }
  Sentry.addBreadcrumb({ message: event, level: 'info', data: context })
}

/**
 * Log a routine, self-healing lifecycle event as a Sentry breadcrumb only.
 *
 * Unlike {@link logWarning}/{@link logError} this captures NO Sentry event and
 * therefore costs no quota. Use it for high-volume, transient signals that
 * recover on their own (e.g. realtime channel disconnects that auto-reconnect).
 */
export function logBreadcrumb(
  event: string,
  level: ObservabilityEvent['level'] = 'info',
  context?: Record<string, unknown>
): void {
  const payload = buildEvent(event, level, context)
  if (import.meta.env.DEV && !_isTestEnv) {
    console.debug('[observability]', payload)
  }
  Sentry.addBreadcrumb({ message: event, level, data: context })
}

/**
 * Log a recoverable condition that should be investigated but does not halt
 * execution (e.g. a guard rejected an invalid state transition).
 */
export function logWarning(event: string, context?: Record<string, unknown>): void {
  const payload = buildEvent(event, 'warning', context)
  if (!_isTestEnv) {
    console.warn('[observability]', payload)
  }
  Sentry.captureMessage(event, { level: 'warning', extra: context })
}

/**
 * Log a failure and forward the exception to Sentry when available.
 *
 * @param event   - Structured event name (`layer.domain.operation_failed`)
 * @param error   - The raw error/exception value, if any
 * @param context - Additional key/value pairs to attach (jobId, paymentId, etc.)
 */
export function logError(
  event: string,
  error?: unknown,
  context?: Record<string, unknown>
): void {
  const payload = buildEvent(event, 'error', context)
  if (!_isTestEnv) {
    console.error('[observability]', payload, error)
  }

  if (error instanceof Error) {
    Sentry.captureException(error, { extra: { event, ...context } })
  } else {
    Sentry.captureMessage(event, {
      level: 'error',
      extra: { rawError: error, ...context },
    })
  }
}
