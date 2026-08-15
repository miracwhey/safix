/**
 * Search domain – provider scoring and ranking selectors.
 *
 * All functions are pure: they take plain data and return plain data without
 * touching any global state or making network calls.
 */

import type { DiscoveryProvider } from '../discovery/discoveryTypes'
import type { ProviderSearchParams } from './types'
import { deriveTrustScorePenalty } from '../trust/trustSelectors'

// ---------------------------------------------------------------------------
// Internal scoring helpers
// ---------------------------------------------------------------------------

/**
 * Normalises a provider rating (0–5) into a 0–1 signal.
 * A null rating yields 0.
 */
function ratingSignal(rating: number | null): number {
  if (rating === null || rating <= 0) return 0
  return Math.min(rating / 5, 1)
}

/**
 * Computes a count-credibility signal on a logarithmic scale.
 *
 * Uses log base-100 so that 1 review → ~0.0, 10 reviews → ~0.5,
 * 100 reviews → 1.0.  Capped at 1.
 */
function ratingCountSignal(count: number): number {
  if (count <= 0) return 0
  return Math.min(Math.log(count + 1) / Math.log(100), 1)
}

/**
 * Derives a 0–1 profile-readiness score from the provider's onboarding state.
 *
 * Each completed facet adds a proportional share:
 *   - onboardingDone   (+0.4)
 *   - has description  (+0.3)
 *   - has avatar       (+0.2)
 *   - has ≥1 trade     (+0.1)
 */
function profileReadinessSignal(provider: DiscoveryProvider): number {
  let score = 0
  if (provider.onboardingDone) score += 0.4
  if (provider.description && provider.description.trim().length > 0) score += 0.3
  if (provider.avatarUrl) score += 0.2
  if (provider.tradeCategories.length > 0) score += 0.1
  return score
}

/**
 * Returns a simple 0–1 query-relevance score for a provider given a search
 * query string.  Returns 1 when no query is supplied.
 *
 * Matching is case-insensitive substring search across the main text fields.
 * Matching on company name or display name scores higher than description.
 */
function queryRelevanceSignal(provider: DiscoveryProvider, query?: string): number {
  if (!query || !query.trim()) return 1

  const needle = query.trim().toLowerCase()

  const companyName = (provider.companyName ?? '').toLowerCase()
  const displayName = (provider.displayName ?? '').toLowerCase()
  const description = (provider.description ?? '').toLowerCase()
  const city = (provider.city ?? '').toLowerCase()
  const categories = provider.tradeCategories.map((t) => t.toLowerCase()).join(' ')

  const handle = (provider.handle ?? '').toLowerCase().replace(/^@/, '')
  if (companyName.includes(needle) || displayName.includes(needle) || handle.includes(needle.replace(/^@/, ''))) return 1
  if (categories.includes(needle)) return 0.85
  if (city.includes(needle)) return 0.8
  if (description.includes(needle)) return 0.7

  return 0
}

/**
 * Returns a 0–1 location-proximity signal for a provider.
 *
 * When no `location` parameter is provided the signal is 0 (neutral –
 * location does not contribute to the score).  When a location is set:
 *
 *   - Exact city match or one value contains the other   → 1.0
 *   - Shared regional token (min length 3, e.g. "Berlin") → 0.5
 *   - No overlap                                          → 0.0
 *
 * The signal is deliberately soft: it boosts matching providers within the
 * result set but does not hard-exclude non-matching ones.  Hard exclusion
 * is handled by the `location` filter in `rankProviders`.
 */
