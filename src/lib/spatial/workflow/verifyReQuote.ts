/**
 * Spatial · Workflow · Re-Quote-Trigger (Phase 3 · Block 3.9 · VF-2)
 *
 * The pure decision layer for the QUOTE-STALE trigger (Implementation-Spec §4).
 * When a customer changes the scan basis AFTER a provider already sent a quote,
 * that quote rests on out-of-date geometry. VF-2 locks the threshold at which
 * the change is "significant enough" to flag the quote stale:
 *
 *   >5 % change in ANY wall/room dimension  OR  a new `severity='high'` pin
 *   OR a layout change (wall delete / opening add/move).
 *
 * The three conditions are OR-ed. The first one that fires picks the
 * {@link OfferStaleReason}.
 *
 * ── Layer (binding · SaFix architecture rule) ───────────────────────────────
 * PURE workflow logic — no React, no zustand, no three.js, no DB, no offer
 * repository. Deterministic over the verify change-summary. The actual write
 * (flipping `offers.is_stale`) is done by {@link planMarkQuotesStale}'s caller
 * via the offers domain `updateOffer` API — or, in production, a
 * SECURITY-DEFINER RPC (a customer may not write a provider's offer columns
 * directly · Implementation-Spec §4). This module only DECIDES.
 *
 * ── Why not `superseded` / `expired` ────────────────────────────────────────
 * A stale offer stays formally `pending` — the customer could still accept it.
 * `superseded` is a fresh provider quote; `expired` is a time lapse. Stale is a
 * distinct flag on the same `pending` offer (Implementation-Spec §4). Only
 * `pending` offers are ever marked stale.
 */

import type { Offer, OfferStaleReason } from '../../offers/types'
import type { VerifyChangeSummary } from './verifyChangeSummary'

// ─────────────────────────────────────────────────────────────────────────────
// VF-2 threshold
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The VF-2 dimension threshold — a relative change above this fraction (5 %)
 * in any wall dimension trips the `measurement_changed` stale reason.
 * Implementation-Spec §3 VF-2 ("> 5 % change in any dimension").
 */
export const RE_QUOTE_DIMENSION_THRESHOLD = 0.05

/**
 * The outcome of {@link evaluateReQuoteTrigger}: whether the customer's verify
 * changes crossed the VF-2 threshold, and — if so — which reason fired first.
 */
export type ReQuoteEvaluation =
  /** No condition tripped — existing pending quotes stay valid. */
  | { triggered: false }
  /** The VF-2 threshold was crossed. `reason` is the first-firing trigger. */
  | { triggered: true; reason: OfferStaleReason }

/**
 * Return `true` when a single wall-height correction crossed the 5 % VF-2
 * threshold. Length is not customer-correctable in V1 (walls store length
 * parametrically; `resize_wall` only touches height/thickness — see
 * `spatialVerifyWorkflow.buildWallCorrectionCommand`), so the measurement
 * trigger evaluates the height delta.
 */
function heightCrossedThreshold(beforeM: number, afterM: number): boolean {
  if (beforeM <= 0) {
    // A degenerate base height — any positive after-value is "significant".
    return afterM > 0
  }
  return Math.abs(afterM - beforeM) / beforeM > RE_QUOTE_DIMENSION_THRESHOLD
}

/**
 * Evaluate the VF-2 Re-Quote trigger against a Stage-5 verify change-summary.
 *
 * The three OR-ed conditions are checked in a fixed priority order so the
 * reason is deterministic:
 *
 *   1. `measurement_changed`     — any wall height moved > 5 %.
 *   2. `high_severity_pin_added` — any new pin with `severity === 'high'`.
 *   3. `layout_changed`          — any wall deleted / opening added or moved.
 *
 * Returns `{ triggered: false }` when none fired — the customer's edits were
 * cosmetic and the provider's quotes still hold.
 *
 * @param summary the {@link VerifyChangeSummary} from `deriveVerifyChangeSummary`.
 */
export function evaluateReQuoteTrigger(summary: VerifyChangeSummary): ReQuoteEvaluation {
  // 1 · measurement — any wall height past the 5 % threshold.
  const significantMeasurement = summary.measurements.some((m) =>
    heightCrossedThreshold(m.heightBeforeM, m.heightAfterM),
  )
  if (significantMeasurement) {
    return { triggered: true, reason: 'measurement_changed' }
  }

  // 2 · a new high-severity damage pin.
  const highSeverityPin = summary.pins.some((p) => p.severity === 'high')
  if (highSeverityPin) {
    return { triggered: true, reason: 'high_severity_pin_added' }
  }

  // 3 · any layout change (wall delete / opening add / opening move).
  if (summary.layout.length > 0) {
    return { triggered: true, reason: 'layout_changed' }
  }

  return { triggered: false }
}

// ─────────────────────────────────────────────────────────────────────────────
// markQuotesStale — the offer-selection plan
// ─────────────────────────────────────────────────────────────────────────────

/** One offer the workflow has decided to flag stale, with the patch to apply. */
export interface StaleOfferPlan {
  /** The `offers.id` to update. */
  offerId: string
  /** Why it is stale — the VF-2 reason. */
  reason: OfferStaleReason
  /** Unix-ms timestamp the flag is being set. */
  markedAt: number
  /** The `spatial_scenes.id` whose verify change tripped the trigger. */
  sourceSceneId: string
}

/**
 * Plan the QUOTE-STALE writes for a completed Stage-2/3/4 verify edit.
 *
 * Given the candidate offers (typically every offer for the project the scene
 * belongs to) and the VF-2 evaluation, this returns the subset that must be
 * flagged stale, each with its `is_stale` patch. The caller then runs the
 * patches through the offers domain (`updateOffer`) — this module performs NO
 * write itself (pure layer).
 *
 * Selection rules (Implementation-Spec §4):
 *   - only `status === 'pending'` offers are ever marked stale,
 *   - an offer already `isStale` is skipped (idempotent — no churned timestamp),
 *   - when the VF-2 trigger did NOT fire, the plan is empty.
 *
 * @param offers       candidate offers (any status — filtered here).
 * @param evaluation   the {@link evaluateReQuoteTrigger} result.
 * @param sourceSceneId the scene whose change triggered the re-quote.
 * @param markedAt     the timestamp to stamp (injected for deterministic tests).
 */
export function planMarkQuotesStale(
  offers: readonly Offer[],
  evaluation: ReQuoteEvaluation,
  sourceSceneId: string,
  markedAt: number = Date.now(),
): StaleOfferPlan[] {
  if (!evaluation.triggered) return []
  const plans: StaleOfferPlan[] = []
  for (const offer of offers) {
    // Only a live (pending) quote can go stale — a closed / draft offer has
    // no out-of-date basis to flag.
    if (offer.status !== 'pending') continue
    // Idempotent — re-running verify must not churn an already-stale flag.
    if (offer.isStale === true) continue
    plans.push({
      offerId: offer.id,
      reason: evaluation.reason,
      markedAt,
      sourceSceneId,
    })
  }
  return plans
}

/**
 * Apply a {@link StaleOfferPlan} to an {@link Offer}, returning the patched
 * offer. The pure mapping the offers-domain `updateOffer` updater calls — it
 * sets the four QUOTE-STALE fields and leaves everything else (including
 * `status`, which stays `pending`) untouched.
 */
export function applyStalePlan(offer: Offer, plan: StaleOfferPlan): Offer {
  return {
    ...offer,
    isStale: true,
    staleReason: plan.reason,
    staleMarkedAt: plan.markedAt,
    staleSourceSceneId: plan.sourceSceneId,
  }
}
