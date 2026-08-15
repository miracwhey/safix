import type { ExploreProviderCard, ExploreReel } from './exploreTypes'
import type { SearchCriteria } from './searchCriteriaSelectors'
import { deriveProviderTrustProjection } from '../trust'

export type MatchReason = {
  label: string
}

export type CraftsmanMatchResult = {
  reel: ExploreReel
  matchReasons: MatchReason[]
  matchScore: number
}

/**
 * Returns ExploreReel entries from `reels` that match the given criteria,
 * sorted by descending matchScore. Each result includes matchReasons
 * explaining why this craftsman was suggested.
 *
 * Matching logic (additive scoring):
 * - Category exact match (case-insensitive): +50 pts, reason "Kategorie: {category}"
 * - Location match (case-insensitive): +30 pts, reason "Standort: {location}"
 * - Any searchTag from reel appears in description (case-insensitive): +10 pts per tag (max 20),
 *   reason "Leistung: {tag}"
 *
 * Returns only results with matchScore > 0.
 */
export function matchCraftsmenToSearchCriteria(
  criteria: SearchCriteria,
  reels: ExploreReel[]
): CraftsmanMatchResult[] {
  const normalise = (s: string) => s.trim().toLowerCase()
  const catNorm = normalise(criteria.category)
  const locNorm = normalise(criteria.location)
  const descNorm = normalise(criteria.description)

  const results: CraftsmanMatchResult[] = []

  for (const reel of reels) {
    let matchScore = 0
    const matchReasons: MatchReason[] = []

    // Category exact match: +50 pts
    if (normalise(reel.category) === catNorm) {
      matchScore += 50
      matchReasons.push({ label: `Kategorie: ${reel.category}` })
    }

    // Location match: +30 pts
    const reelLocNorm = normalise(reel.location)
    if (
      reelLocNorm === locNorm ||
      reelLocNorm.includes(locNorm) ||
      locNorm.includes(reelLocNorm)
    ) {
      matchScore += 30
      matchReasons.push({ label: `Standort: ${reel.location}` })
    }

    // Tag matching: +10 pts per tag, capped at 20 pts total from tags. Guard the
    // empty tag: normalise('') is '' and descNorm.includes('') is always true, so
    // a blank searchTags entry would otherwise add +10 plus a blank "Leistung: "
    // reason to every reel.
    let tagScore = 0
    for (const tag of reel.searchTags) {
      const tagNorm = normalise(tag)
      if (tagNorm && descNorm.includes(tagNorm)) {
        tagScore += 10
        matchReasons.push({ label: `Leistung: ${tag}` })
      }
    }
    matchScore += Math.min(tagScore, 20)

    if (matchScore > 0) {
      results.push({ reel, matchReasons, matchScore })
    }
  }

  return results.sort((a, b) => b.matchScore - a.matchScore)
}

export type ProviderMatchResult = {
  provider: ExploreProviderCard
  matchReasons: MatchReason[]
  matchScore: number
  /** Debug signals that describe which scoring rules contributed to this result. */
  matchedSignals?: string[]
}

/**
 * Returns ExploreProviderCard entries from `providers` that match the given criteria,
 * sorted by descending matchScore. Each result includes matchReasons (human-readable)
 * and matchedSignals (debug keys) explaining why this provider was suggested.
 *
 * Matching model (additive scoring):
 *
 * 1. Category match
 *    - criteria.category matches any tradeCategory (exact):       +50
 *    - criteria.category appears in any servicesOffered string:   +30
 *      (only when no exact tradeCategory match)
 *
 * 2. Service keyword match
 *    - Keywords extracted from criteria.description that appear
 *      in provider.servicesOffered: +10 per keyword (cap 30)
 *
 * 3. Location + service radius
 *    - Same city (exact or substring match):                      +30
 *    - Nearby / region (shared location token):                   +15
 *    - No location overlap (when serviceRadiusKm is set):         -30
 *
 * 4. Experience signal (weak ranking tie-breaker)
 *    - yearsInBusiness > 10:                                      +10
 *    - yearsInBusiness > 5:                                       +5
 *
 * Providers with a final score <= 0 are excluded.
 * Results are sorted by score descending.
 */
