/**
 * Quote Lifecycle Hardening — Service & Workflow Enforcement
 *
 * Validates that Block 2 lifecycle rules are enforced at the service/workflow
 * level, not just in the UI:
 *
 *   1. Accepted quotes cannot be edited via updateOffer (service-level block)
 *   2. Declined quotes cannot be edited via updateOffer (service-level block)
 *   3. Accepted quotes cannot be declined (workflow throws)
 *   4. Declined quotes cannot be accepted (workflow throws)
 *   5. Invalid status transitions throw readable errors
 *   6. Accepted → pending/sent is blocked
 *   7. Declined → pending/sent is blocked
 *   8. No regression to existing accept/decline behavior
 *   9. No regression to idempotent re-accept
 *  10. No regression to reload/re-entry stability
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
  declineOfferWorkflow,
} from '../../src/lib/workflow/offerWorkflow'
import {
  updateOffer,
  getOfferById,
  isOfferLocked,
  isOfferActionable,
  isOfferInactive,
} from '../../src/lib/offers/service'
import { getOfferRepository } from '../../src/lib/offers/repository/registry'


describe('Quote Lifecycle Hardening — Block 2 Completion', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // FIX 1 — ACCEPTED QUOTES ARE IMMUTABLE VIA updateOffer
  // ─────────────────────────────────────────────────────────────────────────

  describe('FIX 1 — accepted quotes are immutable in normal flow', () => {
    it('updateOffer throws when trying to edit an accepted offer price', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-h1',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '2.000 €',
      })

      await acceptOfferWorkflow(offer.id)

      await expect(
        updateOffer(offer.id, (o) => ({ ...o, price: '3.000 €' }))
      ).rejects.toThrow(/accepted/)
    })

    it('updateOffer throws when trying to edit an accepted offer description', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-h2',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.500 €',
        description: 'Original scope',
      })

      await acceptOfferWorkflow(offer.id)

      await expect(
        updateOffer(offer.id, (o) => ({ ...o, description: 'Modified scope' }))
      ).rejects.toThrow(/immutable/)
    })

    it('accepted offer data is preserved after blocked mutation attempt', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-h3',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '5.000 €',
      })

      await acceptOfferWorkflow(offer.id)

      try {
        await updateOffer(offer.id, (o) => ({ ...o, price: '1 €' }))
      } catch {
        // Expected
      }

      const persisted = getOfferById(offer.id)
      expect(persisted!.price).toBe('5.000 €')
      expect(persisted!.status).toBe('accepted')
      expect(persisted!.lockedAt).toBeDefined()
    })

    it('updateOffer throws when trying to change accepted offer status to pending', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-h4',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.000 €',
      })

      await acceptOfferWorkflow(offer.id)

      await expect(
        updateOffer(offer.id, (o) => ({ ...o, status: 'pending' as const }))
      ).rejects.toThrow(/accepted/)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // FIX 2 — DECLINED QUOTES STAY INACTIVE
  // ─────────────────────────────────────────────────────────────────────────

  describe('FIX 2 — declined quotes stay inactive', () => {
    it('updateOffer throws when trying to edit a declined offer', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-h5',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '800 €',
      })

      await declineOfferWorkflow(offer.id)

      await expect(
        updateOffer(offer.id, (o) => ({ ...o, price: '700 €' }))
      ).rejects.toThrow(/declined/)
    })

    it('updateOffer throws when trying to revert declined to pending', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-h6',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '600 €',
      })

      await declineOfferWorkflow(offer.id)

      await expect(
        updateOffer(offer.id, (o) => ({ ...o, status: 'pending' as const }))
      ).rejects.toThrow(/no longer active/)
    })

    it('declined offer data is preserved after blocked mutation attempt', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-h7',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '900 €',
      })

      await declineOfferWorkflow(offer.id)

      try {
        await updateOffer(offer.id, (o) => ({ ...o, price: '1 €' }))
      } catch {
        // Expected
      }

      const persisted = getOfferById(offer.id)
      expect(persisted!.price).toBe('900 €')
      expect(persisted!.status).toBe('declined')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // FIX 3 — ILLEGAL STATE TRANSITIONS ARE BLOCKED
  // ─────────────────────────────────────────────────────────────────────────

  describe('FIX 3 — illegal state transitions blocked', () => {
    it('accepted → declined is blocked by workflow', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-h8',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.000 €',
      })

      await acceptOfferWorkflow(offer.id)

      await expect(declineOfferWorkflow(offer.id)).rejects.toThrow(/accepted/)
    })

    it('declined → accepted is blocked by workflow', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-h9',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.200 €',
      })

      await declineOfferWorkflow(offer.id)

      await expect(acceptOfferWorkflow(offer.id)).rejects.toThrow(/declined/)
    })

    it('accepted → pending is blocked by service', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-h10',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '2.500 €',
      })

      await acceptOfferWorkflow(offer.id)

      await expect(
        updateOffer(offer.id, (o) => ({ ...o, status: 'pending' as const }))
      ).rejects.toThrow()
    })

    it('declined → pending is blocked by service', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-h11',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '700 €',
      })

      await declineOfferWorkflow(offer.id)

      await expect(
        updateOffer(offer.id, (o) => ({ ...o, status: 'pending' as const }))
      ).rejects.toThrow()
    })

    it('pending → expired is allowed (server-side expiry cron transition)', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-h12',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '400 €',
      })

      // pending → expired is the cron-driven transition. Must succeed.
      await expect(
        updateOffer(offer.id, (o) => ({ ...o, status: 'expired' as const, updatedAt: Date.now() }))
      ).resolves.not.toThrow()
    })

    it('pending → cancelled is blocked (no valid transition)', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-h13',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '300 €',
      })

      await expect(
        updateOffer(offer.id, (o) => ({ ...o, status: 'cancelled' as const }))
      ).rejects.toThrow(/Invalid offer status transition/)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // FIX 4 — SERVICE ENFORCEMENT (not just UI)
  // ─────────────────────────────────────────────────────────────────────────

  describe('FIX 4 — service/workflow enforcement', () => {
    it('updateOffer is the enforcement point (not just UI buttons)', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-h14',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.800 €',
      })

      // First update on pending offer succeeds
      await updateOffer(offer.id, (o) => ({
        ...o,
        description: 'Updated scope',
        updatedAt: Date.now(),
      }))

      const updated = getOfferById(offer.id)
      expect(updated!.description).toBe('Updated scope')

      // Accept the offer
      await acceptOfferWorkflow(offer.id)

      // Now the same updateOffer call fails
      await expect(
        updateOffer(offer.id, (o) => ({
          ...o,
          description: 'Attempted change after acceptance',
          updatedAt: Date.now(),
        }))
      ).rejects.toThrow(/immutable/)
    })

    it('valid pending → accepted transition still works through workflow', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-h15',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '3.000 €',
      })

      const accepted = await acceptOfferWorkflow(offer.id)

      expect(accepted!.status).toBe('accepted')
      expect(accepted!.lockedAt).toBeDefined()
      expect(accepted!.createdJobId).toBeDefined()
    })

    it('valid pending → declined transition still works through workflow', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-h16',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '2.200 €',
      })

      const declined = await declineOfferWorkflow(offer.id)

      expect(declined!.status).toBe('declined')
      expect(declined!.declinedAt).toBeDefined()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // FIX 5 — CONSISTENT ERROR SURFACES
  // ─────────────────────────────────────────────────────────────────────────

  describe('FIX 5 — consistent error surfaces', () => {
    it('error from accepted offer mutation is human-readable', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-h17',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '500 €',
      })

      await acceptOfferWorkflow(offer.id)

      try {
        await updateOffer(offer.id, (o) => ({ ...o, price: '999 €' }))
        expect.unreachable('Should have thrown')
      } catch (err) {
        const message = (err as Error).message
        expect(message).toContain('accepted')
        expect(message).toContain('immutable')
        expect(message).toContain(offer.id)
      }
    })

    it('error from declined offer mutation is human-readable', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-h18',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '400 €',
      })

      await declineOfferWorkflow(offer.id)

      try {
        await updateOffer(offer.id, (o) => ({ ...o, price: '999 €' }))
        expect.unreachable('Should have thrown')
      } catch (err) {
        const message = (err as Error).message
        expect(message).toContain('declined')
        expect(message).toContain('no longer active')
        expect(message).toContain(offer.id)
      }
    })

    it('error from invalid transition includes both statuses', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-h19',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '350 €',
      })

      // pending → cancelled is not a valid transition; use it to verify error format
      try {
        await updateOffer(offer.id, (o) => ({ ...o, status: 'cancelled' as const }))
        expect.unreachable('Should have thrown')
      } catch (err) {
        const message = (err as Error).message
        expect(message).toContain('pending')
        expect(message).toContain('cancelled')
        expect(message).toContain('Invalid')
      }
    })

    it('error from accept on declined includes clear status', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-h20',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '250 €',
      })

      await declineOfferWorkflow(offer.id)

      try {
        await acceptOfferWorkflow(offer.id)
        expect.unreachable('Should have thrown')
      } catch (err) {
        const message = (err as Error).message
        expect(message).toContain('declined')
        expect(message).toContain('pending')
      }
    })

    it('error from decline on accepted includes clear status', async () => {
      const created = await createOfferWorkflow({
        conversationId: 'conv-h21',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '750 €',
      })

      await acceptOfferWorkflow(created.id)

      try {
        await declineOfferWorkflow(created.id)
        expect.unreachable('Should have thrown')
      } catch (err) {
        const message = (err as Error).message
        expect(message).toContain('accepted')
        expect(message).toContain('pending')
      }
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // NO REGRESSION — EXISTING BEHAVIOR
  // ─────────────────────────────────────────────────────────────────────────

  describe('no regression — existing accept/decline behavior', () => {
    it('accept on pending offer works correctly', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-nr-1',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.600 €',
      })

      const accepted = await acceptOfferWorkflow(offer.id)

      expect(accepted!.status).toBe('accepted')
      expect(accepted!.acceptedAt).toBeDefined()
      expect(accepted!.lockedAt).toBeDefined()
      expect(accepted!.createdJobId).toBeDefined()
    })

    it('decline on pending offer works correctly', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-nr-2',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '900 €',
      })

      const declined = await declineOfferWorkflow(offer.id)

      expect(declined!.status).toBe('declined')
      expect(declined!.declinedAt).toBeDefined()
    })

    it('idempotent re-accept returns same result', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-nr-3',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '2.000 €',
      })

      const first = await acceptOfferWorkflow(offer.id)
      const second = await acceptOfferWorkflow(offer.id)

      expect(second!.status).toBe('accepted')
      expect(second!.acceptedAt).toBe(first!.acceptedAt)
      expect(second!.lockedAt).toBe(first!.lockedAt)
      expect(second!.createdJobId).toBe(first!.createdJobId)
    })

    it('idempotent re-decline returns same result', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-nr-4',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.100 €',
      })

      const first = await declineOfferWorkflow(offer.id)
      const second = await declineOfferWorkflow(offer.id)

      expect(second!.status).toBe('declined')
      expect(second!.declinedAt).toBe(first!.declinedAt)
    })

    it('normal pending offer can be edited via updateOffer', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-nr-5',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.500 €',
      })

      // Editing a pending offer should work
      await updateOffer(offer.id, (o) => ({
        ...o,
        description: 'Added scope details',
        updatedAt: Date.now(),
      }))

      const updated = getOfferById(offer.id)
      expect(updated!.description).toBe('Added scope details')
      expect(updated!.status).toBe('pending')
    })

    it('new offer can be created after decline', async () => {
      const first = await createOfferWorkflow({
        conversationId: 'conv-nr-6',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '1.000 €',
      })

      await declineOfferWorkflow(first.id)

      const second = await createOfferWorkflow({
        conversationId: 'conv-nr-6',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '800 €',
      })

      expect(second.status).toBe('pending')
      expect(second.price).toBe('800 €')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // NO REGRESSION — RELOAD / RE-ENTRY STABILITY
  // ─────────────────────────────────────────────────────────────────────────

  describe('no regression — reload/re-entry stability', () => {
    it('lifecycle guards remain correct on reload for accepted offer', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-nr-7',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '4.000 €',
      })

      await acceptOfferWorkflow(offer.id)

      // Simulate reload: read from repository
      const reloaded = getOfferRepository().getById(offer.id)!
      expect(isOfferLocked(reloaded)).toBe(true)
      expect(isOfferActionable(reloaded)).toBe(false)
      expect(isOfferInactive(reloaded)).toBe(true)

      // Mutation still blocked after reload
      await expect(
        updateOffer(offer.id, (o) => ({ ...o, price: '1 €' }))
      ).rejects.toThrow()
    })

    it('lifecycle guards remain correct on reload for declined offer', async () => {
      const offer = await createOfferWorkflow({
        conversationId: 'conv-nr-8',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '600 €',
      })

      await declineOfferWorkflow(offer.id)

      const reloaded = getOfferRepository().getById(offer.id)!
      expect(isOfferLocked(reloaded)).toBe(false)
      expect(isOfferActionable(reloaded)).toBe(false)
      expect(isOfferInactive(reloaded)).toBe(true)

      // Mutation still blocked after reload
      await expect(
        updateOffer(offer.id, (o) => ({ ...o, price: '1 €' }))
      ).rejects.toThrow()
    })
  })
})
