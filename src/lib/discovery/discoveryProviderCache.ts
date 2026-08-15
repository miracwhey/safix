import type { ExploreProviderCard } from '../explore/exploreTypes'

/**
 * Module-level in-memory cache for the loaded set of real Discovery provider
 * cards. Populated by any Discovery screen that calls getExploreProviderCards()
 * (ExploreFeed, SearchScreen) so that synchronous workflow functions can access
 * real providers without making an async call at inquiry time.
 *
 * The cache is intentionally process-scoped (not persisted) and is refreshed
 * whenever a Discovery surface loads. Discovery workflows that read from the
 * cache should return null when it is empty rather than falling back to mock
 * data.
 */
let _cachedProviderCards: ExploreProviderCard[] = []

/**
 * Stores the current set of Discovery-visible provider cards.
 * Called by Discovery screens immediately after `getExploreProviderCards()`
 * resolves so that the cache is warm before the user triggers any inquiry.
 */
export function setDiscoveryProviderCache(cards: ExploreProviderCard[]): void {
  _cachedProviderCards = cards
}

/**
 * Returns the cached Discovery provider cards.
 */
export function getDiscoveryProviderCache(): ExploreProviderCard[] {
  return _cachedProviderCards
}

/**
 * Liefert den Count der zuletzt geladenen Discovery-Provider.
 * Wird vom Home-Schnellstart konsumiert, um die Anzahl verfügbarer Betriebe
 * im NavigationCard-Subtitle anzuzeigen, ohne einen weiteren Roundtrip.
 */
export function getCachedProviderCount(): number {
  return _cachedProviderCards.length
}

/**
 * Clears the Discovery provider cache.
 *
 * Useful when the app knows the provider data may have changed (e.g. after a
 * provider updates their profile). Discovery screens will repopulate the cache
 * on their next mount via setDiscoveryProviderCache().
 */
export function clearDiscoveryProviderCache(): void {
  _cachedProviderCards = []
}

/**
 * Finds the best provider for the given category from the cache.
 *
 * Matching priority:
 * 1. Exact trade-category match (case-insensitive)
 * 2. Partial trade-category match (one is a substring of the other)
 * 3. First provider in the cache (general fallback)
 * 4. null when the cache is empty
 */
export function findCachedProviderByCategory(
  category: string
): ExploreProviderCard | null {
  if (_cachedProviderCards.length === 0) return null

  const norm = (s: string) => s.trim().toLowerCase()
  const catNorm = norm(category)

  // Exact match first
  const exact = _cachedProviderCards.find((p) =>
    p.tradeCategories.some((t) => norm(t) === catNorm)
  )
  if (exact) return exact

  // Partial match
  const partial = _cachedProviderCards.find((p) =>
    p.tradeCategories.some(
      (t) => norm(t).includes(catNorm) || catNorm.includes(norm(t))
    )
  )
  if (partial) return partial

  // General fallback: first available provider
  return _cachedProviderCards[0]
}
