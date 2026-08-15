/**
 * Search domain – pure ranking signals (L1).
 *
 * Each signal is a pure function returning a value in [0, 1]. The set of
 * signals is unified across every search surface via the common
 * `SearchCandidate` adapter shape (DiscoveryProvider | ExploreProviderCard |
 * ExploreReel all map in).
 *
 * Hard invariant: proximity is a SIGNAL ONLY, never a filter. When the user
 * location or the candidate location is unknown the signal returns a NEUTRAL
 * ~0.5 — never 0, never excludes.
 *
 * Determinism: the freshness signal takes `nowMs` explicitly; nothing here
 * reads `Date.now()`. The boundary (engine) injects the clock.
 *
 * Social: mirrors the canonical `exploreRanking` for-you weighting
 * (likedTags +1 / savedTags +1 / recentJobTags +1 / adjacentTags +0.5) on the
 * candidate's trade tags, plus a popularity prior from like/save volume. We
 * replicate the deterministic tag-matching rather than call `scoreReelForYou`
 * directly, because that helper requires an `ExploreReel` and reads `Date.now()`
 * (freshness is handled separately here for purity).
 */

import type { DiscoveryProvider } from '../discovery/discoveryTypes'
import type { ExploreProviderCard, ExploreReel } from '../explore/exploreTypes'
import type { ViewerContext } from '../explore/exploreRanking'
import type { SearchCandidate, SearchSignalKey } from './types'
import { normalizeTerm, expandTrade, canonicalizeTrade } from './taxonomy'

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

/** Direct-tag-match units that saturate the personalisation signal to 1. */
const SOCIAL_PERSONALIZATION_SATURATION = 3
/** Like volume that saturates the like popularity prior to 1. */
const SOCIAL_LIKES_FULL = 50
/** Save volume that saturates the save popularity prior to 1. */
const SOCIAL_SAVES_FULL = 25
/** Social blend: three-quarters viewer personalisation, one-quarter raw popularity. */
const SOCIAL_PERSONALIZATION_WEIGHT = 0.75
const SOCIAL_POPULARITY_WEIGHT = 0.25
/** Freshness half-life in days (mirrors exploreRanking). */
const FRESHNESS_HALF_LIFE_DAYS = 14
const MS_PER_DAY = 86_400_000

// ---------------------------------------------------------------------------
// Adapters — concrete candidate types → common SearchCandidate shape
// ---------------------------------------------------------------------------

/** Adapts a Discovery read-path provider into the common candidate shape. */
export function fromDiscoveryProvider(p: DiscoveryProvider): SearchCandidate {
  return {
    id: p.id,
    name: p.companyName || p.displayName || '',
    description: p.description ?? '',
    location: p.city ?? '',
    tradeCategories: p.tradeCategories ?? [],
    services: [],
    rating: p.rating,
    ratingCount: p.ratingCount ?? 0,
    verified: p.verified,
    likes: 0,
    saves: 0,
    providerUserId: p.profileId,
    createdAt: p.createdAt ?? 0,
  }
}

/** Adapts an Explore provider card into the common candidate shape. */
export function fromExploreProviderCard(c: ExploreProviderCard): SearchCandidate {
  return {
    id: c.craftsmanId,
    name: c.craftsmanName ?? '',
    description: c.bio ?? '',
    location: c.location ?? '',
    tradeCategories: c.tradeCategories ?? [],
    services: c.servicesOffered ?? [],
    // Cards carry a ratingCount but no average rating value.
    rating: null,
    ratingCount: c.ratingCount ?? 0,
    verified: c.verified ?? false,
    likes: 0,
    saves: 0,
    providerUserId: c.craftsmanId,
    // No createdAt on the card → freshness stays neutral for cards.
    createdAt: 0,
  }
}

