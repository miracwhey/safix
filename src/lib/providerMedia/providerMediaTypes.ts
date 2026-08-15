/**
 * Supported media kinds stored in provider_media.
 * - 'avatar'    – profile picture shown in cards and profile headers
 * - 'portfolio' – work samples shown in the profile portfolio gallery
 * - 'cover'     – optional cover / banner image
 */
export type ProviderMediaKind = 'avatar' | 'portfolio' | 'cover'

/**
 * Raw DB row shape returned by Supabase for the provider_media table.
 */
export type ProviderMediaRow = {
  id: string
  provider_id: string
  kind: string
  storage_path: string | null
  public_url: string | null
  caption: string | null
  sort_order: number | null
  created_at: string | null
  updated_at: string | null
}

/**
 * UI-friendly ViewModel for a single provider_media entry.
 *
 * `publicUrl` is the preferred field for rendering; `storagePath` is
 * retained for completeness but is not required for the read path.
 */
export type ProviderMediaItem = {
  /** provider_media.id */
  id: string
  /** provider_media.provider_id (= providers.id, NOT profile_id) */
  providerId: string
  /** Media kind – drives how the item is rendered */
  kind: ProviderMediaKind
  /** Supabase Storage path, may be null */
  storagePath: string | null
  /**
   * Publicly accessible URL for the media asset.
   * This is the primary render URL. Null when not yet published.
   */
  publicUrl: string | null
  /** Optional caption shown below portfolio images */
  caption: string | null
  /** Lower sort_order values appear first */
  sortOrder: number
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// M1: provider_media_assets — individual media items within a portfolio post
// ---------------------------------------------------------------------------

/**
 * One entry in the `provider_media_assets` table.
 * A portfolio post (`provider_media` with kind='portfolio') owns N assets.
 * sort_order=0 is the cover asset whose data is cached on the parent row.
 */
export type PortfolioAsset = {
  id: string
  portfolioItemId: string
  providerId: string
  /** Position in the carousel. 0 = cover. Must be unique per portfolioItemId. */
  sortOrder: number
  mediaType: 'image' | 'video'
  storagePath: string | null
  publicUrl: string
  posterUrl: string | null
  h264Url: string | null
  /** Trim in/out points stored as metadata — no actual video rendering. */
  trimStartMs: number
  trimEndMs: number | null
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Block 2: Portfolio-specific types
// ---------------------------------------------------------------------------

/**
 * Extended raw DB row — includes the Block 2 portfolio columns added via
 * migration 20260407000001_portfolio_block2.sql.
 *
 * Used only by portfolioItemService.ts for full portfolio CRUD.
 * Avatar/cover code continues to use ProviderMediaRow.
 */
export type ProviderMediaRowV2 = ProviderMediaRow & {
  media_type: string | null
  title: string | null
  description: string | null
  trade_tags: string[] | null
  published: boolean | null
  show_price: boolean | null
  show_duration: boolean | null
  source_job_id: string | null
  project_title_snapshot: string | null
  location_snapshot: string | null
  duration_snapshot: string | null
  amount_snapshot: string | null
  trade_tags_snapshot: string[] | null
  /** Sibling JPEG poster for video items (migration 20260504000003). */
  poster_url: string | null
  /** Sibling H.264 .mp4 transcode for video items (migration 20260504000006). */
  h264_url: string | null
}

/**
 * Canonical portfolio item — the single type read by both the owner profile
 * (CraftsmanProfile.tsx) and the public explore profile
 * (ExploreCraftsmanProfileScreen.tsx).
 *
 * Always corresponds to a `provider_media` row with kind='portfolio'.
 * The `provider_media` row is the Beitrag-Hülle (post wrapper): it holds
 * metadata, publish state, and a denormalized Primary-Asset-Cache of the
 * cover asset's media fields for backwards-compatible feed reads.
 *
 * Individual media files are stored in `provider_media_assets` (1:N).
 * The cover asset (lowest sort_order) drives the cache via the DB trigger
 * `sync_provider_media_cover`. Read the full assets array via `.assets`.
 */
export type PortfolioItem = {
  id: string
  providerId: string
  kind: 'portfolio'
  storagePath: string | null
  publicUrl: string | null
  /** 'image' | 'video' */
  mediaType: 'image' | 'video'
  /**
   * Short display title. Grid overlay prefers title over caption.
   * Render rule: title ?? caption
   */
  title: string | null
  /**
   * Legacy-compat caption field. Used as fallback when title is absent.
   * Render rule: title ?? caption
   */
  caption: string | null
  /**
   * Longer public description shown in the composer / detail view.
   * Never shown in the grid overlay — grid uses title ?? caption only.
   */
  description: string | null
  /** Gewerke explicitly chosen by the owner for this item */
  tradeTags: string[]
  /** Lower sort_order values appear first */
  sortOrder: number
  /**
   * Public URL of a JPEG poster frame extracted at upload time. Set only
   * for `mediaType: 'video'` items where extraction succeeded — `null`
   * everywhere else. Renderers should pass this to `<video poster=...>`
   * so customers on browsers that cannot decode the source codec (e.g.
   * iPhone HEVC viewed on Android Chrome) still see the cover frame.
   */
  posterUrl: string | null
  /**
   * Public URL of an H.264 transcode of the source video. Populated
   * asynchronously by the Block 0 transcode pipeline; null until the
   * pipeline finishes or for non-video items. Renderers should prefer
   * this URL on browsers that cannot decode the original codec
   * (e.g. iPhone HEVC viewed on Android Chromium).
   */
  h264Url: string | null
  /** false → hidden from public profile; true → visible */
  published: boolean
  /** Whether to show amountSnapshot on the public profile */
  showPrice: boolean
  /** Whether to show durationSnapshot on the public profile */
  showDuration: boolean
  /** Back-reference to the originating job (jobs.id is text, no FK) */
  sourceJobId: string | null
  /** Immutable snapshot of project title at creation time */
  projectTitleSnapshot: string | null
  /** Immutable snapshot of job location at creation time */
  locationSnapshot: string | null
  /** Immutable snapshot of job duration at creation time */
  durationSnapshot: string | null
  /** Immutable snapshot of job amount at creation time */
  amountSnapshot: string | null
  /** Immutable snapshot of trade tags chosen in the composer */
  tradeTagsSnapshot: string[]
  /**
   * All media assets belonging to this post, ordered by sort_order ASC.
   * assets[0] is the cover asset. Always non-empty for persisted items;
   * empty array only for optimistic prepends not yet confirmed by the DB.
   */
  assets: PortfolioAsset[]
  createdAt: number
  updatedAt: number
}
