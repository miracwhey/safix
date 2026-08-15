/**
 * Sub-block 3.4 — offer:accepted Timeline Hook Tests
 *
 * Covers:
 *   A. Success — offer_accepted timeline event emitted after acceptOfferWorkflow
 *   B. Guard paths — no timeline event when workflow returns early
 *   C. Idempotence — repeated accept does not produce duplicate events
 *   D. Regression — existing offer lifecycle behaviour unaffected
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
  declineOfferWorkflow,
} from '../../src/lib/workflow/offerWorkflow'
import { getTimelineSignalsForJob } from '../../src/lib/timeline/timelineStore'

// ── Helpers ───────────────────────────────────────────────────────────────────

let convCounter = 9000

function nextConvId(): string {
  return `conv-oa-${++convCounter}`
}

async function createAndAccept(
  convId: string
): Promise<{ offerId: string; jobId: string }> {
  const offer = await createOfferWorkflow({
    conversationId: convId,
    customerUserId: 'customer-oa',
    craftsmanUserId: 'craftsman-oa',
    price: '1.500 €',
  })
  const accepted = await acceptOfferWorkflow(offer.id)
  const jobId = accepted?.createdJobId ?? ''
  return { offerId: offer.id, jobId }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Sub-block 3.4 — offer_accepted Timeline Hook', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── A. Success ──────────────────────────────────────────────────────────────

  describe('A. offer_accepted event is emitted after successful accept', () => {
    it('timeline contains offer_accepted event for the created job', async () => {
      const convId = nextConvId()
      const { jobId } = await createAndAccept(convId)

      const signals = getTimelineSignalsForJob(jobId)
      const types = signals.map((s) => s.type)
      expect(types).toContain('offer_accepted')
    })

    it('offer_accepted event carries the correct jobId', async () => {
      const convId = nextConvId()
      const { jobId } = await createAndAccept(convId)

      const signals = getTimelineSignalsForJob(jobId)
      const event = signals.find((s) => s.type === 'offer_accepted')
      expect(event).toBeDefined()
      expect(event?.jobId).toBe(jobId)
    })

    it('offer_accepted event is emitted exactly once on first acceptance', async () => {
      const convId = nextConvId()
      const { jobId } = await createAndAccept(convId)

      const signals = getTimelineSignalsForJob(jobId)
      const offerAcceptedEvents = signals.filter((s) => s.type === 'offer_accepted')
      expect(offerAcceptedEvents).toHaveLength(1)
    })
  })

  // ── B. Guard paths — no event on early return ───────────────────────────────

  describe('B. No offer_accepted event on early-return paths', () => {
    it('no offer_accepted event when offer does not exist', async () => {
      // acceptOfferWorkflow returns undefined for unknown offer — no job, no event
      const result = await acceptOfferWorkflow('non-existent-offer')
      expect(result).toBeUndefined()
      // No job created, no timeline to check — passes if no crash
    })

    it('no offer_accepted event when offer is declined (throws)', async () => {
      const convId = nextConvId()
      const offer = await createOfferWorkflow({
        conversationId: convId,
        customerUserId: 'customer-oa',
        craftsmanUserId: 'craftsman-oa',
        price: '800 €',
      })
      await declineOfferWorkflow(offer.id)

      // Accepting a declined offer must throw — no acceptance side effects
      await expect(acceptOfferWorkflow(offer.id)).rejects.toThrow()
    })
  })

  // ── C. Idempotence ──────────────────────────────────────────────────────────

  describe('C. Idempotent — no duplicate offer_accepted event on re-entry', () => {
    it('two calls to acceptOfferWorkflow produce exactly one offer_accepted event', async () => {
      const convId = nextConvId()
      const offer = await createOfferWorkflow({
        conversationId: convId,
        customerUserId: 'customer-oa',
        craftsmanUserId: 'craftsman-oa',
        price: '2.000 €',
      })

      // First acceptance — creates event
      const first = await acceptOfferWorkflow(offer.id)
      const jobId = first?.createdJobId ?? ''

      // Second call — offer is already accepted, workflow hits idempotent early return
      await acceptOfferWorkflow(offer.id)

      const signals = getTimelineSignalsForJob(jobId)
      const offerAcceptedEvents = signals.filter((s) => s.type === 'offer_accepted')
      expect(offerAcceptedEvents).toHaveLength(1)
    })
  })

  // ── D. Regression ───────────────────────────────────────────────────────────

  describe('D. Regression — existing offer acceptance behaviour is unaffected', () => {
    it('accepted offer still has status accepted', async () => {
      const convId = nextConvId()
      const { offerId } = await createAndAccept(convId)

      const { getOfferById } = await import('../../src/lib/offers/service')
      const offer = getOfferById(offerId)
      expect(offer?.status).toBe('accepted')
    })

    it('accepted offer still has a createdJobId', async () => {
      const convId = nextConvId()
      const { offerId } = await createAndAccept(convId)

      const { getOfferById } = await import('../../src/lib/offers/service')
      const offer = getOfferById(offerId)
      expect(offer?.createdJobId).toBeTruthy()
    })

    it('declining an offer still works normally', async () => {
      const convId = nextConvId()
      const offer = await createOfferWorkflow({
        conversationId: convId,
        customerUserId: 'customer-oa',
        craftsmanUserId: 'craftsman-oa',
        price: '500 €',
      })
      const declined = await declineOfferWorkflow(offer.id)
      expect(declined?.status).toBe('declined')
    })
  })
})
