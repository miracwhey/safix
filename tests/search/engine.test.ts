/**
 * Search domain – unified ranking engine specs (additive, L1).
 *
 * Covers the profile-driven ranking (`rankDiscoveryProviders`, `rankReels`),
 * the profile weight tables (`PROFILE_WEIGHTS`) and the legacy filter path
 * (`rankProviders`). Pure + deterministic: the freshness clock is pinned via
 * `nowMs` so every assertion is reproducible.
 *
 * Hard invariant under test: proximity/location is a SIGNAL, never a filter — a
 * candidate with an unknown location is kept and treated as neutral (0.5), so it
 * is never excluded and never pushed below a known-but-far candidate.
 */

import { describe, it, expect } from 'vitest'
import { rankDiscoveryProviders, rankReels } from '../../src/lib/search/engine'
import { PROFILE_WEIGHTS } from '../../src/lib/search/profiles'
import { rankProviders } from '../../src/lib/search/selectors'
import type { ScoredResult } from '../../src/lib/search/types'
import type { DiscoveryProvider } from '../../src/lib/discovery/discoveryTypes'
import type { ExploreReel } from '../../src/lib/explore/exploreTypes'
import type { ViewerContext } from '../../src/lib/explore/exploreRanking'

// Pinned clock + creation timestamp so freshness is identical + deterministic.
const NOW = 1_700_000_500_000
const CREATED = 1_700_000_000_000

function makeProvider(overrides: Partial<DiscoveryProvider> = {}): DiscoveryProvider {
  return {
    id: 'provider-1',
    profileId: 'profile-1',
    companyName: 'Muster GmbH',
    displayName: 'Max Muster',
    description: 'Ihr zuverlässiger Handwerker.',
    city: 'Hannover',
    tradeCategories: ['Sanitär'],
    avatarUrl: null,
    rating: 4.5,
    ratingCount: 10,
    verified: true,
    isPublic: true,
    onboardingDone: true,
    craftsmanRole: 'craftsman',
    isOperator: false,
    handle: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  }
}

function makeReel(overrides: Partial<ExploreReel> = {}): ExploreReel {
  return {
    id: 'reel-1',
    craftsmanId: 'craftsman-1',
    craftsmanName: 'Max Muster',
    craftsmanHandle: '@max',
    craftsmanAvatarUrl: '',
    title: 'Projekt',
    category: 'Maler',
    location: 'Hannover',
    thumbnailUrl: '',
    likes: 0,
    saves: 0,
    likeCount: 0,
    isLikedByCurrentUser: false,
    projectTags: ['Maler'],
    searchTags: [],
    costLabel: '',
    durationLabel: '',
    createdAt: CREATED,
    ratingCount: 5,
    ...overrides,
  }
}

function scoreById<T extends { id: string }>(results: ScoredResult<T>[]): Map<string, number> {
  return new Map(results.map((r) => [r.candidate.id, r.score]))
}

describe('PROFILE_WEIGHTS — profile orderings', () => {
  it('forYou: weights sum to 1 and proximity is the strict maximum', () => {
    const w = PROFILE_WEIGHTS.forYou
    const sum = Object.values(w).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 10)
    const others = [w.trade, w.text, w.social, w.trust, w.freshness]
    expect(others.every((x) => w.proximity > x)).toBe(true)
  })

  it('inspiration: weights sum to 1 and social is the strict maximum', () => {
    const w = PROFILE_WEIGHTS.inspiration
    const sum = Object.values(w).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 10)
    const others = [w.trade, w.text, w.proximity, w.trust, w.freshness]
    expect(others.every((x) => w.social > x)).toBe(true)
  })

  it('providers: weights sum to 1 and proximity+trust+text+trade are a balanced top tier', () => {
    const w = PROFILE_WEIGHTS.providers
    const sum = Object.values(w).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 10)
    expect(w.proximity).toBe(w.trust)
    expect(w.text).toBe(w.trust)
    expect(w.trade).toBe(w.trust)
    expect(w.trust).toBeGreaterThan(w.social)
    expect(w.trust).toBeGreaterThan(w.freshness)
  })
})

