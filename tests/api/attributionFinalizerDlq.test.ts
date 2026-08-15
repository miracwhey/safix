/**
 * Attribution Finalizer — Max-Retry + DLQ + Audit-Log tests (Stage 3).
 *
 * Coverage:
 *   F1.  Missing user IDs → DLQ with reason MISSING_USER_IDS (no retry).
 *   F2.  DB error at retry_count = MAX → DLQ with reason MAX_RETRY_EXCEEDED.
 *   F3.  DB error below MAX → retry_count incremented, status=retrying.
 *   F4.  DLQ transitions emit an ERROR-level observability event (Sentry route).
 *   F5.  DLQ transitions write to attribution_audit_log.
 *   F6.  Finalize with relationship record → event_type = 'finalize_auto'.
 *   F7.  Finalize without record (definitively absent) → event_type = 'finalize_absent'.
 *   F8.  Retry-incremented path writes attribution_audit_log entry.
 *   F9.  Backoff skip does NOT write audit row and does NOT alter state.
 *   F10. Response summary includes the new `dlq` counter.
 *   F11. The finalizer query excludes DLQ rows (only pending/retrying swept).
 */

const { mockGetSupabaseAdminWithStatus } = vi.hoisted(() => ({
  mockGetSupabaseAdminWithStatus: vi.fn(),
}))

const { mockRequireCronAuth } = vi.hoisted(() => ({
  mockRequireCronAuth: vi.fn(),
}))

const { mockLogInfo, mockLogWarning, mockLogError } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogWarning: vi.fn(),
  mockLogError: vi.fn(),
}))

vi.mock('../../api/_supabase', () => ({
  getSupabaseAdminWithStatus: mockGetSupabaseAdminWithStatus,
}))

vi.mock('../../api/_cronAuth', () => ({
  requireCronAuth: mockRequireCronAuth,
}))

vi.mock('../../api/_observability', () => ({
  logInfo: mockLogInfo,
  logWarning: mockLogWarning,
  logError: mockLogError,
  withSentryFlush: (h: unknown) => h,
}))

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { SupabaseClient } from '@supabase/supabase-js'
import handler, { MAX_RETRY_COUNT } from '../../api/cron/finalize-attribution'

// ── Request / response helpers ───────────────────────────────────────────────

function makeReq(): VercelRequest {
  return { method: 'POST', headers: {}, url: '/api/cron/finalize-attribution' } as unknown as VercelRequest
}

function makeRes(): {
  res: VercelResponse
  statusCode: () => number
  body: () => Record<string, unknown>
} {
  let _status = 0
  let _body: unknown
  const res = {
    setHeader: vi.fn(() => res),
    status: vi.fn((code: number) => { _status = code; return res }),
    json: vi.fn((payload: unknown) => { _body = payload }),
  } as unknown as VercelResponse
  return {
    res,
    statusCode: () => _status,
    body: () => _body as Record<string, unknown>,
  }
}

// ── Supabase admin mock ──────────────────────────────────────────────────────

type JobRow = {
  id: string
  customer_user_id: string | null
  craftsman_user_id: string | null
  attribution_status: 'pending' | 'retrying'
  attribution_retry_count: number
  attribution_last_retry_at: string | null
  commercial_origin: string | null
}

type UpdateRecord = {
  table: string
  id: string
  patch: Record<string, unknown>
  eqCalls: Array<[string, unknown]>
}

type AdminMock = {
  client: SupabaseClient
  updateCalls: Array<UpdateRecord>
  auditInserts: Array<Record<string, unknown>>
  queryPredicate: { attributionStatusIn?: string[] }
}

/**
 * Build a Supabase admin mock that supports the CAS call-chain:
 *   update(patch).eq(col, val).eq(col, val)[.eq(col, val)].select('id')
 *
 * Responses:
 *   - updateError                         → { data: null, error }
 *   - staleSnapshot (CAS miss)            → { data: [], error: null }
 *   - default happy path                  → { data: [{id:<jobId>}], error: null }
 */
