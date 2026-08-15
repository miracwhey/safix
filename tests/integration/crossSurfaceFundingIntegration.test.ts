/**
 * Cross-Surface Funding Integration Tests
 *
 * Validates that funding/escrow/job state is correctly projected across
 * all app surfaces:
 *
 * 1. Provider setup messaging reflects real product rules (quotes allowed
 *    without Stripe, only payout blocked)
 * 2. Craftsman jobs screen shows correct next action for accepted/funding states
 * 3. Customer project progression reflects accepted + funding states
 * 4. Provider assignment messaging reflects accepted quote/job linkage
 * 5. No regression to funding flow, quote lifecycle, or thread logic
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installSessionForJobOwner, mockCustomerSession } from '../helpers/mockSession'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
  requestFundingWorkflow,
  markDepositPaidForJobWorkflow,
  lockEscrowWorkflow,
} from '../../src/lib/workflow'
import { getJobById } from '../../src/lib/jobs'
import { getEscrowPlanByJobId, confirmFunding } from '../../src/lib/payments/escrow'
import { getFundingRequestByJobId } from '../../src/lib/payments/fundingRequest'
import { addConversation } from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'

// ── Selectors under test ──────────────────────────────────────────────────

import { deriveCustomerJobStage } from '../../src/lib/jobs/customerJobStageSelectors'
import { deriveCustomerNextStep } from '../../src/lib/jobs/customerNextStepSelectors'
import { deriveExecutionNextStep } from '../../src/lib/jobs/executionSelectors'
import {
  canProviderSendQuote,
  canProviderTriggerFundingStep,
  canProviderReceivePayout,
} from '../../src/lib/payout/paymentGatingRules'
import { deriveOnboardingProgress } from '../../src/lib/onboarding/selectors'
import type { CraftsmanBusinessProfile } from '../../src/lib/craftsman/types'
import type { Job } from '../../src/lib/jobs'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeConversation(id: string): Conversation {
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Max Mustermann',
    customerAvatarUrl: '',
    customerUserId: `customer-${id}`,
    craftsmanName: 'Hans Handwerker',
    craftsmanHandle: 'hans-handwerker',
    craftsmanAvatarUrl: '',
    craftsmanUserId: `craftsman-${id}`,
    projectTitle: 'Cross-Surface Test',
    projectSubtitle: 'Test',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'reel',
    messages: [],
  }
}

function makeProfile(
  overrides: Partial<CraftsmanBusinessProfile> = {},
): CraftsmanBusinessProfile {
  return {
    userId: 'user-1',
    businessName: 'Müller Bau GmbH',
    handle: 'mueller-bau',
    avatarUrl: 'https://example.com/avatar.jpg',
    bio: 'Wir bauen seit 20 Jahren.',
    location: 'Berlin',
    businessAddress: '',
    tradeCategories: ['Maurerarbeiten'],
    servicesOffered: ['Neubau', 'Renovierung'],
    serviceRadiusKm: 30,
    onboardingCompleted: true,
    taxProfile: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-test',
    projectId: 'project-test',
    title: 'Test Job',
    customer: 'Max Mustermann',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'new',
    amount: '5.000 €',
    description: 'Test',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  }
}

async function createAcceptedOffer(conversationId: string) {
  const conv = makeConversation(conversationId)
  addConversation(conv)

  const offer = await createOfferWorkflow({
    conversationId,
    craftsmanUserId: conv.craftsmanUserId,
    customerUserId: conv.customerUserId,
    price: '5.000 €',
    description: 'Test job',
  })

  const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
  return { offer: accepted, conversation: conv }
}

async function simulateCustomerFunding(jobId: string) {
  await markDepositPaidForJobWorkflow(jobId)
  await lockEscrowWorkflow(jobId)
  const escrowPlan = getEscrowPlanByJobId(jobId)!
  await confirmFunding(escrowPlan.id)
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Cross-Surface Funding Integration', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── FIX 1: Provider setup gating reflects real product rules ──────────

  describe('provider setup messaging reflects product rules', () => {
    it('quote sending is allowed without Stripe Connect', () => {
      expect(canProviderSendQuote(null).allowed).toBe(true)
    })

    it('funding request is allowed without Stripe Connect', () => {
      expect(canProviderTriggerFundingStep(null).allowed).toBe(true)
    })

    it('payout is blocked without Stripe Connect', () => {
      expect(canProviderReceivePayout(null).allowed).toBe(false)
    })

    it('onboarding card shows payout-only language when profile complete without Stripe', () => {
      const progress = deriveOnboardingProgress(makeProfile(), null)
      expect(progress.isProfileReady).toBe(true)
      expect(progress.isPayoutReady).toBe(false)
      expect(progress.isDiscoveryBlocked).toBe(false)
      // When profile ready but no payout: next step is payout_setup
      expect(progress.nextStep?.id).toBe('payout_setup')
    })
  })

  // ── FIX 2: Craftsman jobs screen shows correct next action ────────────

  describe('craftsman jobs next step reflects funding states', () => {
    it('shows "Angebot erstellen" when no proposal sent', () => {
      const job = makeJob({
        id: 'j1', proposalSentAt: undefined,
        proposalAcceptedAt: undefined, assignedMemberIds: ['m1'],
      })
      expect(deriveExecutionNextStep(job)).toBe('Angebot erstellen')
    })

    it('shows "Zahlungsaufforderung senden" when proposal accepted but no funding', () => {
      const job = makeJob({
        id: 'j2',
        proposalSentAt: Date.now() - 100000,
        proposalAcceptedAt: Date.now() - 50000,
        assignedMemberIds: ['m1'],
      })
      expect(deriveExecutionNextStep(job)).toBe('Zahlungsaufforderung senden')
    })

    it('shows "Warte auf Kundeneinzahlung" when funding request sent', () => {
      const job = makeJob({
        id: 'j3',
        proposalSentAt: Date.now() - 100000,
        proposalAcceptedAt: Date.now() - 50000,
        assignedMemberIds: ['m1'],
      })
      expect(deriveExecutionNextStep(job, 'sent')).toBe('Warte auf Kundeneinzahlung')
    })

    it('shows "Kundeneinzahlung wird verarbeitet" when funding initiated', () => {
      const job = makeJob({
        id: 'j4',
        proposalSentAt: Date.now() - 100000,
        proposalAcceptedAt: Date.now() - 50000,
        assignedMemberIds: ['m1'],
      })
      expect(deriveExecutionNextStep(job, 'funding_initiated')).toBe('Kundeneinzahlung wird verarbeitet')
    })

    it('shows "Arbeit starten" when funded', () => {
      const job = makeJob({
        id: 'j5',
        proposalSentAt: Date.now() - 100000,
        proposalAcceptedAt: Date.now() - 50000,
        assignedMemberIds: ['m1'],
      })
      expect(deriveExecutionNextStep(job, 'funded')).toBe('Arbeit starten')
    })

    it('shows correct next step for real accepted workflow with funding request', async () => {
      const { offer } = await createAcceptedOffer('conv-nextstep-1')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      const fundingRequest = requestFundingWorkflow(job.id)
      expect(fundingRequest).toBeDefined()

      const fr = getFundingRequestByJobId(job.id)
      const hint = deriveExecutionNextStep(job, fr?.status)
      expect(hint).toBe('Warte auf Kundeneinzahlung')
    })

    it('handles booked status (post-acceptance) with funding-aware hints', () => {
      const job = makeJob({
        id: 'j-booked', status: 'booked',
        proposalSentAt: Date.now() - 100000,
        proposalAcceptedAt: Date.now() - 50000,
        assignedMemberIds: ['m1'],
      })
      expect(deriveExecutionNextStep(job)).toBe('Zahlungsaufforderung senden')
      expect(deriveExecutionNextStep(job, 'sent')).toBe('Warte auf Kundeneinzahlung')
      expect(deriveExecutionNextStep(job, 'funded')).toBe('Arbeit starten')
    })
  })

  // ── FIX 4: Customer project progression reflects accepted/funding ─────

  describe('customer project progression reflects funding states', () => {
    const NOW = Date.now()

    it('shows offer_accepted when proposal accepted but no funding request', () => {
      const result = deriveCustomerJobStage(
        'new', 'deposit_required',
        NOW - 100000, NOW - 50000,
        undefined
      )
      expect(result.stage).toBe('offer_accepted')
      expect(result.activeIndex).toBe(2)
    })

    it('shows funding_pending when funding request sent', () => {
      const result = deriveCustomerJobStage(
        'new', 'deposit_required',
        NOW - 100000, NOW - 50000,
        'sent'
      )
      expect(result.stage).toBe('funding_pending')
      expect(result.activeIndex).toBe(3)
    })

    it('shows funding_pending when funding request created', () => {
      const result = deriveCustomerJobStage(
        'new', 'deposit_required',
        NOW - 100000, NOW - 50000,
        'created'
      )
      expect(result.stage).toBe('funding_pending')
      expect(result.activeIndex).toBe(3)
    })

    it('shows funded_in_escrow when funded', () => {
      const result = deriveCustomerJobStage(
        'new', 'deposit_required',
        NOW - 100000, NOW - 50000,
        'funded'
      )
      expect(result.stage).toBe('funded_in_escrow')
      expect(result.activeIndex).toBe(4)
    })

    it('customer next step shows Fund Escrow for funding_pending stage', () => {
      const job = makeJob({
        id: 'j-ns-1', projectId: 'p-ns-1',
        proposalSentAt: NOW - 100000,
        proposalAcceptedAt: NOW - 50000,
      })
      const step = deriveCustomerNextStep(job, undefined, 'sent')
      expect(step.label).toBe('Zahlung einzahlen')
      expect(step.actionLabel).toBe('Jetzt einzahlen')
    })

    it('customer next step shows Escrow Funded when funded', () => {
      const job = makeJob({
        id: 'j-ns-2', projectId: 'p-ns-2',
        proposalSentAt: NOW - 100000,
        proposalAcceptedAt: NOW - 50000,
      })
      const step = deriveCustomerNextStep(job, undefined, 'funded')
      expect(step.label).toBe('Zahlung abgesichert')
    })

    it('end-to-end: progression moves correctly through funding lifecycle', async () => {
      const { offer } = await createAcceptedOffer('conv-progression-1')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      // Stage 1: Accepted, no funding yet
      const stage1 = deriveCustomerJobStage(
        job.status, job.paymentState,
        job.proposalSentAt, job.proposalAcceptedAt,
        undefined
      )
      expect(stage1.stage).toBe('offer_accepted')

      // Stage 2: Funding request sent
      requestFundingWorkflow(job.id)
      const fr = getFundingRequestByJobId(job.id)!
      const stage2 = deriveCustomerJobStage(
        job.status, job.paymentState,
        job.proposalSentAt, job.proposalAcceptedAt,
        fr.status
      )
      expect(stage2.stage).toBe('funding_pending')

      // Stage 3: Funded
      await simulateCustomerFunding(job.id)
      const updatedJob = getJobById(job.id)!
      const updatedFr = getFundingRequestByJobId(job.id)
      const stage3 = deriveCustomerJobStage(
        updatedJob.status, updatedJob.paymentState,
        updatedJob.proposalSentAt, updatedJob.proposalAcceptedAt,
        updatedFr?.status
      )
      expect(stage3.stage).toBe('funded_in_escrow')
    })
  })

  // ── FIX 5: Provider assignment messaging ──────────────────────────────

  describe('provider assignment reflects accepted quote/job linkage', () => {
    it('job with proposalAcceptedAt implies provider responsibility', async () => {
      const { offer } = await createAcceptedOffer('conv-assign-1')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      expect(job.proposalAcceptedAt).toBeDefined()
      // A job with an accepted proposal has an established provider relationship
      expect(job.proposalAcceptedAt).toBeGreaterThan(0)
    })

    it('job with proposalSentAt implies provider engagement', async () => {
      // After acceptance, the job has proposalSentAt from the offer's sentAt
      const { offer } = await createAcceptedOffer('conv-assign-2')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      expect(job.proposalSentAt).toBeDefined()
      expect(job.proposalSentAt).toBeGreaterThan(0)
    })
  })

  // ── FIX 6: Cross-surface consistency ──────────────────────────────────

  describe('cross-surface consistency after funding request', () => {
    it('funding request does not duplicate on repeated calls', async () => {
      const { offer } = await createAcceptedOffer('conv-idempotent-1')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      const r1 = requestFundingWorkflow(job.id)
      const r2 = requestFundingWorkflow(job.id)

      expect(r1).toBeDefined()
      // Second call should return the same request (idempotent)
      expect(r2).toBeDefined()
      expect(r1!.fundingRequestId).toBe(r2!.fundingRequestId)
    })

    it('execution next step and customer stage align for accepted/funding', async () => {
      const { offer } = await createAcceptedOffer('conv-align-1')
      const job = getJobById(offer.createdJobId!)!

      installSessionForJobOwner(job)
      // Before funding request
      const execHint1 = deriveExecutionNextStep(job, undefined)
      const custStage1 = deriveCustomerJobStage(
        job.status, job.paymentState,
        job.proposalSentAt, job.proposalAcceptedAt,
        undefined
      )
      expect(execHint1).toBe('Zahlungsaufforderung senden')
      expect(custStage1.stage).toBe('offer_accepted')

      // After funding request
      requestFundingWorkflow(job.id)
      const fr = getFundingRequestByJobId(job.id)!
      const execHint2 = deriveExecutionNextStep(job, fr.status)
      const custStage2 = deriveCustomerJobStage(
        job.status, job.paymentState,
        job.proposalSentAt, job.proposalAcceptedAt,
        fr.status
      )
      expect(execHint2).toBe('Warte auf Kundeneinzahlung')
      expect(custStage2.stage).toBe('funding_pending')
    })

    it('no regression: quote lifecycle works after changes', async () => {
      const conv = makeConversation('conv-no-regress-1')
      addConversation(conv)
      const offer = await createOfferWorkflow({
        conversationId: conv.id,
        craftsmanUserId: conv.craftsmanUserId,
        customerUserId: conv.customerUserId,
        price: '2.000 €',
        description: 'Regression test',
      })
      expect(offer.status).toBe('pending')

      const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
      expect(accepted.status).toBe('accepted')
      expect(accepted.createdJobId).toBeDefined()
    })
  })
})
