/**
 * Funding Request Foundation Tests
 *
 * Verifies that the persistent funding request entity:
 * 1. Links to accepted quote/job/escrow plan
 * 2. Is idempotent — no duplicates on retry
 * 3. Persists after reload/re-entry
 * 4. Status transitions work correctly
 * 5. Can be queried by multiple keys
 * 6. Integrates with the escrow plan lifecycle
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  ensureFundingRequest,
  getFundingRequestById,
  getFundingRequestByPlanId,
  getFundingRequestByJobId,
  getFundingRequestByOfferId,
  getAllFundingRequests,
  getFundingRequestStatusLabel,
  markFundingRequestSent,
  markFundingStarted,
  markFundingCompleted,
} from '../../src/lib/payments/fundingRequest'
import { ensureEscrowPlan } from '../../src/lib/payments/escrow'
import { addConversation } from '../../src/lib/messages'
import { createOfferWorkflow, acceptOfferWorkflow } from '../../src/lib/workflow'
import { getOfferById } from '../../src/lib/offers'
import { getJobById } from '../../src/lib/jobs'
import { getEscrowPlanByOfferId } from '../../src/lib/payments/escrow'
import type { Conversation } from '../../src/lib/messages/types'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeConversation(id = 'conv-fr-001'): Conversation {
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Max Mustermann',
    customerAvatarUrl: '',
    customerUserId: 'customer-fr',
    craftsmanName: 'Hans Handwerker',
    craftsmanHandle: 'hans-handwerker',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-fr',
    projectTitle: 'Funding Request Test',
    projectSubtitle: 'Test',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'reel',
    messages: [],
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Funding Request Foundation', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  describe('Idempotent creation', () => {
    it('creates a funding request linked to an escrow plan', async () => {
      const plan = await ensureEscrowPlan({
        sourceOfferId: 'offer-fr-1',
        jobId: 'job-fr-1',
        customerUserId: 'customer-fr',
        providerId: 'provider-fr',
        totalAmount: 5000,
      })

      const request = await ensureFundingRequest({
        sourceOfferId: 'offer-fr-1',
        jobId: 'job-fr-1',
        escrowPlanId: plan.id,
        customerUserId: 'customer-fr',
        providerUserId: 'craftsman-fr',
        providerId: 'provider-fr',
        amount: 5000,
        conversationId: 'conv-fr-001',
      })

      expect(request.id).toBeDefined()
      expect(request.sourceOfferId).toBe('offer-fr-1')
      expect(request.jobId).toBe('job-fr-1')
      expect(request.escrowPlanId).toBe(plan.id)
      expect(request.customerUserId).toBe('customer-fr')
      expect(request.providerUserId).toBe('craftsman-fr')
      expect(request.type).toBe('full_escrow')
      expect(request.status).toBe('created')
      expect(request.amount).toBe(5000)
      expect(request.currency).toBe('EUR')
      expect(request.createdBy).toBe('provider')
      expect(request.conversationId).toBe('conv-fr-001')
    })

    it('returns existing funding request on retry (no duplicate)', async () => {
      const plan = await ensureEscrowPlan({
        sourceOfferId: 'offer-fr-2',
        jobId: 'job-fr-2',
        customerUserId: 'customer-fr',
        providerId: 'provider-fr',
        totalAmount: 3000,
      })

      const first = await ensureFundingRequest({
        sourceOfferId: 'offer-fr-2',
        jobId: 'job-fr-2',
        escrowPlanId: plan.id,
        customerUserId: 'customer-fr',
        providerUserId: 'craftsman-fr',
        providerId: 'provider-fr',
        amount: 3000,
      })

      const second = await ensureFundingRequest({
        sourceOfferId: 'offer-fr-2',
        jobId: 'job-fr-2',
        escrowPlanId: plan.id,
        customerUserId: 'customer-fr',
        providerUserId: 'craftsman-fr',
        providerId: 'provider-fr',
        amount: 3000,
      })

      expect(second.id).toBe(first.id)
      expect(getAllFundingRequests()).toHaveLength(1)
    })

    it('does not create duplicate funding requests on reload/re-entry', async () => {
      const plan = await ensureEscrowPlan({
        sourceOfferId: 'offer-fr-reload',
        jobId: 'job-fr-reload',
        customerUserId: 'customer-fr',
        providerId: 'provider-fr',
        totalAmount: 4000,
      })

      // Simulate multiple calls (e.g., from different app re-entries)
      for (let i = 0; i < 5; i++) {
        await ensureFundingRequest({
          sourceOfferId: 'offer-fr-reload',
          jobId: 'job-fr-reload',
          escrowPlanId: plan.id,
          customerUserId: 'customer-fr',
          providerUserId: 'craftsman-fr',
        providerId: 'provider-fr',
          amount: 4000,
        })
      }

      expect(getAllFundingRequests()).toHaveLength(1)
    })
  })

  describe('Query operations', () => {
    it('finds funding request by ID', async () => {
      const plan = await ensureEscrowPlan({
        sourceOfferId: 'offer-fr-q1',
        jobId: 'job-fr-q1',
        customerUserId: 'customer-fr',
        providerId: 'provider-fr',
        totalAmount: 2000,
      })

      const request = await ensureFundingRequest({
        sourceOfferId: 'offer-fr-q1',
        jobId: 'job-fr-q1',
        escrowPlanId: plan.id,
        customerUserId: 'customer-fr',
        providerUserId: 'craftsman-fr',
        providerId: 'provider-fr',
        amount: 2000,
      })

      expect(getFundingRequestById(request.id)).toEqual(request)
    })

    it('finds funding request by escrow plan ID', async () => {
      const plan = await ensureEscrowPlan({
        sourceOfferId: 'offer-fr-q2',
        jobId: 'job-fr-q2',
        customerUserId: 'customer-fr',
        providerId: 'provider-fr',
        totalAmount: 2000,
      })

      const request = await ensureFundingRequest({
        sourceOfferId: 'offer-fr-q2',
        jobId: 'job-fr-q2',
        escrowPlanId: plan.id,
        customerUserId: 'customer-fr',
        providerUserId: 'craftsman-fr',
        providerId: 'provider-fr',
        amount: 2000,
      })

      expect(getFundingRequestByPlanId(plan.id)?.id).toBe(request.id)
    })

    it('finds funding request by job ID', async () => {
      const plan = await ensureEscrowPlan({
        sourceOfferId: 'offer-fr-q3',
        jobId: 'job-fr-q3',
        customerUserId: 'customer-fr',
        providerId: 'provider-fr',
        totalAmount: 2000,
      })

      const request = await ensureFundingRequest({
        sourceOfferId: 'offer-fr-q3',
        jobId: 'job-fr-q3',
        escrowPlanId: plan.id,
        customerUserId: 'customer-fr',
        providerUserId: 'craftsman-fr',
        providerId: 'provider-fr',
        amount: 2000,
      })

      expect(getFundingRequestByJobId('job-fr-q3')?.id).toBe(request.id)
    })

    it('finds funding request by offer ID', async () => {
      const plan = await ensureEscrowPlan({
        sourceOfferId: 'offer-fr-q4',
        jobId: 'job-fr-q4',
        customerUserId: 'customer-fr',
        providerId: 'provider-fr',
        totalAmount: 2000,
      })

      const request = await ensureFundingRequest({
        sourceOfferId: 'offer-fr-q4',
        jobId: 'job-fr-q4',
        escrowPlanId: plan.id,
        customerUserId: 'customer-fr',
        providerUserId: 'craftsman-fr',
        providerId: 'provider-fr',
        amount: 2000,
      })

      expect(getFundingRequestByOfferId('offer-fr-q4')?.id).toBe(request.id)
    })

    it('returns undefined for non-existent IDs', () => {
      expect(getFundingRequestById('nonexistent')).toBeUndefined()
      expect(getFundingRequestByPlanId('nonexistent')).toBeUndefined()
      expect(getFundingRequestByJobId('nonexistent')).toBeUndefined()
      expect(getFundingRequestByOfferId('nonexistent')).toBeUndefined()
    })
  })

  describe('Status transitions', () => {
    it('transitions from created → sent', async () => {
      const plan = await ensureEscrowPlan({
        sourceOfferId: 'offer-fr-st1',
        jobId: 'job-fr-st1',
        customerUserId: 'customer-fr',
        providerId: 'provider-fr',
        totalAmount: 1500,
      })

      const request = await ensureFundingRequest({
        sourceOfferId: 'offer-fr-st1',
        jobId: 'job-fr-st1',
        escrowPlanId: plan.id,
        customerUserId: 'customer-fr',
        providerUserId: 'craftsman-fr',
        providerId: 'provider-fr',
        amount: 1500,
      })

      const sent = await markFundingRequestSent(request.id, 'msg-123')
      expect(sent?.status).toBe('sent')
      expect(sent?.sentAt).toBeDefined()
      expect(sent?.messageId).toBe('msg-123')
    })

    it('transitions from sent → funding_started', async () => {
      const plan = await ensureEscrowPlan({
        sourceOfferId: 'offer-fr-st2',
        jobId: 'job-fr-st2',
        customerUserId: 'customer-fr',
        providerId: 'provider-fr',
        totalAmount: 1500,
      })

      const request = await ensureFundingRequest({
        sourceOfferId: 'offer-fr-st2',
        jobId: 'job-fr-st2',
        escrowPlanId: plan.id,
        customerUserId: 'customer-fr',
        providerUserId: 'craftsman-fr',
        providerId: 'provider-fr',
        amount: 1500,
      })

      await markFundingRequestSent(request.id)
      const started = await markFundingStarted(request.id)
      expect(started?.status).toBe('funding_started')
    })

    it('transitions from funding_started → funded', async () => {
      const plan = await ensureEscrowPlan({
        sourceOfferId: 'offer-fr-st3',
        jobId: 'job-fr-st3',
        customerUserId: 'customer-fr',
        providerId: 'provider-fr',
        totalAmount: 1500,
      })

      const request = await ensureFundingRequest({
        sourceOfferId: 'offer-fr-st3',
        jobId: 'job-fr-st3',
        escrowPlanId: plan.id,
        customerUserId: 'customer-fr',
        providerUserId: 'craftsman-fr',
        providerId: 'provider-fr',
        amount: 1500,
      })

      await markFundingRequestSent(request.id)
      await markFundingStarted(request.id)
      const funded = await markFundingCompleted(request.id)
      expect(funded?.status).toBe('funded')
      expect(funded?.fundedAt).toBeDefined()
    })

    it('is idempotent: double-send does not change state', async () => {
      const plan = await ensureEscrowPlan({
        sourceOfferId: 'offer-fr-st4',
        jobId: 'job-fr-st4',
        customerUserId: 'customer-fr',
        providerId: 'provider-fr',
        totalAmount: 1500,
      })

      const request = await ensureFundingRequest({
        sourceOfferId: 'offer-fr-st4',
        jobId: 'job-fr-st4',
        escrowPlanId: plan.id,
        customerUserId: 'customer-fr',
        providerUserId: 'craftsman-fr',
        providerId: 'provider-fr',
        amount: 1500,
      })

      await markFundingRequestSent(request.id)
      const second = await markFundingRequestSent(request.id)
      expect(second?.status).toBe('sent')
    })

    it('is idempotent: double-complete does not change state', async () => {
      const plan = await ensureEscrowPlan({
        sourceOfferId: 'offer-fr-st5',
        jobId: 'job-fr-st5',
        customerUserId: 'customer-fr',
        providerId: 'provider-fr',
        totalAmount: 1500,
      })

      const request = await ensureFundingRequest({
        sourceOfferId: 'offer-fr-st5',
        jobId: 'job-fr-st5',
        escrowPlanId: plan.id,
        customerUserId: 'customer-fr',
        providerUserId: 'craftsman-fr',
        providerId: 'provider-fr',
        amount: 1500,
      })

      await markFundingRequestSent(request.id)
      await markFundingStarted(request.id)
      await markFundingCompleted(request.id)
      const second = await markFundingCompleted(request.id)
      expect(second?.status).toBe('funded')
    })
  })

  describe('Status labels', () => {
    it('returns German labels for all statuses', () => {
      expect(getFundingRequestStatusLabel('created')).toBe('Erstellt')
      expect(getFundingRequestStatusLabel('sent')).toBe('Gesendet')
      expect(getFundingRequestStatusLabel('funding_started')).toBe('Einzahlung gestartet')
      expect(getFundingRequestStatusLabel('funded')).toBe('Finanziert')
      expect(getFundingRequestStatusLabel('expired')).toBe('Abgelaufen')
      expect(getFundingRequestStatusLabel('cancelled')).toBe('Storniert')
    })
  })

  describe('Integration with offer acceptance workflow', () => {
    it('creates a funding request after offer acceptance + escrow plan creation', async () => {
      const conv = makeConversation('conv-fr-wf')
      await addConversation(conv)

      const offer = await createOfferWorkflow({
        conversationId: conv.id,
        customerUserId: 'customer-fr',
        craftsmanUserId: 'craftsman-fr',
        price: '5.000 €',
      })

      await acceptOfferWorkflow(offer.id)

      const acceptedOffer = getOfferById(offer.id)!
      expect(acceptedOffer.status).toBe('accepted')

      const plan = getEscrowPlanByOfferId(offer.id)
      expect(plan).toBeDefined()

      // Now create the funding request (this would be triggered by the craftsman)
      const request = await ensureFundingRequest({
        sourceOfferId: offer.id,
        jobId: acceptedOffer.createdJobId!,
        escrowPlanId: plan!.id,
        customerUserId: 'customer-fr',
        providerUserId: 'craftsman-fr',
        providerId: 'provider-fr',
        amount: plan!.totalAmount,
        conversationId: conv.id,
      })

      expect(request.sourceOfferId).toBe(offer.id)
      expect(request.jobId).toBe(acceptedOffer.createdJobId)
      expect(request.escrowPlanId).toBe(plan!.id)
      expect(request.amount).toBe(5000)
      expect(request.conversationId).toBe(conv.id)
    })

    it('funding request persists after simulated reload', async () => {
      const conv = makeConversation('conv-fr-reload')
      await addConversation(conv)

      const offer = await createOfferWorkflow({
        conversationId: conv.id,
        customerUserId: 'customer-fr',
        craftsmanUserId: 'craftsman-fr',
        price: '3.000 €',
      })

      await acceptOfferWorkflow(offer.id)
      const plan = getEscrowPlanByOfferId(offer.id)!
      const acceptedOffer = getOfferById(offer.id)!

      const request = await ensureFundingRequest({
        sourceOfferId: offer.id,
        jobId: acceptedOffer.createdJobId!,
        escrowPlanId: plan.id,
        customerUserId: 'customer-fr',
        providerUserId: 'craftsman-fr',
        providerId: 'provider-fr',
        amount: plan.totalAmount,
      })

      // Simulate "reload": re-query the funding request
      const reloaded = getFundingRequestByPlanId(plan.id)
      expect(reloaded).toBeDefined()
      expect(reloaded!.id).toBe(request.id)
      expect(reloaded!.amount).toBe(3000)
      expect(reloaded!.status).toBe('created')
    })
  })

  describe('No regression to quote lifecycle', () => {
    it('quote accept/decline still works after adding funding request support', async () => {
      const conv = makeConversation('conv-fr-noreg')
      await addConversation(conv)

      const offer = await createOfferWorkflow({
        conversationId: conv.id,
        customerUserId: 'customer-fr',
        craftsmanUserId: 'craftsman-fr',
        price: '2.000 €',
      })

      expect(offer.status).toBe('pending')

      // Accept
      const accepted = await acceptOfferWorkflow(offer.id)
      expect(accepted.status).toBe('accepted')
      expect(accepted.createdJobId).toBeDefined()

      // Job exists
      const job = getJobById(accepted.createdJobId!)
      expect(job).toBeDefined()

      // Escrow plan exists
      const plan = getEscrowPlanByOfferId(offer.id)
      expect(plan).toBeDefined()
      expect(plan!.status).toBe('awaiting_customer_funding')
    })
  })

  describe('No regression to escrow plan creation', () => {
    it('escrow plan still creates correctly with 25/75 tranches', async () => {
      const plan = await ensureEscrowPlan({
        sourceOfferId: 'offer-fr-ep',
        jobId: 'job-fr-ep',
        customerUserId: 'customer-fr',
        providerId: 'provider-fr',
        totalAmount: 10000,
      })

      expect(plan.totalAmount).toBe(10000)
      expect(plan.fundingMode).toBe('full_upfront_escrow')
      expect(plan.releaseModel).toBe('start_25_completion_75')

      const { getEscrowTranches } = await import('../../src/lib/payments/escrow')
      const tranches = getEscrowTranches(plan.id)
      expect(tranches).toHaveLength(2)

      const deposit = tranches.find((t) => t.kind === 'deposit_release')
      const final = tranches.find((t) => t.kind === 'final_release')
      expect(deposit!.amount).toBe(2500)
      expect(final!.amount).toBe(7500)
      expect(deposit!.amount + final!.amount).toBe(10000)
    })
  })
})
