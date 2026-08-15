/**
 * SupabaseOfferRepository — QUOTE-STALE timestamp boundary (F13 · Block 3.9).
 *
 * Regression test for the `stale_marked_at` type mismatch: migration
 * 20260520120041 declares the column `timestamptz`, but the offer domain
 * carries `staleMarkedAt` as unix-ms. `offerToRow` must convert the unix-ms to
 * an ISO-8601 string at the write boundary (Postgres will NOT coerce a bare
 * integer into a timestamptz — every real QUOTE-STALE UPDATE would fail),
 * and `rowToOffer` must parse it back. The `offers_stale_consistency_chk`
 * constraint (reason + timestamp NULL iff not stale) must still hold.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { SupabaseOfferRepository } from '../../../src/lib/offers/repository/SupabaseOfferRepository'
import { supabase } from '../../../src/lib/supabase'
import type { Offer } from '../../../src/lib/offers/types'

interface MockSession {
  user: { id: string }
}
interface MockQueryBuilder {
  select?: ReturnType<typeof vi.fn>
  or?: ReturnType<typeof vi.fn>
  order?: ReturnType<typeof vi.fn>
  limit?: ReturnType<typeof vi.fn>
  insert?: ReturnType<typeof vi.fn>
  update?: ReturnType<typeof vi.fn>
  eq?: ReturnType<typeof vi.fn>
}

vi.mock('../../../src/lib/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn(), onAuthStateChange: vi.fn() },
    from: vi.fn(),
  },
}))
vi.mock('../../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))
vi.mock('../../../src/lib/persistence', () => ({
  recordPersistenceFailure: vi.fn(),
}))

const CRAFTSMAN = 'craftsman-1'

/** A minimal pending offer carrying the QUOTE-STALE fields. */
function staleOffer(staleMarkedAt: number | undefined, isStale: boolean): Offer {
  return {
    id: 'offer-1',
    conversationId: 'conv-1',
    customerUserId: 'customer-1',
    craftsmanUserId: CRAFTSMAN,
    price: '100',
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
    sentAt: 1,
    documentType: 'binding_offer',
    contextType: 'conversation',
    offerMode: 'binding',
    isStale,
    ...(isStale && {
      staleReason: 'measurement_changed' as const,
      ...(staleMarkedAt !== undefined && { staleMarkedAt }),
      staleSourceSceneId: 'scene-9',
    }),
  } as unknown as Offer
}

beforeEach(() => {
  vi.mocked(supabase.auth.onAuthStateChange).mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  } as never)
})
afterEach(() => vi.clearAllMocks())

describe('SupabaseOfferRepository · QUOTE-STALE timestamp boundary (F13)', () => {
  it('offerToRow writes stale_marked_at as an ISO-8601 string, never a bare integer', async () => {
    const repo = new SupabaseOfferRepository()
    let captured: Record<string, unknown> | null = null
    const updateMock = vi.fn((row: Record<string, unknown>) => {
      captured = row
      return { eq: vi.fn().mockResolvedValue({ error: null }) }
    })
    vi.mocked(supabase.from).mockReturnValue({ update: updateMock } as unknown as MockQueryBuilder)

    // Seed a non-stale offer locally, then flip it stale through the updater.
    const fresh = staleOffer(undefined, false)
    ;(repo as unknown as { offers: Offer[] }).offers = [fresh]

    const markedAt = Date.UTC(2026, 4, 20, 12, 0, 0) // a real unix-ms instant
    await repo.update('offer-1', (o) => ({
      ...o,
      isStale: true,
      staleReason: 'measurement_changed',
      staleMarkedAt: markedAt,
      staleSourceSceneId: 'scene-9',
    }))

    expect(captured).not.toBeNull()
    const row = captured as unknown as Record<string, unknown>
    expect(row.is_stale).toBe(true)
    // The load-bearing assertion — a string, not the raw integer.
    expect(typeof row.stale_marked_at).toBe('string')
    expect(row.stale_marked_at).toBe(new Date(markedAt).toISOString())
    expect(row.stale_reason).toBe('measurement_changed')
  })

  it('a non-stale offer writes all three QUOTE-STALE columns NULL (consistency_chk holds)', async () => {
    const repo = new SupabaseOfferRepository()
    let captured: Record<string, unknown> | null = null
    const updateMock = vi.fn((row: Record<string, unknown>) => {
      captured = row
      return { eq: vi.fn().mockResolvedValue({ error: null }) }
    })
    vi.mocked(supabase.from).mockReturnValue({ update: updateMock } as unknown as MockQueryBuilder)

    ;(repo as unknown as { offers: Offer[] }).offers = [staleOffer(undefined, false)]
    await repo.update('offer-1', (o) => ({ ...o, description: 'touched' }))

    const row = captured as unknown as Record<string, unknown>
    expect(row.is_stale).toBe(false)
    expect(row.stale_reason).toBeNull()
    expect(row.stale_marked_at).toBeNull()
    expect(row.stale_source_scene_id).toBeNull()
  })

  it('rowToOffer parses an ISO-8601 stale_marked_at back into unix-ms', async () => {
    const repo = new SupabaseOfferRepository()
    const markedAt = Date.UTC(2026, 4, 20, 12, 0, 0)
    const iso = new Date(markedAt).toISOString()

    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: { user: { id: CRAFTSMAN } } as MockSession },
      error: null,
    } as never)
    vi.mocked(supabase.from).mockReturnValue({
      select: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'offer-1',
            conversation_id: 'conv-1',
            customer_user_id: 'customer-1',
            craftsman_user_id: CRAFTSMAN,
            price: '100',
            description: null,
            timing_note: null,
            status: 'pending',
            created_at: 1,
            updated_at: 1,
            accepted_at: null,
            declined_at: null,
            created_job_id: null,
            document_type: 'binding_offer',
            context_type: 'conversation',
            is_stale: true,
            stale_reason: 'measurement_changed',
            stale_marked_at: iso, // timestamptz → ISO string from PostgREST
            stale_source_scene_id: 'scene-9',
          },
        ],
        error: null,
      }),
    } as unknown as MockQueryBuilder)

    await repo.initialize()
    const offer = repo.getById('offer-1')
    expect(offer?.isStale).toBe(true)
    expect(offer?.staleMarkedAt).toBe(markedAt)
    expect(typeof offer?.staleMarkedAt).toBe('number')
    expect(offer?.staleReason).toBe('measurement_changed')
  })

  it('rowToOffer drops a non-parseable stale_marked_at instead of emitting NaN', async () => {
    const repo = new SupabaseOfferRepository()
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: { user: { id: CRAFTSMAN } } as MockSession },
      error: null,
    } as never)
    vi.mocked(supabase.from).mockReturnValue({
      select: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'offer-1',
            conversation_id: 'conv-1',
            customer_user_id: 'customer-1',
            craftsman_user_id: CRAFTSMAN,
            price: '100',
            description: null,
            timing_note: null,
            status: 'pending',
            created_at: 1,
            updated_at: 1,
            accepted_at: null,
            declined_at: null,
            created_job_id: null,
            document_type: 'binding_offer',
            context_type: 'conversation',
            is_stale: true,
            stale_reason: 'layout_changed',
            stale_marked_at: 'not-a-timestamp',
            stale_source_scene_id: 'scene-9',
          },
        ],
        error: null,
      }),
    } as unknown as MockQueryBuilder)

    await repo.initialize()
    const offer = repo.getById('offer-1')
    expect(offer?.isStale).toBe(true)
    expect(offer?.staleMarkedAt).toBeUndefined()
  })
})
