/**
 * Search domain – public barrel.
 *
 * Re-exports all types, selectors, and services from the search domain.
 */

export type { SortBy, ProviderSearchParams } from './types'
export { computeProviderScore, rankProviders, locationSignal } from './selectors'
export { searchProviders } from './providerSearchService'

// ── Unified trade-aware search engine (additive, L1 pure-logic core) ─────────
export type {
  SearchProfile,
  SearchSignalKey,
  SearchProfileWeights,
  SearchCandidate,
  RankContext,
  ScoredResult,
} from './types'
export { TRADES, normalizeTerm, resolveQuery, expandTrade } from './taxonomy'
export type { TradeDefinition, ResolvedQuery } from './taxonomy'
export {
  fromDiscoveryProvider,
  fromExploreProviderCard,
  fromExploreReel,
  textRelevance,
  tradeMatchSignal,
  proximitySignal,
  socialSignal,
  freshnessSignal,
  trustSignal,
  computeSearchSignals,
} from './signals'
export type { SignalInputs } from './signals'
export { PROFILE_WEIGHTS, rank } from './profiles'
export { rankSearch, rankDiscoveryProviders, rankProviderCards, rankReels } from './engine'
export type { RankSearchOptions, RankSearchInput } from './engine'
