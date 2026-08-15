/**
 * Shared Attribution-Block → UI-State mapper tests.
 *
 * Ensures the mapper:
 *   - produces a distinct AttributionBlockInfo for each of the five
 *     canonical server codes;
 *   - marks retryable vs non-retryable correctly;
 *   - attaches the right CTA action (retry | support | dismiss);
 *   - carries forensic fields (jobId, attributionStatus, dlqReason);
 *   - rejects non-attribution payloads via isAttributionBlockError.
 */

import { describe, it, expect } from 'vitest'
import {
  ATTRIBUTION_BLOCK_ERROR_CODES,
  isAttributionBlockCode,
  isAttributionBlockError,
  buildAttributionBlockInfo,
  tryAttributionBlockInfo,
} from '../../src/lib/commercialAttribution/attributionBlockUi'

// ── Constants ────────────────────────────────────────────────────────────────

describe('ATTRIBUTION_BLOCK_ERROR_CODES', () => {
  it('covers all five canonical codes in matching order', () => {
    expect(ATTRIBUTION_BLOCK_ERROR_CODES).toEqual([
      'PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED',
      'PAYMENT_BLOCKED_ATTRIBUTION_DLQ',
      'PAYMENT_BLOCKED_ATTRIBUTION_INVALID',
      'PAYMENT_BLOCKED_JOB_NOT_FOUND',
      'ATTRIBUTION_LOOKUP_FAILED',
    ])
  })
})

// ── Guards ───────────────────────────────────────────────────────────────────

describe('isAttributionBlockCode', () => {
  it.each(ATTRIBUTION_BLOCK_ERROR_CODES.map((c) => [c]))(
    'accepts %s',
    (code) => {
      expect(isAttributionBlockCode(code)).toBe(true)
    },
  )

  it('rejects unrelated strings, null, undefined, numbers, objects', () => {
    expect(isAttributionBlockCode('PROVIDER_NOT_PAYOUT_READY')).toBe(false)
    expect(isAttributionBlockCode(null)).toBe(false)
    expect(isAttributionBlockCode(undefined)).toBe(false)
    expect(isAttributionBlockCode(500)).toBe(false)
    expect(isAttributionBlockCode({})).toBe(false)
  })
})

describe('isAttributionBlockError', () => {
  it('accepts any body whose error field is a canonical code', () => {
    expect(isAttributionBlockError({ error: 'PAYMENT_BLOCKED_ATTRIBUTION_DLQ' })).toBe(true)
  })

  it('rejects malformed or non-attribution bodies', () => {
    expect(isAttributionBlockError(null)).toBe(false)
    expect(isAttributionBlockError(undefined)).toBe(false)
    expect(isAttributionBlockError({ error: 'PROVIDER_NOT_PAYOUT_READY' })).toBe(false)
    expect(isAttributionBlockError({ errorCode: 'PAYMENT_BLOCKED_ATTRIBUTION_DLQ' })).toBe(false)
  })
})

// ── Mapper ───────────────────────────────────────────────────────────────────

describe('buildAttributionBlockInfo', () => {
  it('maps UNRESOLVED → retryable unresolved with retry CTA', () => {
    const info = buildAttributionBlockInfo({
      error: 'PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED',
      jobId: 'job-1',
      attributionStatus: 'pending',
    })
    expect(info.kind).toBe('unresolved')
    expect(info.retryable).toBe(true)
    expect(info.retryAfterSeconds).toBe(30)
    expect(info.cta?.action).toBe('retry')
    expect(info.jobId).toBe('job-1')
    expect(info.attributionStatus).toBe('pending')
    expect(info.dlqReason).toBeNull()
    expect(info.title).toBeTruthy()
    expect(info.message).toBeTruthy()
  })

  it('maps DLQ → non-retryable dlq with support CTA and forwarded dlqReason', () => {
    const info = buildAttributionBlockInfo({
      error: 'PAYMENT_BLOCKED_ATTRIBUTION_DLQ',
      jobId: 'job-2',
      dlqReason: 'MAX_RETRY_EXCEEDED',
    })
    expect(info.kind).toBe('dlq')
    expect(info.retryable).toBe(false)
    expect(info.retryAfterSeconds).toBeNull()
    expect(info.cta?.action).toBe('support')
    expect(info.dlqReason).toBe('MAX_RETRY_EXCEEDED')
    expect(info.attributionStatus).toBe('dlq')
  })

  it('maps INVALID → non-retryable invalid with support CTA', () => {
    const info = buildAttributionBlockInfo({
      error: 'PAYMENT_BLOCKED_ATTRIBUTION_INVALID',
      jobId: 'job-3',
    })
    expect(info.kind).toBe('invalid')
    expect(info.retryable).toBe(false)
    expect(info.cta?.action).toBe('support')
  })

  it('maps JOB_NOT_FOUND → non-retryable job_not_found with dismiss CTA', () => {
    const info = buildAttributionBlockInfo({
      error: 'PAYMENT_BLOCKED_JOB_NOT_FOUND',
      jobId: 'job-4',
    })
    expect(info.kind).toBe('job_not_found')
    expect(info.retryable).toBe(false)
    expect(info.cta?.action).toBe('dismiss')
  })

  it('maps ATTRIBUTION_LOOKUP_FAILED → retryable lookup_failed with retry CTA', () => {
    const info = buildAttributionBlockInfo({
      error: 'ATTRIBUTION_LOOKUP_FAILED',
      jobId: 'job-5',
    })
    expect(info.kind).toBe('lookup_failed')
    expect(info.retryable).toBe(true)
    expect(info.cta?.action).toBe('retry')
  })

  it('unknown error code falls back to retryable unresolved (defensive)', () => {
    const info = buildAttributionBlockInfo({ error: 'SOMETHING_ELSE' })
    expect(info.kind).toBe('unresolved')
    expect(info.retryable).toBe(true)
  })

  it('titles and messages are German and free of raw English / error codes', () => {
    for (const code of ATTRIBUTION_BLOCK_ERROR_CODES) {
      const info = buildAttributionBlockInfo({ error: code })
      expect(info.title).not.toMatch(/PAYMENT_BLOCKED|ATTRIBUTION_/)
      expect(info.message).not.toMatch(/PAYMENT_BLOCKED|ATTRIBUTION_/)
      // basic German sanity — every message contains at least one German word
      expect(info.message).toMatch(/[äöüßÄÖÜ]|bitte|Auftrag|Team|Provisions|versuchen/i)
    }
  })
})

// ── tryAttributionBlockInfo ─────────────────────────────────────────────────

describe('tryAttributionBlockInfo', () => {
  it('returns null for non-attribution bodies', () => {
    expect(tryAttributionBlockInfo({ error: 'OTHER' })).toBeNull()
    expect(tryAttributionBlockInfo(null)).toBeNull()
    expect(tryAttributionBlockInfo({})).toBeNull()
  })

  it('returns AttributionBlockInfo for attribution bodies', () => {
    const info = tryAttributionBlockInfo({
      error: 'PAYMENT_BLOCKED_ATTRIBUTION_DLQ',
      dlqReason: 'MISSING_USER_IDS',
    })
    expect(info).not.toBeNull()
    expect(info?.kind).toBe('dlq')
    expect(info?.dlqReason).toBe('MISSING_USER_IDS')
  })
})
