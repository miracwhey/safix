const { mockRequireOwner } = vi.hoisted(() => ({ mockRequireOwner: vi.fn() }))
const { mockGetSupabaseAdminWithStatus } = vi.hoisted(() => ({
  mockGetSupabaseAdminWithStatus: vi.fn(),
}))

vi.mock('../../api/_authRole', () => ({ requireOwner: mockRequireOwner }))
vi.mock('../../api/_supabase', () => ({
  getSupabaseAdminWithStatus: mockGetSupabaseAdminWithStatus,
  formatAdminUnavailable: () => 'missing credentials.',
}))
vi.mock('../../api/_subscriptionAuth', () => ({
  requireProEntitlement: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('../../api/_rateLimit', () => ({ applyRateLimit: vi.fn().mockResolvedValue(false) }))
vi.mock('../../api/_observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import handler from '../../api/request-funding'

type TableResult = { data: unknown; error: unknown }
const tableQueues: Record<string, TableResult[]> = {}
const fromCalls: string[] = []

function queueTableResult(table: string, result: TableResult): void {
  if (!tableQueues[table]) tableQueues[table] = []
  tableQueues[table].push(result)
}

function buildChain(table: string): Record<string, unknown> {
  const result = tableQueues[table]?.shift() ?? { data: null, error: null }
  const chain: Record<string, unknown> = {}
  const passthrough = () => chain
  chain.select = passthrough
  chain.eq = passthrough
  chain.not = passthrough
  chain.or = passthrough
  chain.limit = passthrough
  chain.maybeSingle = () => Promise.resolve(result)
  ;(chain as { then?: (fn: (value: unknown) => unknown) => Promise<unknown> }).then = (fn) =>
    Promise.resolve(result).then(fn)
  return chain
}

const adminClient = {
  from: (table: string) => {
    fromCalls.push(table)
    return buildChain(table)
  },
}

function makeRequest(): VercelRequest {
  return {
    method: 'POST',
    headers: {},
    body: { jobId: 'stale-job' },
    url: '/api/request-funding',
  } as unknown as VercelRequest
}

function makeResponse(): { res: VercelResponse; statusCode: () => number; body: () => unknown } {
  let status = 0
  let payload: unknown
  const res = {
    setHeader: vi.fn(() => res),
    status: vi.fn((nextStatus: number) => {
      status = nextStatus
      return res
    }),
    json: vi.fn((nextPayload: unknown) => {
      payload = nextPayload
      return res
    }),
  } as unknown as VercelResponse
  return { res, statusCode: () => status, body: () => payload }
}

describe('/api/request-funding — canonical job isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(tableQueues)) delete tableQueues[key]
    fromCalls.length = 0
    mockRequireOwner.mockResolvedValue({ userId: 'provider-owner' })
    mockGetSupabaseAdminWithStatus.mockReturnValue({ ok: true, client: adminClient })
  })

  it('never redirects to a historical job based only on the same customer/provider pair', async () => {
    queueTableResult('jobs', {
      data: {
        id: 'stale-job',
        status: 'in_progress',
        source_offer_id: null,
        customer_user_id: 'customer-1',
        provider_id: 'provider-1',
      },
      error: null,
    })
    queueTableResult('offers', { data: null, error: null })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(), res)

    expect(statusCode()).toBe(422)
    expect((body() as { code?: string }).code).toBe('SOURCE_OFFER_MISSING')
    expect(fromCalls).toEqual(['jobs', 'offers'])
  })

  it('does not attempt a redirect when either immutable party link is missing', async () => {
    queueTableResult('jobs', {
      data: {
        id: 'stale-job',
        status: 'in_progress',
        source_offer_id: null,
        customer_user_id: null,
        provider_id: 'provider-1',
      },
      error: null,
    })
    queueTableResult('offers', { data: null, error: null })

    const { res, statusCode, body } = makeResponse()
    await handler(makeRequest(), res)

    expect(statusCode()).toBe(422)
    expect((body() as { code?: string }).code).toBe('SOURCE_OFFER_MISSING')
    expect(fromCalls).toEqual(['jobs', 'offers'])
  })
})
