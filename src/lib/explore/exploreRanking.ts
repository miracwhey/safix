/**
 * Explore "Für dich" Ranking — M3.2
 *
 * Builds a per-viewer signal context once per tab activation and computes a
 * score for each reel in the current page. The Item-Feed service consumes
 * the score function through `sortFeedReels(_, tab, ctx)` and falls back to
 * `sort_order DESC` ("Inspiration" semantics) whenever the context is
 * absent, the user is unauthenticated, or every reel scores zero (cold
 * start).
 *
 * Signal sources
 *   1. likedTags        — distinct trade_tags from the viewer's most recent
 *                         provider_media_likes (snapshot + live tags).
 *   2. savedTags        — same shape from provider_media_saves.
 *   3. recentJobTags    — projects.category for the viewer's most recent
 *                         customer-side projects.
 *   4. adjacentTags     — co-occurring tags pulled from
 *                         provider_media_tag_cooccur (PR-D migration), so a
 *                         viewer who likes "Bad" also gets "Fliesen" hits
 *                         even when "Fliesen" isn't directly in their set.
 *
 * Score components (additive; tiebreakers small enough not to dominate)
 *   +1.0 per direct tag match in likedTags
 *   +1.0 per direct tag match in savedTags
 *   +1.0 per direct tag match in recentJobTags
 *   +0.5 per adjacency match
 *   +0.4 * exp(-ageDays / 14)  (freshness, capped contribution)
 *   +0.1 verified provider
 *   +0.1 well-rated provider (≥ 10 ratings)
 *
 * Performance budget
 *   - Context build: 4 short SELECTs in parallel (3 + 1 fan-out for
 *     adjacency). 30 most-recent likes / saves are enough to cover each
 *     viewer's preferences without dragging in years of stale taps.
 *   - Score: pure, O(reelTags) per reel. 30 reels × ~3 tags = 90 lookups
 *     in JS Sets, all O(1).
 *   - The feed-page mapping pulls trade_tags inline already; the score
 *     reads from `reel.projectTags` (mapped from trade_tags / snapshot)
 *     so no extra fetch happens during scoring.
 *
 * Failure modes
 *   - Network errors during context build: returns a context where every
 *     `Set` is empty. The score then degenerates to freshness + quality
 *     tiebreakers, which barely re-ranks — the feed effectively falls
 *     back to Inspiration order, never crashes.
 *   - Cold-start (no signals at all): `sortReelsByForYou` detects an
 *     all-zero score set and returns the reels in their original
 *     `sort_order DESC` order so the tab does not look empty / random.
 */

import { supabase } from '../supabase'
import type { ExploreReel } from './exploreTypes'
import { logError } from '../observability'

export type ViewerContext = {
  userId: string
  likedTags: ReadonlySet<string>
  savedTags: ReadonlySet<string>
  recentJobTags: ReadonlySet<string>
  adjacentTags: ReadonlySet<string>
}

const DEFAULT_LIKES_LIMIT = 30
const DEFAULT_SAVES_LIMIT = 30
const DEFAULT_JOBS_LIMIT = 5
const DEFAULT_ADJACENCY_LIMIT = 30
const FRESHNESS_HALF_LIFE_DAYS = 14
const FRESHNESS_WEIGHT = 0.4

// ---------------------------------------------------------------------------
// Signal fetchers — small + isolated for unit-testability
// ---------------------------------------------------------------------------

async function fetchTagsFromLikes(userId: string, limit = DEFAULT_LIKES_LIMIT): Promise<string[]> {
  const { data: likes, error: likeErr } = await supabase
    .from('provider_media_likes')
    .select('media_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (likeErr) {
    logError('explore.viewer_context.likes_failed', likeErr, { userId })
    return []
  }
  if (!likes || likes.length === 0) return []
  const mediaIds = Array.from(new Set(likes.map((l) => l.media_id)))
  return tagsForMediaIds(mediaIds)
}

async function fetchTagsFromSaves(userId: string, limit = DEFAULT_SAVES_LIMIT): Promise<string[]> {
  const { data: saves, error: saveErr } = await supabase
    .from('provider_media_saves')
    .select('media_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (saveErr) {
    logError('explore.viewer_context.saves_failed', saveErr, { userId })
    return []
  }
  if (!saves || saves.length === 0) return []
  const mediaIds = Array.from(new Set(saves.map((s) => s.media_id)))
  return tagsForMediaIds(mediaIds)
}

async function tagsForMediaIds(mediaIds: string[]): Promise<string[]> {
  if (mediaIds.length === 0) return []
  const { data, error } = await supabase
    .from('provider_media')
    .select('id, trade_tags, trade_tags_snapshot')
    .in('id', mediaIds)
    .eq('kind', 'portfolio')
  if (error) {
    logError('explore.viewer_context.media_tags_failed', error, { count: mediaIds.length })
    return []
  }
  const tags = new Set<string>()
  for (const row of (data ?? []) as Array<{
    trade_tags: string[] | null
    trade_tags_snapshot: string[] | null
  }>) {
    for (const t of row.trade_tags ?? []) addTag(tags, t)
    for (const t of row.trade_tags_snapshot ?? []) addTag(tags, t)
  }
  return Array.from(tags)
}

