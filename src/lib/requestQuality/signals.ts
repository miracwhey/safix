import type { InquiryOrigin } from '../messages/types'
import type { RequestQualitySignals } from './score'

/**
 * Raw inputs needed to derive a request's quality signals, decoupled from the
 * store/repository layer so the derivation stays pure and unit-testable.
 *
 * Field precedence mirrors how the craftsman request detail enriches its view:
 * explicit conversation fields first, then reel `inquiryCriteria`, then a linked
 * structured project (project-origin inquiries).
 */
export type RequestQualitySignalSources = {
  /** How the customer reached out. `null` = no inquiry origin. */
  inquiryOrigin: InquiryOrigin | null
  /** Structured reel search criteria, present only for reel-origin inquiries. */
  inquiryCriteria?: {
    category?: string
    description?: string
    location?: string
    budget?: string
    timing?: string
  }
  projectDescription?: string
  projectLocation?: string
  projectCostRange?: string
  projectDuration?: string
  /** Category of the linked structured project (project-origin inquiries). */
  linkedProjectCategory?: string
  /** Description of the linked structured project (length-scoring fallback). */
  linkedProjectDescription?: string
  /** True if a structured project card is attached to the thread's messages. */
  hasProjectAttachment: boolean
  /** True if the customer has a completed prior job (proven payer). */
  isReturningCustomer?: boolean
}

/** Returns the first non-blank, trimmed value, or undefined. */
function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

/**
 * Derives the intrinsic quality signals for an incoming request.
 *
 * Origin-aware mapping (verified against the inquiry workflows):
 * - Category: `inquiryCriteria.category` (reel) → linked project category
 *   (project). Profile/category-text inquiries carry no explicit category.
 *   NOTE: `projectSubtitle` is a status label ("Neue Anfrage"), never a category.
 * - Description: explicit `projectDescription` (category/project) → reel
 *   `inquiryCriteria.description` → linked project description.
 * - Location/budget/timing: explicit conversation field → reel criteria.
 * - Structured project: the message attachment flag — NOT `sourceProjectId`,
 *   which is merely the project-origin marker.
 *
 * Signals that require async I/O or unhydrated data (customer verification,
 * spatial scan presence) are intentionally left undefined so the scorer
 * excludes them from the normalised denominator until they are wired in.
 */
export function deriveRequestQualitySignals(
  src: RequestQualitySignalSources,
): RequestQualitySignals {
  const category = firstNonEmpty(src.inquiryCriteria?.category, src.linkedProjectCategory)
  const description = firstNonEmpty(
    src.projectDescription,
    src.inquiryCriteria?.description,
    src.linkedProjectDescription,
  )
  const location = firstNonEmpty(src.projectLocation, src.inquiryCriteria?.location)
  const budget = firstNonEmpty(src.projectCostRange, src.inquiryCriteria?.budget)
  const timing = firstNonEmpty(src.projectDuration, src.inquiryCriteria?.timing)

  return {
    hasCategory: category !== undefined,
    description,
    hasLocation: location !== undefined,
    hasBudget: budget !== undefined,
    hasTiming: timing !== undefined,
    origin: src.inquiryOrigin,
    hasStructuredProject: src.hasProjectAttachment,
    isReturningCustomer: src.isReturningCustomer,
    // Deferred to phase 2 (undefined → excluded from normalisation):
    //   customerVerified      — auth confirmation not on conversation/profile
    //   customerHasRealProfile — non-discriminating (name nearly always present)
    //   hasSpatialScan         — async-only shared-scan lookup; would N+1 the inbox
  }
}
