import { describe, it, expect } from 'vitest'
import type { Rating } from '../../src/lib/ratings/types'
import {
  deriveProviderReputation,
  canSubmitRating,
  formatAverageRating,
  getRecentRatings,
} from '../../src/lib/ratings/selectors'

function makeRating(
  overrides: Partial<Rating> & { ratingScore: 1 | 2 | 3 | 4 | 5 }
): Rating {
  return {
    id: `rating-${Math.random()}`,
    jobId: `job-${Math.random()}`,
    providerUserId: 'provider-1',
    customerUserId: 'customer-1',
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('deriveProviderReputation', () => {
  it('returns zeroed reputation when no ratings exist', () => {
    const rep = deriveProviderReputation('provider-1', [])
    expect(rep.averageRating).toBe(0)
    expect(rep.ratingCount).toBe(0)
    expect(rep.ratingDistribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 })
  })

  it('calculates average rating correctly', () => {
    const ratings: Rating[] = [
      makeRating({ providerUserId: 'provider-1', ratingScore: 5 }),
      makeRating({ providerUserId: 'provider-1', ratingScore: 3 }),
      makeRating({ providerUserId: 'provider-1', ratingScore: 4 }),
    ]
    const rep = deriveProviderReputation('provider-1', ratings)
    expect(rep.averageRating).toBe(4.0)
    expect(rep.ratingCount).toBe(3)
  })

  it('rounds average to one decimal place', () => {
    const ratings: Rating[] = [
      makeRating({ providerUserId: 'provider-1', ratingScore: 5 }),
      makeRating({ providerUserId: 'provider-1', ratingScore: 4 }),
      makeRating({ providerUserId: 'provider-1', ratingScore: 4 }),
    ]
    // (5+4+4)/3 = 4.333... → rounds to 4.3
    const rep = deriveProviderReputation('provider-1', ratings)
    expect(rep.averageRating).toBe(4.3)
  })

  it('only counts ratings for the given provider', () => {
    const ratings: Rating[] = [
      makeRating({ providerUserId: 'provider-1', ratingScore: 5 }),
      makeRating({ providerUserId: 'provider-2', ratingScore: 1 }),
    ]
    const rep = deriveProviderReputation('provider-1', ratings)
    expect(rep.ratingCount).toBe(1)
    expect(rep.averageRating).toBe(5)
  })

  it('builds correct distribution', () => {
    const ratings: Rating[] = [
      makeRating({ providerUserId: 'provider-1', ratingScore: 5 }),
      makeRating({ providerUserId: 'provider-1', ratingScore: 5 }),
      makeRating({ providerUserId: 'provider-1', ratingScore: 3 }),
      makeRating({ providerUserId: 'provider-1', ratingScore: 1 }),
    ]
    const rep = deriveProviderReputation('provider-1', ratings)
    expect(rep.ratingDistribution[5]).toBe(2)
    expect(rep.ratingDistribution[3]).toBe(1)
    expect(rep.ratingDistribution[1]).toBe(1)
    expect(rep.ratingDistribution[2]).toBe(0)
    expect(rep.ratingDistribution[4]).toBe(0)
  })
})

describe('canSubmitRating', () => {
  const baseJob = { id: 'job-1', status: 'completed', customerUserId: 'customer-1' }

  it('returns true when all conditions are met', () => {
    expect(canSubmitRating(baseJob, undefined, 'customer-1')).toBe(true)
  })

  it('returns false when job is not completed', () => {
    expect(canSubmitRating({ ...baseJob, status: 'in_progress' }, undefined, 'customer-1')).toBe(false)
  })

  it('returns false when a rating already exists', () => {
    const existing = makeRating({ ratingScore: 4 })
    expect(canSubmitRating(baseJob, existing, 'customer-1')).toBe(false)
  })

  it('returns false when customerUserId is absent', () => {
    expect(canSubmitRating({ id: 'job-1', status: 'completed' }, undefined, 'customer-1')).toBe(false)
  })

  it('returns false when caller is not the customer', () => {
    expect(canSubmitRating(baseJob, undefined, 'other-user')).toBe(false)
  })
})

describe('formatAverageRating', () => {
  it('returns dash when no ratings', () => {
    const rep = deriveProviderReputation('provider-1', [])
    expect(formatAverageRating(rep)).toBe('–')
  })

  it('formats to one decimal place', () => {
    const ratings: Rating[] = [
      makeRating({ providerUserId: 'provider-1', ratingScore: 5 }),
    ]
    const rep = deriveProviderReputation('provider-1', ratings)
    expect(formatAverageRating(rep)).toBe('5.0')
  })
})

describe('getRecentRatings', () => {
  const BASE_TIME = 1_000_000_000_000 // fixed reference timestamp (ms)

  it('returns empty array when no ratings exist', () => {
    expect(getRecentRatings('provider-1', [])).toEqual([])
  })

  it('returns only ratings for the given provider', () => {
    const ratings: Rating[] = [
      makeRating({ providerUserId: 'provider-1', ratingScore: 5, createdAt: BASE_TIME }),
      makeRating({ providerUserId: 'provider-2', ratingScore: 3, createdAt: BASE_TIME }),
    ]
    const result = getRecentRatings('provider-1', ratings)
    expect(result).toHaveLength(1)
    expect(result[0].providerUserId).toBe('provider-1')
  })

  it('returns results sorted newest first', () => {
    const older = makeRating({ providerUserId: 'p1', ratingScore: 3, createdAt: BASE_TIME })
    const newer = makeRating({ providerUserId: 'p1', ratingScore: 5, createdAt: BASE_TIME + 10_000 })
    const result = getRecentRatings('p1', [older, newer])
    expect(result[0].createdAt).toBeGreaterThan(result[1].createdAt)
    expect(result[0].ratingScore).toBe(5)
  })

  it('respects the default limit of 3', () => {
    const ratings: Rating[] = Array.from({ length: 5 }, (_, i) =>
      makeRating({ providerUserId: 'p1', ratingScore: 4, createdAt: BASE_TIME + i * 1_000 })
    )
    expect(getRecentRatings('p1', ratings)).toHaveLength(3)
  })

  it('respects a custom limit', () => {
    const ratings: Rating[] = Array.from({ length: 5 }, (_, i) =>
      makeRating({ providerUserId: 'p1', ratingScore: 4, createdAt: BASE_TIME + i * 1_000 })
    )
    expect(getRecentRatings('p1', ratings, 1)).toHaveLength(1)
    expect(getRecentRatings('p1', ratings, 5)).toHaveLength(5)
  })

  it('returns fewer than limit when fewer ratings exist', () => {
    const ratings: Rating[] = [
      makeRating({ providerUserId: 'p1', ratingScore: 4, createdAt: BASE_TIME }),
    ]
    expect(getRecentRatings('p1', ratings, 3)).toHaveLength(1)
  })

  it('preserves optional comment in returned ratings', () => {
    const withComment = makeRating({
      providerUserId: 'p1',
      ratingScore: 5,
      ratingComment: 'Great work!',
      createdAt: BASE_TIME,
    })
    const withoutComment = makeRating({
      providerUserId: 'p1',
      ratingScore: 3,
      createdAt: BASE_TIME - 1_000,
    })
    const result = getRecentRatings('p1', [withComment, withoutComment])
    expect(result[0].ratingComment).toBe('Great work!')
    expect(result[1].ratingComment).toBeUndefined()
  })
})
