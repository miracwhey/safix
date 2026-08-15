/**
 * Portfolio Stats Selectors — Block 2 (Customer-Discovery Profile-Detail)
 *
 * Aggregations across a provider's portfolio for the public profile header.
 * Reads are anon-safe (provider_media + provider_media_likes have public SELECT).
 */

import { supabase } from '../supabase'
import { logError } from '../observability'

/**
 * Total like count across all published portfolio items of a provider.
 *
 * Strategy: select all published portfolio media IDs of the provider, then
 * count rows in provider_media_likes that match. Two round-trips, no joins.
 *
 * Returns 0 on error (graceful degradation — number is shown as a stat tile).
 */
export async function aggregateLikesForProvider(providerDbId: string): Promise<number> {
  if (!providerDbId) return 0

  const { data: mediaRows, error: mediaErr } = await supabase
    .from('provider_media')
    .select('id')
    .eq('provider_id', providerDbId)
    .eq('kind', 'portfolio')
    .eq('published', true)

  if (mediaErr) {
    logError('portfolio_stats.media_lookup_failed', mediaErr, { providerDbId })
    return 0
  }

  const ids = (mediaRows ?? []).map((row) => (row as { id: string }).id)
  if (ids.length === 0) return 0

  const { count, error: likesErr } = await supabase
    .from('provider_media_likes')
    .select('id', { count: 'exact', head: true })
    .in('media_id', ids)

  if (likesErr) {
    logError('portfolio_stats.likes_count_failed', likesErr, { providerDbId })
    return 0
  }

  return count ?? 0
}

/**
 * Returns a per-media like-count map for the given media IDs.
 * Used by the Reels-Grid to render the Like-Counter on each tile without
 * issuing one query per tile (avoids the N+1 hot-spot called out in the
 * Block-2 risks).
 *
 * Returns `{}` on error or empty input.
 */
export async function fetchLikeCountsForMedia(
  mediaIds: string[],
): Promise<Record<string, number>> {
  if (mediaIds.length === 0) return {}

  const { data, error } = await supabase
    .from('provider_media_likes')
    .select('media_id')
    .in('media_id', mediaIds)

  if (error) {
    logError('portfolio_stats.like_counts_failed', error, { mediaCount: mediaIds.length })
    return {}
  }

  const counts: Record<string, number> = {}
  for (const id of mediaIds) counts[id] = 0
  for (const row of (data ?? []) as { media_id: string }[]) {
    counts[row.media_id] = (counts[row.media_id] ?? 0) + 1
  }
  return counts
}