/** Adapts an Explore reel into the common candidate shape. */
export function fromExploreReel(r: ExploreReel): SearchCandidate {
  return {
    id: r.id,
    name: r.craftsmanName || r.title || '',
    description: r.description ?? r.title ?? '',
    location: r.location ?? '',
    tradeCategories: r.projectTags ?? [],
    services: r.searchTags ?? [],
    rating: null,
    ratingCount: r.ratingCount ?? 0,
    verified: r.verified ?? false,
    likes: r.likes ?? 0,
    saves: r.saves ?? 0,
    providerUserId: r.craftsmanId,
    createdAt: r.createdAt ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Signals — each returns [0, 1]
// ---------------------------------------------------------------------------

/**
 * Free-text relevance via the taxonomy normaliser (NOT raw substring).
 *
 *   - empty query                       → 0.5 (neutral, no constraint)
 *   - whole-query match on the name     → 1.0
 *   - per-token best match graded by field (name > category > service > location
 *     > description), blended with token coverage
 *   - query present but no token matches → 0.0
 */
export function textRelevance(query: string, candidate: SearchCandidate): number {
  const qNorm = normalizeTerm(query)
  if (!qNorm) return 0.5

  const tokens = qNorm.split(' ').filter((t) => t.length >= 2)
  if (tokens.length === 0) return 0.5

  // Whole-query name match → 1.0, but a SUBSTRING name match only for queries of
  // ≥3 chars. Otherwise a 2-char query ('ba') returned a perfect 1.0 for every
  // candidate whose name merely contains those two letters; the screen admits
  // length-2 queries, so they fall through to the graded per-token logic instead.
  const name = normalizeTerm(candidate.name)
  if (name && (name === qNorm || (qNorm.length >= 3 && name.includes(qNorm)))) return 1

  const desc = normalizeTerm(candidate.description)
  const loc = normalizeTerm(candidate.location)
  const services = candidate.services.map(normalizeTerm).filter(Boolean)
  const cats = candidate.tradeCategories.map(normalizeTerm).filter(Boolean)

  let best = 0
  let hits = 0
  for (const tok of tokens) {
    let s = 0
    if (name && name.includes(tok)) s = Math.max(s, 0.9)
    if (cats.some((c) => c.includes(tok))) s = Math.max(s, 0.85)
    if (services.some((sv) => sv.includes(tok))) s = Math.max(s, 0.75)
    if (loc && loc.includes(tok)) s = Math.max(s, 0.6)
    if (desc && desc.includes(tok)) s = Math.max(s, 0.55)
    if (s > 0) hits++
    if (s > best) best = s
  }
  if (hits === 0) return 0
  const coverage = hits / tokens.length
  return Math.min(best * 0.7 + coverage * 0.3, 1)
}

/**
 * Trade-match relevance from the resolved query trades.
 *
 *   - no resolved trade                       → 0.5 (neutral)
 *   - candidate trade ∈ matchedTrades         → 1.0 (direct)
 *   - matched trade appears in a service       → 0.7
 *   - candidate trade ∈ relatedTrades(matched) → 0.6 (adjacency)
 *   - otherwise                                → 0.0
 */
export function tradeMatchSignal(matchedTrades: string[], candidate: SearchCandidate): number {
  if (!matchedTrades || matchedTrades.length === 0) return 0.5

  // Canonicalise the candidate's stored labels first, so drifted labels
  // ("Schreinerei"→"Schreiner", "Malerei"→"Maler") meet the query's canonical.
  const cats = candidate.tradeCategories.map((c) => normalizeTerm(canonicalizeTrade(c))).filter(Boolean)
  const matchedNorm = matchedTrades.map(normalizeTerm)

  if (matchedNorm.some((m) => cats.includes(m))) return 1

  let score = 0
  const services = candidate.services.map(normalizeTerm).filter(Boolean)
  if (matchedNorm.some((m) => services.some((s) => s.includes(m)))) score = Math.max(score, 0.7)

  const related = new Set<string>()
  for (const t of matchedTrades) for (const r of expandTrade(t)) related.add(normalizeTerm(r))
  if (cats.some((c) => related.has(c))) score = Math.max(score, 0.6)

  return score
}

/**
 * Location proximity — SIGNAL ONLY, never a filter.
 *
 *   - user location unknown      → 0.5 (neutral)
 *   - candidate location unknown → 0.5 (neutral)
 *   - same / contained city      → 1.0
 *   - shared region token        → 0.7
 *   - both known, no overlap     → 0.2 (soft demote; still NEVER excludes)
 */
export function proximitySignal(userLocation: string | undefined, candidate: SearchCandidate): number {
  const a = normalizeTerm(userLocation ?? '')
  if (!a) return 0.5
  const b = normalizeTerm(candidate.location ?? '')
  if (!b) return 0.5

  if (a === b || a.includes(b) || b.includes(a)) return 1

  const at = a.split(' ').filter((t) => t.length >= 3)
  const bt = b.split(' ').filter((t) => t.length >= 3)
  if (at.some((t) => bt.includes(t))) return 0.7

  return 0.2
}

/**
 * Social signal — personalisation (viewer tag affinity) + popularity prior.
 *
 *   - no viewer context → personalisation contributes 0 (anon: relevance only)
 *   - personalisation: liked/saved/recentJob tag hits (+1 each) + adjacent
 *     (+0.5), saturating to 1 at `SOCIAL_PERSONALIZATION_SATURATION` units
 *   - popularity: like/save volume, 0 for provider-derived candidates today
 *   - blended 0.75 personalisation / 0.25 popularity, clamped to [0, 1]
 */
export function socialSignal(candidate: SearchCandidate, viewer?: ViewerContext | null): number {
  let pHits = 0
  if (viewer) {
    for (const raw of candidate.tradeCategories) {
      const tag = (raw ?? '').trim()
      if (!tag) continue
      if (viewer.likedTags.has(tag)) pHits += 1
      if (viewer.savedTags.has(tag)) pHits += 1
      if (viewer.recentJobTags.has(tag)) pHits += 1
      if (viewer.adjacentTags.has(tag)) pHits += 0.5
    }
  }
  const personalization = pHits <= 0 ? 0 : Math.min(pHits / SOCIAL_PERSONALIZATION_SATURATION, 1)

  // NaN-guard the volume inputs: Math.max(NaN, 0) is NaN (Math.max propagates
  // NaN), which would make popularity — and thus the whole signal — NaN and
  // poison rank()'s comparator into an unstable sort. Mirrors the defensive
  // short-circuits in freshnessSignal / trustSignal.
  const likes = Number.isFinite(candidate.likes) ? candidate.likes : 0
  const saves = Number.isFinite(candidate.saves) ? candidate.saves : 0
  const likeScore = Math.min(Math.max(likes, 0) / SOCIAL_LIKES_FULL, 1)
  const saveScore = Math.min(Math.max(saves, 0) / SOCIAL_SAVES_FULL, 1)
  const popularity = likeScore * 0.6 + saveScore * 0.4

  return Math.min(personalization * SOCIAL_PERSONALIZATION_WEIGHT + popularity * SOCIAL_POPULARITY_WEIGHT, 1)
}

/**
 * Freshness via an exponential half-life on `createdAt`.
 *
 *   - `nowMs` absent OR createdAt ≤ 0 → 0.5 (neutral; unknown freshness)
 *   - future timestamp                → 1.0 (clamped brand-new, never NaN)
 *   - otherwise                       → exp(-ageDays / half-life) in (0, 1]
 */
export function freshnessSignal(candidate: SearchCandidate, nowMs?: number): number {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return 0.5
  const created = candidate.createdAt
  if (!created || created <= 0) return 0.5
  const ageDays = (nowMs - created) / MS_PER_DAY
  if (ageDays < 0) return 1
  return Math.min(Math.exp(-ageDays / FRESHNESS_HALF_LIFE_DAYS), 1)
}

/**
 * Trust/reputation signal from rating quality + count credibility + verified.
 *
 *   - rating unknown → rating quality is neutral (0.5)
 *   - count credibility log-scaled (10 ratings ≈ 0.5, 100 ≈ 1.0)
 *   - blended 0.6 rating / 0.3 count / 0.1 verified, clamped to [0, 1]
 *
 * NOTE: this is the additive trust SIGNAL. The multiplicative trust *dampener*
 * (`deriveTrustScorePenalty`) is applied separately in `profiles.rank`.
 */
export function trustSignal(candidate: SearchCandidate): number {
  // Guard NaN as well as null: `NaN != null` is true, so an unguarded Math.max(
  // NaN, 0) would make ratingQuality — and the whole signal — NaN and poison
  // rank()'s comparator (same class as the socialSignal volume guard).
  const ratingQuality =
    typeof candidate.rating === 'number' && Number.isFinite(candidate.rating)
      ? Math.min(Math.max(candidate.rating, 0) / 5, 1)
      : 0.5
  const count = candidate.ratingCount ?? 0
  const countCred = count > 0 ? Math.min(Math.log(count + 1) / Math.log(100), 1) : 0
  const verifiedBoost = candidate.verified ? 1 : 0
  return Math.min(ratingQuality * 0.6 + countCred * 0.3 + verifiedBoost * 0.1, 1)
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export type SignalInputs = {
  /** Raw query string (free-text relevance). */
  query?: string
  /** Canonical trades resolved from the query (trade match). */
  matchedTrades?: string[]
  /** User location for proximity (never a filter). */
  userLocation?: string
  /** Personalisation context; null for anon. */
  viewer?: ViewerContext | null
  /** Freshness clock (epoch ms). */
  nowMs?: number
}

/**
 * Computes every signal for one candidate. Pure: pass the resolved trades and
 * `nowMs` in so the query is resolved + the clock read once at the boundary.
 */
export function computeSearchSignals(
  candidate: SearchCandidate,
  inputs: SignalInputs,
): Record<SearchSignalKey, number> {
  return {
    text: textRelevance(inputs.query ?? '', candidate),
    trade: tradeMatchSignal(inputs.matchedTrades ?? [], candidate),
    proximity: proximitySignal(inputs.userLocation, candidate),
    social: socialSignal(candidate, inputs.viewer),
    freshness: freshnessSignal(candidate, inputs.nowMs),
    trust: trustSignal(candidate),
  }
}
