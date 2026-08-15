import { fetchDiscoveryProviders, fetchDiscoveryProviderForProfile } from '../discovery'
import { deriveDiscoveryReadiness } from '../discovery/discoverySelectors'
import type { DiscoveryProvider } from '../discovery'
import type { ExploreProviderCard, ExploreReel } from './exploreTypes'
import { deriveProviderTrustProjection } from '../trust'
import type { ProviderTrustProjection } from '../trust'
import {
  fetchProviderAvatar,
  fetchProviderAvatarsBatch,
} from '../providerMedia'
import { fetchPublicPortfolio } from '../providerMedia/portfolioItemService'
import { aggregateLikesForProvider } from '../providerMedia/portfolioStatsSelectors'
import type { PortfolioItem } from '../providerMedia'
import {
  deriveProviderResponseLatency,
  type ResponseLatencyLabel,
} from '../messages/responseLatencySelector'
import {
  fetchProviderRatingDistribution,
  type RatingDistributionBucket,
} from '../ratings/ratingDistributionService'
import { deriveTradeHighlights, type TradeHighlight } from './tradeHighlightsSelector'
import { fetchHighlightsForProvider, type ProviderHighlight } from '../highlights/highlightRepository'
import { supabase } from '../supabase'

export type ExploreCraftsmanProfile = {
  craftsmanId: string
  /** providers.id (DB-generated UUID); used for media showcase fetches */
  providerDbId?: string
  craftsmanName: string
  craftsmanHandle: string
  craftsmanAvatarUrl: string
  location: string
  primaryCategory: string
  bio: string
  tradeCategories: string[]
  reels: ExploreReel[]
  /** Portfolio items loaded from provider_media (kind='portfolio', published=true). */
  portfolioItems: PortfolioItem[]
  serviceRadiusKm: number
  /** Telefonnummer des Betriebs (optional, nur wenn vom Handwerker gepflegt). */
  phone?: string
  /** Website des Betriebs (optional). */
  website?: string
  /** Gründungsjahr / Berufsjahre (optional). */
  yearsInBusiness?: number
  /** Centralized trust projection for this provider. */
  trust: ProviderTrustProjection
  stats: {
    reels: number
    likes: number
    saves: number
    completedJobs: number
    /** Number of customers who said they would hire this craftsman again. */
    wouldHireAgainCount: number
  }
  // ---- Block 2: Customer-Discovery Profile-Detail extensions ----
  /** Total count of published portfolio items rendered in the Reels-Grid. */
  reelsCount: number
  /** Total likes aggregated across all the provider's published portfolio items. */
  likesTotal: number
  /** Aggregated star count from `ratings` (also exposed via stats / reputation badge). */
  ratingCount: number
  /** Antwortzeit-Surrogat (e.g. „< 4 h"); null when not enough signal. */
  responseLatencyLabel: ResponseLatencyLabel | null
  /** Distinct trade categories paired with the cover of their first matching portfolio item. */
  tradeHighlights: TradeHighlight[]
  /** User-curated named highlights (e.g. "Elektrik", "Sanitär"). */
  highlights: ProviderHighlight[]
  /** Histogramm-Buckets in descending star order (5 → 1). */
  ratingDistribution: RatingDistributionBucket[]
  /** Whether the provider passed verification (✓-Badge in header). */
  verified: boolean
}

/**
 * Derives a URL-safe handle from a company or display name.
 * Appends a short suffix from the profileId to prevent collisions between
 * providers with similar names (e.g. "Elektro Weber" vs "Elektro Weber GmbH").
 * e.g. "Elektro Weber GmbH", "abc123" → "@elektrowebergmbh_abc"
 */
function toHandle(name: string, profileId: string): string {
  const slug = name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 20)
  // Take first 3 alphanumeric chars of the profileId as a disambiguation suffix
  const suffix = profileId.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase()
  return `@${slug || 'handwerker'}_${suffix}`
}

/**
 * Fetches the first published portfolio item per provider (id + public_url)
 * in a single batched query. Used to populate
 * `ExploreProviderCard.featuredPortfolioItemId` (Like-Anchor) und
 * `featuredPortfolioPublicUrl` (Reel-/Card-Hintergrund).
 *
 * Returns a Map<providerDbId, { id, publicUrl }>.
 * Providers with no published portfolio items are absent from the map.
 */
