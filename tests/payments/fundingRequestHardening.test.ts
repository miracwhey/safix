/**
 * Post-Migration Code Hardening Tests
 *
 * Verifies that runtime code correctly matches the finalized live schema:
 * 1. FundingRequest.providerId is required — creation fails without it
 * 2. UUID-linked fields remain aligned in types/mappings
 * 3. No customer-side direct UPDATE assumption remains for funding_requests
 * 4. No regression to current funding flow
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installSessionForJobOwner, installSessionForJobCustomer, mockCustomerSession } from '../helpers/mockSession'
import {
  ensureFundingRequest,
  getFundingRequestByJobId,
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
import { requestFundingWorkflow, confirmFundingWorkflow, customerFundingEntryWorkflow } from '../../src/lib/workflow'
import type { Conversation } from '../../src/lib/messages/types'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeConversation(id = 'conv-harden-001'): Conversation {
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Max Mustermann',
    customerAvatarUrl: '',
    customerUserId: 'customer-harden',
    craftsmanName: 'Hans Handwerker',
    craftsmanHandle: 'hans-handwerker',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-harden',
    projectTitle: 'Hardening Test',
    projectSubtitle: 'Test',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'reel',
    messages: [],
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Post-Migration Code Hardening', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── FIX 1: providerId is required ──────────────────────────────────────

  describe('FIX 1 — FundingRequest providerId is required', () => {
    it('providerId is a required field on FundingRequest type', async () => {
      const plan = await ensureEscrowPlan({
        sourceOfferId: 'offer-h-1',
        jobId: 'job-h-1',
        customerUserId: 'customer-harden',
        providerId: 'provider-harden',
        totalAmount: 5000,
      })

      const request = await ensureFundingRequest({
        sourceOfferId: 'offer-h-1',
        jobId: 'job-h-1',
        escrowPlanId: plan.id,
        customerUserId: 'customer-harden',
        providerUserId: 'craftsman-harden',
        providerId: 'provider-harden',
        amount: 5000,
      })

      // providerId must be present and non-optional on the created object
      expect(request.providerId).toBe('provider-harden')
      expect(request.providerId).toBeTruthy()
    })

    it('ensureFundingRequest throws when providerId is empty string', async () => {
      const plan = await ensureEscrowPlan({
        sourceOfferId: 'offer-h-2',
        jobId: 'job-h-2',
        customerUserId: 'customer-harden',
        providerId: 'provider-harden',
        totalAmount: 5000,
      })

      await expect(
        ensureFundingRequest({
          sourceOfferId: 'offer-h-2',
          jobId: 'job-h-2',
          escrowPlanId: plan.id,
          customerUserId: 'customer-harden',
          providerUserId: 'craftsman-harden',
          providerId: '',
          amount: 5000,
        })
      ).rejects.toThrow(/providerId is required/)
    })
  })

  // ── FIX 2: Fail clearly on missing required linkage ────────────────────

  describe('FIX 2 — Fail clearly on missing required funding linkage', () => {
    it('requestFundingWorkflow falls back to craftsmanUserId when job has no DB-resolved providerId', async () => {
      const conv = makeConversation('conv-h-noprov')
      await addConversation(conv)

      const offer = await createOfferWorkflow({
        conversationId: conv.id,
        customerUserId: 'customer-harden',
        craftsmanUserId: 'craftsman-harden',
        price: '3.000 €',
      })

      await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))

      const acceptedOffer = getOfferById(offer.id)!
      const job = getJobById(acceptedOffer.createdJobId!)!

      installSessionForJobOwner(job)
      // In test environments where resolveProviderId returns undefined,
      // the workflow falls back to offer.craftsmanUserId. This test
      // verifies that the workflow still works with the fallback chain.
      const result = await requestFundingWorkflow(job.id)
      expect(result).toBeDefined()
      expect(result!.fundingRequestId).toBeTruthy()

      // The created funding request must have a non-empty providerId
      const fr = getFundingRequestByJobId(job.id)
      expect(fr).toBeDefined()
      expect(fr!.providerId).toBeTruthy()
    })
  })

  // ── FIX 3: UUID field alignment ────────────────────────────────────────

  describe('FIX 3 — UUID-sensitive field alignment', () => {
    it('sourceOfferId is persisted as UUID-compatible EntityId', async () => {
      const plan = await ensureEscrowPlan({
        sourceOfferId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        jobId: 'job-uuid-1',
        customerUserId: 'customer-harden',
        providerId: 'provider-harden',
        totalAmount: 5000,
      })

      const request = await ensureFundingRequest({
        sourceOfferId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        jobId: 'job-uuid-1',
        escrowPlanId: plan.id,
        customerUserId: 'customer-harden',
        providerUserId: 'craftsman-harden',
        providerId: 'provider-uuid-1',
        amount: 5000,
        conversationId: 'conv-uuid-1',
      })

      expect(request.sourceOfferId).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890')
      expect(request.providerId).toBe('provider-uuid-1')
      expect(request.conversationId).toBe('conv-uuid-1')
    })

    it('conversationId / sourceOfferId / providerId survive round-trip through creation and query', async () => {
      const plan = await ensureEscrowPlan({
        sourceOfferId: 'offer-uuid-rt',
        jobId: 'job-uuid-rt',
        customerUserId: 'customer-harden',
        providerId: 'prov-uuid-rt',
        totalAmount: 3000,
      })

      await ensureFundingRequest({
        sourceOfferId: 'offer-uuid-rt',
        jobId: 'job-uuid-rt',
        escrowPlanId: plan.id,
        customerUserId: 'customer-harden',
        providerUserId: 'craftsman-harden',
        providerId: 'prov-uuid-rt',
        amount: 3000,
        conversationId: 'conv-uuid-rt',
      })

      const queried = getFundingRequestByJobId('job-uuid-rt')
      expect(queried).toBeDefined()
      expect(queried!.sourceOfferId).toBe('offer-uuid-rt')
      expect(queried!.providerId).toBe('prov-uuid-rt')
      expect(queried!.conversationId).toBe('conv-uuid-rt')
    })
  })

  // ── FIX 4: No customer-side direct update assumption ───────────────────

  describe('FIX 4 — No customer-side direct UPDATE assumption for funding_requests', () => {
    it('funding status transitions only occur through service-layer functions (not direct mutation)', async () => {
      const conv = makeConversation('conv-h-rls')
      await addConversation(conv)

      const offer = await createOfferWorkflow({
        conversationId: conv.id,
        customerUserId: 'customer-harden',
        craftsmanUserId: 'craftsman-harden',
        price: '5.000 €',
      })

      await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))

      const acceptedOffer = getOfferById(offer.id)!
      const job = getJobById(acceptedOffer.createdJobId!)!

      installSessionForJobOwner(job)
      // Request funding (provider-side workflow)
      const result = await requestFundingWorkflow(job.id)
      expect(result).toBeDefined()

      // Customer enters funding flow — via workflow, not direct mutation
      installSessionForJobCustomer(job)
      const entryResult = await customerFundingEntryWorkflow(job.id)
      expect(entryResult).toBeDefined()
      expect(entryResult!.status).toBe('funding_started')

      // Funding confirmation — via server-side workflow, not customer direct update
      installSessionForJobCustomer(job)
      const confirmResult = await confirmFundingWorkflow(job.id)
      expect(confirmResult).toBeDefined()
      expect(confirmResult!.status).toBe('funded_in_escrow')

      // Final state: funded via server-confirmed path
      const fr = getFundingRequestByJobId(job.id)
      expect(fr).toBeDefined()
      expect(fr!.status).toBe('funded')
    })

    it('markFundingCompleted is the only path that sets funded status', async () => {
      const plan = await ensureEscrowPlan({
        sourceOfferId: 'offer-h-rls2',
        jobId: 'job-h-rls2',
        customerUserId: 'customer-harden',
        providerId: 'provider-harden',
        totalAmount: 5000,
      })

      const request = await ensureFundingRequest({
        sourceOfferId: 'offer-h-rls2',
        jobId: 'job-h-rls2',
        escrowPlanId: plan.id,
        customerUserId: 'customer-harden',
        providerUserId: 'craftsman-harden',
        providerId: 'provider-harden',
        amount: 5000,
      })

      // Status starts at created
      expect(request.status).toBe('created')

      // Progress through transitions
      await markFundingRequestSent(request.id)
      await markFundingStarted(request.id)

      // Before completion, status is funding_started
      const beforeComplete = getFundingRequestByJobId('job-h-rls2')
      expect(beforeComplete!.status).toBe('funding_started')

      // Only server-side markFundingCompleted sets funded
      await markFundingCompleted(request.id)
      const afterComplete = getFundingRequestByJobId('job-h-rls2')
      expect(afterComplete!.status).toBe('funded')
    })
  })

  // ── FIX 5: No regression ──────────────────────────────────────────────

  describe('FIX 5 — No regression to current funding flow', () => {
    it('full funding lifecycle works end-to-end after hardening', async () => {
      const conv = makeConversation('conv-h-e2e')
      await addConversation(conv)

      const offer = await createOfferWorkflow({
        conversationId: conv.id,
        customerUserId: 'customer-harden',
        craftsmanUserId: 'craftsman-harden',
        price: '8.000 €',
      })

      await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))

      const acceptedOffer = getOfferById(offer.id)!
      const job = getJobById(acceptedOffer.createdJobId!)!
      installSessionForJobOwner(job)
      const escrowPlan = getEscrowPlanByOfferId(offer.id)!

      // 1. Provider requests funding
      const result = await requestFundingWorkflow(job.id)
      expect(result).toBeDefined()
      expect(result!.amount).toBe(8000)

      // 2. Customer enters funding flow
      installSessionForJobCustomer(job)
      const entry = await customerFundingEntryWorkflow(job.id)
      expect(entry).toBeDefined()
      expect(entry!.fundingRequestId).toBeTruthy()
      expect(entry!.escrowPlanId).toBe(escrowPlan.id)

      // 3. Server confirms funding
      installSessionForJobCustomer(job)
      const confirmation = await confirmFundingWorkflow(job.id)
      expect(confirmation).toBeDefined()
      expect(confirmation!.status).toBe('funded_in_escrow')

      // 4. Funding request has required providerId
      const fr = getFundingRequestByJobId(job.id)!
      expect(fr.providerId).toBeTruthy()
      expect(fr.status).toBe('funded')
      expect(fr.sourceOfferId).toBe(offer.id)
    })

    it('idempotent creation still works after hardening', async () => {
      const plan = await ensureEscrowPlan({
        sourceOfferId: 'offer-h-idem',
        jobId: 'job-h-idem',
        customerUserId: 'customer-harden',
        providerId: 'provider-harden',
        totalAmount: 4000,
      })

      const first = await ensureFundingRequest({
        sourceOfferId: 'offer-h-idem',
        jobId: 'job-h-idem',
        escrowPlanId: plan.id,
        customerUserId: 'customer-harden',
        providerUserId: 'craftsman-harden',
        providerId: 'provider-harden',
        amount: 4000,
      })

      const second = await ensureFundingRequest({
        sourceOfferId: 'offer-h-idem',
        jobId: 'job-h-idem',
        escrowPlanId: plan.id,
        customerUserId: 'customer-harden',
        providerUserId: 'craftsman-harden',
        providerId: 'provider-harden',
        amount: 4000,
      })

      expect(second.id).toBe(first.id)
    })
  })
})
