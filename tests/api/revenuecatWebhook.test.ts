/**
 * api/revenuecat-webhook.ts — behavioral pins for the subscription-sync handler.
 *
 * This branch had ZERO test coverage and has never run end-to-end in prod
 * (events_processed=0): the only real event ever received was a RevenueCat
 * "Send Test Event" (type TEST → skipped). These tests exercise the actual
 * RevenueCat v1 webhook payloads — INITIAL_PURCHASE / RENEWAL / CANCELLATION /
 * EXPIRATION, with trial state carried by period_type=TRIAL (RC has NO
 * TRIAL_STARTED/CONVERTED/CANCELLED events) — plus the two correctness guards
 * (event_id dedup, out-of-order ordering guard) and Bearer auth, so the revenue
 * path is de-risked before a real Sandbox purchase.
 *
 * secureCompare is intentionally NOT mocked — auth is exercised for real against
 * process.env.REVENUECAT_WEBHOOK_SECRET.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const { mockGetAdminWithStatus, mockLogInfo, mockLogError } = vi.hoisted(() => ({
  mockGetAdminWithStatus: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogError: vi.fn(),
}))

vi.mock('../../api/_supabase', () => ({
  getSupabaseAdminWithStatus: () => mockGetAdminWithStatus(),
}))

vi.mock('../../api/_observability', () => ({
  logInfo: (...a: unknown[]) => mockLogInfo(...a),
  logError: (...a: unknown[]) => mockLogError(...a),
}))

import handler from '../../api/revenuecat-webhook'

const SECRET = 'rc-test-secret'
const retryClaimMigration = readFileSync(
  resolve(__dirname, '../../supabase/migrations/20260712093000_harden_revenuecat_webhook_retry_claim.sql'),
  'utf-8',
)
const atomicOrderingMigration = readFileSync(
  resolve(__dirname, '../../supabase/migrations/20260713002303_harden_revenuecat_event_ordering_atomic.sql'),
  'utf-8',
)

// ── Configurable recording Supabase admin mock ─────────────────────────────

type SupaConfig = {
  insertError?: { code?: string } | null
  priorApplied?: { event_timestamp_ms: number } | null
  priorError?: unknown
  subsRows?: Array<{ id: string }> | null
  subsError?: { message: string } | null
  reclaimFailedRows?: Array<{ event_id: string }> | null
  reclaimProcessingRows?: Array<{ event_id: string }> | null
  reclaimError?: { message: string } | null
  existingOutcome?: 'processing' | 'processed' | 'failed' | 'skipped' | null
  existingOutcomeError?: { message: string } | null
  rpcAction?: 'updated' | 'stale' | 'no_subscription' | string | null
  rpcError?: { message: string } | null
}

type Filter = [op: string, ...args: unknown[]]

function makeSupabase(config: SupaConfig = {}) {
  const captured = {
    subsUpdatePayload: null as Record<string, unknown> | null,
    subsProfileId: null as string | null,
    eventRowUpdates: [] as Array<Record<string, unknown>>,
    insertedRow: null as Record<string, unknown> | null,
    rpcName: null as string | null,
    rpcArgs: null as Record<string, unknown> | null,
    /** Filters applied to the ordering-guard SELECT, in call order. */
    priorFilters: [] as Filter[],
  }
  const client = {
    from(table: string) {
      if (table === 'revenuecat_webhook_events') {
        const eventUpdateChain = (patch: Record<string, unknown>) => {
          const filters: Filter[] = []
          const result = () => {
            captured.eventRowUpdates.push(patch)
            const reclaimsFailed = filters.some(
              ([op, col, value]) => op === 'eq' && col === 'outcome' && value === 'failed',
            )
            const reclaimsExpiredProcessing = filters.some(
              ([op, col, value]) => op === 'eq' && col === 'outcome' && value === 'processing',
            ) && filters.some(([op, col]) => op === 'lt' && col === 'processed_at')
            if (reclaimsFailed) {
              return { data: config.reclaimFailedRows ?? [], error: config.reclaimError ?? null }
            }
            if (reclaimsExpiredProcessing) {
              return { data: config.reclaimProcessingRows ?? [], error: config.reclaimError ?? null }
            }
            return { data: null, error: null }
          }
          const chain = {
            eq: (col: string, value: unknown) => {
              filters.push(['eq', col, value])
              return chain
            },
            lt: (col: string, value: unknown) => {
              filters.push(['lt', col, value])
              return chain
            },
            select: () => Promise.resolve(result()),
            then: <TResult1 = { data: null; error: null }, TResult2 = never>(
              onfulfilled?: ((value: { data: null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
              onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
            ) => Promise.resolve(result()).then(onfulfilled, onrejected),
          }
          return chain
        }
        return {
          insert: (row: Record<string, unknown>) => {
            captured.insertedRow = row
            return Promise.resolve({ error: config.insertError ?? null })
          },
          // Self-returning chain that RECORDS each filter argument, so a test can
          // assert the handler actually applies the self-exclusion + outcome
          // filters that make the ordering guard correct (an arg-less passthrough
          // mock would pass even if those filters were dropped).
          select: (columns?: string) => {
            const filters: Filter[] = []
            const chain = {
              eq: (col: string, val: unknown) => {
                filters.push(['eq', col, val])
                return chain
              },
              not: (col: string, op: string, val: unknown) => {
                filters.push(['not', col, op, val])
                return chain
              },
              neq: (col: string, val: unknown) => {
                filters.push(['neq', col, val])
                return chain
              },
              order: () => chain,
              limit: () => chain,
              maybeSingle: () => {
                if (columns === 'outcome') {
                  return Promise.resolve({
                    data: config.existingOutcome ? { outcome: config.existingOutcome } : null,
                    error: config.existingOutcomeError ?? null,
                  })
                }
                captured.priorFilters = filters
                return Promise.resolve({
                  data: config.priorApplied ?? null,
                  error: config.priorError ?? null,
                })
              },
            }
            return chain
          },
          update: eventUpdateChain,
        }
      }
      if (table === 'craftsman_subscriptions') {
        return {
          update: (patch: Record<string, unknown>) => {
            captured.subsUpdatePayload = patch
            return {
              eq: (_col: string, val: string) => {
                captured.subsProfileId = val
                return {
                  select: () =>
                    Promise.resolve({
                      data: config.subsRows ?? [{ id: 'sub-1' }],
                      error: config.subsError ?? null,
                    }),
                }
              },
            }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
    rpc(name: string, args: Record<string, unknown>) {
      captured.rpcName = name
      captured.rpcArgs = args
      captured.subsUpdatePayload = args.p_subscription_updates as Record<string, unknown>
      captured.subsProfileId = args.p_profile_id as string
      const inferredAction = config.priorApplied
        ? 'stale'
        : config.subsRows && config.subsRows.length === 0
          ? 'no_subscription'
          : 'updated'
      return Promise.resolve({
        data: config.rpcAction ?? inferredAction,
        error: config.rpcError ?? config.subsError ?? null,
      })
    },
  }
  return { client, captured }
}

function setSupabase(config: SupaConfig = {}) {
  const supa = makeSupabase(config)
  mockGetAdminWithStatus.mockReturnValue({ ok: true, client: supa.client })
  return supa
}

// ── req / res harness ──────────────────────────────────────────────────────

function makeRes() {
  const res = {
    statusCode: 0,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return res as unknown as VercelResponse & { statusCode: number; body: unknown }
}

function makeReq(
  method: string,
  headers: Record<string, string>,
  body?: unknown,
): VercelRequest {
  return { method, headers, body } as unknown as VercelRequest
}

// Mirrors a real RevenueCat v1 webhook event: store=APP_STORE (uppercase) and
// period_type present (NORMAL = paid period). Override per test.
function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    type: 'INITIAL_PURCHASE',
    app_user_id: 'profile-1',
    expiration_at_ms: 1_700_000_000_000,
    purchased_at_ms: 1_699_000_000_000,
    product_id: 'fixup_pro_monthly',
    store: 'APP_STORE',
    period_type: 'NORMAL',
    original_transaction_id: 'txn-abc',
    event_timestamp_ms: 1_699_000_000_000,
    ...overrides,
  }
}

function authHeaders() {
  return { authorization: `Bearer ${SECRET}` }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET
})

afterEach(() => {
  delete process.env.REVENUECAT_WEBHOOK_SECRET
})

// ── Auth ───────────────────────────────────────────────────────────────────

describe('revenuecat-webhook — auth', () => {
  it('rejects non-POST with 405', async () => {
    const res = makeRes()
    await handler(makeReq('GET', authHeaders()), res)
    expect(res.statusCode).toBe(405)
  })

  it('rejects a wrong Bearer token with 401', async () => {
    setSupabase()
    const res = makeRes()
    await handler(makeReq('POST', { authorization: 'Bearer wrong' }, { event: event() }), res)
    expect(res.statusCode).toBe(401)
  })

  it('returns 500 webhook_misconfigured when the secret env is missing', async () => {
    delete process.env.REVENUECAT_WEBHOOK_SECRET
    const res = makeRes()
    await handler(makeReq('POST', { authorization: 'Bearer x' }, { event: event() }), res)
    expect(res.statusCode).toBe(500)
    expect((res.body as { error: string }).error).toBe('webhook_misconfigured')
  })

  it('rejects a missing event payload with 400', async () => {
    const res = makeRes()
    await handler(makeReq('POST', authHeaders(), {}), res)
    expect(res.statusCode).toBe(400)
  })
})

// ── Processing branch (never run in prod) ──────────────────────────────────

describe('revenuecat-webhook — status transitions', () => {
  it('INITIAL_PURCHASE (period_type NORMAL) → active + apple provider + current_period_start', async () => {
    const supa = setSupabase()
    const res = makeRes()
    await handler(makeReq('POST', authHeaders(), { event: event() }), res)

    expect(res.statusCode).toBe(200)
    expect((res.body as { action: string }).action).toBe('updated')
    const p = supa.captured.subsUpdatePayload!
    expect(p.status).toBe('active')
    expect(p.billing_provider).toBe('apple')
    expect(p.billing_provider_subscription_id).toBe('txn-abc')
    expect(p.current_period_start).toBe(new Date(1_699_000_000_000).toISOString())
    expect(p.current_period_end).toBe(new Date(1_700_000_000_000).toISOString())
    expect(supa.captured.subsProfileId).toBe('profile-1')
  })

  it('RENEWAL (period_type NORMAL) → active', async () => {
    const supa = setSupabase()
    const res = makeRes()
    await handler(
      makeReq('POST', authHeaders(), { event: event({ id: 'evt-renew', type: 'RENEWAL' }) }),
      res,
    )
    expect(supa.captured.subsUpdatePayload!.status).toBe('active')
  })

  it('INITIAL_PURCHASE with period_type=TRIAL → trial_active + trial dates + current_period cleared', async () => {
    const supa = setSupabase()
    const res = makeRes()
    await handler(
      makeReq('POST', authHeaders(), {
        event: event({ id: 'evt-trial', type: 'INITIAL_PURCHASE', period_type: 'TRIAL' }),
      }),
      res,
    )
    const p = supa.captured.subsUpdatePayload!
    expect(p.status).toBe('trial_active')
    expect(p.trial_started_at).toBe(new Date(1_699_000_000_000).toISOString())
    expect(p.trial_ends_at).toBe(new Date(1_700_000_000_000).toISOString())
    expect(p.current_period_start).toBeNull()
    expect(p.current_period_end).toBeNull()
  })

  it('CANCELLATION → canceled + canceled_at', async () => {
    const supa = setSupabase()
    const res = makeRes()
    await handler(
      makeReq('POST', authHeaders(), { event: event({ id: 'evt-cancel', type: 'CANCELLATION' }) }),
      res,
    )
    const p = supa.captured.subsUpdatePayload!
    expect(p.status).toBe('canceled')
    expect(p.canceled_at).toBe(new Date(1_699_000_000_000).toISOString())
  })

  it('EXPIRATION → expired', async () => {
    const supa = setSupabase()
    const res = makeRes()
    await handler(
      makeReq('POST', authHeaders(), { event: event({ id: 'evt-exp', type: 'EXPIRATION' }) }),
      res,
    )
    expect(supa.captured.subsUpdatePayload!.status).toBe('expired')
  })

  it('BILLING_ISSUE → grace + grace_started_at', async () => {
    const supa = setSupabase()
    const res = makeRes()
    await handler(
      makeReq('POST', authHeaders(), { event: event({ id: 'evt-bi', type: 'BILLING_ISSUE' }) }),
      res,
    )
    const p = supa.captured.subsUpdatePayload!
    expect(p.status).toBe('grace')
    expect(p.grace_started_at).toBeDefined()
  })

  it('SUBSCRIBER_ALIAS → skipped, no subscription write', async () => {
    const supa = setSupabase()
    const res = makeRes()
    await handler(
      makeReq('POST', authHeaders(), { event: event({ id: 'evt-alias', type: 'SUBSCRIBER_ALIAS' }) }),
      res,
    )
    expect((res.body as { action: string }).action).toBe('skipped')
    expect(supa.captured.subsUpdatePayload).toBeNull()
  })
})

// ── Correctness guards ─────────────────────────────────────────────────────

describe('revenuecat-webhook — dedup + ordering guards', () => {
  it('duplicate event_id (23505) → 200 duplicate, no subscription write', async () => {
    const supa = setSupabase({ insertError: { code: '23505' }, existingOutcome: 'processed' })
    const res = makeRes()
    await handler(makeReq('POST', authHeaders(), { event: event() }), res)
    expect(res.statusCode).toBe(200)
    expect((res.body as { action: string }).action).toBe('duplicate')
    expect(supa.captured.subsUpdatePayload).toBeNull()
  })

  it('out-of-order stale event is finalized by the RPC before returning 200', async () => {
    const supa = setSupabase({ priorApplied: { event_timestamp_ms: 2_000_000_000_000 } })
    const res = makeRes()
    // event_timestamp_ms (1.699e12) < latest applied (2.0e12) → stale
    await handler(makeReq('POST', authHeaders(), { event: event({ type: 'EXPIRATION' }) }), res)
    expect(res.statusCode).toBe(200)
    expect((res.body as { action: string }).action).toBe('stale')
    expect(supa.captured.rpcName).toBe('finalize_revenuecat_subscription_event')
  })

  it('passes the claimed event and subscription transition to the atomic RPC', async () => {
    const supa = setSupabase()
    const res = makeRes()
    await handler(makeReq('POST', authHeaders(), { event: event({ id: 'evt-self' }) }), res)
    expect(supa.captured.rpcName).toBe('finalize_revenuecat_subscription_event')
    expect(supa.captured.rpcArgs).toMatchObject({
      p_event_id: 'evt-self',
      p_profile_id: 'profile-1',
      p_event_timestamp_ms: 1_699_000_000_000,
    })
    expect(supa.captured.rpcArgs?.p_subscription_updates).toMatchObject({ status: 'active' })
  })

  it('no matching subscription row → 500 retryable failure', async () => {
    const supa = setSupabase({ subsRows: [] })
    const res = makeRes()
    await handler(makeReq('POST', authHeaders(), { event: event() }), res)
    expect(res.statusCode).toBe(500)
    expect((res.body as { error: string }).error).toBe('no_subscription_row')
    expect(supa.captured.rpcName).toBe('finalize_revenuecat_subscription_event')
  })

  it('DB update error → 500 + failed audit row', async () => {
    const supa = setSupabase({ subsError: { message: 'boom' } })
    const res = makeRes()
    await handler(makeReq('POST', authHeaders(), { event: event() }), res)
    expect(res.statusCode).toBe(500)
    expect((res.body as { error: string }).error).toBe('boom')
    expect(
      supa.captured.eventRowUpdates.some((u) => u.outcome === 'failed' && u.outcome_reason === 'boom'),
    ).toBe(true)
  })

  it('reclaims a failed event ID and finalizes it after the subscription write succeeds', async () => {
    const supa = setSupabase({
      insertError: { code: '23505' },
      reclaimFailedRows: [{ event_id: 'evt-1' }],
    })
    const res = makeRes()
    await handler(makeReq('POST', authHeaders(), { event: event() }), res)

    expect(res.statusCode).toBe(200)
    expect((res.body as { action: string }).action).toBe('updated')
    expect(supa.captured.subsUpdatePayload?.status).toBe('active')
    expect(
      supa.captured.eventRowUpdates.some((u) => u.outcome === 'processing' && u.outcome_reason === null),
    ).toBe(true)
    expect(supa.captured.rpcName).toBe('finalize_revenuecat_subscription_event')
  })

  it('reclaims an expired processing lease but returns retryable failure for a live claim', async () => {
    const expired = setSupabase({
      insertError: { code: '23505' },
      reclaimProcessingRows: [{ event_id: 'evt-1' }],
    })
    const expiredRes = makeRes()
    await handler(makeReq('POST', authHeaders(), { event: event() }), expiredRes)
    expect((expiredRes.body as { action: string }).action).toBe('updated')
    expect(expired.captured.subsUpdatePayload).not.toBeNull()

    const live = setSupabase({ insertError: { code: '23505' }, existingOutcome: 'processing' })
    const liveRes = makeRes()
    await handler(makeReq('POST', authHeaders(), { event: event() }), liveRes)
    expect(liveRes.statusCode).toBe(500)
    expect((liveRes.body as { error: string }).error).toBe('event_processing')
    expect(live.captured.subsUpdatePayload).toBeNull()
  })
})

describe('revenuecat-webhook — retry-claim migration contract', () => {
  it('makes processing a valid outcome and repairs legacy optimistic claims', () => {
    expect(retryClaimMigration).toContain("outcome IN ('processing', 'processed', 'duplicate', 'failed', 'skipped')")
    expect(retryClaimMigration).toContain("WHERE outcome = 'processed'")
    expect(retryClaimMigration).toContain('AND processed_at IS NULL')
  })
})

describe('revenuecat-webhook — atomic ordering migration contract', () => {
  it('serializes by profile before checking processed event timestamps', () => {
    expect(atomicOrderingMigration).toContain('pg_catalog.pg_advisory_xact_lock')
    expect(atomicOrderingMigration).toContain("AND outcome = 'processed'")
    expect(atomicOrderingMigration).toContain('p_event_timestamp_ms < v_latest_applied_timestamp_ms')
  })

  it('updates the subscription and finalizes the event inside one RPC transaction', () => {
    expect(atomicOrderingMigration).toContain('UPDATE public.craftsman_subscriptions')
    expect(atomicOrderingMigration).toContain("outcome = 'processed'")
    expect(atomicOrderingMigration).toContain("RAISE EXCEPTION 'revenuecat_event_finalize_failed'")
    expect(atomicOrderingMigration).toContain("RETURN 'updated'")
  })

  it('uses invoker rights with an empty search path and service-role-only execution', () => {
    expect(atomicOrderingMigration).toContain('SECURITY INVOKER')
    expect(atomicOrderingMigration).toContain("SET search_path = ''")
    expect(atomicOrderingMigration).toContain('FROM PUBLIC, anon, authenticated')
    expect(atomicOrderingMigration).toContain('TO service_role')
    expect(atomicOrderingMigration).not.toContain('SECURITY DEFINER')
  })
})
