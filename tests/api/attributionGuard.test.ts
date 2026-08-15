/**
 * Shared Attribution Guard — unit tests.
 *
 * Validates the single source of truth that every money-moving API path
 * (create-escrow, initiate-supplementary-funding, release-tranche,
 * _releaseSupplementaryPayout) must use.
 *
 * Coverage:
 *   - finalized + valid origin → ok
 *   - pending / retrying / null → ATTRIBUTION_UNRESOLVED (retryable)
 *   - dlq → ATTRIBUTION_DLQ (non-retryable, reason surfaced)
 *   - finalized + null/unknown origin → ATTRIBUTION_INVALID
 *   - job missing → JOB_NOT_FOUND
 *   - empty/whitespace jobId → JOB_NOT_FOUND (fail-closed)
 *   - DB error → DB_ERROR (release blocked)
 *   - HTTP mapping shape
 */

import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  assertAttributionFinalized,
  attributionGateToHttpResponse,
} from '../../api/_attributionGuard'

vi.mock('../../api/_observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

// ── DB mock ──────────────────────────────────────────────────────────────────

function makeSupabaseWithJob(row: Record<string, unknown> | null, error: unknown = null): SupabaseClient {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error })
  const eq = vi.fn().mockReturnValue({ maybeSingle })
  const select = vi.fn().mockReturnValue({ eq })
  return { from: vi.fn(() => ({ select })) } as unknown as SupabaseClient
}

// ── Guard behaviour ──────────────────────────────────────────────────────────

