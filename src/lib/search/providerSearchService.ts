/**
 * Search domain – provider search service.
 *
 * Fetches DiscoveryProviders from Supabase and applies the ranking selectors
 * defined in `selectors.ts`.  Emits structured observability events for every
 * meaningful state transition.
 */

import { fetchDiscoveryProviders } from '../discovery'
import { logInfo, logError } from '../observability'
import type { DiscoveryProvider } from '../discovery/discoveryTypes'
import { rankProviders } from './selectors'
import type { ProviderSearchParams } from './types'

/**
 * Searches for providers matching the given params.
 *
 * Steps:
 *  1. Emit `search.started` event.
 *  2. Fetch all discovery-visible providers from Supabase.
 *  3. Apply `rankProviders` to filter and sort.
 *  4. Emit `search.completed`, `search.empty_result`, or
 *     `search.filters_applied` as appropriate.
 *
 * Returns an empty array on error so callers always receive a valid list.
 */
export async function searchProviders(
  params: ProviderSearchParams
): Promise<DiscoveryProvider[]> {
  const hasFilters =
    Boolean(params.query?.trim()) ||
    Boolean(params.tradeCategory?.trim()) ||
    Boolean(params.location?.trim()) ||
    (params.minimumRating !== undefined && params.minimumRating > 0)

  logInfo('search.started', {
    query: params.query ?? null,
    tradeCategory: params.tradeCategory ?? null,
    location: params.location ?? null,
    minimumRating: params.minimumRating ?? null,
    sortBy: params.sortBy ?? 'relevance',
  })

  let allProviders: DiscoveryProvider[]

  try {
    allProviders = await fetchDiscoveryProviders()
  } catch (err) {
    logError('search.fetch_failed', err, { params: params as Record<string, unknown> })
    return []
  }

  if (hasFilters) {
    logInfo('search.filters_applied', {
      totalProviders: allProviders.length,
      filters: {
        query: params.query ?? null,
        tradeCategory: params.tradeCategory ?? null,
        location: params.location ?? null,
        minimumRating: params.minimumRating ?? null,
      },
    })
  }

  const results = rankProviders(allProviders, params)

  if (results.length === 0) {
    logInfo('search.empty_result', {
      query: params.query ?? null,
      tradeCategory: params.tradeCategory ?? null,
      location: params.location ?? null,
      totalProviders: allProviders.length,
    })
  } else {
    logInfo('search.completed', {
      resultCount: results.length,
      totalProviders: allProviders.length,
      sortBy: params.sortBy ?? 'relevance',
      location: params.location ?? null,
      minimumRating: params.minimumRating ?? null,
      tradeCategory: params.tradeCategory ?? null,
    })
  }

  return results
}
