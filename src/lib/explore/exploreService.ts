import { getExploreProviderCards } from './exploreProfileService'
import type { ExploreProviderCard, ExploreReel, ExploreTab } from './exploreTypes'
import { getRatingsByProviderUserId } from '../ratings/service'
import { deriveProviderReputation } from '../ratings/selectors'
import { deriveTrustScorePenalty } from '../trust/trustSelectors'

export type ExploreContext = {
  createdProjectTags?: string[]
  savedTags?: string[]
  likedTags?: string[]
  searchQuery?: string
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map(normalize).filter(Boolean)))
}

function getReelTrustPenalty(reel: ExploreReel): number {
  const ratings = getRatingsByProviderUserId(reel.craftsmanId)
  const rep = deriveProviderReputation(reel.craftsmanId, ratings)
  return deriveTrustScorePenalty({
    rating: rep.ratingCount > 0 ? rep.averageRating : null,
    ratingCount: rep.ratingCount,
  })
}

function scoreReelForYou(reel: ExploreReel, context: ExploreContext): number {
  const projectTags = uniqueStrings(context.createdProjectTags ?? [])
  const savedTags = uniqueStrings(context.savedTags ?? [])
  const likedTags = uniqueStrings(context.likedTags ?? [])

  const reelTags = uniqueStrings([...reel.projectTags, ...reel.searchTags])

  let score = 0

  for (const tag of reelTags) {
    if (projectTags.includes(tag)) score += 10
    if (savedTags.includes(tag)) score += 5
    if (likedTags.includes(tag)) score += 3
  }

  score += Math.min(reel.likes / 50, 5)
  score += Math.min(reel.saves / 25, 4)

  return score
}

function sortFeed(
  reels: ExploreReel[],
  tab: ExploreTab,
  context?: ExploreContext
): ExploreReel[] {
  if (tab === 'inspiration') {
    return [...reels].sort((a, b) => b.createdAt - a.createdAt)
  }

  return [...reels].sort((a, b) => {
    const scoreB = scoreReelForYou(b, context ?? {}) * getReelTrustPenalty(b)
    const scoreA = scoreReelForYou(a, context ?? {}) * getReelTrustPenalty(a)
    return scoreB - scoreA
  })
}

/** Maximum characters used from a provider's bio as a reel title. */
const MAX_REEL_TITLE_LENGTH = 60

/**
 * Builds one ExploreReel per real provider card.
 *
 * Since no reel CMS exists yet each provider contributes a single discovery
 * card that surfaces their identity, location, categories, and description.
 * This replaces the previous hybrid approach of overlaying real identities
 * onto mock content tiles.
 */
export function buildProviderReels(providerCards: ExploreProviderCard[]): ExploreReel[] {
  const baseTime = Date.now()
  return providerCards.map((card, index) => {
    const descriptionTitle = card.bio
      ? card.bio.slice(0, MAX_REEL_TITLE_LENGTH).trimEnd() +
        (card.bio.length > MAX_REEL_TITLE_LENGTH ? '…' : '')
      : card.primaryCategory || 'Handwerksleistungen'

    // Reel-Hintergrund priorisiert das erste veröffentlichte Portfolio-Bild;
    // wenn kein Portfolio existiert, fällt es auf das Avatar-Bild zurück
    // (Reel-Card rendert dann den Brand-Gradient-Fallback).
    const thumbnailUrl =
      card.featuredPortfolioPublicUrl ?? card.craftsmanAvatarUrl ?? ''

    return {
      id: `provider_reel_${card.craftsmanId}`,
      craftsmanId: card.craftsmanId,
      craftsmanName: card.craftsmanName,
      craftsmanHandle: card.craftsmanHandle,
      craftsmanAvatarUrl: card.craftsmanAvatarUrl ?? '',
      title: descriptionTitle,
      category: card.primaryCategory,
      location: card.location,
      thumbnailUrl,
      likes: 0,
      saves: 0,
      featuredMediaId: card.featuredPortfolioItemId,
      likeCount: 0,
      isLikedByCurrentUser: false,
      projectTags: card.tradeCategories,
      searchTags: [
        ...card.tradeCategories,
        ...card.servicesOffered,
        card.location,
        card.craftsmanName,
      ].filter(Boolean),
      costLabel: '',
      durationLabel: '',
      // Stagger createdAt so sort-by-newest produces a stable order
      createdAt: baseTime - index * 1000,
      completedJobsCount: card.completedJobsCount,
      wouldHireAgainCount: card.wouldHireAgainCount,
      verified: card.verified,
      ratingCount: card.ratingCount,
      responseLatency: card.responseLatency,
    }
  })
}

/**
 * Synchronous feed builder that accepts pre-loaded provider cards.
 *
 * When providerCards is non-empty the feed is built exclusively from real
 * providers (one reel per provider). When providerCards is empty the feed
 * returns an empty array so the UI can show a meaningful empty state rather
 * than stale mock content.
 */
export function getExploreFeedWithProviders(
  tab: ExploreTab,
  context?: ExploreContext,
  providerCards?: ExploreProviderCard[]
): ExploreReel[] {
  const cards = providerCards ?? []
  const reels = buildProviderReels(cards)
  return sortFeed(reels, tab, context)
}

export { getExploreProviderCards } from './exploreProfileService'

/**
 * Async feed loader that fetches real provider cards from the canonical
 * Discovery read-path (providers + profiles tables) and builds a sorted feed.
 */
export async function getExploreFeedAsync(
  tab: ExploreTab,
  context?: ExploreContext
): Promise<ExploreReel[]> {
  const providerCards = await getExploreProviderCards()
  return getExploreFeedWithProviders(tab, context, providerCards)
}

/**
 * Searches reels by query string.
 *
 * Runs against the passed `reels` set (the real-provider feed already built
 * for the session) so results are consistent with what the user sees.
 * Searches across provider name, handle, location, category, description
 * (via title), and all search/project tags.
 *
 * Returns an empty array when no reels are provided and query is non-empty,
 * rather than falling back to stale mock data.
 */
export function getExploreSearchResults(query: string, reels?: ExploreReel[]): ExploreReel[] {
  const q = normalize(query)

  if (!q) return []

  const source = reels ?? []

  return source.filter((reel) => {
    return (
      normalize(reel.title).includes(q) ||
      normalize(reel.category).includes(q) ||
      normalize(reel.location).includes(q) ||
      normalize(reel.craftsmanName).includes(q) ||
      normalize(reel.craftsmanHandle).includes(q) ||
      normalize(reel.costLabel).includes(q) ||
      normalize(reel.durationLabel).includes(q) ||
      reel.searchTags.some((tag) => normalize(tag).includes(q)) ||
      reel.projectTags.some((tag) => normalize(tag).includes(q))
    )
  })
}
