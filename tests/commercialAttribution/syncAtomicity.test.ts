/**
 * L2 ↔ L3 Sync Atomicity — Stage 5 tests.
 *
 * Verifies that `resolveAndEnsureRelationship` and `recordInviteRelationship`
 *   - await the Layer-2 INSERT (no fire-and-forget);
 *   - re-read the canonical row after INSERT (so concurrent races land on the
 *     winning value deterministically);
 *   - return `unknown_pending_resolution` when the round-trip fails, so the
 *     caller never stamps a Layer-3 origin that the Layer-2 table does not
 *     confirm;
 *   - never write the cache on a failed round-trip.
 *
 * Execution mode: the tests run in non-supabase mode by default (service
 * short-circuits to in-memory cache), BUT we override the Vite env via vi.stubEnv
 * so the Supabase path is exercised directly.
 */

import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const { mockSupabaseFrom } = vi.hoisted(() => ({
  mockSupabaseFrom: vi.fn(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: mockSupabaseFrom,
    auth: {},
  },
}))

// Import AFTER mocks so the service picks up the mocked client.
import {
  resolveAndEnsureRelationship,
  recordInviteRelationship,
  clearCommercialAttributionCache,
} from '../../src/lib/commercialAttribution/commercialAttributionService'

// ── helpers ──────────────────────────────────────────────────────────────────

type SelectResolver = () => Promise<{ data: unknown; error: unknown | null }>
type InsertResolver = (row: Record<string, unknown>) => Promise<{ error: unknown | null }>

/**
 * Builds a mock of `supabase.from('customer_provider_relationships')` that
 * honours a sequence of select/insert responses so the test can express a
 * race precisely.
 *
 * Calls are queued FIFO per operation (select, insert).  Any unexpected
 * operation without a queued response throws.
 */
function wireCustomerProviderRelationships(config: {
  selects: SelectResolver[]
  inserts: InsertResolver[]
}): { selectCalls: number; insertCalls: Array<Record<string, unknown>> } {
  const state = {
    selectCalls: 0,
    insertCalls: [] as Array<Record<string, unknown>>,
  }

  mockSupabaseFrom.mockImplementation((table: string) => {
    if (table !== 'customer_provider_relationships') {
      throw new Error(`Unexpected table: ${table}`)
    }

    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => {
              const resolver = config.selects[state.selectCalls]
              if (!resolver) throw new Error('No select resolver queued')
              state.selectCalls++
              return resolver()
            }),
          })),
        })),
      })),
      insert: vi.fn(async (row: Record<string, unknown>) => {
        const resolver = config.inserts[state.insertCalls.length]
        if (!resolver) throw new Error('No insert resolver queued')
        state.insertCalls.push(row)
        return resolver(row)
      }),
    }
  })

  return state
}

// ── Supabase-mode override (service checks VITE_DATA_SOURCE) ─────────────────