async function fetchFeaturedPortfolioIdsBatch(
  providerDbIds: string[]
): Promise<Map<string, { id: string; publicUrl: string }>> {
  if (providerDbIds.length === 0) return new Map()

  const { data, error } = await supabase
    .from('provider_media')
    .select('id, provider_id, public_url')
    .in('provider_id', providerDbIds)
    .eq('kind', 'portfolio')
    .eq('published', true)
    // Newest first — Reels and the public profile both surface the latest
    // upload at the top, and the discovery cover should mirror that so the
    // card a customer sees in Explore matches the first tile they would
    // see when tapping into the profile. Aligns with portfolioItemService
    // (DESC since M1 of the Reels refresh block).
    .order('sort_order', { ascending: false })

  if (error || !data) return new Map()

  // Keep the first row per provider — with DESC ordering this is the
  // most recently published portfolio item, which doubles as the
  // discovery card cover.
  const result = new Map<string, { id: string; publicUrl: string }>()
  for (const row of data as { id: string; provider_id: string; public_url: string | null }[]) {
    if (!result.has(row.provider_id) && row.public_url) {
      result.set(row.provider_id, { id: row.id, publicUrl: row.public_url })
    }
  }
  return result
}

/**
 * Maps a DiscoveryProvider to the ExploreProviderCard contract used by
 * Explore Feed, Search, and Provider Profile surfaces.
 *
 * `avatarMap` is an optional pre-fetched lookup (provider.id → public_url)
 * produced by `fetchProviderAvatarsBatch`. When provided, the media avatar
 * takes precedence over the legacy `providers.avatar_url` column. When the
 * map has no entry for this provider the legacy column is used as a fallback.
 */
export function discoveryProviderToCard(
  p: DiscoveryProvider,
  avatarMap?: Map<string, string>,
  featuredPortfolioMap?: Map<string, { id: string; publicUrl: string }>
): ExploreProviderCard {
  const name = p.companyName || p.displayName || 'Handwerker'
  const trust = deriveProviderTrustProjection({
    craftsmanUserId: p.profileId,
  })
  // Prefer provider_media avatar, fall back to providers.avatar_url
  const mediaAvatar = avatarMap?.get(p.id) ?? null
  const avatarUrl = mediaAvatar ?? p.avatarUrl ?? undefined
  const featured = featuredPortfolioMap?.get(p.id)

  const responseLatency = deriveProviderResponseLatency({
    craftsmanUserId: p.profileId,
    ratingCount: p.ratingCount,
    verified: p.verified,
  })

  const readiness = deriveDiscoveryReadiness(p)

  return {
    craftsmanId: p.profileId,
    craftsmanName: name,
    craftsmanHandle: p.handle?.trim() ? `@${p.handle.replace(/^@/, '')}` : toHandle(name, p.profileId),
    craftsmanAvatarUrl: avatarUrl,
    location: p.city ?? '',
    primaryCategory: p.tradeCategories[0] ?? '',
    tradeCategories: p.tradeCategories,
    // Use trade_categories as services until a dedicated services field exists
    servicesOffered: p.tradeCategories,
    serviceRadiusKm: 25,
    yearsInBusiness: undefined,
    completedJobsCount: trust.completedJobsCount > 0 ? trust.completedJobsCount : undefined,
    wouldHireAgainCount: trust.wouldHireAgainCount > 0 ? trust.wouldHireAgainCount : undefined,
    bio: p.description ?? undefined,
    featuredPortfolioItemId: featured?.id,
    featuredPortfolioPublicUrl: featured?.publicUrl,
    verified: p.verified,
    ratingCount: p.ratingCount,
    responseLatency: responseLatency ?? undefined,
    readinessMissingFields: readiness.isReady ? undefined : readiness.missingFields,
  }
}

/**
 * Fetches all Discovery-visible provider cards from the real Supabase
 * `providers` + `profiles` tables, enriched with avatars from provider_media.
 *
 * A single batch query fetches all available avatars so there is no N+1 issue.
 * Cards whose provider has no provider_media avatar fall back to the legacy
 * `providers.avatar_url` field, and ultimately to undefined (the UI applies
 * its own fallback).
 *
 * Returns an empty array on error so callers (Explore Feed, Search) degrade
 * gracefully.
 */
