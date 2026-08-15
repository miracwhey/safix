/**
 * `_shared/errorReport.ts` — minimal Edge Function error/alert wrapper.
 *
 * FixUp Edge Functions have zero Sentry/alerting today (finding M11): a
 * failure inside `console.error` is only visible to someone who goes
 * looking at `supabase functions logs`. This wrapper gives every function a
 * single call-site that:
 *
 *   • POSTs a structured event to Sentry's minimal envelope endpoint when
 *     `SENTRY_DSN` is set (Deno.env) — no `@sentry/deno` SDK dependency,
 *     so no extra esm.sh import weight in every function's cold start.
 *   - falls back to a structured `console.error` (same shape as the
 *     existing `log()` helpers in this codebase: JSON line with `event`,
 *     `timestamp`, plus context) when `SENTRY_DSN` is unset — this is the
 *     default in every environment until a DSN is provisioned, so it must
 *     never throw or block the caller.
 *
 * Usage (reference integration: `account-cascade-cleanup/index.ts`):
 *
 *   import { reportError } from '../_shared/errorReport.ts'
 *   await reportError('cleanup.cascade.bucket.error', error, { userId, bucket })
 *
 * Intentionally NOT wired into other functions yet — each function's owner
 * imports this when ready. The wrapper has no side effects at import time.
 */

type DenoEnvLike = {
  env?: { get?: (name: string) => string | undefined }
}

function getDenoEnv(): DenoEnvLike | undefined {
  return (globalThis as { Deno?: DenoEnvLike }).Deno
}

function getEnv(name: string): string | undefined {
  return getDenoEnv()?.env?.get?.(name)
}

export type ErrorReportContext = Record<string, unknown>

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function toStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined
}

/**
 * Builds a minimal Sentry envelope (event item only, no session/attachment
 * items) per https://develop.sentry.dev/sdk/envelopes/. Avoids pulling in
 * the full Sentry SDK for a single POST per error.
 */
function buildSentryEnvelope(
  dsn: string,
  event: string,
  error: unknown,
  context: ErrorReportContext | undefined,
): { url: string; body: string } | null {
  // DSN shape: https://<key>@<host>/<projectId>
  const match = /^https:\/\/([^@]+)@([^/]+)\/(.+)$/.exec(dsn)
  if (!match) return null
  const [, publicKey, host, projectId] = match
  const url = `https://${host}/api/${projectId}/envelope/`
  const eventId = crypto.randomUUID().replace(/-/g, '')
  const sentAt = new Date().toISOString()

  const header = JSON.stringify({
    event_id: eventId,
    sent_at: sentAt,
    dsn,
  })
  const itemHeader = JSON.stringify({ type: 'event' })
  const itemBody = JSON.stringify({
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: 'javascript',
    level: 'error',
    message: { formatted: `${event}: ${toMessage(error)}` },
    exception: {
      values: [
        {
          type: event,
          value: toMessage(error),
          stacktrace: toStack(error)
            ? { frames: [{ filename: 'edge-function', function: event }] }
            : undefined,
        },
      ],
    },
    tags: { event, source: 'edge-function' },
    extra: context ?? {},
  })

  return {
    url: `${url}?sentry_key=${publicKey}`,
    body: `${header}\n${itemHeader}\n${itemBody}\n`,
  }
}

/**
 * Reports an error to Sentry (if `SENTRY_DSN` is set) and always logs a
 * structured line to console.error so `supabase functions logs` remains a
 * complete record even without alerting configured.
 *
 * Never throws — a broken alerting path must not break the caller's error
 * handling.
 */
export async function reportError(
  event: string,
  error: unknown,
  context?: ErrorReportContext,
): Promise<void> {
  console.error(
    JSON.stringify({
      event,
      timestamp: Date.now(),
      level: 'error',
      message: toMessage(error),
      ...(context ?? {}),
    }),
  )

  const dsn = getEnv('SENTRY_DSN')
  if (!dsn) return

  try {
    const envelope = buildSentryEnvelope(dsn, event, error, context)
    if (!envelope) {
      console.error(
        JSON.stringify({ event: 'errorReport.dsn_invalid', timestamp: Date.now() }),
      )
      return
    }
    await fetch(envelope.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-sentry-envelope' },
      body: envelope.body,
    })
  } catch (reportErr) {
    // Alerting itself failed (network, bad DSN, etc) — swallow, the
    // console.error above already preserved the original error.
    console.error(
      JSON.stringify({
        event: 'errorReport.sentry_post_failed',
        timestamp: Date.now(),
        error: toMessage(reportErr),
      }),
    )
  }
}
