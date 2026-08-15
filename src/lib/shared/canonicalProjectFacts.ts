/**
 * Canonical Project Facts Resolver
 *
 * Resolves core business facts from the strongest available source for
 * a given job/order context.  Both provider and customer surfaces MUST
 * consume these facts instead of assembling them ad-hoc from partial
 * entity fields.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CANONICAL FACTS HIERARCHY (strongest → weakest per field)
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   title     — Project.title (customer-facing, from intake/conversation)
 *             → Offer.description / Offer.projectTitleSnapshot (accepted-offer context)
 *             → Job.title (often generic "Auftrag aus Angebot" — weakest)
 *
 *   customer  — Project.customer (set from conversation.customerName at creation)
 *             → Job.customer (fallback, may be empty for offer-created jobs)
 *
 *   location  — Project.location (set from conversation.projectLocation at creation)
 *             → Offer.locationSnapshot (snapshot at quote creation time)
 *             → Job.location (may be placeholder "Ort folgt" — weakest)
 *
 *   dateLabel — Project.dateLabel (if non-empty and non-placeholder)
 *             → Offer.timingNote (scheduling context from accepted offer)
 *             → Job.dateLabel (may be placeholder "Termin offen" — weakest)
 *
 *   amount    — resolveCanonicalAmount() (escrow → offer → job)
 *
 *   acceptedOfferLinkage — present when job.sourceOfferId exists:
 *             → sourceOfferId, acceptedAt, offer description/timing context
 *
 * IMPORTANT:
 *   - Generic job placeholders ("Auftrag aus Angebot", "Ort folgt",
 *     "Termin offen") must NOT win when stronger project/offer context exists.
 *   - The same accepted/booked context must resolve to the same facts
 *     for both provider and customer surfaces.
 * ═══════════════════════════════════════════════════════════════════════
 */

import { getJobById } from '../jobs/service'
import { getProjectByJobId } from '../projects'
import { getOfferById } from '../offers/service'
import { resolveCanonicalAmount, type CanonicalAmount } from './canonicalAmountResolver'
import { resolveScheduleDateLabel, isForbiddenTerminValue } from '../scheduling/canonicalScheduling'

/** Known weak/placeholder values that should not win over stronger sources. */
const GENERIC_TITLE_PLACEHOLDER = 'Auftrag aus Angebot'
const LOCATION_PLACEHOLDERS = new Set(['Ort folgt', ''])
const DATE_LABEL_PLACEHOLDERS = new Set(['Termin offen', ''])

export type AcceptedOfferLinkage = {
  /** ID of the accepted offer */
  sourceOfferId: string
  /** Unix timestamp (ms) when the offer was accepted */
  acceptedAt: number | undefined
  /** Offer description (scope of work) */
  description: string
  /** Scheduling / timing note from the offer */
  timingNote: string
}

export type CanonicalProjectFacts = {
  /** Resolved display title — strongest non-placeholder source */
  title: string
  /** Customer display name */
  customer: string
  /** Work location */
  location: string
  /** Scheduling / date label */
  dateLabel: string
  /** Canonical amount resolution (numeric + formatted + source) */
  canonicalAmount: CanonicalAmount
  /** Accepted-offer linkage, present when the job originates from an accepted offer */
  acceptedOfferLinkage: AcceptedOfferLinkage | null
}

// ── Helpers ───────────────────────────────────────────────────────────────

function isNonEmpty(value: string | undefined | null): value is string {
  return value != null && value.trim().length > 0
}

/**
 * Resolves canonical project/order facts for a job.
 *
 * Returns null if the job does not exist.
 */
export function resolveCanonicalProjectFacts(jobId: string): CanonicalProjectFacts | null {
  const job = getJobById(jobId)
  if (!job) return null

  const project = getProjectByJobId(jobId)
  const offer = job.sourceOfferId ? getOfferById(job.sourceOfferId) : undefined
  const canonicalAmount = resolveCanonicalAmount(jobId)

  // ── Title ─────────────────────────────────────────────────────────────
  // Project title is the richest (from conversation.projectTitle at intake).
  // Offer context is the next-best.
  // Job title is weakest — often the generic "Auftrag aus Angebot".
  let title = job.title
  if (isNonEmpty(project?.title) && project!.title !== GENERIC_TITLE_PLACEHOLDER) {
    title = project!.title
  } else if (title === GENERIC_TITLE_PLACEHOLDER) {
    // Try offer context before accepting the generic placeholder
    if (isNonEmpty(offer?.projectTitleSnapshot)) {
      title = offer!.projectTitleSnapshot!
    } else if (isNonEmpty(offer?.description)) {
      title = offer!.description!
    }
  }

  // ── Customer ──────────────────────────────────────────────────────────
  // Project.customer is set from conversation.customerName — richer source.
  const customer = isNonEmpty(project?.customer)
    ? project!.customer
    : job.customer

  // ── Location ──────────────────────────────────────────────────────────
  // Project.location is set from conversation.projectLocation at creation.
  // Offer.locationSnapshot is a secondary enrichment.
  // Job.location may be a placeholder ("Ort folgt").
  let location = job.location
  if (isNonEmpty(project?.location) && !LOCATION_PLACEHOLDERS.has(project!.location)) {
    location = project!.location
  } else if (LOCATION_PLACEHOLDERS.has(location) && isNonEmpty(offer?.locationSnapshot)) {
    location = offer!.locationSnapshot!
  }

  // ── DateLabel / Scheduling ────────────────────────────────────────────
  // CANONICAL SCHEDULING TRUTH FIRST:
  // If a real schedule exists (JobSchedule or CalendarEntry with scheduled status),
  // derive the dateLabel from that schedule data — never from workflow residue.
  // This prevents "Anfrage läuft" or other process labels from appearing in TERMIN.
  const scheduleTruth = resolveScheduleDateLabel(job.id)
  let dateLabel: string
  if (scheduleTruth !== 'Termin offen') {
    // Schedule truth exists — use it unconditionally
    dateLabel = scheduleTruth
  } else {
    // No schedule truth — fall back to project/offer/job metadata hierarchy
    dateLabel = job.dateLabel
    if (isNonEmpty(project?.dateLabel) && !DATE_LABEL_PLACEHOLDERS.has(project!.dateLabel)) {
      dateLabel = project!.dateLabel
    } else if (DATE_LABEL_PLACEHOLDERS.has(dateLabel) && isNonEmpty(offer?.timingNote)) {
      dateLabel = offer!.timingNote!
    }
  }

  // Final guard: never allow forbidden workflow/process labels as dateLabel
  if (isForbiddenTerminValue(dateLabel)) {
    dateLabel = 'Termin offen'
  }

  // ── Accepted-offer linkage ────────────────────────────────────────────
  const acceptedOfferLinkage: AcceptedOfferLinkage | null = offer
    ? {
        sourceOfferId: offer.id,
        acceptedAt: offer.acceptedAt,
        description: offer.description ?? '',
        timingNote: offer.timingNote ?? '',
      }
    : null

  return {
    title,
    customer,
    location,
    dateLabel,
    canonicalAmount,
    acceptedOfferLinkage,
  }
}