describe('forYou profile — proximity dominates', () => {
  it('ranks a nearer candidate above a far one when all other signals are equal', () => {
    const near = makeProvider({ id: 'near', city: 'Hannover' })
    const far = makeProvider({ id: 'far', city: 'München' })

    const results = rankDiscoveryProviders([far, near], {
      profile: 'forYou',
      query: '',
      userLocation: 'Hannover',
      nowMs: NOW,
    })

    expect(results).toHaveLength(2)
    expect(results[0].candidate.id).toBe('near')
    expect(results[1].candidate.id).toBe('far')
    expect(results[0].score).toBeGreaterThan(results[1].score)
  })
})

describe('inspiration profile — social dominates', () => {
  it('ranks a higher-social candidate above a low-social one', () => {
    const viewer: ViewerContext = {
      userId: 'u1',
      likedTags: new Set(['Maler']),
      savedTags: new Set(['Maler']),
      recentJobTags: new Set(['Maler']),
      adjacentTags: new Set<string>(),
    }
    const social = makeReel({ id: 'social', projectTags: ['Maler'] })
    const cold = makeReel({ id: 'cold', projectTags: ['Elektrik'] })

    const results = rankReels([cold, social], {
      profile: 'inspiration',
      query: '',
      viewer,
      nowMs: NOW,
    })

    expect(results).toHaveLength(2)
    expect(results[0].candidate.id).toBe('social')
    expect(results[1].candidate.id).toBe('cold')
    expect(results[0].score).toBeGreaterThan(results[1].score)
  })
})

describe('providers profile — balanced (proximity + trust both top tier)', () => {
  it('shrinks proximity dominance: the near-vs-far score gap is smaller than under forYou', () => {
    // near = same city (high proximity) but lower trust; far = other city (low
    // proximity) but higher trust. All other signals are equal, so the gap is
    // driven only by proximity (favours near) and trust (favours far). Because
    // providers downweights proximity (0.34→0.18) and upweights trust
    // (0.12→0.18), the near-over-far gap must shrink relative to forYou.
    const near = makeProvider({
      id: 'near',
      city: 'Hannover',
      rating: 4.0,
      ratingCount: 4,
      verified: false,
    })
    const far = makeProvider({
      id: 'far',
      city: 'München',
      rating: 5.0,
      ratingCount: 100,
      verified: true,
    })

    const opts = { query: '', userLocation: 'Hannover', nowMs: NOW } as const

    const forYou = scoreById(rankDiscoveryProviders([far, near], { ...opts, profile: 'forYou' }))
    const providers = scoreById(rankDiscoveryProviders([far, near], { ...opts, profile: 'providers' }))

    const gapForYou = forYou.get('near')! - forYou.get('far')!
    const gapProviders = providers.get('near')! - providers.get('far')!

    expect(gapForYou).toBeGreaterThan(gapProviders)
    expect(gapProviders).toBeGreaterThan(0)
  })

  it('with proximity equal, the higher-trust provider ranks first', () => {
    const high = makeProvider({ id: 'high', rating: 5.0, ratingCount: 50, verified: true })
    const low = makeProvider({ id: 'low', rating: 4.0, ratingCount: 5, verified: false })

    const results = rankDiscoveryProviders([low, high], {
      profile: 'providers',
      query: '',
      userLocation: 'Hannover',
      nowMs: NOW,
    })

    expect(results[0].candidate.id).toBe('high')
    expect(results[1].candidate.id).toBe('low')
  })
})

describe('proximity is a signal, never a filter (critical invariant)', () => {
  it('keeps an unknown-location candidate and never pushes it below a known-far one', () => {
    const near = makeProvider({ id: 'near', city: 'Hannover' })
    const unknown = makeProvider({ id: 'unknown', city: '' }) // location unknown
    const far = makeProvider({ id: 'far', city: 'München' })

    const results = rankDiscoveryProviders([far, unknown, near], {
      profile: 'forYou', // proximity-heaviest profile = strongest test
      query: '',
      userLocation: 'Hannover',
      nowMs: NOW,
    })

    // (a) NOT excluded — all three survive.
    expect(results).toHaveLength(3)
    expect(results.map((r) => r.candidate.id)).toContain('unknown')

    const byId = scoreById(results)

    // (b) unknown location scores the NEUTRAL 0.5 proximity signal …
    const unknownResult = results.find((r) => r.candidate.id === 'unknown')!
    expect(unknownResult.breakdown.proximity).toBe(0.5)

    // … so it lands between the near (1.0) and the known-but-far (0.2) candidate
    // and is NEVER the absolute bottom by proximity alone.
    expect(byId.get('near')!).toBeGreaterThan(byId.get('unknown')!)
    expect(byId.get('unknown')!).toBeGreaterThan(byId.get('far')!)
    expect(results[results.length - 1].candidate.id).toBe('far')
  })
})

