import type { Offer, OfferStatus } from './types'
import { getOfferRepository } from './repository/registry'

export function getOffers(): Offer[] {
  return getOfferRepository().getAll()
}

export function getOfferById(id: string): Offer | undefined {
  return getOfferRepository().getById(id)
}

export function getOffersByConversationId(conversationId: string): Offer[] {
  return getOfferRepository().getByConversationId(conversationId)
}

/**
 * Returns the currently active (pending) offer for a conversation, if any.
 */
export function getActiveOfferForConversation(conversationId: string): Offer | undefined {
  return getOfferRepository()
    .getByConversationId(conversationId)
    .find((o) => o.status === 'pending')
}

/**
 * Returns the unique accepted offer whose `createdJobId` matches the given
 * job ID.  This is the canonical reverse lookup for recovering a missing
 * `job.sourceOfferId`.
 *
 * Returns `undefined` when no match exists **or** when more than one
 * accepted offer points to the same job (ambiguous — caller must not
 * auto-recover).
 *
 * Safety: only considers offers with status === 'accepted' and a non-null
 * `createdJobId` that exactly equals `jobId`.
 */
export function getAcceptedOfferByJobId(jobId: string): Offer | undefined {
  const matches = getOfferRepository()
    .getAll()
    .filter((o) => o.status === 'accepted' && o.createdJobId === jobId)
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * Returns the follow-up binding_offer that was created after a diagnosis
 * einsatz.  The follow-up carry `sourceDiagnosisId === diagnosisOfferId`.
 *
 * Used as a reverse lookup: given a diagnosis offer, find any existing
 * follow-up so the UI can show it rather than offering to create another.
 * Returns the first match — at most one follow-up is expected per diagnosis.
 */
export function getFollowUpOfferForDiagnosis(diagnosisOfferId: string): Offer | undefined {
  return getOfferRepository()
    .getAll()
    .find((o) => o.sourceDiagnosisId === diagnosisOfferId)
}

export function subscribeOffers(listener: () => void): () => void {
  return getOfferRepository().subscribe(listener)
}

/**
 * Returns `true` once the offer repository has completed its initial data
 * load.  Used by screens to distinguish "not loaded yet" from "genuinely
 * does not exist" without resorting to a timeout.
 */
export function isOfferRepositoryHydrated(): boolean {
  return getOfferRepository().isHydrated()
}

export async function addOffer(offer: Offer): Promise<void> {
  return getOfferRepository().add(offer)
}

/**
 * Updates an offer with lifecycle enforcement.
 *
 * This is the public mutation API — it enforces lifecycle rules:
 * - Accepted/locked offers cannot be mutated (immutable in normal flow)
 * - Declined/expired/superseded/cancelled offers cannot be mutated
 * - Only pending and draft offers can be freely updated
 *
 * Valid status transitions (enforced when the updater changes status):
 *   pending  → accepted | declined
 *   draft    → pending
 *
 * @throws {Error} If the offer is in a terminal/locked state
 * @throws {Error} If the status transition is invalid
 */
export async function updateOffer(offerId: string, updater: (offer: Offer) => Offer): Promise<void> {
  const current = getOfferRepository().getById(offerId)
  if (!current) return

  // Block any mutation on locked/terminal offers
  if (IMMUTABLE_STATUSES.has(current.status)) {
    throw new Error(
      `Offer ${offerId} is ${current.status} and cannot be modified. ` +
      `${current.status === 'accepted' ? 'Accepted quotes are locked and immutable.' : 'This quote is no longer active.'}`
    )
  }

  // Peek at the intended update to validate status transitions
  const intended = updater(current)
  if (intended.status !== current.status) {
    const allowed = VALID_TRANSITIONS.get(current.status)
    if (!allowed || !allowed.has(intended.status)) {
      throw new Error(
        `Invalid offer status transition: ${current.status} → ${intended.status}. ` +
        `Offer ${offerId} cannot change from '${current.status}' to '${intended.status}'.`
      )
    }
  }

  return getOfferRepository().update(offerId, updater)
}

// ── Lifecycle Guards ──────────────────────────────────────────────────────

/** Statuses where the quote is no longer actionable (cannot accept/decline). */
const INACTIVE_STATUSES: ReadonlySet<OfferStatus> = new Set<OfferStatus>([
  'accepted', 'declined', 'expired', 'superseded', 'cancelled',
])

/**
 * Statuses where the offer is immutable — no normal-flow mutations allowed.
 * This is the enforcement set used by `updateOffer()`.
 */
const IMMUTABLE_STATUSES: ReadonlySet<OfferStatus> = new Set<OfferStatus>([
  'accepted', 'declined', 'expired', 'superseded', 'cancelled',
])

/**
 * Allowed status transitions in normal runtime flow.
 * Any transition not listed here is rejected by `updateOffer()`.
 *
 * pending → superseded is used by supersedeOfferWorkflow when the craftsman
 * revises a sent quote — the old one is superseded, a new version is created.
 */
const VALID_TRANSITIONS: ReadonlyMap<OfferStatus, ReadonlySet<OfferStatus>> = new Map([
  ['draft',   new Set<OfferStatus>(['pending'])],
  ['pending', new Set<OfferStatus>(['accepted', 'declined', 'superseded', 'expired'])],
])

/**
 * Returns `true` when the offer has been accepted and is locked against
 * normal edits.  Locked offers are the binding basis for a job and must
 * not be mutated outside of a formal change-order flow (future block).
 */
export function isOfferLocked(offer: Offer): boolean {
  return offer.status === 'accepted' || offer.lockedAt != null
}

/**
 * Returns `true` when the offer is in a state where accept/decline
 * decisions can still be made (i.e. it is a pending quote).
 */
export function isOfferActionable(offer: Offer): boolean {
  return offer.status === 'pending'
}

/**
 * Returns `true` when the offer is in any terminal/inactive state.
 * Inactive offers should not present as "open" or decision-pending.
 */
export function isOfferInactive(offer: Offer): boolean {
  return INACTIVE_STATUSES.has(offer.status)
}
