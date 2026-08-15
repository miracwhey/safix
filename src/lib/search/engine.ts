/**
 * Search domain – unified trade-aware ranking engine (L1, top-level).
 *
 * Thin orchestration over `profiles.rank`: a single generic entry point plus
 * candidate-type-bound convenience wrappers so future wiring is trivial and
 * type-safe. Pure except for the `Date.now()` default injected at THIS
 * boundary (the ranking core itself reads the clock only from `ctx.nowMs`).
 *
 * This module is purely additive — it wires no consumer. The legacy
 * `selectors.rankProviders` / `providerSearchService.searchProviders` path is
 * untouched and continues to work unchanged.
 */

import type { DiscoveryProvider } from '../discovery/discoveryTypes'
import type { ExploreProviderCard, ExploreReel } from '../explore/exploreTypes'
import type { ViewerContext } from '../explore/exploreRanking'
import type { SearchCandidate, SearchProfile, ScoredResult } from './types'
import { rank } from './profiles'
import { fromDiscoveryProvider, fromExploreProviderCard, fromExploreReel } from './signals'

/** Options shared by every convenience wrapper. */
export type RankSearchOptions = {
  /** Free-text query. Empty/omitted = browse mode (trade/text degrade to neutral). */
  query?: string
  /** Scoring profile. Each wrapper supplies a sensible default. */
  profile?: SearchProfile
  /** User location for the proximity signal (never a filter). */
  userLocation?: string
  /** Personalisation context from `buildViewerContext`; null/omitted for anon. */
  viewer?: ViewerContext | null
  /** Freshness clock override (epoch ms). Defaults to `Date.now()`. */
  nowMs?: number
}

/** Generic ranking input: bring your own `project` adapter for type `T`. */
export type RankSearchInput<T> = RankSearchOptions & {
  candidates: T[]
  project: (candidate: T) => SearchCandidate
}

/**
 * Generic top-level ranking entry point. Delegates to `profiles.rank`, filling
 * the freshness clock with `Date.now()` here at the boundary.
 */
export function rankSearch<T>(input: RankSearchInput<T>): ScoredResult<T>[] {
  const { candidates, project, query = '', profile = 'providers', userLocation, viewer = null, nowMs } = input
  return rank(candidates, project, query, profile, {
    viewer,
    userLocation,
    nowMs: nowMs ?? Date.now(),
  })
}

/** Ranks Discovery providers. Defaults to the balanced `providers` profile. */
export function rankDiscoveryProviders(
  candidates: DiscoveryProvider[],
  options: RankSearchOptions = {},
): ScoredResult<DiscoveryProvider>[] {
  return rankSearch({ ...options, candidates, project: fromDiscoveryProvider, profile: options.profile ?? 'providers' })
}

/** Ranks Explore provider cards. Defaults to the `inspiration` profile. */
export function rankProviderCards(
  candidates: ExploreProviderCard[],
  options: RankSearchOptions = {},
): ScoredResult<ExploreProviderCard>[] {
  return rankSearch({ ...options, candidates, project: fromExploreProviderCard, profile: options.profile ?? 'inspiration' })
}

/** Reels-aware variant. Defaults to the `forYou` profile. */
export function rankReels(
  candidates: ExploreReel[],
  options: RankSearchOptions = {},
): ScoredResult<ExploreReel>[] {
  return rankSearch({ ...options, candidates, project: fromExploreReel, profile: options.profile ?? 'forYou' })
}
