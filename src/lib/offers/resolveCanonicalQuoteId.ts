/**
 * Canonical Quote ID Resolution
 *
 * Single source of truth for resolving a quote/offer entity from any
 * valid identifier that might appear in a quote detail route.
 *
 * Resolution order:
 *   1. Direct offer lookup by ID (canonical path)
 *   2. Reverse lookup by jobId → accepted offer (for stale paths that
 *      pass a jobId where an offerId was expected)
 *
 * If the identifier does not resolve to any offer, returns undefined.
 * The caller must handle the undefined case (loading state, error, etc).
 */

import { getOfferById, getAcceptedOfferByJobId } from './service'
import type { Offer } from './types'

/**
 * Resolves the canonical Offer entity for a quote detail screen.
 *
 * @param identifier  — the route parameter (expected to be an offerId,
 *                      but may be a jobId in legacy/stale paths)
 * @returns the resolved Offer, or undefined if no match is found
 */
export function resolveCanonicalQuoteId(identifier: string): Offer | undefined {
  // 1. Direct lookup — this is the canonical happy path
  const direct = getOfferById(identifier)
  if (direct) return direct

  // 2. Fallback: identifier might be a jobId (stale link / legacy path)
  //    getAcceptedOfferByJobId returns undefined if 0 or >1 match,
  //    so this is safe against ambiguous resolution.
  const byJob = getAcceptedOfferByJobId(identifier)
  if (byJob) return byJob

  return undefined
}
