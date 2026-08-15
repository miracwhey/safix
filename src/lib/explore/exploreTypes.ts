import type { PortfolioAsset } from '../providerMedia/providerMediaTypes'

export type ExploreTab = 'foryou' | 'inspiration'

export type ExploreReel = {
  // ── identity ─────────────────────────────────────────────────────────────
  /** Synthetic feed-row id. For item-feed reels (M3.1+) this equals
   *  `provider_media.id` — stable across pagination, deep-links, and analytics. */
  id: string

  // ── M3.1 Item-Feed (1 reel = 1 provider_media row) ───────────────────────
  // These fields are populated by the Item-Feed pipeline (exploreItemFeedService).
  // They are optional so legacy provider-feed reels and existing test literals
  // remain valid; ExploreReelCard branches on `mediaType` and falls back to the
  // pre-M3.1 cover render when these are absent.
  /** provider_media.id — primary anchor for likes / comments / share / deep-link.
   *  Equals `id` for item-feed reels. */
  mediaId?: string
  /** 'image' | 'video' — drives the renderer branch in ExploreReelCard. */
  mediaType?: 'image' | 'video'
  /** Public URL of the original media (image OR video source). */
  mediaUrl?: string
  /** Poster frame for video items (extracted on upload). null for images. */
  posterUrl?: string | null
  /** H.264 transcoded URL when available (Block-0 pipeline output). null until
   *  the transcode-portfolio-video Edge Function fills it. */
  h264Url?: string | null
  /** providers.id (DB UUID) — used by realtime filters, like-status batch
   *  hydration, and applyDistinctProviderWindow. */
  providerId?: string

  // ── deprecated compat shim ───────────────────────────────────────────────
  /** @deprecated Use `mediaId`. Kept for transitional reads while the rest of
   *  the codebase migrates off the legacy provider-feed shape. Mirrors `mediaId`. */
  featuredMediaId?: string

  // ── provider-side meta (unchanged from pre-M3.1) ─────────────────────────
  craftsmanId: string
  craftsmanName: string
  craftsmanHandle: string
  craftsmanAvatarUrl: string
  /** Caption / one-line headline above the description. From provider_media.caption,
   *  with provider_media.title as a secondary source and a description-snippet
   *  fallback when both are blank. */
  title: string
  /** Long-form description body. Distinct from `title` so the card can render
   *  the headline + a collapsible "mehr"-expandable body (Insta-style).
   *  Optional because legacy provider-shape reels (built from
   *  `ExploreProviderCard`) carry no item-level description; the
   *  consumer treats `undefined` and `''` identically. */
  description?: string
  category: string
  location: string
  /** Cover URL for grids / search / share preview. For images = mediaUrl;
   *  for videos = posterUrl ?? mediaUrl. Kept for callers that don't know
   *  the renderer branch (e.g. ExploreSearchOverlay tile). */
  thumbnailUrl: string
  videoUrl?: string
  likes: number
  saves: number
  likeCount: number
  isLikedByCurrentUser: boolean
  projectTags: string[]
  searchTags: string[]
  costLabel: string
  durationLabel: string
  createdAt: number
  sourceJobId?: string
  problemType?: string
  completedJobsCount?: number
  wouldHireAgainCount?: number
  verified?: boolean
  ratingCount?: number
  responseLatency?: '< 4 h' | '< 1 d' | '1-2 d'
  /** M3 Multi-Asset: all assets for this portfolio item, sorted by sort_order.
   *  Absent / length ≤ 1 = single-asset item (card renders cover as before).
   *  Length > 1 = multi-asset: card shows carousel + dot indicators. */
  assets?: PortfolioAsset[]
}

export type ExploreProviderCard = {
  craftsmanId: string
  craftsmanName: string
  craftsmanHandle: string
  craftsmanAvatarUrl?: string
  location: string
  primaryCategory: string
  tradeCategories: string[]
  servicesOffered: string[]
  serviceRadiusKm: number
  yearsInBusiness?: number
  completedJobsCount?: number
  wouldHireAgainCount?: number
  bio?: string
  /** provider_media.id of the first published portfolio item, if any. */
  featuredPortfolioItemId?: string
  /** Public URL of the first published portfolio item, used as reel/card BG. */
  featuredPortfolioPublicUrl?: string
  /** Whether the provider passed verification (✓-Badge). */
  verified?: boolean
  /** Number of individual customer ratings (display only). */
  ratingCount?: number
  /** Optional response-latency surrogate (Reel-Pill). */
  responseLatency?: '< 4 h' | '< 1 d' | '1-2 d'
  /** Missing-fields hint when readiness is incomplete (Profil unvollständig-Badge). */
  readinessMissingFields?: string[]
}