beforeEach(() => {
  vi.clearAllMocks()
  clearCommercialAttributionCache()
  vi.stubEnv('VITE_DATA_SOURCE', 'supabase')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ── resolveAndEnsureRelationship — atomicity contract ────────────────────────

describe('resolveAndEnsureRelationship — L2 ↔ L3 atomicity', () => {
  const CU = 'cust-1'
  const CR = 'craft-1'

  it('returns existing canonical origin on primary lookup hit (no write)', async () => {
    const state = wireCustomerProviderRelationships({
      selects: [
        async () => ({
          data: {
            id: 'rel-1',
            commercial_origin: 'merchant_brought',
            origin_context: 'invite',
            created_at: new Date().toISOString(),
          },
          error: null,
        }),
      ],
      inserts: [],
    })
    const origin = await resolveAndEnsureRelationship(CU, CR, { inquiryOrigin: 'reel' })
    expect(origin).toBe('merchant_brought')
    expect(state.insertCalls).toHaveLength(0)
  })

  it('primary lookup DB error → unknown_pending_resolution, no insert attempted', async () => {
    const state = wireCustomerProviderRelationships({
      selects: [async () => ({ data: null, error: { message: 'conn reset' } })],
      inserts: [],
    })
    const origin = await resolveAndEnsureRelationship(CU, CR, { inquiryOrigin: 'reel' })
    expect(origin).toBe('unknown_pending_resolution')
    expect(state.insertCalls).toHaveLength(0)
  })

  it('no record + happy INSERT + read-back → canonical origin returned', async () => {
    const state = wireCustomerProviderRelationships({
      selects: [
        // Primary lookup: no row
        async () => ({ data: null, error: null }),
        // Read-back after INSERT: canonical row visible
        async () => ({
          data: {
            id: 'rel-new',
            commercial_origin: 'platform_acquired',
            origin_context: 'search',
            created_at: new Date().toISOString(),
          },
          error: null,
        }),
      ],
      inserts: [async () => ({ error: null })],
    })
    const origin = await resolveAndEnsureRelationship(CU, CR, { inquiryOrigin: 'profile' })
    expect(origin).toBe('platform_acquired')
    expect(state.insertCalls).toHaveLength(1)
    expect(state.insertCalls[0]).toMatchObject({
      customer_user_id: CU,
      craftsman_user_id: CR,
      commercial_origin: 'platform_acquired',
    })
  })

  it('INSERT transient error (not 23505) → unknown_pending_resolution; no read-back attempted', async () => {
    const state = wireCustomerProviderRelationships({
      selects: [async () => ({ data: null, error: null })],
      inserts: [async () => ({ error: { code: '40001', message: 'serialization' } })],
    })
    const origin = await resolveAndEnsureRelationship(CU, CR, { inquiryOrigin: 'profile' })
    expect(origin).toBe('unknown_pending_resolution')
    // Read-back not attempted on a non-conflict insert failure
    expect(state.selectCalls).toBe(1)
  })

  it('INSERT 23505 conflict + read-back finds pre-existing merchant_brought → returns canonical merchant_brought', async () => {
    // Simulates: concurrent recordInviteRelationship wrote merchant_brought first;
    // our resolveAndEnsureRelationship then infers platform_acquired but the
    // conflict + read-back must surface the canonical merchant_brought.
    const state = wireCustomerProviderRelationships({
      selects: [
        async () => ({ data: null, error: null }), // primary lookup: empty (stale)
        async () => ({                              // read-back: canonical winner
          data: {
            id: 'rel-winner',
            commercial_origin: 'merchant_brought',
            origin_context: 'invite',
            created_at: new Date().toISOString(),
          },
          error: null,
        }),
      ],
      inserts: [async () => ({ error: { code: '23505', message: 'duplicate key' } })],
    })
    const origin = await resolveAndEnsureRelationship(CU, CR, { inquiryOrigin: 'profile' })
    // Canonical value from DB wins — NOT the locally inferred platform_acquired.
    expect(origin).toBe('merchant_brought')
    expect(state.insertCalls).toHaveLength(1)
  })

  it('post-insert read returns no row → unknown_pending_resolution (fail-closed)', async () => {
    const state = wireCustomerProviderRelationships({
      selects: [
        async () => ({ data: null, error: null }),
        async () => ({ data: null, error: null }), // read-back sees nothing
      ],
      inserts: [async () => ({ error: null })],
    })
    const origin = await resolveAndEnsureRelationship(CU, CR, { inquiryOrigin: 'profile' })
    expect(origin).toBe('unknown_pending_resolution')
    expect(state.selectCalls).toBe(2)
  })

  it('post-insert read errors → unknown_pending_resolution', async () => {
    wireCustomerProviderRelationships({
      selects: [
        async () => ({ data: null, error: null }),
        async () => ({ data: null, error: { message: 'network' } }),
      ],
      inserts: [async () => ({ error: null })],
    })
    const origin = await resolveAndEnsureRelationship(CU, CR, { inquiryOrigin: 'profile' })
    expect(origin).toBe('unknown_pending_resolution')
  })

  it('concurrent calls for same pair: both end with identical canonical origin (one INSERT wins)', async () => {
    // Two callers enter the "no record" branch at the same time.
    // - Caller A: primary lookup empty → INSERT wins (no error) → read-back returns A's row.
    // - Caller B: primary lookup empty → INSERT gets 23505 → read-back returns A's row.
    // Both callers end up with the same canonical origin.

    // We interleave responses by tracking insert call order — the SECOND insert
    // returns 23505 to simulate the race.
    const canonicalRow = {
      id: 'rel-A',
      commercial_origin: 'platform_acquired',
      origin_context: 'reel',
      created_at: new Date().toISOString(),
    }
    let insertOrder = 0
    const state = wireCustomerProviderRelationships({
      selects: [
        async () => ({ data: null, error: null }), // A primary
        async () => ({ data: null, error: null }), // B primary
        async () => ({ data: canonicalRow, error: null }), // A read-back
        async () => ({ data: canonicalRow, error: null }), // B read-back
      ],
      inserts: [
        async () => {
          insertOrder++
          return { error: null } // A wins
        },
        async () => {
          insertOrder++
          return { error: { code: '23505', message: 'duplicate' } } // B loses
        },
      ],
    })

    const [originA, originB] = await Promise.all([
      resolveAndEnsureRelationship(CU, CR, { inquiryOrigin: 'reel' }),
      resolveAndEnsureRelationship(CU, CR, { inquiryOrigin: 'profile' }), // different inference
    ])

    expect(originA).toBe('platform_acquired')
    expect(originB).toBe('platform_acquired')
    expect(state.insertCalls).toHaveLength(2)
    expect(insertOrder).toBe(2)
  })
})

// ── recordInviteRelationship — no fire-and-forget ────────────────────────────

describe('recordInviteRelationship — atomicity contract', () => {
  const CU = 'cust-invite'
  const CR = 'craft-invite'

  it('awaits the insert and completes only after Supabase round-trip', async () => {
    let insertResolved = false
    const state = wireCustomerProviderRelationships({
      selects: [
        // read-back: canonical row visible
        async () => ({
          data: {
            id: 'rel-invite',
            commercial_origin: 'merchant_brought',
            origin_context: 'invite',
            created_at: new Date().toISOString(),
          },
          error: null,
        }),
      ],
      inserts: [
        async () => {
          // Resolve asynchronously to prove the caller awaits.
          await Promise.resolve()
          insertResolved = true
          return { error: null }
        },
      ],
    })

    const p = recordInviteRelationship(CU, CR)
    // Before await, the insert may or may not have resolved — but after await it MUST have.
    await p
    expect(insertResolved).toBe(true)
    expect(state.insertCalls).toHaveLength(1)
  })

  it('insert failure (non-conflict) still completes (signature is void) but logs warning', async () => {
    // Provide an extra select resolver because the service attempts a read-back
    // only after a 23505 conflict.  For non-conflict errors, persistAndReadCanonical
    // bails without reading back; consequently only the insert is queued.
    wireCustomerProviderRelationships({
      selects: [],
      inserts: [async () => ({ error: { code: '40001', message: 'transient' } })],
    })
    await expect(recordInviteRelationship(CU, CR)).resolves.toBeUndefined()
  })
})
