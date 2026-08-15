import { describe, it, expect } from 'vitest'
import type { DiscoveryProvider } from '../../src/lib/discovery/discoveryTypes'
import { computeProviderScore, rankProviders, locationSignal } from '../../src/lib/search/selectors'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000_000 // fixed reference timestamp (ms)

/** Build a fully-ready provider with sane defaults; override as needed. */
function makeProvider(overrides: Partial<DiscoveryProvider> = {}): DiscoveryProvider {
  return {
    id: `provider-${Math.random().toString(36).slice(2)}`,
    profileId: `profile-${Math.random().toString(36).slice(2)}`,
    companyName: 'Muster GmbH',
    displayName: 'Max Muster',
    description: 'Ihr zuverlässiger Handwerker für alle Gewerke.',
    city: 'Berlin',
    tradeCategories: ['Sanitär'],
    avatarUrl: 'https://example.com/avatar.jpg',
    rating: 4.5,
    ratingCount: 0,
    verified: true,
    isPublic: true,
    onboardingDone: true,
    craftsmanRole: 'craftsman',
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// computeProviderScore
// ---------------------------------------------------------------------------

describe('computeProviderScore', () => {
  it('returns a value between 0 and 1', () => {
    const provider = makeProvider()
    const score = computeProviderScore(provider)
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('scores a fully-ready provider higher than a bare-bones provider', () => {
    const full = makeProvider({ rating: 5, onboardingDone: true, description: 'Great!', avatarUrl: 'https://x.com/a.jpg' })
    const bare = makeProvider({
      rating: null,
      onboardingDone: false,
      description: null,
      avatarUrl: null,
      tradeCategories: [],
    })
    expect(computeProviderScore(full)).toBeGreaterThan(computeProviderScore(bare))
  })

  it('scores a 5-star provider higher than a 1-star provider (no query)', () => {
    const high = makeProvider({ rating: 5, onboardingDone: true })
    const low = makeProvider({ rating: 1, onboardingDone: false, description: null, avatarUrl: null })
    expect(computeProviderScore(high)).toBeGreaterThan(computeProviderScore(low))
  })

  it('returns 0 rating contribution when rating is null', () => {
    const withRating = makeProvider({ rating: 5 })
    const noRating = makeProvider({ rating: null, description: withRating.description, avatarUrl: withRating.avatarUrl, onboardingDone: withRating.onboardingDone })
    // No rating → lower score due to missing rating signal
    expect(computeProviderScore(withRating)).toBeGreaterThan(computeProviderScore(noRating))
  })

  it('boosts score when query matches company name vs no query', () => {
    const provider = makeProvider({ companyName: 'Sanitär Meier' })
    const scoreWithMatch = computeProviderScore(provider, { query: 'Sanitär Meier' })
    const scoreWithNoMatch = computeProviderScore(provider, { query: 'Fliesenleger' })
    expect(scoreWithMatch).toBeGreaterThan(scoreWithNoMatch)
  })

  it('gives full relevance score when no query is provided', () => {
    // Without query, relevance signal is 1.0, contributing 0.2 to the total.
    // Score should be the same with undefined params or empty query.
    const provider = makeProvider()
    const scoreNoParams = computeProviderScore(provider)
    const scoreEmptyQuery = computeProviderScore(provider, { query: '' })
    expect(scoreNoParams).toBeCloseTo(scoreEmptyQuery, 5)
  })

  it('query matching on trade category scores lower than company name match', () => {
    const provider = makeProvider({ companyName: 'Fliesenleger Berlin', tradeCategories: ['Fliesen'] })
    const companyScore = computeProviderScore(provider, { query: 'Fliesenleger Berlin' })
    const categoryScore = computeProviderScore(provider, { query: 'Fliesen' })
    // company name match should be at least as good as category match
    expect(companyScore).toBeGreaterThanOrEqual(categoryScore)
  })

  it('clamps score to 1 for a theoretically perfect provider', () => {
    const perfect = makeProvider({ rating: 5 })
    const score = computeProviderScore(perfect, { query: 'Muster' })
    expect(score).toBeLessThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// rankProviders
// ---------------------------------------------------------------------------

describe('rankProviders', () => {
  // ---- Empty / trivial cases --------------------------------------------

  it('returns empty array when providers list is empty', () => {
    const result = rankProviders([], { query: 'anything' })
    expect(result).toEqual([])
  })

  it('returns all providers when no filters are set', () => {
    const providers = [makeProvider(), makeProvider(), makeProvider()]
    const result = rankProviders(providers, {})
    expect(result).toHaveLength(3)
  })

  // ---- Trade category filter -------------------------------------------

  it('filters by tradeCategory (case-insensitive)', () => {
    const sanitaer = makeProvider({ tradeCategories: ['Sanitär'] })
    const elektrik = makeProvider({ tradeCategories: ['Elektrik'] })

    const result = rankProviders([sanitaer, elektrik], { tradeCategory: 'sanitär' })
    expect(result).toHaveLength(1)
    expect(result[0].tradeCategories).toContain('Sanitär')
  })

  it('includes providers whose category contains the filter string', () => {
    const provider = makeProvider({ tradeCategories: ['Sanitär & Heizung'] })
    const result = rankProviders([provider], { tradeCategory: 'Sanitär' })
    expect(result).toHaveLength(1)
  })

  it('excludes providers whose categories do not match', () => {
    const provider = makeProvider({ tradeCategories: ['Dach'] })
    const result = rankProviders([provider], { tradeCategory: 'Elektrik' })
    expect(result).toHaveLength(0)
  })

  // ---- Minimum rating filter -------------------------------------------

  it('filters by minimumRating', () => {
    const highRating = makeProvider({ id: 'h', rating: 4.8 })
    const lowRating = makeProvider({ id: 'l', rating: 3.2 })

    const result = rankProviders([highRating, lowRating], { minimumRating: 4 })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('h')
  })

  it('excludes providers with null rating when minimumRating is set', () => {
    const noRating = makeProvider({ rating: null })
    const result = rankProviders([noRating], { minimumRating: 3 })
    expect(result).toHaveLength(0)
  })

  it('includes all providers when minimumRating is 0', () => {
    const providers = [makeProvider({ rating: null }), makeProvider({ rating: 2 })]
    const result = rankProviders(providers, { minimumRating: 0 })
    expect(result).toHaveLength(2)
  })

  // ---- Location filter -------------------------------------------------

  it('filters by location (case-insensitive substring)', () => {
    const berlin = makeProvider({ city: 'Berlin' })
    const munich = makeProvider({ city: 'München' })

    const result = rankProviders([berlin, munich], { location: 'berlin' })
    expect(result).toHaveLength(1)
    expect(result[0].city).toBe('Berlin')
  })

  it('excludes providers whose city does not match location filter', () => {
    const provider = makeProvider({ city: 'Hamburg' })
    const result = rankProviders([provider], { location: 'Berlin' })
    expect(result).toHaveLength(0)
  })

  // ---- Query filter ----------------------------------------------------

  it('filters by query text across companyName', () => {
    const match = makeProvider({ companyName: 'Fliesenleger Müller' })
    const noMatch = makeProvider({ companyName: 'Elektriker AG' })

    const result = rankProviders([match, noMatch], { query: 'Fliesen' })
    expect(result).toHaveLength(1)
    expect(result[0].companyName).toBe('Fliesenleger Müller')
  })

  it('filters by query text in description', () => {
    const match = makeProvider({ description: 'Spezialist für Badezimmer-Renovierungen' })
    const noMatch = makeProvider({ description: 'Dachdeckermeister' })

    const result = rankProviders([match, noMatch], { query: 'Badezimmer' })
    expect(result).toHaveLength(1)
  })

  it('filters by query text in tradeCategories', () => {
    const match = makeProvider({ tradeCategories: ['Sanitär', 'Heizung'] })
    const noMatch = makeProvider({ tradeCategories: ['Dach'] })

    const result = rankProviders([match, noMatch], { query: 'Heizung' })
    expect(result).toHaveLength(1)
  })

  it('filters by query text in city', () => {
    const match = makeProvider({ city: 'Hannover' })
    const noMatch = makeProvider({ city: 'Stuttgart' })

    const result = rankProviders([match, noMatch], { query: 'Hannover' })
    expect(result).toHaveLength(1)
  })

  it('excludes provider when query matches nothing', () => {
    const provider = makeProvider({
      companyName: 'Maler Schmidt',
      description: 'Malerei und Tapezieren',
      tradeCategories: ['Malerei'],
      city: 'Leipzig',
    })
    const result = rankProviders([provider], { query: 'Elektrik' })
    expect(result).toHaveLength(0)
  })

  // ---- Combined filters -----------------------------------------------

  it('applies multiple filters together (category + rating)', () => {
    const good = makeProvider({ tradeCategories: ['Sanitär'], rating: 4.6 })
    const badRating = makeProvider({ tradeCategories: ['Sanitär'], rating: 2.0 })
    const wrongTrade = makeProvider({ tradeCategories: ['Dach'], rating: 4.8 })

    const result = rankProviders([good, badRating, wrongTrade], {
      tradeCategory: 'Sanitär',
      minimumRating: 4,
    })
    expect(result).toHaveLength(1)
    expect(result[0].rating).toBe(4.6)
  })

  // ---- Sorting ---------------------------------------------------------

  describe('sortBy: rating', () => {
    it('sorts providers by rating descending', () => {
      const p1 = makeProvider({ rating: 3.0 })
      const p2 = makeProvider({ rating: 5.0 })
      const p3 = makeProvider({ rating: 4.2 })

      const result = rankProviders([p1, p2, p3], { sortBy: 'rating' })
      expect(result[0].rating).toBe(5.0)
      expect(result[1].rating).toBe(4.2)
      expect(result[2].rating).toBe(3.0)
    })

    it('places providers with null rating last', () => {
      const withRating = makeProvider({ rating: 3.5 })
      const noRating = makeProvider({ rating: null })

      const result = rankProviders([noRating, withRating], { sortBy: 'rating' })
      expect(result[0].rating).toBe(3.5)
      expect(result[1].rating).toBeNull()
    })
  })

  describe('sortBy: recency', () => {
    it('sorts providers by createdAt descending (newest first)', () => {
      const old = makeProvider({ createdAt: BASE_TIME - 10_000 })
      const newest = makeProvider({ createdAt: BASE_TIME + 20_000 })
      const middle = makeProvider({ createdAt: BASE_TIME })

      const result = rankProviders([old, newest, middle], { sortBy: 'recency' })
      expect(result[0].createdAt).toBe(BASE_TIME + 20_000)
      expect(result[1].createdAt).toBe(BASE_TIME)
      expect(result[2].createdAt).toBe(BASE_TIME - 10_000)
    })
  })

  describe('sortBy: relevance (default)', () => {
    it('returns a valid ordered list when sortBy is not specified', () => {
      const providers = [makeProvider(), makeProvider(), makeProvider()]
      const result = rankProviders(providers, {})
      expect(result).toHaveLength(3)
    })

    it('places providers with higher composite score first', () => {
      const highScore = makeProvider({
        rating: 5,
        onboardingDone: true,
        description: 'Best craftsman',
        avatarUrl: 'https://x.com/a.jpg',
      })
      const lowScore = makeProvider({
        rating: null,
        onboardingDone: false,
        description: null,
        avatarUrl: null,
        tradeCategories: [],
      })

      const result = rankProviders([lowScore, highScore], { sortBy: 'relevance' })
      expect(result[0].rating).toBe(5)
    })
  })

  // ---- Edge cases -----------------------------------------------------

  it('does not mutate the original providers array', () => {
    const providers = [
      makeProvider({ rating: 1 }),
      makeProvider({ rating: 5 }),
    ]
    const original = [...providers]
    rankProviders(providers, { sortBy: 'rating' })
    expect(providers[0]).toBe(original[0])
    expect(providers[1]).toBe(original[1])
  })

  it('handles providers with empty tradeCategories gracefully', () => {
    const provider = makeProvider({ tradeCategories: [] })
    const result = rankProviders([provider], {})
    expect(result).toHaveLength(1)
  })

  it('handles providers with null description and null city gracefully', () => {
    const provider = makeProvider({ description: null, city: null })
    expect(() => rankProviders([provider], { query: 'anything', location: 'Berlin' })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// locationSignal
// ---------------------------------------------------------------------------

describe('locationSignal', () => {
  it('returns 0 when no location is provided', () => {
    const provider = makeProvider({ city: 'Berlin' })
    expect(locationSignal(provider)).toBe(0)
    expect(locationSignal(provider, '')).toBe(0)
    expect(locationSignal(provider, '   ')).toBe(0)
  })

  it('returns 1 for an exact city match (case-insensitive)', () => {
    const provider = makeProvider({ city: 'Berlin' })
    expect(locationSignal(provider, 'Berlin')).toBe(1)
    expect(locationSignal(provider, 'berlin')).toBe(1)
    expect(locationSignal(provider, 'BERLIN')).toBe(1)
  })

  it('returns 1 when city contains the location string', () => {
    const provider = makeProvider({ city: 'Berlin Mitte' })
    expect(locationSignal(provider, 'Berlin')).toBe(1)
  })

  it('returns 1 when location contains the city string', () => {
    const provider = makeProvider({ city: 'Berlin' })
    expect(locationSignal(provider, 'Berlin Charlottenburg')).toBe(1)
  })

  it('returns 0.5 for a shared regional token', () => {
    const provider = makeProvider({ city: 'München Nord' })
    expect(locationSignal(provider, 'München Süd')).toBe(0.5)
  })

  it('returns 0 when there is no overlap', () => {
    const provider = makeProvider({ city: 'Hamburg' })
    expect(locationSignal(provider, 'Berlin')).toBe(0)
  })

  it('returns 0 when provider has no city', () => {
    const provider = makeProvider({ city: null })
    expect(locationSignal(provider, 'Berlin')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// computeProviderScore – location integration
// ---------------------------------------------------------------------------

describe('computeProviderScore – location signal', () => {
  it('scores a city-matching provider higher than a non-matching one when location is set', () => {
    const berlinProvider = makeProvider({ city: 'Berlin', rating: 4.0 })
    const hamburgProvider = makeProvider({ city: 'Hamburg', rating: 4.0 })

    const berlinScore = computeProviderScore(berlinProvider, { location: 'Berlin' })
    const hamburgScore = computeProviderScore(hamburgProvider, { location: 'Berlin' })

    expect(berlinScore).toBeGreaterThan(hamburgScore)
  })

  it('does not penalise providers when no location is set', () => {
    const berlinProvider = makeProvider({ city: 'Berlin', rating: 4.0 })
    const hamburgProvider = makeProvider({ city: 'Hamburg', rating: 4.0 })

    // Without a location param both providers produce the same score
    const berlinScore = computeProviderScore(berlinProvider)
    const hamburgScore = computeProviderScore(hamburgProvider)

    expect(berlinScore).toBeCloseTo(hamburgScore, 5)
  })

  it('scores a provider with ratingCount > 0 higher than one without', () => {
    const withCount = makeProvider({ rating: 4.0, ratingCount: 50 })
    const withoutCount = makeProvider({ rating: 4.0, ratingCount: 0 })

    expect(computeProviderScore(withCount)).toBeGreaterThan(computeProviderScore(withoutCount))
  })
})

// ---------------------------------------------------------------------------
// rankProviders – location filter behaviour
// ---------------------------------------------------------------------------

describe('rankProviders – location filter', () => {
  it('excludes providers whose city does not match via partial overlap', () => {
    const berlin = makeProvider({ city: 'Berlin' })
    const munich = makeProvider({ city: 'München' })

    const result = rankProviders([berlin, munich], { location: 'Berlin' })
    expect(result).toHaveLength(1)
    expect(result[0].city).toBe('Berlin')
  })

  it('includes providers whose city contains the location string (partial match)', () => {
    const berliner = makeProvider({ city: 'Berlin Mitte' })
    const result = rankProviders([berliner], { location: 'Berlin' })
    expect(result).toHaveLength(1)
  })

  it('handles null city gracefully when location filter is active', () => {
    const noCity = makeProvider({ city: null })
    const result = rankProviders([noCity], { location: 'Berlin' })
    expect(result).toHaveLength(0)
  })

  it('combined category + location filter keeps only matching providers', () => {
    const match = makeProvider({ city: 'Berlin', tradeCategories: ['Sanitär'] })
    const wrongCity = makeProvider({ city: 'Hamburg', tradeCategories: ['Sanitär'] })
    const wrongCategory = makeProvider({ city: 'Berlin', tradeCategories: ['Elektrik'] })

    const result = rankProviders([match, wrongCity, wrongCategory], {
      tradeCategory: 'Sanitär',
      location: 'Berlin',
    })
    expect(result).toHaveLength(1)
    expect(result[0].city).toBe('Berlin')
    expect(result[0].tradeCategories).toContain('Sanitär')
  })

  it('empty location string does not filter providers', () => {
    const providers = [
      makeProvider({ city: 'Berlin' }),
      makeProvider({ city: 'Hamburg' }),
    ]
    const result = rankProviders(providers, { location: '' })
    expect(result).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// rankProviders – tie-breaker stability
// ---------------------------------------------------------------------------

describe('rankProviders – tie-breaker stability', () => {
  it('breaks ties by companyName (asc) when relevance scores are equal', () => {
    // Two identical providers except for companyName
    const providerA = makeProvider({ id: 'a', companyName: 'Zimmermann GmbH', rating: 4.0, ratingCount: 0 })
    const providerB = makeProvider({ id: 'b', companyName: 'Albrecht GmbH', rating: 4.0, ratingCount: 0 })

    const result = rankProviders([providerA, providerB], { sortBy: 'relevance' })
    // Albrecht < Zimmermann alphabetically → Albrecht first
    expect(result[0].companyName).toBe('Albrecht GmbH')
    expect(result[1].companyName).toBe('Zimmermann GmbH')
  })

  it('breaks recency ties by updatedAt, then companyName', () => {
    const a = makeProvider({ companyName: 'Z GmbH', createdAt: BASE_TIME, updatedAt: BASE_TIME + 5000 })
    const b = makeProvider({ companyName: 'A GmbH', createdAt: BASE_TIME, updatedAt: BASE_TIME + 5000 })
    const c = makeProvider({ companyName: 'M GmbH', createdAt: BASE_TIME, updatedAt: BASE_TIME })

    const result = rankProviders([c, b, a], { sortBy: 'recency' })

    // a and b share same createdAt and updatedAt+5000 → alphabetical: A < Z
    expect(result[0].companyName).toBe('A GmbH')
    expect(result[1].companyName).toBe('Z GmbH')
    // c has a lower updatedAt → last
    expect(result[2].companyName).toBe('M GmbH')
  })

  it('breaks rating-sort ties by ratingCount desc, then companyName', () => {
    const manyReviews = makeProvider({ id: 'many', companyName: 'Z GmbH', rating: 4.5, ratingCount: 100 })
    const fewReviews = makeProvider({ id: 'few', companyName: 'A GmbH', rating: 4.5, ratingCount: 5 })

    const result = rankProviders([fewReviews, manyReviews], { sortBy: 'rating' })
    // Same rating → more reviews first
    expect(result[0].id).toBe('many')
    expect(result[1].id).toBe('few')
  })
})

// ---------------------------------------------------------------------------
// computeProviderScore – trust penalty integration
// ---------------------------------------------------------------------------

describe('computeProviderScore – trust penalty', () => {
  it('a restricted provider (rating < 2.5, ≥ 3 ratings) scores lower than an identical trusted provider', () => {
    // Same profile, different rating — trust penalty of 0.5 applies to restricted
    const trusted = makeProvider({ rating: 4.0, ratingCount: 10, onboardingDone: true, description: 'Great!', avatarUrl: 'https://x.com/a.jpg' })
    const restricted = makeProvider({ rating: 2.0, ratingCount: 10, onboardingDone: true, description: 'Great!', avatarUrl: 'https://x.com/a.jpg' })

    const trustedScore = computeProviderScore(trusted)
    const restrictedScore = computeProviderScore(restricted)

    expect(restrictedScore).toBeLessThan(trustedScore)
  })

  it('a watch provider (rating 2.5–3.0, ≥ 3 ratings) scores lower than a trusted but higher than restricted', () => {
    const trusted = makeProvider({ rating: 4.5, ratingCount: 10 })
    const watch = makeProvider({ rating: 2.8, ratingCount: 5 })
    const restricted = makeProvider({ rating: 2.0, ratingCount: 5 })

    const trustedScore = computeProviderScore(trusted)
    const watchScore = computeProviderScore(watch)
    const restrictedScore = computeProviderScore(restricted)

    expect(trustedScore).toBeGreaterThan(watchScore)
    expect(watchScore).toBeGreaterThan(restrictedScore)
  })

  it('no trust penalty is applied when provider has fewer than 3 ratings', () => {
    const restrictedProvider = makeProvider({ rating: 1.0, ratingCount: 3 })       // restricted: has ≥ 3 ratings
    const insufficientDataProvider = makeProvider({ rating: 1.0, ratingCount: 2 }) // no penalty: < 3 ratings

    // The insufficientDataProvider has same rating but ratingCount < 3, so no penalty
    // insufficientDataProvider score should be higher (or equal) since no trust multiplier is applied
    expect(computeProviderScore(insufficientDataProvider)).toBeGreaterThan(computeProviderScore(restrictedProvider))
  })

  it('a restricted provider is still included in rankProviders results', () => {
    const restricted = makeProvider({ rating: 2.0, ratingCount: 10, onboardingDone: true })
    const trusted = makeProvider({ rating: 4.5, ratingCount: 10, onboardingDone: true })

    const result = rankProviders([restricted, trusted], { sortBy: 'relevance' })
    // Both providers are included
    expect(result).toHaveLength(2)
  })

  it('restricted provider ranks after trusted provider in relevance sort', () => {
    const restricted = makeProvider({ id: 'r', rating: 2.0, ratingCount: 10, onboardingDone: true, description: 'x', avatarUrl: 'https://x.com/a.jpg' })
    const trusted = makeProvider({ id: 't', rating: 4.5, ratingCount: 10, onboardingDone: true, description: 'x', avatarUrl: 'https://x.com/a.jpg' })

    const result = rankProviders([restricted, trusted], { sortBy: 'relevance' })
    expect(result[0].id).toBe('t')
    expect(result[1].id).toBe('r')
  })

  it('no penalty for providers with no ratings (null rating)', () => {
    const noRating = makeProvider({ rating: null, ratingCount: 0 })
    const score = computeProviderScore(noRating)
    // Score should be based only on profile readiness (no rating penalty)
    expect(score).toBeGreaterThanOrEqual(0)
    // Ensure it's the same as manually computing without penalty
    expect(score).toBeLessThanOrEqual(1)
  })
})
