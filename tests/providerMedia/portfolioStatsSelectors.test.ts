import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  aggregateLikesForProvider,
  fetchLikeCountsForMedia,
} from '../../src/lib/providerMedia/portfolioStatsSelectors'
import { supabase } from '../../src/lib/supabase'

vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: vi.fn() },
}))

vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(supabase.from).mockReset()
})

describe('aggregateLikesForProvider', () => {
  it('returns 0 when provider has no published portfolio items', async () => {
    const mediaSelect = {
      eq: vi.fn().mockReturnThis(),
    } as Record<string, unknown>
    Object.assign(mediaSelect, {
      eq: vi.fn(function chain(this: unknown) {
        return mediaSelect
      }),
    })
    // Build a chain that resolves with no rows
    const chain = {
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    }
    vi.mocked(supabase.from).mockReturnValue(chain as unknown as ReturnType<typeof supabase.from>)
    expect(await aggregateLikesForProvider('prov-1')).toBe(0)
  })

  it('returns 0 when provider id is blank', async () => {
    expect(await aggregateLikesForProvider('')).toBe(0)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('counts likes across the provider\'s media items', async () => {
    let callIdx = 0
    vi.mocked(supabase.from).mockImplementation(() => {
      callIdx += 1
      if (callIdx === 1) {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () =>
                  Promise.resolve({
                    data: [{ id: 'm1' }, { id: 'm2' }],
                    error: null,
                  }),
              }),
            }),
          }),
        } as unknown as ReturnType<typeof supabase.from>
      }
      return {
        select: () => ({
          in: () => Promise.resolve({ data: null, count: 7, error: null }),
        }),
      } as unknown as ReturnType<typeof supabase.from>
    })

    expect(await aggregateLikesForProvider('prov-1')).toBe(7)
  })

  it('returns 0 on media lookup error', async () => {
    vi.mocked(supabase.from).mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
          }),
        }),
      }),
    } as unknown as ReturnType<typeof supabase.from>)
    expect(await aggregateLikesForProvider('prov-1')).toBe(0)
  })
})

describe('fetchLikeCountsForMedia', () => {
  it('returns {} for empty input without hitting supabase', async () => {
    expect(await fetchLikeCountsForMedia([])).toEqual({})
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('aggregates per-media counts from like rows', async () => {
    vi.mocked(supabase.from).mockReturnValue({
      select: () => ({
        in: () =>
          Promise.resolve({
            data: [
              { media_id: 'm1' },
              { media_id: 'm1' },
              { media_id: 'm2' },
            ],
            error: null,
          }),
      }),
    } as unknown as ReturnType<typeof supabase.from>)

    const counts = await fetchLikeCountsForMedia(['m1', 'm2', 'm3'])
    expect(counts).toEqual({ m1: 2, m2: 1, m3: 0 })
  })

  it('returns {} on query error', async () => {
    vi.mocked(supabase.from).mockReturnValue({
      select: () => ({
        in: () => Promise.resolve({ data: null, error: { message: 'nope' } }),
      }),
    } as unknown as ReturnType<typeof supabase.from>)
    expect(await fetchLikeCountsForMedia(['m1'])).toEqual({})
  })
})
