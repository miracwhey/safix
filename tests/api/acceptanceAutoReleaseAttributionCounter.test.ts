/**
 * Acceptance auto-release — attribution-block counter includes ATTRIBUTION_LOOKUP_FAILED.
 *
 * The shared attribution guard maps its five blocking branches to mixed HTTP
 * statuses:
 *   402 — PAYMENT_BLOCKED_ATTRIBUTION_{UNRESOLVED|DLQ|INVALID|JOB_NOT_FOUND}
 *   500 — ATTRIBUTION_LOOKUP_FAILED   (guard-layer DB error, retryable)
 *
 * The acceptance auto-release cron must count BOTH flavours as
 * `summary.attributionBlocked` — not as generic `summary.failed` — because
 * they share the same fachliche semantic (release held back due to
 * unresolvable commercial-attribution state, cron will retry next tick).
 *
 * These tests lock that contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../api/_observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

import { autoReleaseExpiredAcceptances } from '../../api/_acceptanceAutoRelease'
import type { SupabaseClient } from '@supabase/supabase-js'

// ── Fetch mock ───────────────────────────────────────────────────────────────

const originalFetch = global.fetch

function mockFetchReply({ status, body }: { status: number; body: Record<string, unknown> }) {
  // @ts-expect-error - global fetch replacement for test
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  })
}

// ── Supabase mock ────────────────────────────────────────────────────────────

const EXPIRED_ACCEPTANCE = {
  id: 'acc-1',
  job_id: 'job-1',
  customer_user_id: 'cust-1',
  status: 'pending',
  expires_at: Date.now() - 10_000,
}

const PLAN = { id: 'plan-1' }

const ELIGIBLE_FINAL_TRANCHE = {
  id: 'tranche-final',
  status: 'eligible_for_release',
}

function makeSupabase(): SupabaseClient {
  return {
    from: vi.fn((table: string) => {
      if (table === 'acceptances') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              not: vi.fn().mockReturnValue({
                lte: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue({
                      data: [EXPIRED_ACCEPTANCE],
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null }),
            }),
          }),
        }
      }
      if (table === 'escrow_payment_plans') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: PLAN, error: null }),
            }),
          }),
        }
      }
      if (table === 'escrow_tranches') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: ELIGIBLE_FINAL_TRANCHE,
                  error: null,
                }),
              }),
            }),
          }),
        }
      }
      return {}
    }),
  } as unknown as SupabaseClient
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('autoReleaseExpiredAcceptances — attribution-block counter contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('402 UNRESOLVED → counted as attributionBlocked (existing contract)', async () => {
    mockFetchReply({
      status: 402,
      body: {
        error: 'PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED',
        message: 'Die Provisionszuordnung wird noch geprüft.',
        attributionStatus: 'pending',
      },
    })
    const summary = await autoReleaseExpiredAcceptances(makeSupabase(), 'cron-secret', 'http://api')
    expect(summary.attributionBlocked).toBe(1)
    expect(summary.failed).toBe(0)
  })

  it('402 DLQ → counted as attributionBlocked with dlqReason', async () => {
    mockFetchReply({
      status: 402,
      body: {
        error: 'PAYMENT_BLOCKED_ATTRIBUTION_DLQ',
        dlqReason: 'MAX_RETRY_EXCEEDED',
      },
    })
    const summary = await autoReleaseExpiredAcceptances(makeSupabase(), 'cron-secret', 'http://api')
    expect(summary.attributionBlocked).toBe(1)
    expect(summary.failed).toBe(0)
  })

  // The critical Codex-P3 regression lock: 500 + ATTRIBUTION_LOOKUP_FAILED must
  // count as attributionBlocked, not as generic failure.
  it('500 ATTRIBUTION_LOOKUP_FAILED → counted as attributionBlocked, NOT as failed', async () => {
    mockFetchReply({
      status: 500,
      body: {
        error: 'ATTRIBUTION_LOOKUP_FAILED',
        message: 'Die Provisionsprüfung ist fehlgeschlagen.',
      },
    })
    const summary = await autoReleaseExpiredAcceptances(makeSupabase(), 'cron-secret', 'http://api')
    expect(summary.attributionBlocked).toBe(1)
    expect(summary.failed).toBe(0)
  })

  it('500 with unrelated error code → generic failed (not attributionBlocked)', async () => {
    mockFetchReply({
      status: 500,
      body: { error: 'INTERNAL_SERVER_ERROR' },
    })
    const summary = await autoReleaseExpiredAcceptances(makeSupabase(), 'cron-secret', 'http://api')
    expect(summary.attributionBlocked).toBe(0)
    expect(summary.failed).toBe(1)
  })

  it('402 JOB_NOT_FOUND → counted as attributionBlocked', async () => {
    mockFetchReply({
      status: 402,
      body: { error: 'PAYMENT_BLOCKED_JOB_NOT_FOUND' },
    })
    const summary = await autoReleaseExpiredAcceptances(makeSupabase(), 'cron-secret', 'http://api')
    expect(summary.attributionBlocked).toBe(1)
  })
})
