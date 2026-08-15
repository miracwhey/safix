/**
 * Server-side structured observability for Vercel API functions.
 *
 * Mirrors the event naming convention of src/lib/observability/index.ts but
 * uses @sentry/node instead of @sentry/react (browser).
 *
 * Event naming convention: `<layer>.<domain>.<event_name>`
 *   e.g. `webhook.stripe.received`
 *        `webhook.stripe.verified`
 *        `webhook.stripe.duplicate`
 *        `webhook.stripe.processed`
 *        `webhook.stripe.failed`
 *
 * Sentry capture:
 *   Active only when SENTRY_DSN is present in the server environment.
 *   `Sentry.init()` is called at module load time, guarded by SENTRY_DSN.
 *   The @sentry/node package is always imported (zero cost when DSN is absent),
 *   but no initialization or capture occurs without a configured DSN.
 *
 * Structured JSON is also written to stdout/stderr, which Vercel log
 * aggregation captures automatically.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import * as Sentry from '@sentry/node'

export interface ServerObservabilityEvent {
  event: string
  level: 'info' | 'warning' | 'error'
  timestamp: number
  context?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Sentry initialization — lazy, guarded by SENTRY_DSN presence
// ---------------------------------------------------------------------------

const sentryDsn = process.env.SENTRY_DSN

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    // Use VERCEL_ENV (production | preview | development) when available.
    environment: process.env.VERCEL_ENV ?? 'development',
    // Tie server-side errors to the same release as the client bundle.
    release: process.env.VERCEL_GIT_COMMIT_SHA || undefined,
  })
}

// ---------------------------------------------------------------------------
// Emit helpers
// ---------------------------------------------------------------------------

function emit(payload: ServerObservabilityEvent): void {
  const line = JSON.stringify(payload)
  switch (payload.level) {
    case 'info':
      console.log('[observability]', line)
      break
    case 'warning':
      console.warn('[observability]', line)
      break
    case 'error':
      console.error('[observability]', line)
      break
  }
}

/**
 * Log an informational lifecycle event (e.g. webhook received, event processed).
 * Adds a Sentry breadcrumb when Sentry is configured.
 */
export function logInfo(
  event: string,
  context?: Record<string, unknown>,
): void {
  emit({ event, level: 'info', timestamp: Date.now(), context })
  if (sentryDsn) {
    Sentry.addBreadcrumb({ message: event, level: 'info', data: context })
  }
}

/**
 * Log a recoverable condition that should be investigated (e.g. duplicate
 * event, invalid state transition).
 * Forwards to Sentry as a warning-level message when configured.
 */
export function logWarning(
  event: string,
  context?: Record<string, unknown>,
): void {
  emit({ event, level: 'warning', timestamp: Date.now(), context })
  if (sentryDsn) {
    Sentry.captureMessage(event, { level: 'warning', extra: context })
  }
}

/**
 * Log a failure and forward to Sentry when configured.
 *
 * @param event   - Structured event name (`layer.domain.operation_failed`)
 * @param error   - The raw error/exception value, if any
 * @param context - Additional key/value pairs to attach (eventId, paymentId, etc.)
 */
export function logError(
  event: string,
  error?: unknown,
  context?: Record<string, unknown>,
): void {
  const errorDetail =
    error instanceof Error
      ? { message: error.message, stack: error.stack }
      : error !== undefined
        ? { raw: String(error) }
        : undefined

  emit({
    event,
    level: 'error',
    timestamp: Date.now(),
    context: errorDetail ? { ...context, error: errorDetail } : context,
  })

  if (sentryDsn) {
    if (error instanceof Error) {
      Sentry.captureException(error, { extra: { event, ...context } })
    } else {
      Sentry.captureMessage(event, {
        level: 'error',
        extra: { rawError: error, ...context },
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Sentry flush — critical for Vercel serverless functions
// ---------------------------------------------------------------------------

/**
 * Flushes queued Sentry events before the serverless function terminates.
 *
 * Vercel may kill the function process after `res.end()`.  Without an explicit
 * flush, events queued by `captureException` / `captureMessage` may be lost.
 *
 * Call this before sending the final response in critical handlers (webhook,
 * cron), or use `withSentryFlush` to wrap the handler automatically.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (sentryDsn) {
    await Sentry.flush(timeoutMs)
  }
}

/**
 * Wraps a Vercel API handler so that Sentry events are flushed after every
 * invocation, regardless of whether the handler succeeded or threw.
 *
 * Usage:
 *   async function handler(req, res) { ... }
 *   export default withSentryFlush(handler)
 */
export function withSentryFlush(
  handler: (req: VercelRequest, res: VercelResponse) => Promise<void>,
): (req: VercelRequest, res: VercelResponse) => Promise<void> {
  return async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    try {
      await handler(req, res)
    } finally {
      await flushSentry()
    }
  }
}

// ---------------------------------------------------------------------------
// Sentry user context for authenticated requests
// ---------------------------------------------------------------------------

/**
 * Sets the Sentry user scope for the current request.
 * Call after `requireAuth` succeeds so that all Sentry events emitted during
 * this request include the authenticated user ID.
 */
export function setSentryRequestUser(userId: string): void {
  if (sentryDsn) {
    Sentry.setUser({ id: userId })
  }
}