async function fetchRecentJobTags(userId: string, limit = DEFAULT_JOBS_LIMIT): Promise<string[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('category, created_at')
    // Mirror the projects RLS owner identity (customer_profile_id first); a bare
    // customer_user_id filter under-fetches profile-only-owned rows. Same identity
    // contract as SupabaseProjectRepository.loadForUser.
    .or(`customer_profile_id.eq.${userId},customer_user_id.eq.${userId}`)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) {
    logError('explore.viewer_context.projects_failed', error, { userId })
    return []
  }
  const tags = new Set<string>()
  for (const row of (data ?? []) as Array<{ category: string | null }>) {
    addTag(tags, row.category ?? null)
  }
  return Array.from(tags)
}

async function fetchAdjacentTags(seedTags: string[], limit = DEFAULT_ADJACENCY_LIMIT): Promise<string[]> {
  if (seedTags.length === 0) return []
  const { data, error } = await supabase
    .from('provider_media_tag_cooccur')
    .select('tag_b, cooccur_count')
    .in('tag_a', seedTags)
    .order('cooccur_count', { ascending: false })
    .limit(limit)
  if (error) {
    logError('explore.viewer_context.adjacency_failed', error, {
      seedCount: seedTags.length,
    })
    return []
  }
  const adjacent = new Set<string>()
  const seedSet = new Set(seedTags)
  for (const row of (data ?? []) as Array<{ tag_b: string }>) {
    const t = row.tag_b?.trim()
    if (!t) continue
    // Skip seeds — they already score 1.0 via the direct match.
    if (seedSet.has(t)) continue
    adjacent.add(t)
  }
  return Array.from(adjacent)
}

function addTag(target: Set<string>, raw: string | null | undefined): void {
  if (!raw) return
  const trimmed = raw.trim()
  if (trimmed.length === 0) return
  target.add(trimmed)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds the viewer-scoped signal context for the for-you ranker.
 *
 * Returns `null` for unauthenticated viewers so the feed transparently
 * falls back to Inspiration ordering. Never throws — every fetch failure
 * is logged and contributes an empty Set to the result.
 */
export async function buildViewerContext(
  userId: string | null | undefined,
): Promise<ViewerContext | null> {
  if (!userId) return null

  const [liked, saved, jobs] = await Promise.all([
    fetchTagsFromLikes(userId),
    fetchTagsFromSaves(userId),
    fetchRecentJobTags(userId),
  ])

  // Seed adjacency with the union of direct signals — likedTags alone would
  // miss the case where a viewer never liked Bath but only Saved or
  // Worked-on Bath items.
  const seedTags = Array.from(new Set([...liked, ...saved, ...jobs]))
  const adjacent = await fetchAdjacentTags(seedTags)

  return {
    userId,
    likedTags: new Set(liked),
    savedTags: new Set(saved),
    recentJobTags: new Set(jobs),
    adjacentTags: new Set(adjacent),
  }
}

/**
 * Pure scoring function — call once per reel during sort.
 *
 * Intentionally tolerant: invalid `createdAt` (negative, missing) skips the
 * freshness term instead of producing NaN. Empty `projectTags` yields a
 * tag-less score with only freshness + quality contributions, which is the
 * correct fallback for legacy provider-shape reels.
 */
export function scoreReelForYou(reel: ExploreReel, ctx: ViewerContext): number {
  let score = 0
  const reelTags = reel.projectTags ?? []

  for (const tag of reelTags) {
    if (!tag) continue
    const trimmed = tag.trim()
    if (trimmed.length === 0) continue
    if (ctx.likedTags.has(trimmed)) score += 1.0
    if (ctx.savedTags.has(trimmed)) score += 1.0
    if (ctx.recentJobTags.has(trimmed)) score += 1.0
    if (ctx.adjacentTags.has(trimmed)) score += 0.5
  }

  // Freshness: half-life of FRESHNESS_HALF_LIFE_DAYS, capped at FRESHNESS_WEIGHT.
  if (typeof reel.createdAt === 'number' && reel.createdAt > 0) {
    const ageDays = (Date.now() - reel.createdAt) / 86_400_000
    if (ageDays >= 0) {
      score += Math.exp(-ageDays / FRESHNESS_HALF_LIFE_DAYS) * FRESHNESS_WEIGHT
    }
  }

  // Quality tiebreakers — small enough that they don't override tag-match.
  if (reel.verified) score += 0.1
  if ((reel.ratingCount ?? 0) >= 10) score += 0.1

  return score
}

/**
 * Sorts reels by for-you score with cold-start fallback.
 *
 * If the viewer context is absent OR every reel scores at the freshness/
 * quality floor (i.e. no personalization signal hit), the function returns
 * the reels in their input order. The caller (Item-Feed) supplies them in
 * `sort_order DESC` already, so the fallback is the canonical Inspiration
 * order — the for-you tab degrades gracefully into the Inspiration tab on
 * cold start instead of looking broken.
 */
export function sortReelsByForYou(
  reels: ExploreReel[],
  ctx: ViewerContext | null,
): ExploreReel[] {
  if (!ctx) return reels
  if (reels.length === 0) return reels

  const scored = reels.map((reel) => ({ reel, score: scoreReelForYou(reel, ctx) }))

  // Cold-start floor: if no reel earns a tag/adjacency hit, every score is
  // bounded by 0.4 (freshness) + 0.2 (quality). Treat that as "no signal"
  // and preserve input order.
  const FLOOR = 0.4 + 0.2 + 1e-9
  if (scored.every(({ score }) => score <= FLOOR)) return reels

  // Stable sort: when two reels tie on score, preserve the input order so
  // the keyset cursor (`sort_order DESC, id DESC`) stays meaningful.
  const indexed = scored.map((entry, idx) => ({ ...entry, idx }))
  indexed.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.idx - b.idx
  })
  return indexed.map((x) => x.reel)
}
