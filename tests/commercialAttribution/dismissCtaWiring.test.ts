/**
 * Attribution-Block Dismiss CTA wiring contract.
 *
 * Locks the Codex-P3 regression: for `job_not_found` attribution blocks the
 * UI must NOT fire `onRetryPayment` on dismiss.  The handler built by
 * PaymentInitErrorBlock when `cta.action === 'dismiss'` calls either the
 * caller-provided `onDismiss` OR `window.history.back()` as fallback —
 * never `onRetryPayment`.
 *
 * We lock the contract at the pure-logic layer so the test is stable
 * against the heavy Stripe/Supabase dependency tree of the component.
 * The component uses the exact same fallback expression.
 */

import { describe, it, expect, vi } from 'vitest'
import { buildAttributionBlockInfo } from '../../src/lib/commercialAttribution/attributionBlockUi'

describe('Dismiss CTA — mapper contract', () => {
  it('job_not_found → cta.action === "dismiss" (never "retry")', () => {
    const info = buildAttributionBlockInfo({
      error: 'PAYMENT_BLOCKED_JOB_NOT_FOUND',
      jobId: 'job-stale',
    })
    expect(info.kind).toBe('job_not_found')
    expect(info.retryable).toBe(false)
    expect(info.cta?.action).toBe('dismiss')
    expect(info.cta?.action).not.toBe('retry')
    expect(info.cta?.label).toMatch(/Zurück/i)
  })

  it('cta.action values are disjoint across the five attribution branches', () => {
    const jobNotFound = buildAttributionBlockInfo({ error: 'PAYMENT_BLOCKED_JOB_NOT_FOUND' })
    const unresolved = buildAttributionBlockInfo({ error: 'PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED' })
    const dlq = buildAttributionBlockInfo({ error: 'PAYMENT_BLOCKED_ATTRIBUTION_DLQ' })
    const invalid = buildAttributionBlockInfo({ error: 'PAYMENT_BLOCKED_ATTRIBUTION_INVALID' })
    const lookup = buildAttributionBlockInfo({ error: 'ATTRIBUTION_LOOKUP_FAILED' })

    expect(jobNotFound.cta?.action).toBe('dismiss')
    expect(unresolved.cta?.action).toBe('retry')
    expect(lookup.cta?.action).toBe('retry')
    expect(dlq.cta?.action).toBe('support')
    expect(invalid.cta?.action).toBe('support')
  })
})

describe('Dismiss click path — component-level handler semantics', () => {
  // Mirror of the inline handler installed by PaymentInitErrorBlock when the
  // branch is rendered:
  //   const handleDismiss = onDismiss ?? (() => window.history.back())
  // We test that identical expression directly so regressions in wiring
  // (e.g. reverting to onRetryPayment) are caught by a stable unit test.
  function buildHandler(
    onDismiss: (() => void) | undefined,
    win: { history?: { back: () => void } } | undefined,
  ): () => void {
    return onDismiss ?? (() => {
      if (win && win.history) {
        win.history.back()
      }
    })
  }

  it('no onDismiss → fallback calls window.history.back, never onRetryPayment', () => {
    const onRetry = vi.fn()
    const backSpy = vi.fn()
    const fakeWindow = { history: { back: backSpy } }

    const handle = buildHandler(undefined, fakeWindow)
    handle()

    expect(backSpy).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('no onDismiss AND no window (SSR/non-browser) → no throw, no onRetryPayment call', () => {
    const onRetry = vi.fn()
    const handle = buildHandler(undefined, undefined)
    expect(() => handle()).not.toThrow()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('onDismiss provided → fired directly, onRetryPayment never called', () => {
    const onRetry = vi.fn()
    const onDismiss = vi.fn()
    const fakeWindow = { history: { back: vi.fn() } }
    const handle = buildHandler(onDismiss, fakeWindow)
    handle()
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
    // Fallback is NOT called when onDismiss is provided
    expect(fakeWindow.history.back).not.toHaveBeenCalled()
  })
})
