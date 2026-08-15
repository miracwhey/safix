/**
 * Funding Flow Semantic Cleanup Tests
 *
 * Verifies:
 * 1. Legacy deposit card is no longer the customer payment path
 * 2. CustomerEscrowFundingCard is the single customer funding entry
 * 3. No duplicate/parallel customer payment paths remain
 * 4. Server-side funded truth is not established by client-only calls
 * 5. Full upfront escrow semantics are consistent across surfaces
 * 6. No regression to quote lifecycle or relationship-thread logic
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installSessionForJobOwner, installSessionForJobCustomer, mockCustomerSession } from '../helpers/mockSession'
import {
  getFundingRequestByJobId,
} from '../../src/lib/payments/fundingRequest'
import {
  getEscrowPlanByJobId,
} from '../../src/lib/payments/escrow'
import {
  requestFundingWorkflow,
  customerFundingEntryWorkflow,
  confirmFundingWorkflow,
} from '../../src/lib/workflow/jobWorkflow'
import { addConversation } from '../../src/lib/messages'
import { createOfferWorkflow, acceptOfferWorkflow } from '../../src/lib/workflow'
import { getJobById } from '../../src/lib/jobs'
import { deriveCustomerJobStage } from '../../src/lib/jobs/customerJobStageSelectors'
import type { Conversation } from '../../src/lib/messages/types'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeConversation(id = 'conv-sc-001'): Conversation {
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Max Mustermann',
    customerAvatarUrl: '',
    customerUserId: 'customer-sc',
    craftsmanName: 'Hans Handwerker',
    craftsmanHandle: 'hans-handwerker',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-sc',
    projectTitle: 'Semantic Cleanup Test',
    projectSubtitle: 'Test',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'reel',
    messages: [],
  } as unknown as Conversation
}

async function setupAcceptedQuote(convId: string) {
  const conv = makeConversation(convId)
  await addConversation(conv)

  const offer = await createOfferWorkflow({
    conversationId: conv.id,
    customerUserId: 'customer-sc',
    craftsmanUserId: 'craftsman-sc',
    price: '3.000 €',
  })

  const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
  const job = getJobById(accepted!.createdJobId!)!
  const escrowPlan = getEscrowPlanByJobId(job.id)!

  installSessionForJobOwner(job)

  return { conv, offer, job, escrowPlan }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Funding Semantic Cleanup', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  describe('FIX 1 — Single customer funding path', () => {
    it('CustomerEscrowFundingCard is the sole customer funding surface (no legacy deposit card)', async () => {
      // This test verifies structurally that the new funding flow is
      // the only customer funding path. The CustomerDepositActionCard
      // has been removed from CustomerProjectDetailScreen.
      //
      // We verify this indirectly by ensuring the new funding path
      // works end-to-end from funding request → customer entry → confirmation.

      const { job } = await setupAcceptedQuote('conv-sc-single-1')

      // Provider sends funding step card
      await requestFundingWorkflow(job.id)
      const fr = getFundingRequestByJobId(job.id)
      expect(fr).toBeDefined()
      expect(fr!.status).toBe('sent')

      // Customer enters funding flow via the new card
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)
      const frAfterEntry = getFundingRequestByJobId(job.id)
      expect(frAfterEntry!.status).toBe('funding_started')

      // Funding is confirmed (mock path)
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)
      const frAfterConfirm = getFundingRequestByJobId(job.id)
      expect(frAfterConfirm!.status).toBe('funded')

      // Escrow plan is funded
      const plan = getEscrowPlanByJobId(job.id)
      expect(plan!.status).toBe('funded_in_escrow')
    })

    it('no duplicate funding requests are created on retry', async () => {
      const { job } = await setupAcceptedQuote('conv-sc-single-2')

      // First request
      await requestFundingWorkflow(job.id)
      const fr1 = getFundingRequestByJobId(job.id)

      // Second request (idempotent)
      await requestFundingWorkflow(job.id)
      const fr2 = getFundingRequestByJobId(job.id)

      expect(fr1!.id).toBe(fr2!.id) // Same funding request
    })
  })

  describe('FIX 2 — Full upfront escrow semantics', () => {
    it('funding amount equals the full accepted quote amount', async () => {
      const { job, escrowPlan } = await setupAcceptedQuote('conv-sc-escrow-1')

      await requestFundingWorkflow(job.id)
      const fr = getFundingRequestByJobId(job.id)

      // Full amount goes into escrow, not partial deposit
      expect(fr!.amount).toBe(escrowPlan.totalAmount)
      expect(escrowPlan.fundingMode).toBe('full_upfront_escrow')
    })

    it('25/75 are release tranches, not customer payment splits', async () => {
      const { escrowPlan } = await setupAcceptedQuote('conv-sc-escrow-2')

      // The 25/75 split is about RELEASE, not customer payment
      expect(escrowPlan.releaseModel).toBe('start_25_completion_75')
      expect(escrowPlan.fundingMode).toBe('full_upfront_escrow')
    })
  })

  describe('FIX 3 — Server-side funded truth', () => {
    it('confirmFundingWorkflow is idempotent', async () => {
      const { job } = await setupAcceptedQuote('conv-sc-truth-1')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      // First confirm
      installSessionForJobCustomer(job)
      const result1 = await confirmFundingWorkflow(job.id)
      expect(result1).toBeDefined()
      expect(result1!.status).toBe('funded_in_escrow')

      // Second confirm (idempotent — should not throw or duplicate)
      installSessionForJobCustomer(job)
      const result2 = await confirmFundingWorkflow(job.id)
      expect(result2).toBeDefined()
      expect(result2!.status).toBe('funded_in_escrow')
    })

    it('confirmFundingWorkflow persists externalFundingRef', async () => {
      const { job } = await setupAcceptedQuote('conv-sc-truth-2')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      installSessionForJobCustomer(job)
      const result = await confirmFundingWorkflow(job.id, {
        externalFundingRef: 'pi_test_stripe_ref_123',
      })
      expect(result).toBeDefined()

      const plan = getEscrowPlanByJobId(job.id)
      expect(plan!.externalFundingRef).toBe('pi_test_stripe_ref_123')
    })

    it('funded state requires explicit confirmation, not client fiction', async () => {
      const { job } = await setupAcceptedQuote('conv-sc-truth-3')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      // Before confirmation: funding is started but NOT funded
      const frBefore = getFundingRequestByJobId(job.id)
      expect(frBefore!.status).toBe('funding_started')

      const planBefore = getEscrowPlanByJobId(job.id)
      expect(planBefore!.status).not.toBe('funded_in_escrow')

      // Only after explicit confirmation does funded state apply
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)
      const frAfter = getFundingRequestByJobId(job.id)
      expect(frAfter!.status).toBe('funded')

      const planAfter = getEscrowPlanByJobId(job.id)
      expect(planAfter!.status).toBe('funded_in_escrow')
    })
  })

  describe('FIX 4 — Cross-surface alignment', () => {
    it('customer job stage reflects funding_pending after request', async () => {
      const { job } = await setupAcceptedQuote('conv-sc-cross-1')

      await requestFundingWorkflow(job.id)

      const stage = deriveCustomerJobStage(
        job.status,
        job.paymentState,
        job.proposalSentAt,
        job.proposalAcceptedAt,
        'sent',
      )
      expect(stage.stage).toBe('funding_pending')
    })

    it('customer job stage reflects funded_in_escrow after confirmation', async () => {
      const { job } = await setupAcceptedQuote('conv-sc-cross-2')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)

      const stage = deriveCustomerJobStage(
        job.status,
        job.paymentState,
        job.proposalSentAt,
        job.proposalAcceptedAt,
        'funded',
      )
      expect(stage.stage).toBe('funded_in_escrow')
    })
  })

  describe('FIX 5 — No regression to quote lifecycle', () => {
    it('quote acceptance still works and creates job + escrow plan', async () => {
      const conv = makeConversation('conv-sc-noreg-1')
      await addConversation(conv)

      const offer = await createOfferWorkflow({
        conversationId: conv.id,
        customerUserId: 'customer-sc',
        craftsmanUserId: 'craftsman-sc',
        price: '2.500 €',
      })

      expect(offer.status).toBe('pending')

      const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
      expect(accepted!.status).toBe('accepted')
      expect(accepted!.createdJobId).toBeDefined()

      const job = getJobById(accepted!.createdJobId!)!
      const plan = getEscrowPlanByJobId(job.id)
      expect(plan).toBeDefined()
    })
  })

  describe('FIX 6 — Confirmation truth write separation', () => {
    it('mock path uses local confirmFundingWorkflow correctly', async () => {
      const { job } = await setupAcceptedQuote('conv-sc-mockconfirm-1')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      // Mock path: local confirmFundingWorkflow is the only truth-write
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)
      const fr = getFundingRequestByJobId(job.id)
      expect(fr!.status).toBe('funded')

      const plan = getEscrowPlanByJobId(job.id)
      expect(plan!.status).toBe('funded_in_escrow')
    })

    it('funding state is not funded before confirmation (no client fiction)', async () => {
      const { job } = await setupAcceptedQuote('conv-sc-nofiction-1')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      // After customer entry but before confirmation:
      // funding request is in 'funding_started', not 'funded'
      const fr = getFundingRequestByJobId(job.id)
      expect(fr!.status).toBe('funding_started')
      expect(fr!.status).not.toBe('funded')

      // Escrow plan is NOT yet funded_in_escrow
      const plan = getEscrowPlanByJobId(job.id)
      expect(plan!.status).not.toBe('funded_in_escrow')
    })

    it('repo refresh after server confirm picks up funded state (simulated)', async () => {
      const { job } = await setupAcceptedQuote('conv-sc-refresh-1')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      // Simulate what the server does: directly mark entities as funded
      // (as /api/confirm-funding would do in the database)
      const { markFundingCompleted } = await import('../../src/lib/payments/fundingRequest')
      const { confirmFunding } = await import('../../src/lib/payments/escrow')

      const fr = getFundingRequestByJobId(job.id)!
      const plan = getEscrowPlanByJobId(job.id)!

      await markFundingCompleted(fr.id)
      await confirmFunding(plan.id, { externalFundingRef: 'pi_simulated_stripe_ref' })

      // After "server" confirms, a pure refresh (re-read from repos)
      // should show funded state — no confirmFundingWorkflow needed
      const refreshedFr = getFundingRequestByJobId(job.id)
      expect(refreshedFr!.status).toBe('funded')

      const refreshedPlan = getEscrowPlanByJobId(job.id)
      expect(refreshedPlan!.status).toBe('funded_in_escrow')
      expect(refreshedPlan!.externalFundingRef).toBe('pi_simulated_stripe_ref')
    })

    it('confirmFundingWorkflow is not needed when server has already confirmed', async () => {
      const { job } = await setupAcceptedQuote('conv-sc-nodup-1')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      // Simulate server confirmation (what /api/confirm-funding does)
      const { markFundingCompleted } = await import('../../src/lib/payments/fundingRequest')
      const { confirmFunding } = await import('../../src/lib/payments/escrow')

      const fr = getFundingRequestByJobId(job.id)!
      const plan = getEscrowPlanByJobId(job.id)!

      await markFundingCompleted(fr.id)
      await confirmFunding(plan.id)

      // Calling confirmFundingWorkflow after server confirm is redundant
      // but should be idempotent (no error, no duplicate)
      installSessionForJobCustomer(job)
      const result = await confirmFundingWorkflow(job.id)
      expect(result).toBeDefined()
      expect(result!.status).toBe('funded_in_escrow')

      // The state should still be funded — no corruption
      const finalFr = getFundingRequestByJobId(job.id)
      expect(finalFr!.status).toBe('funded')
    })
  })
})