export function matchProviderCardsToSearchCriteria(
  criteria: SearchCriteria,
  providers: ExploreProviderCard[]
): ProviderMatchResult[] {
  // Normalise: lowercase, trim, replace hyphens/dots with spaces, strip remaining punctuation
  const normalise = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/[-./]/g, ' ')
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim()

  const catNorm = normalise(criteria.category)
  const locNorm = normalise(criteria.location)
  const descNorm = normalise(criteria.description)

  // Extract unique meaningful keywords from the description (length > 3 to skip stop words)
  const descKeywords = [
    ...new Set(descNorm.split(/\s+/).filter((w) => w.length > 3)),
  ]

  const results: ProviderMatchResult[] = []

  for (const provider of providers) {
    let matchScore = 0
    const matchReasons: MatchReason[] = []
    const matchedSignals: string[] = []

    // ── 1. Category match ────────────────────────────────────────────────────

    const matchedCategory = provider.tradeCategories.find(
      (cat) => normalise(cat) === catNorm
    )
    if (matchedCategory) {
      matchScore += 50
      matchReasons.push({ label: `Kategorie: ${matchedCategory}` })
      matchedSignals.push('category_match')
    } else {
      // Weaker: category string appears anywhere in a servicesOffered entry
      const categoryInServices = provider.servicesOffered.some((svc) =>
        normalise(svc).includes(catNorm)
      )
      if (categoryInServices) {
        matchScore += 30
        matchReasons.push({ label: `Kategorie (Leistung): ${criteria.category}` })
        matchedSignals.push('category_in_services')
      }
    }

    // ── 2. Service keyword match ─────────────────────────────────────────────

    const seenServiceKeywords = new Set<string>()
    let serviceKeywordScore = 0
    for (const keyword of descKeywords) {
      if (seenServiceKeywords.has(keyword)) continue
      const matchedService = provider.servicesOffered.find((svc) =>
        normalise(svc).includes(keyword)
      )
      if (matchedService) {
        seenServiceKeywords.add(keyword)
        serviceKeywordScore += 10
        matchReasons.push({ label: `Leistung: ${matchedService}` })
        matchedSignals.push(`service_keyword:${keyword}`)
      }
    }
    matchScore += Math.min(serviceKeywordScore, 30)

    // ── 3. Location + service radius ─────────────────────────────────────────

    const provLocNorm = normalise(provider.location)
    const isSameCity =
      provLocNorm === locNorm ||
      provLocNorm.includes(locNorm) ||
      locNorm.includes(provLocNorm)

    if (isSameCity) {
      matchScore += 30
      matchReasons.push({ label: `Standort: ${provider.location}` })
      matchedSignals.push('radius_match')
    } else if (provider.serviceRadiusKm != null) {
      // When a provider declares a service radius, apply location proximity signals.
      // Providers without a declared radius receive neither a bonus nor a penalty —
      // they are treated as location-agnostic for ranking purposes.
      // Nearby / region: check for exact token equality (min length > 3 to avoid noise)
      const locTokens = locNorm.split(/\s+/).filter((t) => t.length > 3)
      const provLocTokens = provLocNorm.split(/\s+/).filter((t) => t.length > 3)
      const hasSharedToken = locTokens.some((t) => provLocTokens.includes(t))
      if (hasSharedToken) {
        matchScore += 15
        matchReasons.push({ label: `Region: ${provider.location}` })
        matchedSignals.push('radius_nearby')
      } else {
        matchScore -= 30
        matchedSignals.push('radius_penalty')
      }
    }

    // ── 4. Experience signal ─────────────────────────────────────────────────

    if (provider.yearsInBusiness != null) {
      if (provider.yearsInBusiness > 10) {
        matchScore += 10
        matchedSignals.push('experience_bonus')
      } else if (provider.yearsInBusiness > 5) {
        matchScore += 5
        matchedSignals.push('experience_bonus')
      }
    }

    // ── 5. Trust signal (completed jobs boost) ───────────────────────────────

    const trust = deriveProviderTrustProjection({
      craftsmanUserId: provider.craftsmanId,
      completedJobsCount: provider.completedJobsCount,
      wouldHireAgainCount: provider.wouldHireAgainCount,
    })

    if (trust.completedJobsCount > 0) {
      if (trust.completedJobsCount >= 10) {
        matchScore += 8
        matchedSignals.push('trust_completed_jobs')
      } else if (trust.completedJobsCount >= 3) {
        matchScore += 4
        matchedSignals.push('trust_completed_jobs')
      }
      if (matchedSignals.includes('trust_completed_jobs')) {
        matchReasons.push({ label: `✓ ${trust.completedJobsCount} Projekte abgeschlossen` })
      }
    }

    if (matchScore > 0) {
      results.push({ provider, matchReasons, matchScore, matchedSignals })
    }
  }

  return results.sort((a, b) => b.matchScore - a.matchScore)
}
