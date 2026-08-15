/**
 * Fee-Rate Drift-Guard for attribution_status='dlq'.
 *
 * Contract invariant (non-negotiable):
 *   A job in DLQ must never reach the fee-rate resolver.  The attribution
 *   guard in every money-moving API (create-escrow, initiate-funding,
 *   initiate-supplementary-funding, release-tranche, release-supplementary-
 *   payout) blocks BEFORE fee computation.  If this ordering ever drifts
 *   and a DLQ-status job reaches `resolveCommercialFeeRate`, the system
 *   must still fail-closed — never silently default to 9 %.
 *
 * Tests:
 *   D1. `resolveCommercialFeeRate` must throw on 'unknown_pending_resolution'
 *       (existing legacy safety net — regression lock).
 *   D2. The `AttributionBlockErrorCode` union is the EXACT set of codes the
 *       shared guard emits for non-finalized states.  Any new status branch
 *       must also get a UI-mapper branch.
 *   D3. The UI mapper's 'dlq' branch is always NON-retryable — never offers
 *       a retry CTA that would hit a blocked server path in a loop.
 *   D4. The UI mapper's 'unresolved' branch is retryable (retry is the
 *       correct UX for the finalizer to catch up).
 */

import { describe, it, expect } from 'vitest'
import { resolveCommercialFeeRate } from '../../api/_feeRate'
import {
  ATTRIBUTION_BLOCK_ERROR_CODES,
  buildAttributionBlockInfo,
  type AttributionBlockErrorCode,
} from '../../src/lib/commercialAttribution/attributionBlockUi'

describe('Fee-Rate Drift-Guard — DLQ + unresolved status must never yield a fee', () => {
  // D1
  it("D1: resolveCommercialFeeRate throws on 'unknown_pending_resolution' (regression lock)", () => {
    expect(() => resolveCommercialFeeRate('unknown_pending_resolution')).toThrow(
      /PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED/,
    )
  })

  // D2 — the mapper covers EVERY code the server can emit from the shared guard
  it('D2: every AttributionBlockErrorCode is handled by the UI mapper', () => {
    const nonRetryableKinds = new Set(['dlq', 'invalid', 'job_not_found'])
    for (const code of ATTRIBUTION_BLOCK_ERROR_CODES) {
      const info = buildAttributionBlockInfo({ error: code })
      expect(info.code).toBe(code)
      // Every code maps to either a retryable or non-retryable UI state.
      // Non-retryable states never offer a retry CTA (guard against loops).
      if (nonRetryableKinds.has(info.kind)) {
        expect(info.retryable).toBe(false)
        expect(info.cta?.action).not.toBe('retry')
      }
    }
  })

  // D3 — DLQ is the loudest non-retryable state; retry would spam a locked
  // release path and waste server load while the operator is reviewing.
  it("D3: 'dlq' is never retryable and never offers a retry CTA", () => {
    const info = buildAttributionBlockInfo({
      error: 'PAYMENT_BLOCKED_ATTRIBUTION_DLQ',
      dlqReason: 'MAX_RETRY_EXCEEDED',
    })
    expect(info.kind).toBe('dlq')
    expect(info.retryable).toBe(false)
    expect(info.cta?.action).toBe('support')
    expect(info.retryAfterSeconds).toBeNull()
  })

  // D4 — unresolved IS retryable (finalizer should catch up shortly).
  it("D4: 'unresolved' is retryable with a short backoff and retry CTA", () => {
    const info = buildAttributionBlockInfo({
      error: 'PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED',
      attributionStatus: 'pending',
    })
    expect(info.retryable).toBe(true)
    expect(info.cta?.action).toBe('retry')
    expect(info.retryAfterSeconds).toBeGreaterThan(0)
  })

  // D5 — 'invalid' should surface support, not retry.  An invalid finalized
  // row needs data-team repair, retrying would loop on the same invariant.
  it("D5: 'invalid' points to support, never to retry", () => {
    const info = buildAttributionBlockInfo({ error: 'PAYMENT_BLOCKED_ATTRIBUTION_INVALID' })
    expect(info.kind).toBe('invalid')
    expect(info.retryable).toBe(false)
    expect(info.cta?.action).toBe('support')
  })

  // Sanity: the AttributionBlockErrorCode union matches the handled set
  it('D6: handled set is exactly the code union — no drift', () => {
    const handled = new Set<AttributionBlockErrorCode>()
    for (const code of ATTRIBUTION_BLOCK_ERROR_CODES) {
      const info = buildAttributionBlockInfo({ error: code })
      if (info.code) handled.add(info.code)
    }
    expect(handled.size).toBe(ATTRIBUTION_BLOCK_ERROR_CODES.length)
  })
})
