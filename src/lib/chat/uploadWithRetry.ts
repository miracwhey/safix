/**
 * Block D Slice B — Resilient upload wrapper.
 *
 * Layers of defence (in execution order):
 *   1. Offline check before each attempt — throws OfflineError immediately.
 *   2. Up to maxAttempts attempts with exponential back-off (default 1s/2s/4s).
 *   3. Per-attempt AbortSignal + optional attemptTimeoutMs: a hung socket is
 *      aborted deterministically and the attempt is classified transient so the
 *      loop retries (a 5G/WKWebView socket that never resolves must not pin the
 *      pending bubble forever — the send has to end in success OR a typed fail).
 *   4. Non-retryable errors bypass the loop and re-throw instantly.
 *
 * Designed to wrap Supabase Storage upload calls. The caller has already
 * performed the optimistic insert; this layer keeps the pending state alive
 * as long as there is a plausible chance of success. The wrapped fn receives a
 * fresh AbortSignal per attempt so it can wire an XHR/fetch abort to the timer.
 */

import { ChatRBACError, ChatMigrationPendingError, ChatStorageUploadError } from '../chat/errors'

export class OfflineError extends Error {
  constructor() {
    super('Keine Verbindung — bitte Internet prüfen')
    this.name = 'OfflineError'
  }
}

/**
 * Thrown when an upload attempt exceeds `attemptTimeoutMs`. `name = 'TimeoutError'`
 * so `classifyChatSendError` maps it to the transient class (retryable). The
 * loop itself always treats it as retryable regardless of `isRetryable`.
 */
export class UploadTimeoutError extends Error {
  readonly timeoutMs: number
  constructor(timeoutMs: number) {
    super(`Upload timed out after ${timeoutMs}ms`)
    this.name = 'TimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/** Thrown after an optimistic row is already in the stream. */
export class ChatUploadError extends Error {
  readonly bubbleInserted = true
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'ChatUploadError'
    if (cause instanceof Error && cause.stack) this.stack = cause.stack
  }
}

const DEFAULT_DELAYS = [1000, 2000, 4000]

function isRetryable(err: unknown): boolean {
  if (err instanceof ChatRBACError) return false
  if (err instanceof ChatMigrationPendingError) return false
  if (err instanceof OfflineError) return false
  // A per-attempt timeout / stall is always transient — the loop retries.
  if (err instanceof UploadTimeoutError) return true
  // Storage upload rejections: a 4xx (mime not allowed, payload too large,
  // unsupported media) is permanent — retrying just burns ~7s on a spinner
  // before the same failure. 408/429 are the transient exceptions; network
  // errors carry status 0 and fall through to the retry path below.
  if (err instanceof ChatStorageUploadError && err.status !== null) {
    if (err.status === 408 || err.status === 429) return true
    if (err.status >= 400 && err.status < 500) return false
  }
  // Supabase UNIQUE constraint — idempotent, but indicates a logic error not a transient failure
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as Record<string, unknown>).code
    if (code === '23505' || code === 'PGRST116') return false
  }
  return true
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface UploadRetryOptions {
  maxAttempts?: number
  delays?: number[]
  /**
   * Per-attempt wall-clock budget. When set, each attempt gets a fresh
   * AbortController whose signal fires after this many ms; the abort is
   * classified transient so the attempt is retried. Omit for no timeout.
   */
  attemptTimeoutMs?: number
}

export async function uploadWithRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: UploadRetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3
  const delays = opts.delays ?? DEFAULT_DELAYS
  const attemptTimeoutMs = opts.attemptTimeoutMs

  let lastErr: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new OfflineError()
    }
    const controller = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    if (attemptTimeoutMs !== undefined && attemptTimeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, attemptTimeoutMs)
    }
    try {
      return await fn(controller.signal)
    } catch (err) {
      // A timeout-driven abort surfaces as whatever rejection fn raised; replace
      // it with the typed timeout so both the loop and the UI classifier agree.
      const effective = timedOut ? new UploadTimeoutError(attemptTimeoutMs as number) : err
      lastErr = effective
      if (!isRetryable(effective)) throw effective
      if (attempt < maxAttempts - 1) {
        await sleep(delays[attempt] ?? delays[delays.length - 1])
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  throw lastErr
}
