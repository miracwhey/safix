/**
 * Search domain – scoring profiles + the ranking pass (L1).
 *
 * Profiles define the per-signal weighting; `rank` runs the unified scoring
 * model over any candidate type via a `project` adapter, applies the
 * multiplicative trust dampener, builds German match reasons, and returns a
 * deterministically-sorted result list.
 *
 * Weight orderings (per spec):
 *   - forYou      : proximity > taxonomy/text > social
 *   - inspiration : social    > taxonomy/text > proximity
 *   - providers   : balanced  (proximity + trust matter)
 *
 * Hard invariants:
 *   - proximity/location NEVER excludes a candidate (it is a weighted signal,
 *     neutral 0.5 when unknown — see signals.ts).
 *   - the profile weight orderings above hold.
 *   - pure + deterministic: the freshness clock comes from `ctx.nowMs`.
 */

import type {
  SearchCandidate,
  SearchProfile,
  SearchProfileWeights,
  SearchSignalKey,
  ScoredResult,
  RankContext,
} from './types'
import { computeSearchSignals } from './signals'
import { normalizeTerm, expandTrade, resolveQuery, canonicalizeTrade } from './taxonomy'
import { deriveTrustScorePenalty } from '../trust/trustSelectors'

// ---------------------------------------------------------------------------
// Profile weight tables (each row sums to 1.0)
// ---------------------------------------------------------------------------

export const PROFILE_WEIGHTS: Record<SearchProfile, SearchProfileWeights> = {
  // proximity (0.34) > taxonomy/text group (trade 0.17 + text 0.15 = 0.32) > social (0.13)
  forYou: {
    proximity: 0.34,
    trade: 0.17,
    text: 0.15,
    social: 0.13,
    trust: 0.12,
    freshness: 0.09,
  },
  // social (0.34) > taxonomy/text group (trade 0.16 + text 0.15 = 0.31) > proximity (0.13)
  inspiration: {
    social: 0.34,
    trade: 0.16,
    text: 0.15,
    proximity: 0.13,
    freshness: 0.12,
    trust: 0.10,
  },
  // balanced — proximity + trust matter (tied with text/trade at the top)
  providers: {
    text: 0.18,
    trade: 0.18,
    proximity: 0.18,
    trust: 0.18,
    social: 0.14,
    freshness: 0.14,
  },
}

const SIGNAL_KEYS: SearchSignalKey[] = ['text', 'trade', 'proximity', 'social', 'freshness', 'trust']

// ---------------------------------------------------------------------------
// Match reasons (German) — mirror the existing badge capability
// ---------------------------------------------------------------------------

type Reasons = {
  matchReasons: { label: string }[]
  matchedSignals: string[]
}