export function locationSignal(provider: DiscoveryProvider, location?: string): number {
  if (!location || !location.trim()) return 0

  const needle = location.trim().toLowerCase()
  const provCity = (provider.city ?? '').toLowerCase().trim()

  if (!provCity) return 0

  // Exact / substring match (city contains location or vice-versa)
  if (provCity === needle || provCity.includes(needle) || needle.includes(provCity)) {
    return 1
  }

  // Shared regional token (split on whitespace, commas, hyphens; min 3 chars)
  const needleTokens = needle.split(/[\s,\-/]+/).filter((t) => t.length >= 3)
  const cityTokens = provCity.split(/[\s,\-/]+/).filter((t) => t.length >= 3)
  const hasSharedToken = needleTokens.some((t) => cityTokens.includes(t))
  if (hasSharedToken) return 0.5

  return 0
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Computes a composite ranking score for a single provider.
 *
 * Weights:
 *   - 35 % rating quality          (stored average rating 0–5)
 *   - 15 % rating count credibility (log-scaled review volume)
 *   - 20 % profile readiness        (onboarding completeness)
 *   - 15 % query relevance          (text match across name / categories / city)
 *   - 15 % location proximity       (city / region match; 0 when no location set)
 *
 * The base score is then multiplied by a trust penalty derived from the
 * provider's reputation signals:
 *   - 1.0  trusted  (no penalty)
 *   - 0.8  watch    (slight down-rank for below-average ratings)
 *   - 0.5  restricted (significant down-rank for critically low ratings)
 *
 * This ensures low-trust providers appear later in results without being
 * completely hidden from discovery.
 *
 * Returns a value in [0, 1].
 *
 * Pure function — no side effects.
 */
export function computeProviderScore(
  provider: DiscoveryProvider,
  params?: ProviderSearchParams
): number {
  const rating = ratingSignal(provider.rating)
  const count = ratingCountSignal(provider.ratingCount)
  const readiness = profileReadinessSignal(provider)
  const relevance = queryRelevanceSignal(provider, params?.query)
  const location = locationSignal(provider, params?.location)

  const baseScore = rating * 0.35 + count * 0.15 + readiness * 0.20 + relevance * 0.15 + location * 0.15
  const trustPenalty = deriveTrustScorePenalty(provider)
  return baseScore * trustPenalty
}

/**
 * Filters and ranks a list of DiscoveryProviders according to the given search
 * parameters.
 *
 * Filtering rules:
 *   - `tradeCategory` – case-insensitive inclusion check against
 *     `provider.tradeCategories`.
 *   - `minimumRating` – only providers whose stored `rating` is ≥ the minimum
 *     are kept. Providers with a null rating are excluded.
 *   - `location`      – case-insensitive substring match against `provider.city`.
 *     Providers with no city value are excluded when this filter is active.
 *   - `query`         – a provider is included only when `queryRelevanceSignal`
 *     returns > 0 (i.e. at least one field matches).
 *
 * Sorting rules (applied after filtering):
 *   - `'rating'`    – primary: raw rating desc (null last); secondary: composite
 *     score desc; tertiary: ratingCount desc; quaternary: companyName asc.
 *   - `'recency'`   – primary: createdAt desc; secondary: updatedAt desc;
 *     tertiary: companyName asc.
 *   - `'relevance'` – primary: composite score desc; secondary: rating desc
 *     (null last); tertiary: ratingCount desc; quaternary: companyName asc.
 *
 * All sort orders are deterministic (stable tie-breaking via companyName).
 *
 * Pure function — no side effects.
 */
export function rankProviders(
  providers: DiscoveryProvider[],
  params: ProviderSearchParams
): DiscoveryProvider[] {
  const { tradeCategory, minimumRating, location, query, sortBy = 'relevance' } = params

  // ---- Filter ----------------------------------------------------------
  const filtered = providers.filter((p) => {
    // Trade category filter
    if (tradeCategory && tradeCategory.trim()) {
      const needle = tradeCategory.trim().toLowerCase()
      const matches = p.tradeCategories.some((t) => t.toLowerCase().includes(needle))
      if (!matches) return false
    }

    // Minimum rating filter
    if (minimumRating !== undefined && minimumRating > 0) {
      if (p.rating === null || p.rating < minimumRating) return false
    }

    // Location filter – hard exclusion when location is set
    if (location && location.trim()) {
      const needle = location.trim().toLowerCase()
      const provCity = (p.city ?? '').toLowerCase()
      // A provider with no city is excluded when a location filter is active
      if (!provCity) return false
      if (!provCity.includes(needle) && !needle.includes(provCity) && provCity !== needle) {
        return false
      }
    }

    // Query filter – exclude providers with zero relevance
    if (query && query.trim()) {
      if (queryRelevanceSignal(p, query) === 0) return false
    }

    return true
  })

  // ---- Sort ------------------------------------------------------------
  const sorted = filtered.slice()

  if (sortBy === 'recency') {
    sorted.sort((a, b) => {
      if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
      return (a.companyName ?? '').localeCompare(b.companyName ?? '')
    })
  } else if (sortBy === 'rating') {
    sorted.sort((a, b) => {
      // Providers without a rating sort to the bottom
      const ra = a.rating ?? -1
      const rb = b.rating ?? -1
      if (rb !== ra) return rb - ra
      const scoreDiff = computeProviderScore(b, params) - computeProviderScore(a, params)
      if (scoreDiff !== 0) return scoreDiff
      if (b.ratingCount !== a.ratingCount) return b.ratingCount - a.ratingCount
      return (a.companyName ?? '').localeCompare(b.companyName ?? '')
    })
  } else {
    // 'relevance' (default)
    sorted.sort((a, b) => {
      const scoreDiff = computeProviderScore(b, params) - computeProviderScore(a, params)
      if (scoreDiff !== 0) return scoreDiff
      const ra = a.rating ?? -1
      const rb = b.rating ?? -1
      if (rb !== ra) return rb - ra
      if (b.ratingCount !== a.ratingCount) return b.ratingCount - a.ratingCount
      return (a.companyName ?? '').localeCompare(b.companyName ?? '')
    })
  }

  return sorted
}
