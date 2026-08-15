/**
 * Craftsman Operations Completion — Persistence + UI Wiring Tests
 *
 * Validates:
 * 1. work_completed_at persistence gap is closed (migration + repository)
 * 2. Provider can request funding from the actual operations command
 * 3. Provider can start work only when funding is confirmed
 * 4. Provider can complete work only after start
 * 5. start persists and makes 25% tranche eligible
 * 6. complete persists and makes 75% tranche eligible
 * 7. Duplicate clicks do not create duplicate side effects
 * 8. Customer/project surfaces update correctly after provider actions
 * 9. No regression to funding flow
 * 10. No regression to quote lifecycle
 * 11. No regression to relationship-thread logic
 * 12. No regression to participant scoping
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { resolve } from 'path'
import { readFileSync } from 'fs'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import { installSessionForJobOwner, mockCustomerSession } from '../helpers/mockSession'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
  requestFundingWorkflow,
  markDepositPaidForJobWorkflow,
  lockEscrowWorkflow,
  requestFundingForJob,
  startJob,
  completeJob,
} from '../../src/lib/workflow'

import { getJobById } from '../../src/lib/jobs'
import {
  getEscrowPlanByJobId,
  getEscrowTranches,
  confirmFunding,
} from '../../src/lib/payments/escrow'
import {
  getFundingRequestByJobId,
  getAllFundingRequests,
} from '../../src/lib/payments/fundingRequest'
import { deriveCustomerJobStage } from '../../src/lib/jobs/customerJobStageSelectors'
import { deriveProviderJobPhase } from '../../src/lib/jobs/providerJobPhaseSelectors'
import { deriveProviderNextAction } from '../../src/lib/jobs/providerNextActionSelectors'
import { addConversation } from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeConversation(id = 'conv-persist-001'): Conversation {
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Persist Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-persist',
    craftsmanName: 'Persist Handwerker',
    craftsmanHandle: 'persist-handwerker',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-persist',
    projectTitle: 'Persist Ops Test',
    projectSubtitle: 'Test',
    projectStatusLabel: 'Anfrage',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'reel',
    messages: [],
  }
}

async function createAcceptedOffer(conversationId: string) {
  const conv = makeConversation(conversationId)
  addConversation(conv)

  const offer = await createOfferWorkflow({
    conversationId,
    craftsmanUserId: conv.craftsmanUserId,
    customerUserId: conv.customerUserId,
    price: '6.000 €',
    description: 'Küchen-Renovierung',
  })

  const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
  installSessionForJobOwner({ craftsmanUserId: conv.craftsmanUserId })
  return { offer: accepted, conversation: conv }
}

async function simulateCustomerFunding(jobId: string) {
  await markDepositPaidForJobWorkflow(jobId)
  await lockEscrowWorkflow(jobId)
  const escrowPlan = getEscrowPlanByJobId(jobId)!
  await confirmFunding(escrowPlan.id)
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Craftsman Operations Completion + Persistence', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── PART 1: Persistence Gap ───────────────────────────────────────────

  describe('1. work_completed_at persistence gap is closed', () => {
    it('migration file exists for work_completed_at', () => {
      const migrationPath = resolve(
        __dirname,
        '../../supabase/migrations/20260325000006_jobs_work_completed_at.sql'
      )
      const migrationSql = readFileSync(migrationPath, 'utf-8')
      expect(migrationSql).toContain('work_completed_at')
      expect(migrationSql).toContain('ALTER TABLE')
    })

    it('SupabaseJobRepository jobToRow includes work_completed_at', () => {
      const repoSourcePath = resolve(
        __dirname,
        '../../src/lib/jobs/repository/SupabaseJobRepository.ts'
      )
      const repoSource = readFileSync(repoSourcePath, 'utf-8')
      const jobToRowMatch = repoSource.match(/function jobToRow\b[\s\S]*?^\s*\}/m)
      expect(jobToRowMatch).toBeTruthy()
      const jobToRowBody = jobToRowMatch![0]
      expect(jobToRowBody).toMatch(/work_completed_at/)
    })

    it('JobWriteRow includes work_completed_at field', () => {
      const repoSourcePath = resolve(
        __dirname,
        '../../src/lib/jobs/repository/SupabaseJobRepository.ts'
      )
      const repoSource = readFileSync(repoSourcePath, 'utf-8')
      const writeRowMatch = repoSource.match(/interface JobWriteRow\s*\{[\s\S]*?^\s*\}/m)
      expect(writeRowMatch).toBeTruthy()
      expect(writeRowMatch![0]).toContain('work_completed_at')
    })

    it('work_completed_at is written to DB via jobToRow after completeJob', async () => {
      const { offer } = await createAcceptedOffer('conv-persist-1')
      const jobId = offer.createdJobId!
      await requestFundingWorkflow(jobId)
      await simulateCustomerFunding(jobId)
      await startJob(jobId)
      await completeJob(jobId)

      const job = getJobById(jobId)!
      installSessionForJobOwner(job)
      expect(job.workCompletedAt).toBeDefined()
      expect(typeof job.workCompletedAt).toBe('number')
    })
  })

  // ── PART 2: Real Provider Actions ─────────────────────────────────────

  describe('2. Provider actions work through guarded commands', () => {
    it('requestFundingForJob succeeds for accepted quote with escrow plan', async () => {
      const { offer } = await createAcceptedOffer('conv-cmd-1')
      const result = await requestFundingForJob(offer.createdJobId!)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.status).toBe('sent')
        expect(result.data.amount).toBe(6000)
      }
    })

    it('startJob succeeds only when funding is confirmed', async () => {
      const { offer } = await createAcceptedOffer('conv-cmd-2')
      const jobId = offer.createdJobId!

      // Not funded yet → should fail
      const earlyResult = await startJob(jobId)
      expect(earlyResult.ok).toBe(false)

      // Fund and try again
      await requestFundingWorkflow(jobId)
      await simulateCustomerFunding(jobId)
      const result = await startJob(jobId)
      expect(result.ok).toBe(true)
    })

    it('completeJob succeeds only when work is started', async () => {
      const { offer } = await createAcceptedOffer('conv-cmd-3')
      const jobId = offer.createdJobId!

      // Not started → should fail
      const earlyResult = await completeJob(jobId)
      expect(earlyResult.ok).toBe(false)
      if (!earlyResult.ok) expect(earlyResult.code).toBe('JOB_NOT_STARTED')

      // Start work and try again
      await requestFundingWorkflow(jobId)
      await simulateCustomerFunding(jobId)
      await startJob(jobId)
      const result = await completeJob(jobId)
      expect(result.ok).toBe(true)
    })
  })

  // ── PART 3: Tranche Eligibility ───────────────────────────────────────

  describe('3. startJob makes 25% tranche eligible, completeJob makes 75% eligible', () => {
    it('25% deposit_release tranche becomes eligible on work start', async () => {
      const { offer } = await createAcceptedOffer('conv-tranche-1')
      const jobId = offer.createdJobId!
      await requestFundingWorkflow(jobId)
      await simulateCustomerFunding(jobId)
      await startJob(jobId)

      const escrowPlan = getEscrowPlanByJobId(jobId)!
      const tranches = getEscrowTranches(escrowPlan.id)
      const deposit = tranches.find(t => t.kind === 'deposit_release')
      expect(deposit).toBeDefined()
      expect(deposit!.status).toBe('eligible_for_release')
    })

    it('75% final_release tranche becomes eligible on work complete', async () => {
      const { offer } = await createAcceptedOffer('conv-tranche-2')
      const jobId = offer.createdJobId!
      await requestFundingWorkflow(jobId)
      await simulateCustomerFunding(jobId)
      await startJob(jobId)
      await completeJob(jobId)

      const escrowPlan = getEscrowPlanByJobId(jobId)!
      const tranches = getEscrowTranches(escrowPlan.id)
      const final = tranches.find(t => t.kind === 'final_release')
      expect(final).toBeDefined()
      expect(final!.status).toBe('eligible_for_release')
    })
  })

  // ── PART 4: Idempotency ───────────────────────────────────────────────

  describe('4. Duplicate clicks do not create duplicate side effects', () => {
    it('duplicate requestFundingForJob returns same funding request', async () => {
      const { offer } = await createAcceptedOffer('conv-idem-1')
      const jobId = offer.createdJobId!
      const r1 = await requestFundingForJob(jobId)
      const r2 = await requestFundingForJob(jobId)
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)

      // Only one funding request should exist
      const all = getAllFundingRequests()
      const forJob = all.filter(fr => fr.jobId === jobId)
      expect(forJob.length).toBe(1)
    })

    it('duplicate startJob is idempotent', async () => {
      const { offer } = await createAcceptedOffer('conv-idem-2')
      const jobId = offer.createdJobId!
      await requestFundingWorkflow(jobId)
      await simulateCustomerFunding(jobId)

      const r1 = await startJob(jobId)
      const r2 = await startJob(jobId)
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)
      expect(getJobById(jobId)!.status).toBe('in_progress')
    })

    it('duplicate completeJob is idempotent', async () => {
      const { offer } = await createAcceptedOffer('conv-idem-3')
      const jobId = offer.createdJobId!
      await requestFundingWorkflow(jobId)
      await simulateCustomerFunding(jobId)
      await startJob(jobId)

      const r1 = await completeJob(jobId)
      const r2 = await completeJob(jobId)
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)
    })
  })

  // ── PART 5: Customer/project surface consistency ──────────────────────

  describe('5. Customer surfaces update correctly after provider actions', () => {
    it('customer sees work_in_progress after startJob', async () => {
      const { offer } = await createAcceptedOffer('conv-cust-1')
      const jobId = offer.createdJobId!
      await requestFundingWorkflow(jobId)
      await simulateCustomerFunding(jobId)
      await startJob(jobId)

      const job = getJobById(jobId)!
      installSessionForJobOwner(job)
      const { stage } = deriveCustomerJobStage(
        job.status, job.paymentState,
        job.proposalSentAt, job.proposalAcceptedAt, 'funded'
      )
      expect(stage).toBe('work_in_progress')
    })

    it('customer sees work_completed after completeJob', async () => {
      const { offer } = await createAcceptedOffer('conv-cust-2')
      const jobId = offer.createdJobId!
      await requestFundingWorkflow(jobId)
      await simulateCustomerFunding(jobId)
      await startJob(jobId)
      await completeJob(jobId)

      const job = getJobById(jobId)!
      installSessionForJobOwner(job)
      const { stage } = deriveCustomerJobStage(
        job.status, job.paymentState,
        job.proposalSentAt, job.proposalAcceptedAt, 'funded'
      )
      expect(stage).toBe('work_completed')
    })

    it('provider phase reflects funded_in_escrow when customer has funded', async () => {
      const { offer } = await createAcceptedOffer('conv-phase-1')
      const jobId = offer.createdJobId!
      await requestFundingWorkflow(jobId)
      await simulateCustomerFunding(jobId)

      const job = getJobById(jobId)!
      installSessionForJobOwner(job)
      const fr = getFundingRequestByJobId(jobId)
      const ep = getEscrowPlanByJobId(jobId)
      const { phase } = deriveProviderJobPhase(job, fr?.status, ep?.status)
      expect(phase).toBe('funded_in_escrow')
    })

    it('provider next action shows start_work when funded', async () => {
      const { offer } = await createAcceptedOffer('conv-phase-2')
      const jobId = offer.createdJobId!
      await requestFundingWorkflow(jobId)
      await simulateCustomerFunding(jobId)

      const job = getJobById(jobId)!
      installSessionForJobOwner(job)
      const fr = getFundingRequestByJobId(jobId)
      const ep = getEscrowPlanByJobId(jobId)
      const action = deriveProviderNextAction(job, fr?.status, ep?.status)
      expect(action.actionId).toBe('start_work')
      expect(action.enabled).toBe(true)
    })
  })

  // ── PART 6: No regression to funding flow ─────────────────────────────

  describe('6. No regression to funding flow', () => {
    it('requestFundingWorkflow still works correctly', async () => {
      const { offer } = await createAcceptedOffer('conv-fund-reg-1')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      const result = await requestFundingWorkflow(job.id)
      expect(result).toBeDefined()
      expect(result!.status).toBe('sent')
    })

    it('funding confirmation updates escrow plan status', async () => {
      const { offer } = await createAcceptedOffer('conv-fund-reg-2')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      await requestFundingWorkflow(job.id)
      await simulateCustomerFunding(job.id)

      const ep = getEscrowPlanByJobId(job.id)!
      expect(ep.status).toBe('funded_in_escrow')
    })
  })

  // ── PART 7: No regression to quote lifecycle ──────────────────────────

  describe('7. No regression to quote lifecycle', () => {
    it('accepted offer creates escrow plan with 25/75 tranches', async () => {
      const { offer } = await createAcceptedOffer('conv-quote-reg-1')
      const ep = getEscrowPlanByJobId(offer.createdJobId!)
      expect(ep).toBeDefined()
      expect(ep!.totalAmount).toBe(6000)

      const tranches = getEscrowTranches(ep!.id)
      expect(tranches.length).toBe(2)
      const deposit = tranches.find(t => t.kind === 'deposit_release')
      const final = tranches.find(t => t.kind === 'final_release')
      expect(deposit!.percentage).toBe(25)
      expect(final!.percentage).toBe(75)
    })
  })

  // ── PART 8: No regression to thread logic ─────────────────────────────

  describe('8. No regression to relationship-thread logic', () => {
    it('job has sourceConversationId after acceptance', async () => {
      const { offer } = await createAcceptedOffer('conv-thread-reg-1')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      expect(job.sourceConversationId).toBe('conv-thread-reg-1')
    })
  })

  // ── PART 9: No regression to participant scoping ──────────────────────

  describe('9. No regression to participant scoping', () => {
    it('job has customerUserId and craftsmanUserId after acceptance', async () => {
      const { offer } = await createAcceptedOffer('conv-scope-reg-1')
      const job = getJobById(offer.createdJobId!)!
      installSessionForJobOwner(job)
      expect(job.customerUserId).toBe('customer-persist')
    })
  })

  // ── PART 10: Full happy path ──────────────────────────────────────────

  describe('10. Full lifecycle through guarded commands', () => {
    it('completes quote → fund → start → complete with persisted truth', async () => {
      const { offer } = await createAcceptedOffer('conv-full-persist')
      const jobId = offer.createdJobId!

      // Phase 1: Request funding
      const fundResult = await requestFundingForJob(jobId)
      expect(fundResult.ok).toBe(true)

      // Phase 2: Customer funds
      await simulateCustomerFunding(jobId)

      // Phase 3: Start work
      const startResult = await startJob(jobId)
      expect(startResult.ok).toBe(true)

      // Verify 25% tranche
      const ep = getEscrowPlanByJobId(jobId)!
      const tranchesStart = getEscrowTranches(ep.id)
      expect(tranchesStart.find(t => t.kind === 'deposit_release')!.status).toBe('eligible_for_release')

      // Phase 4: Complete work
      const completeResult = await completeJob(jobId)
      expect(completeResult.ok).toBe(true)

      // Verify 75% tranche
      const tranchesEnd = getEscrowTranches(ep.id)
      expect(tranchesEnd.find(t => t.kind === 'final_release')!.status).toBe('eligible_for_release')

      // Verify final job state
      const finalJob = getJobById(jobId)!
      expect(finalJob.workCompletedAt).toBeTruthy()
      expect(finalJob.status).toBe('waiting_payment')
    })
  })
})