describe('assertAttributionFinalized', () => {
  it('returns ok with merchant_brought origin when finalized', async () => {
    const supabase = makeSupabaseWithJob({
      id: 'job-1',
      commercial_origin: 'merchant_brought',
      attribution_status: 'finalized',
      attribution_dlq_reason: null,
    })
    const result = await assertAttributionFinalized(supabase, 'job-1', 'test')
    expect(result).toEqual({
      ok: true,
      jobId: 'job-1',
      commercialOrigin: 'merchant_brought',
    })
  })

  it('returns ok with platform_acquired origin when finalized', async () => {
    const supabase = makeSupabaseWithJob({
      id: 'job-2',
      commercial_origin: 'platform_acquired',
      attribution_status: 'finalized',
      attribution_dlq_reason: null,
    })
    const result = await assertAttributionFinalized(supabase, 'job-2', 'test')
    expect(result).toEqual({
      ok: true,
      jobId: 'job-2',
      commercialOrigin: 'platform_acquired',
    })
  })

  it('blocks with ATTRIBUTION_UNRESOLVED when status is pending', async () => {
    const supabase = makeSupabaseWithJob({
      id: 'job-3',
      commercial_origin: null,
      attribution_status: 'pending',
      attribution_dlq_reason: null,
    })
    const result = await assertAttributionFinalized(supabase, 'job-3', 'test')
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.code).toBe('ATTRIBUTION_UNRESOLVED')
      if (result.code === 'ATTRIBUTION_UNRESOLVED') {
        expect(result.attributionStatus).toBe('pending')
      }
    }
  })

  it('blocks with ATTRIBUTION_UNRESOLVED when status is retrying', async () => {
    const supabase = makeSupabaseWithJob({
      id: 'job-4',
      commercial_origin: null,
      attribution_status: 'retrying',
      attribution_dlq_reason: null,
    })
    const result = await assertAttributionFinalized(supabase, 'job-4', 'test')
    expect(result.ok).toBe(false)
    if (result.ok === false && result.code === 'ATTRIBUTION_UNRESOLVED') {
      expect(result.attributionStatus).toBe('retrying')
    }
  })

  it('blocks with ATTRIBUTION_UNRESOLVED when status is null', async () => {
    const supabase = makeSupabaseWithJob({
      id: 'job-5',
      commercial_origin: null,
      attribution_status: null,
      attribution_dlq_reason: null,
    })
    const result = await assertAttributionFinalized(supabase, 'job-5', 'test')
    expect(result.ok).toBe(false)
    if (result.ok === false && result.code === 'ATTRIBUTION_UNRESOLVED') {
      expect(result.attributionStatus).toBe('null')
    }
  })

  it('blocks with ATTRIBUTION_DLQ and carries dlqReason when status is dlq', async () => {
    const supabase = makeSupabaseWithJob({
      id: 'job-6',
      commercial_origin: null,
      attribution_status: 'dlq',
      attribution_dlq_reason: 'MAX_RETRY_EXCEEDED',
    })
    const result = await assertAttributionFinalized(supabase, 'job-6', 'test')
    expect(result.ok).toBe(false)
    if (result.ok === false && result.code === 'ATTRIBUTION_DLQ') {
      expect(result.dlqReason).toBe('MAX_RETRY_EXCEEDED')
    }
  })

  it('blocks with ATTRIBUTION_INVALID when finalized but origin is null', async () => {
    const supabase = makeSupabaseWithJob({
      id: 'job-7',
      commercial_origin: null,
      attribution_status: 'finalized',
      attribution_dlq_reason: null,
    })
    const result = await assertAttributionFinalized(supabase, 'job-7', 'test')
    expect(result.ok).toBe(false)
    if (result.ok === false && result.code === 'ATTRIBUTION_INVALID') {
      expect(result.commercialOrigin).toBeNull()
    }
  })

  it('blocks with ATTRIBUTION_INVALID when finalized but origin is unknown_pending_resolution', async () => {
    const supabase = makeSupabaseWithJob({
      id: 'job-8',
      commercial_origin: 'unknown_pending_resolution',
      attribution_status: 'finalized',
      attribution_dlq_reason: null,
    })
    const result = await assertAttributionFinalized(supabase, 'job-8', 'test')
    expect(result.ok).toBe(false)
    if (result.ok === false && result.code === 'ATTRIBUTION_INVALID') {
      expect(result.commercialOrigin).toBe('unknown_pending_resolution')
    }
  })

  it('blocks with JOB_NOT_FOUND when row is absent', async () => {
    const supabase = makeSupabaseWithJob(null)
    const result = await assertAttributionFinalized(supabase, 'job-9', 'test')
    expect(result.ok).toBe(false)
    if (result.ok === false) expect(result.code).toBe('JOB_NOT_FOUND')
  })

  it('blocks with JOB_NOT_FOUND when jobId is empty string (fail-closed)', async () => {
    const supabase = makeSupabaseWithJob(null)
    const result = await assertAttributionFinalized(supabase, '', 'test')
    expect(result.ok).toBe(false)
    if (result.ok === false) expect(result.code).toBe('JOB_NOT_FOUND')
    // No DB call should be issued for an empty jobId
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('blocks with JOB_NOT_FOUND when jobId is whitespace (fail-closed)', async () => {
    const supabase = makeSupabaseWithJob(null)
    const result = await assertAttributionFinalized(supabase, '   ', 'test')
    expect(result.ok).toBe(false)
    if (result.ok === false) expect(result.code).toBe('JOB_NOT_FOUND')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('blocks with DB_ERROR when the lookup fails', async () => {
    const supabase = makeSupabaseWithJob(null, { message: 'connection reset' })
    const result = await assertAttributionFinalized(supabase, 'job-10', 'test')
    expect(result.ok).toBe(false)
    if (result.ok === false && result.code === 'DB_ERROR') {
      expect(result.message).toBe('connection reset')
    }
  })

  it('trims the jobId before lookup', async () => {
    const supabase = makeSupabaseWithJob({
      id: 'job-11',
      commercial_origin: 'platform_acquired',
      attribution_status: 'finalized',
      attribution_dlq_reason: null,
    })
    const result = await assertAttributionFinalized(supabase, '  job-11  ', 'test')
    expect(result.ok).toBe(true)
    if (result.ok === true) expect(result.jobId).toBe('job-11')
  })
})

// ── HTTP mapping ─────────────────────────────────────────────────────────────

describe('attributionGateToHttpResponse', () => {
  it('maps JOB_NOT_FOUND → 402 PAYMENT_BLOCKED_JOB_NOT_FOUND non-retryable', () => {
    const mapped = attributionGateToHttpResponse({
      ok: false,
      code: 'JOB_NOT_FOUND',
      jobId: 'j',
    })
    expect(mapped.status).toBe(402)
    expect(mapped.body.error).toBe('PAYMENT_BLOCKED_JOB_NOT_FOUND')
    expect(mapped.body.retryable).toBe(false)
  })

  it('maps ATTRIBUTION_UNRESOLVED → 402 retryable and carries attributionStatus', () => {
    const mapped = attributionGateToHttpResponse({
      ok: false,
      code: 'ATTRIBUTION_UNRESOLVED',
      jobId: 'j',
      attributionStatus: 'pending',
    })
    expect(mapped.status).toBe(402)
    expect(mapped.body.error).toBe('PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED')
    expect(mapped.body.retryable).toBe(true)
    expect(mapped.body.attributionStatus).toBe('pending')
  })

  it('maps ATTRIBUTION_DLQ → 402 non-retryable and carries dlqReason', () => {
    const mapped = attributionGateToHttpResponse({
      ok: false,
      code: 'ATTRIBUTION_DLQ',
      jobId: 'j',
      dlqReason: 'MAX_RETRY_EXCEEDED',
    })
    expect(mapped.status).toBe(402)
    expect(mapped.body.error).toBe('PAYMENT_BLOCKED_ATTRIBUTION_DLQ')
    expect(mapped.body.retryable).toBe(false)
    expect(mapped.body.dlqReason).toBe('MAX_RETRY_EXCEEDED')
  })

  it('maps ATTRIBUTION_INVALID → 402 non-retryable and carries commercialOrigin', () => {
    const mapped = attributionGateToHttpResponse({
      ok: false,
      code: 'ATTRIBUTION_INVALID',
      jobId: 'j',
      commercialOrigin: null,
    })
    expect(mapped.status).toBe(402)
    expect(mapped.body.error).toBe('PAYMENT_BLOCKED_ATTRIBUTION_INVALID')
    expect(mapped.body.retryable).toBe(false)
    expect(mapped.body.commercialOrigin).toBeNull()
  })

  it('maps DB_ERROR → 500 ATTRIBUTION_LOOKUP_FAILED retryable', () => {
    const mapped = attributionGateToHttpResponse({
      ok: false,
      code: 'DB_ERROR',
      jobId: 'j',
      message: 'oops',
    })
    expect(mapped.status).toBe(500)
    expect(mapped.body.error).toBe('ATTRIBUTION_LOOKUP_FAILED')
    expect(mapped.body.retryable).toBe(true)
  })
})
