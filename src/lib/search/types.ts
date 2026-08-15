/**
 * Search domain – parameter types for provider matching.
 *
 * These types are intentionally thin: they carry user-supplied filter/sort
 * intent and nothing else.  All scoring and ranking logic lives in selectors.ts.
 */

import type { ViewerContext } from '../explore/exploreRanking'

/**
 * How the result list should be ordered.
 *
 * - `'rating'`    – highest-rated providers first.
 * - `'relevance'` – query-match quality combined with profile completeness.
 * - `'recency'`   – most recently created/updated profiles first.
 */
export type SortBy = 'rating' | 'relevance' | 'recency'

/**
 * Parameters that drive a provider search request.
 *
 * All fields are optional so callers can freely omit irrelevant constraints.
 */
export type ProviderSearchParams = {
  /** Free-text query matched against company name, display name, description,
   *  trade categories, and city. */
  query?: string

  /** Filter to providers who offer this trade category (case-insensitive). */
  tradeCategory?: string

  /** City or region text to match against the provider's stored city value. */
  location?: string

  /** Only include providers whose stored rating is ≥ this value. */
  minimumRating?: number

  /** Result ordering strategy. Defaults to `'relevance'` when not provided. */
  sortBy?: SortBy
}

// ---------------------------------------------------------------------------
// Unified trade-aware search engine (additive — L1 pure-logic core)
//
// These types back the generic ranking engine (taxonomy → signals → profiles →
// engine). They are additive: the legacy `ProviderSearchParams` / `SortBy`
// path above is untouched.
// ---------------------------------------------------------------------------

/**
 * Scoring profile — switches the per-signal weighting.
 *
 *   - `'forYou'`      — proximity > taxonomy/text > social.
 *   - `'inspiration'` — social > taxonomy/text > proximity.
 *   - `'providers'`   — balanced (proximity + trust matter).
 */
export type SearchProfile = 'forYou' | 'inspiration' | 'providers'

/** The individual ranking signals, each normalised to [0, 1]. */
export type SearchSignalKey = 'text' | 'trade' | 'proximity' | 'social' | 'freshness' | 'trust'

/** A full set of per-signal weights for one profile. Weights sum to 1.0. */
export type SearchProfileWeights = Record<SearchSignalKey, number>

/**
 * Common normalised candidate shape. Both `DiscoveryProvider` and
 * `ExploreProviderCard` (and `ExploreReel`) adapt into this single shape so the
 * scoring model is unified across every search surface.
 *
 * Adapters live in `signals.ts` (`fromDiscoveryProvider`,
 * `fromExploreProviderCard`, `fromExploreReel`). Missing fields coalesce to
 * neutral defaults so a thin candidate never breaks scoring.
 */
export type SearchCandidate = {
  /** Stable identity for this candidate (providers.id / craftsmanId / reel id). */
  id: string
  /** Display name (companyName ?? displayName ?? craftsmanName). */
  name: string
  /** Long-form text (description ?? bio). */
  description: string
  /** Free-text location (city / location). */
  location: string
  /** Canonical trade labels — drive trade + social tag matching. */
  tradeCategories: string[]
  /** Offered services — secondary text/trade match source ([] when unknown). */
  services: string[]
  /** Average rating 0–5, or null when unknown. */
  rating: number | null
  /** Number of ratings backing `rating`. */
  ratingCount: number
  /** Verification flag. */
  verified: boolean
  /** Aggregate like count (popularity prior; 0 for provider-derived candidates). */
  likes: number
  /** Aggregate save count (popularity prior; 0 for provider-derived candidates). */
  saves: number
  /** Provider/craftsman user id (identity + trust). */
  providerUserId: string
  /** Creation epoch ms (freshness); 0/undefined → freshness treated as neutral. */
  createdAt: number
}

/**
 * Context for a ranking pass. Pure: the freshness clock (`nowMs`) is injected
 * here, never read from `Date.now()` inside the ranking core. The boundary
 * (`engine.rankSearch`) fills `nowMs` with `Date.now()` by default.
 */
export type RankContext = {
  /** Personalisation context from `buildViewerContext`; null for anon (skips social). */
  viewer?: ViewerContext | null
  /** Optional user location for the proximity signal (never a filter). */
  userLocation?: string
  /** Freshness clock (epoch ms). When omitted, freshness degrades to neutral. */
  nowMs?: number
}

/**
 * One ranked result. `breakdown` exposes the per-signal [0,1] contributions;
 * `matchReasons` are human-readable German badges (overlay may ignore them,
 * the screen renders them); `matchedSignals` are debug keys.
 */
export type ScoredResult<T> = {
  candidate: T
  /** Final composite score in [0, 1] (weighted signals × trust dampener). */
  score: number
  breakdown: Record<SearchSignalKey, number>
  matchReasons: { label: string }[]
  matchedSignals: string[]
}
