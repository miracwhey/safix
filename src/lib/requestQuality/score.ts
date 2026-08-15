import type { InquiryOrigin } from '../messages/types'

/**
 * Request Quality Score (RQS) — intrinsic, craftsman-agnostic.
 *
 * Measures how complete and how serious an incoming request is, independent of
 * any single craftsman. The per-craftsman *fit* (distance, trade match, capacity)
 * is deliberately NOT part of this score — fit is relative and computed client-side
 * at render time, where the craftsman's location and trade are available.
 *
 * The score is normalised 0–100 over the signals that are currently *known*.
 * A signal counts toward the achievable maximum only once it has been wired in
 * (i.e. its value is defined). Enrichment signals that are not yet available
 * (`undefined`) are excluded from both earned and possible points, so the MVP
 * score is not unfairly deflated before later signals (customer verification,
 * returning-customer) come online. As more signals are wired, the scale adjusts
 * automatically without re-tuning weights.
 *
 * Product rule: this score sorts and flags — it must never silently hide a
 * request. A low-information emergency ("Heizung tropft, heute?") can score low
 * yet still be a real, urgent lead.
 */

export type RequestQualityTier = 'top' | 'solide' | 'pruefen'

/**
 * Normalised inputs for the scorer. Completeness signals and `origin` are always
 * known (we always know whether a field is present). The five enrichment signals
 * are optional: `undefined` means "not yet wired" and is excluded from scoring;
 * an explicit `true`/`false` means the signal has been measured.
 */
export type RequestQualitySignals = {
  /** A trade/category was provided. */
  hasCategory: boolean
  /** Free-text work description; its length drives the description sub-score. */
  description?: string | null
  /** A location was provided. */
  hasLocation: boolean
  /** A budget / cost range was provided. */
  hasBudget: boolean
  /** A timing / duration expectation was provided. */
  hasTiming: boolean
  /** How the customer reached out. `null` = unknown / no inquiry origin. */
  origin: InquiryOrigin | null
  /** Customer verified email or phone. `undefined` = not yet wired. */
  customerVerified?: boolean
  /** Customer has a real display name + avatar. `undefined` = not yet wired. */
  customerHasRealProfile?: boolean
  /** Customer has a prior/returning relationship. `undefined` = not yet wired. */
  isReturningCustomer?: boolean
  /** A structured builder project is attached. `undefined` = not yet wired. */
  hasStructuredProject?: boolean
  /** Customer shared a 3D spatial scan. `undefined` = not yet wired. */
  hasSpatialScan?: boolean
}

export type RequestQualityCategory = {
  /** Points earned in this category. */
  earned: number
  /** Points achievable given which signals are currently known. */
  possible: number
}

export type RequestQualityScore = {
  /** Normalised 0–100 score over the currently-known signals. */
  score: number
  tier: RequestQualityTier
  breakdown: {
    completeness: RequestQualityCategory
    intent: RequestQualityCategory
    attachments: RequestQualityCategory
  }
}

/** A description of at least this many characters counts as "detailed". */
const DETAILED_DESCRIPTION_MIN_LENGTH = 60

/** Intent points by inquiry origin — higher = stronger demonstrated intent. */
const ORIGIN_INTENT_POINTS: Record<InquiryOrigin, number> = {
  project: 18, // built a full structured project before reaching out
  category: 11, // searched a specific trade/category
  profile: 7, // browsed a craftsman profile
  reel: 4, // tapped through an explore reel
}

/** Score thresholds for the craftsman-facing tier. */
export const REQUEST_QUALITY_TIER_THRESHOLDS = { top: 70, solide: 40 } as const

/** German labels for each tier (UI vocabulary). */
export const REQUEST_QUALITY_TIER_LABEL: Record<RequestQualityTier, string> = {
  top: 'Top-Anfrage',
  solide: 'Solide',
  pruefen: 'Prüfen',
}

function scoreCompleteness(signals: RequestQualitySignals): RequestQualityCategory {
  // All completeness signals are always known → full 45 is always achievable.
  const possible = 45
  let earned = 0

  if (signals.hasCategory) earned += 5

  const description = (signals.description ?? '').trim()
  if (description.length >= DETAILED_DESCRIPTION_MIN_LENGTH) earned += 15
  else if (description.length > 0) earned += 8

  if (signals.hasLocation) earned += 7
  if (signals.hasBudget) earned += 10
  if (signals.hasTiming) earned += 8

  return { earned, possible }
}

function scoreIntent(signals: RequestQualitySignals): RequestQualityCategory {
  // Origin is always known (null if absent) → its 18 points are always achievable.
  let possible = 18
  let earned = signals.origin ? ORIGIN_INTENT_POINTS[signals.origin] : 0

  if (signals.customerVerified !== undefined) {
    possible += 8
    if (signals.customerVerified) earned += 8
  }
  if (signals.customerHasRealProfile !== undefined) {
    possible += 4
    if (signals.customerHasRealProfile) earned += 4
  }
  if (signals.isReturningCustomer !== undefined) {
    possible += 5
    if (signals.isReturningCustomer) earned += 5
  }

  return { earned, possible }
}

function scoreAttachments(signals: RequestQualitySignals): RequestQualityCategory {
  let possible = 0
  let earned = 0

  if (signals.hasStructuredProject !== undefined) {
    possible += 8
    if (signals.hasStructuredProject) earned += 8
  }
  if (signals.hasSpatialScan !== undefined) {
    possible += 12
    if (signals.hasSpatialScan) earned += 12
  }

  return { earned, possible }
}

/** Maps a 0–100 score to its craftsman-facing tier. */
export function tierForScore(score: number): RequestQualityTier {
  if (score >= REQUEST_QUALITY_TIER_THRESHOLDS.top) return 'top'
  if (score >= REQUEST_QUALITY_TIER_THRESHOLDS.solide) return 'solide'
  return 'pruefen'
}

/**
 * Computes the intrinsic quality score for an incoming request.
 *
 * Pure function — no I/O, no globals, deterministic. The headline `score` is the
 * earned points normalised over the points achievable from the currently-known
 * signals; `breakdown` reports the raw earned/possible per category for
 * transparency (the three `earned` values sum to the normalisation numerator and
 * the three `possible` values to its denominator).
 */
export function computeRequestQualityScore(
  signals: RequestQualitySignals,
): RequestQualityScore {
  const completeness = scoreCompleteness(signals)
  const intent = scoreIntent(signals)
  const attachments = scoreAttachments(signals)

  const earned = completeness.earned + intent.earned + attachments.earned
  const possible = completeness.possible + intent.possible + attachments.possible
  const score = possible > 0 ? Math.round((earned / possible) * 100) : 0

  return {
    score,
    tier: tierForScore(score),
    breakdown: { completeness, intent, attachments },
  }
}
