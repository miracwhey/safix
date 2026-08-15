/**
 * Explore Item-Feed Service — M3.1 read path for the `/explore` Reels feed.
 *
 * Replaces the pre-M3.1 provider-feed shape (1 reel per provider, cover =
 * newest item) with an item-feed: 1 reel = 1 `provider_media` row. Multiple
 * items per provider surface as separate reels; ordering is `sort_order DESC`
 * with `id` as a stable tiebreaker for cursor pagination.
 *
 * Read contract (verified live 2026-05-05 against project itdntawwuzqfwmcwnwjr):
 *   - `provider_media` SELECT policy "Public can read provider media" gates
 *     on `provider_is_public(provider_id)` (SECURITY DEFINER helper). Anyone
 *     authenticated or anon may read portfolio rows of any public provider.
 *     Published filter is applied here client-side; the policy itself does
 *     not gate on `published`.
 *   - `providers` is owner-read-only since the 7.1G PII lockdown (migration
 *     20260430000003). Public reads of provider metadata MUST go through the
 *     `discovery_providers` view (PII-free, GRANT SELECT TO anon,
 *     authenticated). We therefore split the read into two roundtrips:
 *       1) provider_media rows (Public-Policy)
 *       2) discovery_providers rows by provider_id IN (…)
 *     A PostgREST embed of the providers table (the legacy approach) would
 *     silently return zero rows for non-owner viewers — the visibility
 *     regression that motivated this contract.
 *   - `providers.trade_categories` (exposed via the view) is a TEXT column
 *     (CSV-style) in this codebase — we split on `,` and trim. NOT an array.
 *   - `discovery_providers.handle` is the canonical handle column (added
 *     2026-05-05 by 20260505000003). Falls back to `toItemFeedHandle()` only
 *     when the column is null/empty.
 *
 * RLS implications
 *   The like-status hydration (likeCount / isLikedByCurrentUser) does NOT
 *   live in this service. ExploreReelCard already loads it on mount via
 *   fetchLikeStatus(mediaId). We seed `likeCount: 0`, `isLikedByCurrentUser:
 *   false` and let the card overwrite.
 *
 * Pagination
 *   Cursor-based on `(sort_order, id)`. Offset would be unsafe under
 *   concurrent inserts (the feed is realtime-fed). The cursor is opaque to
 *   the caller — emit whatever `nextCursor` returns and pass it back.
 */

import { supabase } from '../supabase'
import { applyDistinctProviderWindow } from './distinctProviderWindow'
import type { ExploreReel, ExploreTab } from './exploreTypes'
import type { PortfolioAsset } from '../providerMedia/providerMediaTypes'
import { logError } from '../observability'
import { sortReelsByForYou, type ViewerContext } from './exploreRanking'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExploreItemFeedCursor = {
  /** Last seen `provider_media.sort_order` from the previous page. */
  sortOrder: number
  /** Last seen `provider_media.id` (UUID) — tiebreaker for stable order. */
  id: string
}

export type ExploreItemFeedOpts = {
  tab: ExploreTab
  /** auth.users.id of the current viewer. Used for telemetry today; ranking
   *  reads its signals through `viewerContext` (resolved separately by the
   *  screen so the per-page cursor refetch does not re-build the context). */
  viewerUserId?: string | null
  /**
   * Resolved for-you signals (likedTags / savedTags / recentJobTags /
   * adjacentTags). Required for the for-you tab to actually personalize;
   * when omitted the tab degrades to Inspiration ordering. The screen
   * resolves this once per tab activation and threads it through both the
   * initial fetch and pagination calls.
   */
  viewerContext?: ViewerContext | null
  /** Page size; default 30. */
  limit?: number
  /** Cursor from the previous page, or null/undefined for the first page. */
  cursor?: ExploreItemFeedCursor | null
  /** Distinct-provider window size; default 5. Set to 0/1 to disable. */
  distinctProviderWindow?: number
}

export type ExploreItemFeedPage = {
  reels: ExploreReel[]
  nextCursor: ExploreItemFeedCursor | null
}

const DEFAULT_LIMIT = 30
const DEFAULT_DISTINCT_WINDOW = 5

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

type FeedAssetRow = {
  id: string
  portfolio_item_id: string
  sort_order: number
  media_type: string
  public_url: string
  poster_url: string | null
  h264_url: string | null
}