describe('legacy minimumRating filter (selectors.rankProviders) still works', () => {
  it('excludes providers below the minimum rating and those with a null rating', () => {
    const good = makeProvider({ id: 'good', rating: 4.8 })
    const weak = makeProvider({ id: 'weak', rating: 2.0 })
    const unrated = makeProvider({ id: 'unrated', rating: null })

    const filtered = rankProviders([good, weak, unrated], { minimumRating: 4.0 })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].id).toBe('good')

    // No filter → the full set is returned.
    const all = rankProviders([good, weak, unrated], {})
    expect(all).toHaveLength(3)
  })
})

describe('matchReasons are populated', () => {
  it('emits German trade / proximity / trust / verified reasons for a strong match', () => {
    const provider = makeProvider({
      id: 'p1',
      city: 'Hannover',
      tradeCategories: ['Sanitär'],
      rating: 4.8,
      ratingCount: 12,
      verified: true,
    })

    const results = rankDiscoveryProviders([provider], {
      profile: 'providers',
      query: 'Klempner', // resolves to Sanitär
      userLocation: 'Hannover',
      nowMs: NOW,
    })

    const { matchReasons, matchedSignals } = results[0]
    expect(matchReasons.length).toBeGreaterThan(0)
    expect(matchReasons.some((r) => r.label === 'Gewerk: Sanitär')).toBe(true)
    expect(matchedSignals).toContain('trade_match')
    expect(matchedSignals).toContain('proximity_city')
    expect(matchedSignals).toContain('trust_rating')
    expect(matchedSignals).toContain('verified')
  })
})

describe('candidate-side trade canonicalisation (label drift)', () => {
  it('gives a drifted "Schreinerei" candidate a direct trade boost + Gewerk reason when the query resolves to Schreiner', () => {
    const provider = makeProvider({
      id: 'schreiner',
      city: 'Hannover',
      tradeCategories: ['Schreinerei'], // stored label drifts from canonical "Schreiner"
    })

    const results = rankDiscoveryProviders([provider], {
      profile: 'providers',
      query: 'Tischler', // resolves to Schreiner
      userLocation: 'Hannover',
      nowMs: NOW,
    })

    // Direct (1.0) trade boost, not the neutral 0.5, despite the drifted label.
    expect(results[0].breakdown.trade).toBe(1)
    expect(results[0].matchReasons.some((r) => r.label === 'Gewerk: Schreiner')).toBe(true)
    expect(results[0].matchedSignals).toContain('trade_match')
  })
})

describe('score bounds — every score and breakdown value stays in [0,1]', () => {
  it('holds across all three profiles and a mixed candidate list', () => {
    const candidates = [
      makeProvider({ id: 'a', city: 'Hannover', rating: 5.0, ratingCount: 100, verified: true }),
      makeProvider({ id: 'b', city: '', rating: null, ratingCount: 0, verified: false }),
      makeProvider({ id: 'c', city: 'München', rating: 2.0, ratingCount: 5, verified: false }),
    ]

    for (const profile of ['forYou', 'inspiration', 'providers'] as const) {
      const results = rankDiscoveryProviders(candidates, {
        profile,
        query: 'Klempner',
        userLocation: 'Hannover',
        nowMs: NOW,
      })
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0)
        expect(r.score).toBeLessThanOrEqual(1)
        for (const v of Object.values(r.breakdown)) {
          expect(v).toBeGreaterThanOrEqual(0)
          expect(v).toBeLessThanOrEqual(1)
        }
      }
    }
  })
})
