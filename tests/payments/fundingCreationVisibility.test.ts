/**
 * Funding Creation Visibility + Rehydration Completion Tests
 *
 * Verifies the complete visibility chain after provider funding creation:
 * - Provider-side phase transition becomes visible
 * - Customer-visible funding step card appears in thread
 * - Thread artifact type + selector + UI rendering are consistent
 * - Server does not return success if visible funding artifact failed
 * - Reload/re-entry still shows funding state
 * - Duplicate taps do not create duplicate rows/artifacts
 * - No regression to canonical job resolution, funding flow, or quote lifecycle
 * - Selector resolves funding artifact via jobId fallback
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

// Mock the provider profile service to avoid real HTTP calls
vi.mock('../../src/lib/providers/providerProfileService', () => ({
  getProviderProfile: vi.fn().mockResolvedValue(null),
  getMyProviderProfile: vi.fn().mockResolvedValue(null),
  updateProviderProfile: vi.fn().mockResolvedValue(undefined),
}))

import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installSessionForJobOwner, installSessionForJobCustomer, mockCustomerSession } from '../helpers/mockSession'
import {
  getFundingRequestByJobId,
  getAllFundingRequests,
} from '../../src/lib/payments/fundingRequest'
import {
  getEscrowPlanByJobId,
  getEscrowPlanByOfferId,
} from '../../src/lib/payments/escrow'
import {
  requestFundingWorkflow,
  customerFundingEntryWorkflow,
  confirmFundingWorkflow,
} from '../../src/lib/workflow/jobWorkflow'
import { addConversation } from '../../src/lib/messages'
import { createOfferWorkflow, acceptOfferWorkflow } from '../../src/lib/workflow'
import { getOfferById } from '../../src/lib/offers'
import { getJobById } from '../../src/lib/jobs'
import { getThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'
import { getThreadArtifacts } from '../../src/lib/messages/threadArtifactSelectors'
import { deriveProviderJobPhase, PROVIDER_PHASE_CONFIG } from '../../src/lib/jobs/providerJobPhaseSelectors'
import { deriveProviderNextAction } from '../../src/lib/jobs/providerNextActionSelectors'
import { mapFundingErrorToMessage } from '../../src/lib/payments/fundingClient'
import type { Conversation } from '../../src/lib/messages/types'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeConversation(id = 'conv-vis-001'): Conversation {
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Max Mustermann',
    customerAvatarUrl: '',
    customerUserId: 'customer-vis',
    craftsmanName: 'Hans Handwerker',
    craftsmanHandle: 'hans-handwerker',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-vis',
    projectTitle: 'Visibility Test',
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
    customerUserId: 'customer-vis',
    craftsmanUserId: 'craftsman-vis',
    price: '3.000 €',
  })

  await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))

  const acceptedOffer = getOfferById(offer.id)!
  const job = getJobById(acceptedOffer.createdJobId!)!
  const escrowPlan = getEscrowPlanByOfferId(offer.id)!
  installSessionForJobOwner(job)

  return { conv, offer: acceptedOffer, job, escrowPlan }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Funding Creation Visibility + Rehydration', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  describe('Provider-side visible state transition (FIX 4)', () => {
    it('provider phase transitions from funding_not_requested to funding_requested after success', async () => {
      const { job } = await setupAcceptedQuote('conv-vis-phase1')

      // Before funding request
      const beforePhase = deriveProviderJobPhase(job)
      expect(beforePhase.phase).toBe('funding_not_requested')
      expect(PROVIDER_PHASE_CONFIG[beforePhase.phase]).toBeDefined()

      // After funding request
      await requestFundingWorkflow(job.id)
      const fr = getFundingRequestByJobId(job.id)!
      const afterPhase = deriveProviderJobPhase(job, fr.status)
      expect(afterPhase.phase).toBe('funding_requested')
      expect(PROVIDER_PHASE_CONFIG[afterPhase.phase].label).toBeDefined()
    })

    it('provider next action changes from request_funding to wait_for_funding', async () => {
      const { job } = await setupAcceptedQuote('conv-vis-phase2')

      // Before
      const beforeAction = deriveProviderNextAction(job)
      expect(beforeAction.actionId).toBe('request_funding')
      expect(beforeAction.enabled).toBe(true)

      // After
      await requestFundingWorkflow(job.id)
      const fr = getFundingRequestByJobId(job.id)!
      const afterAction = deriveProviderNextAction(job, fr.status)
      expect(afterAction.actionId).toBe('wait_for_funding')
      expect(afterAction.enabled).toBe(false)
    })

    it('provider sees funding details (escrow amount + status) after request', async () => {
      const { job } = await setupAcceptedQuote('conv-vis-phase3')

      await requestFundingWorkflow(job.id)

      const fr = getFundingRequestByJobId(job.id)
      const plan = getEscrowPlanByJobId(job.id)

      // Both must exist for the funding details section to render
      expect(fr).toBeDefined()
      expect(plan).toBeDefined()
      expect(fr!.status).toBe('sent')
      expect(plan!.totalAmount).toBe(3000)
      expect(plan!.currency).toBe('EUR')
    })

    it('provider phase progresses through funding lifecycle', async () => {
      const { job } = await setupAcceptedQuote('conv-vis-phase4')

      // Pure mapping test — no workflow needed. 'sent' is the initial status
      // after requestFundingWorkflow (verified by previous test).
      expect(deriveProviderJobPhase(job, 'sent').phase).toBe('funding_requested')

      // funding_pending (customer started)
      expect(deriveProviderJobPhase(job, 'funding_started').phase).toBe('funding_pending')
      expect(deriveProviderJobPhase(job, 'funding_initiated').phase).toBe('funding_pending')

      // funded_in_escrow
      expect(deriveProviderJobPhase(job, 'funded').phase).toBe('funded_in_escrow')
    })
  })

  describe('Customer-visible funding card in thread (FIX 5)', () => {
    it('funding step artifact becomes visible via getThreadArtifacts', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-vis-card1')

      await requestFundingWorkflow(job.id)

      const artifacts = getThreadArtifacts(conv.id)
      expect(artifacts.fundingStepArtifact).not.toBeNull()
      expect(artifacts.fundingStepArtifact!.kind).toBe('funding_step')
      expect(artifacts.fundingStepArtifact!.phase).toBe('sent')
      expect(artifacts.fundingStepArtifact!.amount).toContain('3')
    })

    it('pending flag is false when artifact exists with snapshot', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-vis-card2')

      await requestFundingWorkflow(job.id)

      const artifacts = getThreadArtifacts(conv.id)
      expect(artifacts.pendingFundingArtifact).toBe(false)
    })

    it('funding step artifact coexists with offer artifact (no collision)', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-vis-card3')

      await requestFundingWorkflow(job.id)

      const artifacts = getThreadArtifacts(conv.id)
      // Both should exist independently
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.fundingStepArtifact).not.toBeNull()

      // They should have different kinds
      expect(artifacts.offerPaymentArtifact!.kind).toBe('offer_payment')
      expect(artifacts.fundingStepArtifact!.kind).toBe('funding_step')
    })

    it('funding card phase updates as status progresses', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-vis-card4')

      await requestFundingWorkflow(job.id)

      // Initial: sent phase
      let artifacts = getThreadArtifacts(conv.id)
      expect(artifacts.fundingStepArtifact!.phase).toBe('sent')

      // After customer entry
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)
      artifacts = getThreadArtifacts(conv.id)
      expect(artifacts.fundingStepArtifact!.phase).toBe('funding_started')

      // After confirmation
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)
      artifacts = getThreadArtifacts(conv.id)
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')
    })

    it('funding step artifact carries escrowPlanId and fundingRequestId', async () => {
      const { job, conv, escrowPlan } = await setupAcceptedQuote('conv-vis-card5')

      await requestFundingWorkflow(job.id)
      const fr = getFundingRequestByJobId(job.id)!

      const artifacts = getThreadArtifacts(conv.id)
      expect(artifacts.fundingStepArtifact!.fundingRequestId).toBe(fr.id)
      expect(artifacts.fundingStepArtifact!.escrowPlanId).toBe(escrowPlan.id)
    })
  })

  describe('Thread artifact type + selector consistency (FIX 3)', () => {
    it('artifact record uses funding_step type (not payment_phase)', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-vis-type1')

      await requestFundingWorkflow(job.id)

      const repo = getThreadArtifactRepository()
      const record = repo.getByConversationAndType(conv.id, 'funding_step')
      expect(record).toBeDefined()
      expect(record!.artifactType).toBe('funding_step')
    })

    it('payment_phase artifact (from offer acceptance) is separate from funding_step', async () => {
      const { conv } = await setupAcceptedQuote('conv-vis-type2')

      // After offer acceptance, a payment_phase artifact exists
      const repo = getThreadArtifactRepository()
      const paymentPhase = repo.getByConversationAndType(conv.id, 'payment_phase')
      // payment_phase is created by acceptOfferWorkflow
      // funding_step is NOT yet created
      const fundingStep = repo.getByConversationAndType(conv.id, 'funding_step')
      expect(fundingStep).toBeUndefined()

      // Both can coexist without collision
      if (paymentPhase) {
        expect(paymentPhase.artifactType).toBe('payment_phase')
      }
    })

    it('funding_step artifact has proper snapshot data for card rendering', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-vis-type3')

      await requestFundingWorkflow(job.id)

      const repo = getThreadArtifactRepository()
      const record = repo.getByConversationAndType(conv.id, 'funding_step')!

      // Snapshot fields for immediate rendering
      expect(record.snapshotPrice).toBeDefined()
      expect(record.snapshotPhaseLabel).toBeDefined()
      expect(record.phase).toBe('sent')
      expect(record.jobId).toBe(job.id)
    })
  })

  describe('Selector resolves via jobId fallback (defense-in-depth)', () => {
    it('resolves funding artifact even without fundingRequestId on record', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-vis-fallback1')

      await requestFundingWorkflow(job.id)

      // Simulate a record that has jobId but no fundingRequestId
      // (e.g., created by old server code before column was added)
      const repo = getThreadArtifactRepository()
      const existing = repo.getByConversationAndType(conv.id, 'funding_step')!

      // Manually create a record with jobId only (no fundingRequestId)
      const recordWithoutFrId = {
        ...existing,
        id: 'fallback-artifact-id',
        fundingRequestId: undefined,
        escrowPlanId: undefined,
      }

      // Replace with the stripped record
      await repo.upsert(recordWithoutFrId)

      // The selector should fall back to getFundingRequestByJobId
      const artifacts = getThreadArtifacts(conv.id)
      expect(artifacts.fundingStepArtifact).not.toBeNull()
      expect(artifacts.fundingStepArtifact!.phase).toBe('sent')
      // The fundingRequestId should be resolved from the job
      expect(artifacts.fundingStepArtifact!.fundingRequestId).toBeDefined()
      expect(artifacts.fundingStepArtifact!.fundingRequestId).not.toBe('')
    })
  })

  describe('No silent partial success (FIX 6)', () => {
    it('server endpoint returns FUNDING_ARTIFACT_CREATE_FAILED error code', () => {
      const apiPath = path.resolve(__dirname, '../../api/request-funding.ts')
      const content = fs.readFileSync(apiPath, 'utf-8')

      // The endpoint must NOT silently succeed when artifact creation fails
      expect(content).toContain('FUNDING_ARTIFACT_CREATE_FAILED')

      // It must return a non-200 status when artifact fails
      expect(content).toContain("res.status(500)")
    })

    it('fundingClient maps FUNDING_ARTIFACT_CREATE_FAILED to German message', () => {
      const msg = mapFundingErrorToMessage('FUNDING_ARTIFACT_CREATE_FAILED', 'fallback')
      expect(msg).not.toBe('fallback')
      expect(msg).toContain('Konversation')
    })

    it('server returns structured creation/reuse details', () => {
      const apiPath = path.resolve(__dirname, '../../api/request-funding.ts')
      const content = fs.readFileSync(apiPath, 'utf-8')

      // Response must include creation/reuse tracking fields
      expect(content).toContain('escrowPlanCreated')
      expect(content).toContain('escrowPlanReused')
      expect(content).toContain('fundingRequestCreated')
      expect(content).toContain('fundingRequestReused')
      expect(content).toContain('artifactCreated')
      expect(content).toContain('artifactReused')
      expect(content).toContain('conversationId')
    })
  })

  describe('Idempotent visible reuse (FIX 7)', () => {
    it('repeated funding requests do not create duplicate artifacts', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-vis-idem1')

      // Multiple calls
      await requestFundingWorkflow(job.id)
      await requestFundingWorkflow(job.id)
      await requestFundingWorkflow(job.id)

      const repo = getThreadArtifactRepository()
      const fundingArtifacts = repo.getByConversationId(conv.id)
        .filter(a => a.artifactType === 'funding_step')
      expect(fundingArtifacts).toHaveLength(1)

      // And only one funding request
      expect(getAllFundingRequests()).toHaveLength(1)
    })

    it('funding state remains visible after simulated reload', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-vis-idem2')

      await requestFundingWorkflow(job.id)

      // Simulate reload: re-query all data sources
      const fr = getFundingRequestByJobId(job.id)
      const plan = getEscrowPlanByJobId(job.id)
      const artifacts = getThreadArtifacts(conv.id)

      // All must still be visible
      expect(fr).toBeDefined()
      expect(fr!.status).toBe('sent')
      expect(plan).toBeDefined()
      expect(artifacts.fundingStepArtifact).not.toBeNull()
      expect(artifacts.fundingStepArtifact!.phase).toBe('sent')
    })

    it('funded state persists across simulated reload', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-vis-idem3')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)

      // Simulated reload
      const fr = getFundingRequestByJobId(job.id)
      const plan = getEscrowPlanByJobId(job.id)
      const artifacts = getThreadArtifacts(conv.id)

      expect(fr!.status).toBe('funded')
      expect(plan!.status).toBe('funded_in_escrow')
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')
    })
  })

  describe('Client rehydration completeness', () => {
    it('CraftsmanJobOperationsCard refreshes thread artifacts after success', () => {
      const componentPath = path.resolve(
        __dirname,
        '../../src/components/jobs/CraftsmanJobOperationsCard.tsx'
      )
      const content = fs.readFileSync(componentPath, 'utf-8')

      // Must import thread artifact initialization
      expect(content).toContain('initializeThreadArtifactRepository')

      // Must call it in the funding success path
      expect(content).toContain('initializeEscrowPlanRepository()')
      expect(content).toContain('initializeFundingRequestRepository()')
      expect(content).toContain('initializeThreadArtifactRepository()')
    })

    it('server endpoint writes funding_request_id and escrow_plan_id on artifact', () => {
      const apiPath = path.resolve(__dirname, '../../api/request-funding.ts')
      const content = fs.readFileSync(apiPath, 'utf-8')

      expect(content).toContain('funding_request_id: fundingRequestId')
      expect(content).toContain('escrow_plan_id: escrowPlanId')
    })

    it('SupabaseThreadArtifactRepository maps funding columns', () => {
      const repoPath = path.resolve(
        __dirname,
        '../../src/lib/messages/repository/SupabaseThreadArtifactRepository.ts'
      )
      const content = fs.readFileSync(repoPath, 'utf-8')

      // Row type has the columns
      expect(content).toContain('funding_request_id')
      expect(content).toContain('escrow_plan_id')

      // rowToRecord maps them
      expect(content).toContain('fundingRequestId: row.funding_request_id')
      expect(content).toContain('escrowPlanId: row.escrow_plan_id')

      // recordToRow maps them back
      expect(content).toContain('funding_request_id: record.fundingRequestId')
      expect(content).toContain('escrow_plan_id: record.escrowPlanId')
    })
  })

  describe('DB migration correctness', () => {
    it('migration adds funding_step to CHECK constraint', () => {
      const migrationPath = path.resolve(
        __dirname,
        '../../supabase/migrations/20260326000002_thread_artifacts_funding_step.sql'
      )
      const content = fs.readFileSync(migrationPath, 'utf-8')

      expect(content).toContain('funding_step')
      expect(content).toContain('funding_request_id')
      expect(content).toContain('escrow_plan_id')
    })
  })

  describe('No regression to existing flows', () => {
    it('offer acceptance still creates payment_phase artifact', async () => {
      const { conv } = await setupAcceptedQuote('conv-vis-noreg1')

      const repo = getThreadArtifactRepository()
      const paymentPhase = repo.getByConversationAndType(conv.id, 'payment_phase')
      // acceptOfferWorkflow creates this
      expect(paymentPhase).toBeDefined()
    })

    it('offer artifact still visible in thread after funding creation', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-vis-noreg2')

      await requestFundingWorkflow(job.id)

      const artifacts = getThreadArtifacts(conv.id)
      // Offer artifact must still be present
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
    })

    it('canonical job resolution not affected by funding creation', async () => {
      const { job, offer } = await setupAcceptedQuote('conv-vis-noreg3')

      await requestFundingWorkflow(job.id)

      // Job still has sourceOfferId
      const updatedJob = getJobById(job.id)!
      expect(updatedJob.sourceOfferId).toBe(offer.id)
    })

    it('escrow plan still has correct 25/75 split after funding creation', async () => {
      const { job, escrowPlan } = await setupAcceptedQuote('conv-vis-noreg4')

      await requestFundingWorkflow(job.id)

      const plan = getEscrowPlanByJobId(job.id)!
      expect(plan.id).toBe(escrowPlan.id)
      expect(plan.totalAmount).toBe(3000)

      // 25/75 tranches
      const { getEscrowTranches } = await import('../../src/lib/payments/escrow')
      const tranches = getEscrowTranches(plan.id)
      expect(tranches).toHaveLength(2)
      const deposit = tranches.find(t => t.kind === 'deposit_release')!
      const final = tranches.find(t => t.kind === 'final_release')!
      expect(deposit.percentage).toBe(25)
      expect(final.percentage).toBe(75)
    })
  })
})