type ProviderMediaRow = {
  id: string
  provider_id: string
  kind: string
  media_type: 'image' | 'video' | string
  public_url: string | null
  poster_url: string | null
  h264_url: string | null
  caption: string | null
  title: string | null
  description: string | null
  trade_tags: string[] | null
  trade_tags_snapshot: string[] | null
  sort_order: number
  published: boolean
  created_at: string
  source_job_id: string | null
}

type DiscoveryProviderRow = {
  provider_id: string
  profile_id: string
  company_name: string | null
  handle: string | null
  city: string | null
  trade_categories: string | null
  verified: boolean | null
  rating: number | null
  avatar_url: string | null
  is_public: boolean
  display_name: string | null
}

/** CSV split for `providers.trade_categories` (live schema is TEXT, not array). */
function splitTradeCategoriesCsv(csv: string | null | undefined): string[] {
  if (!csv) return []
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Best-effort title for the reel header — caption first, then the upload's
 * `title` field. We deliberately do NOT fall back to a description snippet
 * here: that fallback used to make the same description text appear twice
 * in the UI (once as the truncated headline, once as the full body
 * paragraph). The Card promotes a description-only reel into the headline
 * slot itself, with full body suppression so there is no duplication.
 */
function pickReelTitle(row: ProviderMediaRow): string {
  const direct = row.caption ?? row.title
  if (direct && direct.trim().length > 0) return direct.trim()
  return ''
}

/**
 * Slug-based handle fallback when `providers.handle` is null/empty.
 * Mirrors the toHandle() helper in exploreProfileService.ts; duplicated here
 * to keep the service self-contained and avoid coupling Item-Feed and
 * Provider-Card pipelines.
 */
function toItemFeedHandle(name: string | null | undefined, profileId: string): string {
  const slug = (name ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 20)
  const suffix = profileId.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase()
  return `@${slug || 'handwerker'}_${suffix}`
}

function rowToExploreReel(
  row: ProviderMediaRow,
  provider: DiscoveryProviderRow,
): ExploreReel | null {
  if (!row.public_url) return null // can't render without a media URL

  const mediaType: 'image' | 'video' = row.media_type === 'video' ? 'video' : 'image'
  const craftsmanName =
    provider.company_name?.trim() ||
    provider.display_name?.trim() ||
    'Handwerker'
  const craftsmanHandle =
    provider.handle?.trim() || toItemFeedHandle(craftsmanName, provider.profile_id)
  const tradeCategories = splitTradeCategoriesCsv(provider.trade_categories)
  const reelTags = (() => {
    const fromSnapshot = (row.trade_tags_snapshot ?? []).filter((t) => t && t.length > 0)
    if (fromSnapshot.length > 0) return fromSnapshot
    const fromTags = (row.trade_tags ?? []).filter((t) => t && t.length > 0)
    if (fromTags.length > 0) return fromTags
    return tradeCategories
  })()
  const cover = mediaType === 'video' ? row.poster_url ?? row.public_url : row.public_url

  return {
    id: row.id,
    mediaId: row.id,
    featuredMediaId: row.id, // legacy alias for ExploreReelCard compat path
    mediaType,
    mediaUrl: row.public_url,
    posterUrl: row.poster_url ?? null,
    h264Url: row.h264_url ?? null,
    providerId: provider.provider_id,

    craftsmanId: provider.profile_id,
    craftsmanName,
    craftsmanHandle,
    craftsmanAvatarUrl: provider.avatar_url ?? '',
    title: pickReelTitle(row),
    description: row.description?.trim() ?? '',
    category: tradeCategories[0] ?? '',
    location: provider.city ?? '',
    thumbnailUrl: cover,
    videoUrl: mediaType === 'video' ? row.public_url : undefined,
    likes: 0,
    saves: 0,
    likeCount: 0,
    isLikedByCurrentUser: false,
    projectTags: tradeCategories,
    // City + craftsman name are deliberately NOT folded into searchTags: both
    // are already searchable via the dedicated `location` / `craftsmanName`
    // fields (the signals-engine textRelevance and getExploreSearchResults each
    // match those independently). Including them here also leaked into the
    // trade-matchable tag list, where a short canonical trade substring-matched
    // place names — e.g. the trade "Bad" ("bad") scored every "Bad …" town and
    // "Wiesbaden" as a bathroom hit.
    searchTags: [
      ...reelTags,
      ...tradeCategories,
    ].filter((s) => s && s.length > 0),
    costLabel: '',
    durationLabel: '',
    createdAt: row.created_at ? new Date(row.created_at).getTime() : 0,
    sourceJobId: row.source_job_id ?? undefined,
    verified: provider.verified ?? false,
    ratingCount: 0, // not loaded here — card hydrates on demand
  }
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

/**
 * Tab-aware sort — M3.2.
 *
 * Inspiration tab keeps the SQL `sort_order DESC` order untouched. The
 * for-you tab routes through `sortReelsByForYou` which scores against the
 * provided viewer context and falls back to input order when the context
 * is null OR every reel scores at the cold-start floor (Insta-/TikTok-
 * style graceful degrade — never a visibly empty / random tab).
 *
 * Limitation — score is page-local
 *   The DB-side cursor (sort_order DESC, id DESC) determines which 30
 *   reels arrive in any given page. The score is then computed over those
 *   30 only, so deep scrollers can see a "score break" at the page
 *   boundary: page-1 last reel has high score, page-2 first reel may have
 *   a lower score than something mid-page-1. Acceptable for MVP because
 *   the top of the for-you tab — what 95% of users actually see — is
 *   correctly score-sorted. A global RPC or a scoring sub-cursor would
 *   eliminate this; deferred to a later block.
 */
function sortFeedReels(
  reels: ExploreReel[],
  tab: ExploreTab,
  viewerContext: ViewerContext | null | undefined,
): ExploreReel[] {
  if (tab === 'foryou') {
    return sortReelsByForYou(reels, viewerContext ?? null)
  }
  return reels
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Convenience wrapper: first page with default options. */
export async function fetchExploreItemFeed(
  opts: ExploreItemFeedOpts,
): Promise<ExploreReel[]> {
  const page = await fetchExploreItemFeedPage(opts)
  return page.reels
}

/**
 * Cursor-paginated read of the cross-craftsman item feed.
 *
 * Returns up to `limit` reels plus a `nextCursor` (or null when the page
 * came back smaller than `limit`, signaling end-of-feed). Cursors are
 * opaque to the UI — pass back what was emitted.
 */
export async function fetchExploreItemFeedPage(
  opts: ExploreItemFeedOpts,
): Promise<ExploreItemFeedPage> {
  const limit = opts.limit ?? DEFAULT_LIMIT
  const windowSize = opts.distinctProviderWindow ?? DEFAULT_DISTINCT_WINDOW

  // Step 1: provider_media. We deliberately avoid a PostgREST embed of the
  // providers table — that path silently collapsed to zero rows for
  // non-owner viewers after the 7.1G PII lockdown (providers is owner-
  // read-only). The Public-Read policy on provider_media (via
  // `provider_is_public()` SECURITY DEFINER helper) covers the row gate.
  let mediaQuery = supabase
    .from('provider_media')
    .select(
      `
      id, provider_id, kind, media_type, public_url, poster_url, h264_url,
      caption, title, description, trade_tags, trade_tags_snapshot,
      sort_order, published, created_at, source_job_id
    `,
    )
    .eq('kind', 'portfolio')
    .eq('published', true)
    .order('sort_order', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit)

  // Cursor: keyset pagination on (sort_order DESC, id DESC). PostgREST
  // doesn't support row-tuple comparators directly, so we approximate with
  // `sort_order < cursor.sortOrder` which is correct for non-equal cursors
  // and skips at most one duplicate at the boundary. For tightly-spaced
  // sort_orders we additionally guard with the id tiebreaker via .or().
  if (opts.cursor) {
    const { sortOrder, id } = opts.cursor
    mediaQuery = mediaQuery.or(
      `sort_order.lt.${sortOrder},and(sort_order.eq.${sortOrder},id.lt.${id})`,
    )
  }

  const { data: mediaData, error: mediaError } = await mediaQuery

  if (mediaError) {
    logError('explore.item_feed_fetch_failed', mediaError, {
      tab: opts.tab,
      hasCursor: !!opts.cursor,
      stage: 'media',
    })
    return { reels: [], nextCursor: null }
  }

  const mediaRows = (mediaData ?? []) as unknown as ProviderMediaRow[]

  if (mediaRows.length === 0) {
    return { reels: [], nextCursor: null }
  }

  // Step 2: discovery_providers (PII-free, public-readable view).
  // Join client-side by provider_id. Filter by is_public=true here because
  // the Public-Read policy on provider_media admits rows where the provider
  // is currently public — but a provider that flips back to is_public=false
  // would surface stale media until cache invalidation. We re-check.
  const providerIds = Array.from(new Set(mediaRows.map((r) => r.provider_id)))
  const { data: providerData, error: providerError } = await supabase
    .from('discovery_providers')
    .select(
      `
      provider_id, profile_id, company_name, handle, city, trade_categories,
      verified, rating, avatar_url, is_public, display_name
    `,
    )
    .in('provider_id', providerIds)
    .eq('is_public', true)

  if (providerError) {
    logError('explore.item_feed_fetch_failed', providerError, {
      tab: opts.tab,
      hasCursor: !!opts.cursor,
      stage: 'providers',
    })
    return { reels: [], nextCursor: null }
  }

  const providerById = new Map<string, DiscoveryProviderRow>()
  for (const p of (providerData ?? []) as unknown as DiscoveryProviderRow[]) {
    providerById.set(p.provider_id, p)
  }

  const mapped: ExploreReel[] = []
  for (const row of mediaRows) {
    const provider = providerById.get(row.provider_id)
    if (!provider) continue // provider not public or not visible — skip
    const reel = rowToExploreReel(row, provider)
    if (reel) mapped.push(reel)
  }

  // Step 3: provider_media_assets — M3 multi-asset carousel data.
  // Best-effort: on error each reel keeps assets=[] and the card renders the
  // single-asset cover path (reel.mediaUrl / thumbnailUrl) unchanged.
  if (mapped.length > 0) {
    const portfolioItemIds = mapped.map((r) => r.id)
    const { data: assetData, error: assetError } = await supabase
      .from('provider_media_assets')
      .select('id, portfolio_item_id, sort_order, media_type, public_url, poster_url, h264_url')
      .in('portfolio_item_id', portfolioItemIds)
      .order('sort_order', { ascending: true })

    if (assetError) {
      logError('explore.item_feed_assets_fetch_failed', assetError, { count: portfolioItemIds.length })
    } else {
      const assetsByItemId = new Map<string, PortfolioAsset[]>()
      for (const row of (assetData ?? []) as FeedAssetRow[]) {
        const asset: PortfolioAsset = {
          id: row.id,
          portfolioItemId: row.portfolio_item_id,
          providerId: '',
          sortOrder: row.sort_order,
          mediaType: row.media_type === 'video' ? 'video' : 'image',
          storagePath: null,
          publicUrl: row.public_url,
          posterUrl: row.poster_url ?? null,
          h264Url: row.h264_url ?? null,
          trimStartMs: 0,
          trimEndMs: null,
          createdAt: 0,
          updatedAt: 0,
        }
        const list = assetsByItemId.get(row.portfolio_item_id) ?? []
        list.push(asset)
        assetsByItemId.set(row.portfolio_item_id, list)
      }
      for (const reel of mapped) {
        reel.assets = assetsByItemId.get(reel.id) ?? []
      }
    }
  }

  // NOTE: feed-side comment counts are deliberately NOT loaded here. Counting
  // by fetching every provider_media_comments row for the page is unbounded and
  // silently truncates under PostgREST's row cap. The correct fix is a
  // denormalized provider_media.comment_count maintained by trigger, read as
  // part of the Step-1 select — deferred until that column exists.

  const sorted = sortFeedReels(mapped, opts.tab, opts.viewerContext ?? null)
  const reordered =
    windowSize > 1 ? applyDistinctProviderWindow(sorted, windowSize) : sorted

  let nextCursor: ExploreItemFeedCursor | null = null
  if (mediaRows.length === limit) {
    // We received a full page → there might be more. Use the LAST raw row
    // (not the reordered tail) so the next page picks up exactly where the
    // SQL ORDER BY left off, regardless of how the bench drained.
    const last = mediaRows[mediaRows.length - 1]
    nextCursor = { sortOrder: last.sort_order, id: last.id }
  }

  return { reels: reordered, nextCursor }
}