export async function getExploreProviderCards(): Promise<ExploreProviderCard[]> {
  const providers = await fetchDiscoveryProviders()
  if (providers.length === 0) return []

  // Batch-fetch avatars + first portfolio item per provider — two queries, no N+1
  const providerDbIds = providers.map((p) => p.id)
  const [avatarMap, featuredPortfolioMap] = await Promise.all([
    fetchProviderAvatarsBatch(providerDbIds),
    fetchFeaturedPortfolioIdsBatch(providerDbIds),
  ])

  return providers.map((p) => discoveryProviderToCard(p, avatarMap, featuredPortfolioMap))
}

/**
 * Fetches the full ExploreCraftsmanProfile for the given provider profile ID.
 *
 * Reads real data from `providers` + `profiles`. Also loads:
 *   - Avatar from `provider_media` (kind='avatar'), falling back to the
 *     legacy `providers.avatar_url` column and finally to an empty string.
 *   - Portfolio items from `provider_media` (kind='portfolio').
 *
 * Returns null when the provider is not found or not Discovery-visible.
 *
 * NOTE: `reels` is empty until a real reel CMS is wired up. The profile
 * screen gracefully hides the reels section when the array is empty.
 */
export async function getExploreCraftsmanProfile(
  craftsmanId: string
): Promise<ExploreCraftsmanProfile | null> {
  const provider = await fetchDiscoveryProviderForProfile(craftsmanId)
  if (!provider) return null

  const name = provider.companyName || provider.displayName || 'Handwerker'
  const trust = deriveProviderTrustProjection({
    craftsmanUserId: provider.profileId,
  })

  // Fetch media + legacy extended fields + Block-2 stats in parallel
  // (each promise is independently safe to fail).
  const [
    avatarItem,
    portfolioItems,
    legacyProfile,
    likesTotal,
    ratingDistribution,
    highlights,
    medianResponseMs,
  ] = await Promise.all([
    fetchProviderAvatar(provider.id),
    fetchPublicPortfolio(provider.id),
    supabase
      .from('craftsman_profiles')
      .select('service_radius_km, phone, website, years_in_business')
      .eq('user_id', provider.profileId)
      .maybeSingle()
      .then(
        ({ data }) => data as { service_radius_km: number | null; phone: string | null; website: string | null; years_in_business: number | null } | null,
        () => null,
      ),
    aggregateLikesForProvider(provider.id),
    fetchProviderRatingDistribution(provider.profileId),
    fetchHighlightsForProvider(provider.profileId).catch(() => [] as ProviderHighlight[]),
    supabase
      .rpc('get_provider_median_response_ms', { p_craftsman_user_id: provider.profileId })
      .then(({ data }) => (typeof data === 'number' ? data : null), () => null as number | null),
  ])

  // Prefer provider_media avatar, fall back to providers.avatar_url
  const avatarUrl = avatarItem?.publicUrl ?? provider.avatarUrl ?? ''

  const responseLatencyLabel = deriveProviderResponseLatency({
    craftsmanUserId: provider.profileId,
    ratingCount: provider.ratingCount,
    verified: provider.verified,
    medianResponseMs,
  })

  const tradeHighlights = deriveTradeHighlights(provider.tradeCategories, portfolioItems)
  const reelsCount = portfolioItems.length

  return {
    craftsmanId: provider.profileId,
    providerDbId: provider.id,
    craftsmanName: name,
    craftsmanHandle: provider.handle?.trim() ? `@${provider.handle.replace(/^@/, '')}` : toHandle(name, provider.profileId),
    craftsmanAvatarUrl: avatarUrl,
    location: provider.city ?? '',
    primaryCategory: provider.tradeCategories[0] ?? '',
    bio: provider.description ?? '',
    tradeCategories: provider.tradeCategories,
    reels: [], // No reel CMS yet; profile screen hides section when empty
    portfolioItems,
    serviceRadiusKm: legacyProfile?.service_radius_km ?? 25,
    phone: legacyProfile?.phone ?? undefined,
    website: legacyProfile?.website ?? undefined,
    yearsInBusiness: legacyProfile?.years_in_business ?? undefined,
    trust,
    stats: {
      reels: reelsCount,
      likes: likesTotal,
      saves: 0,
      completedJobs: trust.completedJobsCount,
      wouldHireAgainCount: trust.wouldHireAgainCount,
    },
    reelsCount,
    likesTotal,
    ratingCount: provider.ratingCount,
    responseLatencyLabel,
    tradeHighlights,
    highlights,
    ratingDistribution,
    verified: provider.verified,
  }
}