function makeAdmin(options: {
  jobs: JobRow[]
  relationshipResult?: { data: { commercial_origin: string } | null; error: unknown | null }
  jobUpdateError?: unknown
  auditInsertError?: unknown
  /**
   * When true, every jobs UPDATE returns zero rows affected — simulates a
   * concurrent finalizer having already advanced the row past this snapshot.
   */
  staleSnapshot?: boolean
}): AdminMock {
  const updateCalls: Array<UpdateRecord> = []
  const auditInserts: Array<Record<string, unknown>> = []
  const queryPredicate: { attributionStatusIn?: string[] } = {}

  // jobs SELECT
  const jobsSelect = vi.fn().mockReturnValue({
    in: vi.fn((_col: string, values: string[]) => {
      queryPredicate.attributionStatusIn = values
      return {
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({ data: options.jobs, error: null }),
        }),
      }
    }),
  })

  // jobs UPDATE — chain eq*.eq*.[eq*].select('id')
  const buildUpdateChain = (patch: Record<string, unknown>): Record<string, unknown> => {
    const eqCalls: Array<[string, unknown]> = []
    const chain: Record<string, unknown> = {}
    chain.eq = (col: string, val: unknown) => {
      eqCalls.push([col, val])
      return chain
    }
    chain.select = (_cols: string) => {
      const id = (eqCalls.find(([c]) => c === 'id')?.[1] as string | undefined) ?? 'unknown'
      updateCalls.push({ table: 'jobs', id, patch, eqCalls: [...eqCalls] })
      if (options.jobUpdateError) {
        return Promise.resolve({ data: null, error: options.jobUpdateError })
      }
      if (options.staleSnapshot) {
        return Promise.resolve({ data: [], error: null })
      }
      return Promise.resolve({ data: [{ id }], error: null })
    }
    return chain
  }
  const jobsUpdate = vi.fn((patch: Record<string, unknown>) => buildUpdateChain(patch))

  // customer_provider_relationships SELECT
  const relSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue(
          options.relationshipResult ?? { data: null, error: null },
        ),
      }),
    }),
  })

  // audit log INSERT
  const auditInsert = vi.fn((row: Record<string, unknown>) => {
    auditInserts.push(row)
    return Promise.resolve({ error: options.auditInsertError ?? null })
  })

  const client = {
    from: vi.fn((table: string) => {
      if (table === 'jobs') return { select: jobsSelect, update: jobsUpdate }
      if (table === 'customer_provider_relationships') return { select: relSelect }
      if (table === 'attribution_audit_log') return { insert: auditInsert }
      return {}
    }),
  } as unknown as SupabaseClient

  return { client, updateCalls, auditInserts, queryPredicate }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PENDING_JOB: JobRow = {
  id: 'job-1',
  customer_user_id: 'cust-1',
  craftsman_user_id: 'craft-1',
  attribution_status: 'pending',
  attribution_retry_count: 0,
  attribution_last_retry_at: null,
  commercial_origin: 'unknown_pending_resolution',
}

const RETRYING_JOB_AT_MAX: JobRow = {
  ...PENDING_JOB,
  id: 'job-2',
  attribution_status: 'retrying',
  attribution_retry_count: MAX_RETRY_COUNT, // next increment would exceed
  // lastRetryAt sufficiently old so backoff is satisfied
  attribution_last_retry_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
}

