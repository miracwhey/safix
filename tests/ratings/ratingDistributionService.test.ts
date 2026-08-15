import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  fetchProviderRatingDistribution,
  fetchProviderReviews,
  fetchCompletedJobIds,
} from '../../src/lib/ratings/ratingDistributionService'
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

describe('fetchProviderRatingDistribution', () => {
  it('counts per-star buckets in descending order', async () => {
    vi.mocked(supabase.from).mockReturnValue({
      select: () => ({
        eq: () =>
          Promise.resolve({
            data: [
              { rating_score: 5 },
              { rating_score: 5 },
              { rating_score: 4 },
              { rating_score: 1 },
            ],
            error: null,
          }),
      }),
    } as unknown as ReturnType<typeof supabase.from>)

    const buckets = await fetchProviderRatingDistribution('user-1')
    expect(buckets).toEqual([
      { stars: 5, count: 2 },
      { stars: 4, count: 1 },
      { stars: 3, count: 0 },
      { stars: 2, count: 0 },
      { stars: 1, count: 1 },
    ])
  })

  it('returns all-zero buckets on error', async () => {
    vi.mocked(supabase.from).mockReturnValue({
      select: () => ({
        eq: () => Promise.resolve({ data: null, error: { message: 'nope' } }),
      }),
    } as unknown as ReturnType<typeof supabase.from>)

    const buckets = await fetchProviderRatingDistribution('user-1')
    expect(buckets.every((b) => b.count === 0)).toBe(true)
    expect(buckets.map((b) => b.stars)).toEqual([5, 4, 3, 2, 1])
  })

  it('returns all-zero buckets when providerUserId is blank', async () => {
    const buckets = await fetchProviderRatingDistribution('')
    expect(buckets.every((b) => b.count === 0)).toBe(true)
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('fetchProviderReviews', () => {
  it('maps rows to ProviderReviewRow newest-first', async () => {
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === 'ratings') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () =>
                  Promise.resolve({
                    data: [
                      {
                        id: 'r1',
                        job_id: 'j1',
                        provider_user_id: 'p1',
                        customer_user_id: 'c1',
                        rating_score: 5,
                        rating_comment: 'Top',
                        created_at: '2026-01-01T00:00:00Z',
                      },
                    ],
                    error: null,
                  }),
              }),
            }),
          }),
        } as unknown as ReturnType<typeof supabase.from>
      }
      // profiles batch-fetch for reviewer display names
      return {
        select: () => ({
          in: () => Promise.resolve({ data: [], error: null }),
        }),
      } as unknown as ReturnType<typeof supabase.from>
    })

    const reviews = await fetchProviderReviews('p1')
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({
      id: 'r1',
      jobId: 'j1',
      providerUserId: 'p1',
      ratingScore: 5,
      ratingComment: 'Top',
    })
  })

  it('returns [] on error', async () => {
    vi.mocked(supabase.from).mockReturnValue({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: null, error: { message: 'rls' } }),
          }),
        }),
      }),
    } as unknown as ReturnType<typeof supabase.from>)
    expect(await fetchProviderReviews('p1')).toEqual([])
  })
})

describe('fetchCompletedJobIds', () => {
  it('only returns jobs with status=completed', async () => {
    vi.mocked(supabase.from).mockReturnValue({
      select: () => ({
        in: () =>
          Promise.resolve({
            data: [
              { id: 'j1', status: 'completed' },
              { id: 'j2', status: 'in_progress' },
              { id: 'j3', status: 'completed' },
            ],
            error: null,
          }),
      }),
    } as unknown as ReturnType<typeof supabase.from>)

    const completed = await fetchCompletedJobIds(['j1', 'j2', 'j3'])
    expect(Array.from(completed).sort()).toEqual(['j1', 'j3'])
  })

  it('dedupes and skips empty inputs', async () => {
    expect(await fetchCompletedJobIds([])).toEqual(new Set())
    expect(await fetchCompletedJobIds(['', ''])).toEqual(new Set())
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns empty set on error (RLS-denied case)', async () => {
    vi.mocked(supabase.from).mockReturnValue({
      select: () => ({
        in: () => Promise.resolve({ data: null, error: { message: 'rls' } }),
      }),
    } as unknown as ReturnType<typeof supabase.from>)
    expect(await fetchCompletedJobIds(['j1'])).toEqual(new Set())
  })
})