function buildReasons(
  candidate: SearchCandidate,
  query: string,
  matchedTrades: string[],
  signals: Record<SearchSignalKey, number>,
): Reasons {
  const matchReasons: { label: string }[] = []
  const matchedSignals: string[] = []

  // ── Gewerk (trade) ───────────────────────────────────────────────────────
  const cats = candidate.tradeCategories.filter(Boolean)
  // Canonicalise stored labels so drifted ones ("Schreinerei"→"Schreiner") still
  // earn the direct "Gewerk:" reason against the query's canonical.
  const catNorm = cats.map((c) => normalizeTerm(canonicalizeTrade(c)))
  const directTrade = matchedTrades.find((t) => catNorm.includes(normalizeTerm(t)))
  let tradeReasoned = false
  if (directTrade) {
    matchReasons.push({ label: `Gewerk: ${directTrade}` })
    matchedSignals.push('trade_match')
    tradeReasoned = true
  } else if (matchedTrades.length > 0) {
    const related = new Set<string>()
    for (const t of matchedTrades) for (const r of expandTrade(t)) related.add(normalizeTerm(r))
    const relatedCat = cats.find((c) => related.has(normalizeTerm(canonicalizeTrade(c))))
    if (relatedCat) {
      matchReasons.push({ label: `Verwandtes Gewerk: ${relatedCat}` })
      matchedSignals.push('trade_related')
      tradeReasoned = true
    }
  }

  // ── Leistung (free-text service hit) ──────────────────────────────────────
  if (!tradeReasoned && query) {
    const qtokens = normalizeTerm(query)
      .split(' ')
      .filter((t) => t.length >= 4)
    const svc = candidate.services.find((s) => {
      const sn = normalizeTerm(s)
      return qtokens.some((t) => sn.includes(t))
    })
    if (svc) {
      matchReasons.push({ label: `Leistung: ${svc}` })
      matchedSignals.push('text_match')
    }
  }

  // ── Standort (proximity) ──────────────────────────────────────────────────
  if (signals.proximity >= 1) {
    matchReasons.push({ label: 'In deiner Nähe' })
    matchedSignals.push('proximity_city')
  } else if (signals.proximity >= 0.7) {
    matchReasons.push({ label: 'In deiner Region' })
    matchedSignals.push('proximity_region')
  }

  // ── Bewertung / Verifizierung (trust) ─────────────────────────────────────
  if (candidate.rating != null && candidate.ratingCount > 0) {
    matchReasons.push({ label: `★ ${candidate.rating.toFixed(1)}` })
    matchedSignals.push('trust_rating')
  }
  if (candidate.verified) {
    matchReasons.push({ label: 'Verifiziert' })
    matchedSignals.push('verified')
  }

  // ── Personalisierung (social) ─────────────────────────────────────────────
  if (signals.social >= 0.5) {
    matchReasons.push({ label: 'Für dich' })
    matchedSignals.push('social')
  }

  return { matchReasons, matchedSignals }
}

// ---------------------------------------------------------------------------
// Ranking pass
// ---------------------------------------------------------------------------

/**
 * Ranks `candidates` for `query` under `profile`.
 *
 * `project` adapts each candidate into the common `SearchCandidate` shape (use
 * the adapters from `signals.ts`); the original candidate `T` is preserved in
 * every result so callers get back their own type.
 *
 * The composite score is `Σ(weight · signal) · trustPenalty`, where the trust
 * penalty (`deriveTrustScorePenalty`, ∈ [0.5, 1.0], 1.0 when data is
 * insufficient) demotes low-trust providers without ever excluding them.
 *
 * Deterministic sort: score desc → rating desc (null last) → ratingCount desc →
 * name asc → original input index asc (stability).
 */
export function rank<T>(
  candidates: T[],
  project: (candidate: T) => SearchCandidate,
  query: string,
  profile: SearchProfile,
  ctx: RankContext = {},
): ScoredResult<T>[] {
  const weights = PROFILE_WEIGHTS[profile]
  const { matchedTrades } = resolveQuery(query)

  const inputs = {
    query,
    matchedTrades,
    userLocation: ctx.userLocation,
    viewer: ctx.viewer,
    nowMs: ctx.nowMs,
  }

  const scored = candidates.map((original, idx) => {
    const candidate = project(original)
    const signals = computeSearchSignals(candidate, inputs)

    let base = 0
    for (const key of SIGNAL_KEYS) base += weights[key] * signals[key]

    const penalty = deriveTrustScorePenalty({
      rating: candidate.rating,
      ratingCount: candidate.ratingCount,
    })
    const score = base * penalty

    const { matchReasons, matchedSignals } = buildReasons(candidate, query, matchedTrades, signals)

    return { original, candidate, score, breakdown: signals, matchReasons, matchedSignals, idx }
  })

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const ra = a.candidate.rating ?? -1
    const rb = b.candidate.rating ?? -1
    if (rb !== ra) return rb - ra
    if (b.candidate.ratingCount !== a.candidate.ratingCount) {
      return b.candidate.ratingCount - a.candidate.ratingCount
    }
    const cmp = a.candidate.name.localeCompare(b.candidate.name)
    if (cmp !== 0) return cmp
    return a.idx - b.idx
  })

  return scored.map((s) => ({
    candidate: s.original,
    score: s.score,
    breakdown: s.breakdown,
    matchReasons: s.matchReasons,
    matchedSignals: s.matchedSignals,
  }))
}