const JOB_MISSING_IDS: JobRow = {
  ...PENDING_JOB,
  id: 'job-3',
  customer_user_id: null,
  craftsman_user_id: null,
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('finalize-attribution — Max-Retry + DLQ + Audit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireCronAuth.mockReturnValue(true)
  })

  // F11 — the finalizer query excludes DLQ
  it('F11: the sweep query filters on status ∈ {pending, retrying} only', async () => {
    const admin = makeAdmin({ jobs: [] })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })
    const { res } = makeRes()
    await handler(makeReq(), res)
    expect(admin.queryPredicate.attributionStatusIn).toEqual(['pending', 'retrying'])
  })

  // F1 — missing IDs → immediate DLQ
  it('F1: missing customer/craftsman IDs → transitions directly to DLQ with MISSING_USER_IDS', async () => {
    const admin = makeAdmin({ jobs: [JOB_MISSING_IDS] })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })
    const { res, statusCode, body } = makeRes()
    await handler(makeReq(), res)

    expect(statusCode()).toBe(200)
    expect(body().dlq).toBe(1)
    expect(body().missingIds).toBe(1)
    expect(body().retried).toBe(0)
    expect(body().finalized).toBe(0)

    // The one UPDATE must set attribution_status='dlq' with reason
    const dlqUpdate = admin.updateCalls.find((c) => c.table === 'jobs')
    expect(dlqUpdate).toBeDefined()
    expect(dlqUpdate?.patch.attribution_status).toBe('dlq')
    expect(dlqUpdate?.patch.attribution_dlq_reason).toBe('MISSING_USER_IDS')

    // Audit row written with event_type='dlq_entered' and reason='MISSING_USER_IDS'
    const auditRow = admin.auditInserts[0]
    expect(auditRow?.event_type).toBe('dlq_entered')
    expect(auditRow?.reason).toBe('MISSING_USER_IDS')
    expect(auditRow?.to_status).toBe('dlq')
  })

  // F2 — retry exceeds MAX → DLQ
  it('F2: DB error at retry_count=MAX → DLQ with MAX_RETRY_EXCEEDED, no retry row', async () => {
    const admin = makeAdmin({
      jobs: [RETRYING_JOB_AT_MAX],
      relationshipResult: { data: null, error: { message: 'conn_reset' } },
    })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })
    const { res, body } = makeRes()
    await handler(makeReq(), res)

    expect(body().dlq).toBe(1)
    expect(body().retried).toBe(0)
    expect(body().finalized).toBe(0)

    const dlqUpdate = admin.updateCalls.find((c) => c.patch.attribution_status === 'dlq')
    expect(dlqUpdate).toBeDefined()
    expect(dlqUpdate?.patch.attribution_dlq_reason).toBe('MAX_RETRY_EXCEEDED')

    const auditRow = admin.auditInserts.find((r) => r.event_type === 'dlq_entered')
    expect(auditRow?.reason).toBe('MAX_RETRY_EXCEEDED')
    expect((auditRow?.metadata as Record<string, unknown>).lastError).toBe('conn_reset')
  })

  // F3 — DB error below MAX → retry increment
  it('F3: DB error below MAX → retry_count incremented, status=retrying', async () => {
    const belowMax: JobRow = {
      ...PENDING_JOB,
      id: 'job-4',
      attribution_status: 'retrying',
      attribution_retry_count: 2,
      attribution_last_retry_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
    }
    const admin = makeAdmin({
      jobs: [belowMax],
      relationshipResult: { data: null, error: { message: 'timeout' } },
    })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })
    const { res, body } = makeRes()
    await handler(makeReq(), res)

    expect(body().retried).toBe(1)
    expect(body().dlq).toBe(0)
    const retryUpdate = admin.updateCalls[0]
    expect(retryUpdate?.patch.attribution_status).toBe('retrying')
    expect(retryUpdate?.patch.attribution_retry_count).toBe(3)
  })

  // F4 — DLQ emits ERROR-level log (Sentry route)
  it('F4: DLQ transitions emit an ERROR-level observability event', async () => {
    const admin = makeAdmin({ jobs: [JOB_MISSING_IDS] })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })
    const { res } = makeRes()
    await handler(makeReq(), res)

    const errorCall = mockLogError.mock.calls.find(
      (c) => c[0] === 'cron.attribution_finalizer.job_dlq_entered',
    )
    expect(errorCall).toBeDefined()
    const errorArg = errorCall![1] as Error
    expect(errorArg).toBeInstanceOf(Error)
    expect(errorArg.message).toMatch(/MISSING_USER_IDS/)
    expect((errorCall![2] as { action?: string }).action).toMatch(/OPERATOR_ACTION_REQUIRED/)
  })

  // F5 — DLQ writes audit row
  it('F5: DLQ transitions write audit_log row with event_type=dlq_entered', async () => {
    const admin = makeAdmin({ jobs: [JOB_MISSING_IDS] })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })
    const { res } = makeRes()
    await handler(makeReq(), res)

    expect(admin.auditInserts).toHaveLength(1)
    const row = admin.auditInserts[0]
    expect(row.event_type).toBe('dlq_entered')
    expect(row.to_status).toBe('dlq')
    expect(row.reason).toBe('MISSING_USER_IDS')
  })

  // F6 — finalize_auto when relationship record found
  it('F6: finalize via relationship record writes event_type=finalize_auto', async () => {
    const admin = makeAdmin({
      jobs: [PENDING_JOB],
      relationshipResult: { data: { commercial_origin: 'merchant_brought' }, error: null },
    })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })
    const { res, body } = makeRes()
    await handler(makeReq(), res)

    expect(body().finalized).toBe(1)
    const row = admin.auditInserts.find((r) => r.event_type === 'finalize_auto')
    expect(row).toBeDefined()
    expect(row?.to_origin).toBe('merchant_brought')
    expect(row?.to_status).toBe('finalized')
  })

  // F7 — finalize_absent when no record, no error
  it('F7: finalize with no record writes event_type=finalize_absent + platform_acquired', async () => {
    const admin = makeAdmin({
      jobs: [PENDING_JOB],
      relationshipResult: { data: null, error: null },
    })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })
    const { res, body } = makeRes()
    await handler(makeReq(), res)

    expect(body().finalized).toBe(1)
    const row = admin.auditInserts.find((r) => r.event_type === 'finalize_absent')
    expect(row).toBeDefined()
    expect(row?.to_origin).toBe('platform_acquired')
    expect((row?.metadata as Record<string, unknown>).source).toBe('definitively_absent')
  })

  // F8 — retry-increment writes audit row
  it('F8: retry increment writes audit_log event_type=retry_incremented', async () => {
    const belowMax: JobRow = {
      ...PENDING_JOB,
      id: 'job-5',
      attribution_status: 'retrying',
      attribution_retry_count: 1,
      attribution_last_retry_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
    }
    const admin = makeAdmin({
      jobs: [belowMax],
      relationshipResult: { data: null, error: { message: 'db_unavailable' } },
    })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })
    const { res } = makeRes()
    await handler(makeReq(), res)

    const row = admin.auditInserts.find((r) => r.event_type === 'retry_incremented')
    expect(row).toBeDefined()
    expect(row?.to_status).toBe('retrying')
    expect(row?.retry_count).toBe(2)
    expect(row?.reason).toBe('db_unavailable')
  })

  // F9 — backoff skip makes no DB writes
  it('F9: backoff skip performs no jobs UPDATE and no audit INSERT', async () => {
    const justRetried: JobRow = {
      ...PENDING_JOB,
      id: 'job-6',
      attribution_status: 'retrying',
      attribution_retry_count: 3, // backoff = 900s
      attribution_last_retry_at: new Date().toISOString(),
    }
    const admin = makeAdmin({
      jobs: [justRetried],
      relationshipResult: { data: null, error: null },
    })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })
    const { res, body } = makeRes()
    await handler(makeReq(), res)

    expect(body().skipped).toBe(1)
    expect(body().dlq).toBe(0)
    expect(body().retried).toBe(0)
    expect(body().finalized).toBe(0)
    expect(admin.updateCalls).toHaveLength(0)
    expect(admin.auditInserts).toHaveLength(0)
  })

  // F10 — response exposes the dlq counter
  it('F10: response summary includes dlq counter', async () => {
    const admin = makeAdmin({ jobs: [JOB_MISSING_IDS] })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })
    const { res, body } = makeRes()
    await handler(makeReq(), res)

    expect(body()).toEqual(
      expect.objectContaining({
        ok: true,
        swept: 1,
        finalized: 0,
        retried: 0,
        skipped: 0,
        missingIds: 1,
        dlq: 1,
      }),
    )
  })

  // Audit-write failure does NOT block job update
  it('audit-write failure is non-fatal — job still DLQ-transitioned', async () => {
    const admin = makeAdmin({
      jobs: [JOB_MISSING_IDS],
      auditInsertError: { message: 'audit_log_unavailable' },
    })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })
    const { res, body } = makeRes()
    await handler(makeReq(), res)

    expect(body().dlq).toBe(1)
    const dlqUpdate = admin.updateCalls.find((c) => c.patch.attribution_status === 'dlq')
    expect(dlqUpdate).toBeDefined()
    const auditWarn = mockLogWarning.mock.calls.find(
      (c) => c[0] === 'attribution_audit_log.write_failed',
    )
    expect(auditWarn).toBeDefined()
  })

  // ─────────────────────────────────────────────────────────────────────────
  //  Compare-and-swap: concurrent finalizer safety.
  //  Every state-mutating UPDATE predicates on the snapshot the invocation
  //  read.  If a concurrent finalizer has already advanced the row, the
  //  UPDATE matches zero rows and we skip without writing audit / counters
  //  as if the transition had occurred.
  // ─────────────────────────────────────────────────────────────────────────

  // F12 — every UPDATE chain includes the CAS predicates
  it('F12: every jobs UPDATE carries attribution_status + attribution_retry_count CAS predicates', async () => {
    const belowMax: JobRow = {
      ...PENDING_JOB,
      id: 'job-cas-1',
      attribution_status: 'retrying',
      attribution_retry_count: 2,
      attribution_last_retry_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
    }
    const admin = makeAdmin({
      jobs: [belowMax],
      relationshipResult: { data: null, error: { message: 'transient' } },
    })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })
    const { res } = makeRes()
    await handler(makeReq(), res)

    // Retry-increment update should include CAS predicates on status and retry_count
    const retryUpdate = admin.updateCalls.find((c) => c.patch.attribution_status === 'retrying')
    expect(retryUpdate).toBeDefined()
    const eqByCol = new Map(retryUpdate!.eqCalls)
    expect(eqByCol.get('id')).toBe('job-cas-1')
    expect(eqByCol.get('attribution_status')).toBe('retrying') // expected snapshot
    expect(eqByCol.get('attribution_retry_count')).toBe(2)     // expected snapshot
  })

  // F13 — DLQ via missing-IDs: stale snapshot → skip
  it('F13: stale snapshot on missing-IDs DLQ → skip, no dlq counter, no audit', async () => {
    const admin = makeAdmin({
      jobs: [JOB_MISSING_IDS],
      staleSnapshot: true,
    })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })
    const { res, body } = makeRes()
    await handler(makeReq(), res)

    expect(body().dlq).toBe(0)          // NO dlq increment
    expect(body().staleSkipped).toBe(1) // counted as stale-skip
    expect(body().missingIds).toBe(1)   // root-cause counter still bumps

    // No audit row written (no transition happened)
    expect(admin.auditInserts).toHaveLength(0)

    // No Sentry-routed error emitted (no real DLQ entered)
    const dlqError = mockLogError.mock.calls.find(
      (c) => c[0] === 'cron.attribution_finalizer.job_dlq_entered',
    )
    expect(dlqError).toBeUndefined()

    // Stale-skip observability event emitted
    const staleLog = mockLogInfo.mock.calls.find(
      (c) => c[0] === 'cron.attribution_finalizer.stale_snapshot_skip',
    )
    expect(staleLog).toBeDefined()
  })

  // F14 — DLQ via max-retry: stale snapshot → skip
  it('F14: stale snapshot on max-retry DLQ → skip, no dlq counter, no audit', async () => {
    const admin = makeAdmin({
      jobs: [RETRYING_JOB_AT_MAX],
      relationshipResult: { data: null, error: { message: 'conn_reset' } },
      staleSnapshot: true,
    })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })
    const { res, body } = makeRes()
    await handler(makeReq(), res)

    expect(body().dlq).toBe(0)
    expect(body().staleSkipped).toBe(1)
    expect(admin.auditInserts).toHaveLength(0)
  })

  // F15 — retry-increment: stale snapshot → skip
  it('F15: stale snapshot on retry-increment → skip, no retried counter, no audit', async () => {
    const belowMax: JobRow = {
      ...PENDING_JOB,
      id: 'job-stale-retry',
      attribution_status: 'retrying',
      attribution_retry_count: 1,
      attribution_last_retry_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
    }
    const admin = makeAdmin({
      jobs: [belowMax],
      relationshipResult: { data: null, error: { message: 'transient' } },
      staleSnapshot: true,
    })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })
    const { res, body } = makeRes()
    await handler(makeReq(), res)

    expect(body().retried).toBe(0)
    expect(body().staleSkipped).toBe(1)
    expect(admin.auditInserts).toHaveLength(0)
  })

  // F16 — finalize: stale snapshot → skip (the critical regression guard)
  // If another finalizer already finalized OR escalated the row to dlq,
  // this invocation must NOT overwrite that state.
  it('F16: stale snapshot on finalize → skip, no finalized counter, no audit, no origin rollback', async () => {
    const admin = makeAdmin({
      jobs: [PENDING_JOB],
      relationshipResult: { data: { commercial_origin: 'platform_acquired' }, error: null },
      staleSnapshot: true,
    })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })
    const { res, body } = makeRes()
    await handler(makeReq(), res)

    expect(body().finalized).toBe(0)
    expect(body().staleSkipped).toBe(1)
    // No finalize_auto / finalize_absent audit row — another invocation
    // already owned the finalize; we must not double-write.
    expect(
      admin.auditInserts.find(
        (r) => r.event_type === 'finalize_auto' || r.event_type === 'finalize_absent',
      ),
    ).toBeUndefined()
  })

  // F17 — mixed batch: one stale, one happy — counters reflect both
  it('F17: mixed batch: one stale, one happy-path finalize → staleSkipped=1, finalized=1', async () => {
    const happyJob: JobRow = {
      ...PENDING_JOB,
      id: 'job-happy',
    }
    const staleJob: JobRow = {
      ...PENDING_JOB,
      id: 'job-stale',
    }

    // We need the mock to succeed for job-happy and return [] for job-stale.
    // The simplest way: customise the update chain per-call.  Because the
    // existing makeAdmin sets staleSnapshot as a global flag, we build a
    // more targeted admin client here.
    const updateCalls: Array<UpdateRecord> = []
    const auditInserts: Array<Record<string, unknown>> = []
    const jobsUpdate = vi.fn((patch: Record<string, unknown>) => {
      const eqCalls: Array<[string, unknown]> = []
      const chain: Record<string, unknown> = {}
      chain.eq = (col: string, val: unknown) => {
        eqCalls.push([col, val])
        return chain
      }
      chain.select = (_c: string) => {
        const id = (eqCalls.find(([c]) => c === 'id')?.[1] as string | undefined) ?? ''
        updateCalls.push({ table: 'jobs', id, patch, eqCalls: [...eqCalls] })
        return Promise.resolve({
          data: id === 'job-stale' ? [] : [{ id }],
          error: null,
        })
      }
      return chain
    })
    const jobsSelect = vi.fn().mockReturnValue({
      in: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({ data: [happyJob, staleJob], error: null }),
        }),
      }),
    })
    const client = {
      from: vi.fn((table: string) => {
        if (table === 'jobs') return { select: jobsSelect, update: jobsUpdate }
        if (table === 'customer_provider_relationships') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { commercial_origin: 'platform_acquired' },
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'attribution_audit_log') {
          return {
            insert: vi.fn((row: Record<string, unknown>) => {
              auditInserts.push(row)
              return Promise.resolve({ error: null })
            }),
          }
        }
        return {}
      }),
    } as unknown as SupabaseClient
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client })

    const { res, body } = makeRes()
    await handler(makeReq(), res)

    expect(body().finalized).toBe(1)
    expect(body().staleSkipped).toBe(1)
    // Only the happy-path job produced an audit row
    expect(auditInserts).toHaveLength(1)
    expect(auditInserts[0].job_id).toBe('job-happy')
  })

  // F18 — DLQ success still emits audit + Sentry error (regression guard for F13/F14 semantics)
  it('F18: real DLQ transition (non-stale) still emits audit + Sentry-routed error', async () => {
    const admin = makeAdmin({ jobs: [JOB_MISSING_IDS] })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: admin.client })
    const { res, body } = makeRes()
    await handler(makeReq(), res)

    expect(body().dlq).toBe(1)
    expect(body().staleSkipped).toBe(0)
    expect(admin.auditInserts.find((r) => r.event_type === 'dlq_entered')).toBeDefined()
    expect(
      mockLogError.mock.calls.find(
        (c) => c[0] === 'cron.attribution_finalizer.job_dlq_entered',
      ),
    ).toBeDefined()
  })
})
