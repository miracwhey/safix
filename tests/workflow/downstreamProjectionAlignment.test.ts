/**
 * Block 2.1 — Downstream Projection Alignment and Recovery Wiring
 *
 * Proves that:
 * 1. Funded customer context cannot show outstanding payment state on canonical projection
 * 2. Funded provider context cannot show ready-to-start AND outstanding simultaneously
 * 3. Completed/closed is not projected before true completion conditions
 * 4. reconcilePaymentStateDownstream() is invoked by syncAllProjectsFromJobs (bootstrap)
 * 5. Stale downstream divergence is repaired on the recovery path
 * 6. No regression to Block 1 hydration semantics
 * 7. No regression to Block 2 propagation hardening
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { addJob, getJobById } from '../../src/lib/jobs'
import { addProject, getProjectByJobId } from '../../src/lib/projects'
import {
  createPaymentForJob,
  getPaymentForJob,
} from '../../src/lib/payments/service'
import {
  updatePaymentWorkflow,
  reconcilePaymentStateDownstream,
} from '../../src/lib/workflow/paymentWorkflow'
import { deriveCanonicalProjection } from '../../src/lib/shared/canonicalCustomerLifecycle'
import { deriveCustomerJobStage } from '../../src/lib/jobs/customerJobStageSelectors'
import { deriveProviderJobPhase } from '../../src/lib/jobs/providerJobPhaseSelectors'
import { deriveProviderNextAction } from '../../src/lib/jobs/providerNextActionSelectors'
import { syncAllProjectsFromJobs } from '../../src/lib/projects/projectJobSyncBridge'
import {
  ensureFundingRequest,
  markFundingCompleted,
} from '../../src/lib/payments/fundingRequest/fundingRequestService'
import {
  ensureEscrowPlan,
  confirmFunding,
} from '../../src/lib/payments/escrow/escrowService'
import type { Job } from '../../src/lib/jobs/types'
import type { Project } from '../../src/lib/projects/projectTypes'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = Date.now()
const HOUR = 3600_000

function makeJob(overrides?: Partial<Job>): Job {
  return {
    id: 'job-proj-1',
    projectId: 'project-proj-1',
    title: 'Test Job',
    customer: 'Test Customer',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'new',
    amount: '€2.000',
    description: 'Test',
    paymentState: 'none',
    documentationStatus: 'Keine',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    customerUserId: 'customer-1',
    craftsmanUserId: 'craftsman-1',
    proposalSentAt: NOW - 72 * HOUR,
    proposalAcceptedAt: NOW - 48 * HOUR,
    ...overrides,
  }
}

function makeProject(overrides?: Partial<Project>): Project {
  return {
    id: 'project-proj-1',
    sourceJobId: 'job-proj-1',
    title: 'Test Project',
    customer: 'Test Customer',
    craftsman: 'Test Craftsman',
    location: 'Berlin',
    dateLabel: 'Heute',
    price: '€2.000',
    status: 'request',
    paymentState: 'none',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/**
 * Seeds a FundingRequest in 'funded' status and EscrowPlan in 'funded_in_escrow'
 * for the given job. This establishes canonical funded truth.
 */
async function seedFundedContext(jobId: string, offerId: string) {
  const plan = await ensureEscrowPlan({
    sourceOfferId: offerId,
    jobId,
    customerUserId: 'customer-1',
    providerId: 'provider-1',
    totalAmount: 2000,
  })
  await confirmFunding(plan.id)

  const fr = await ensureFundingRequest({
    sourceOfferId: offerId,
    jobId,
    escrowPlanId: plan.id,
    customerUserId: 'customer-1',
    providerUserId: 'craftsman-1',
    providerId: 'provider-1',
    amount: 2000,
  })
  await markFundingCompleted(fr.id)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Block 2.1 — Downstream Projection Alignment', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── 1. Funded customer context cannot show outstanding ────────────────

  describe('Funded customer context cannot show outstanding payment state', () => {
    it('canonical projection overrides stale deposit_required when funding is confirmed', async () => {
      // Setup: job with stale paymentState, but funded truth exists
      const job = makeJob({
        paymentState: 'deposit_required', // stale downstream value
        sourceOfferId: 'offer-1',
      })
      await addJob(job)
      const project = makeProject({
        paymentState: 'deposit_required', // stale project value
      })
      await addProject(project)

      // Seed funded truth (FundingRequest + EscrowPlan)
      await seedFundedContext(job.id, 'offer-1')

      // Create canonical payment record with correct state
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')

      // Force job.paymentState back to stale value to simulate partial sync failure
      const { getJobRepository } = await import('../../src/lib/jobs/repository')
      await getJobRepository().update(job.id, (j) => ({ ...j, paymentState: 'deposit_required' }))

      // Verify the stale state exists
      expect(getJobById(job.id)!.paymentState).toBe('deposit_required')

      // INVARIANT: canonical projection must NOT show deposit_required
      const canonical = deriveCanonicalProjection(getProjectByJobId(job.id)!)
      expect(canonical.fundingConfirmed).toBe(true)
      expect(canonical.paymentState).not.toBe('deposit_required')
      expect(canonical.paymentState).not.toBe('none')
      expect(canonical.paymentState).toBe('deposit_paid')
    })

    it('canonical projection overrides stale none when funding is confirmed', async () => {
      const job = makeJob({
        paymentState: 'none', // stale
        sourceOfferId: 'offer-2',
      })
      await addJob(job)
      await addProject(makeProject({ paymentState: 'none' }))

      await seedFundedContext(job.id, 'offer-2')

      // No payment record exists — projection should still override to deposit_paid floor
      const canonical = deriveCanonicalProjection(getProjectByJobId(job.id)!)
      expect(canonical.fundingConfirmed).toBe(true)
      expect(canonical.paymentState).not.toBe('none')
      expect(canonical.paymentState).toBe('deposit_paid')
    })

    it('canonical projection preserves non-stale payment state when funded', async () => {
      const job = makeJob({
        paymentState: 'in_escrow', // not stale
        sourceOfferId: 'offer-3',
      })
      await addJob(job)
      await addProject(makeProject({ paymentState: 'in_escrow' }))

      await seedFundedContext(job.id, 'offer-3')

      const canonical = deriveCanonicalProjection(getProjectByJobId(job.id)!)
      expect(canonical.fundingConfirmed).toBe(true)
      expect(canonical.paymentState).toBe('in_escrow')
    })
  })

  // ── 2. Provider funded + outstanding contradiction ────────────────────

  describe('Funded provider context consistency', () => {
    it('funded_in_escrow phase does not coexist with deposit_required on canonical projection', async () => {
      const job = makeJob({
        status: 'new',
        paymentState: 'deposit_required', // stale
        sourceOfferId: 'offer-4',
      })
      await addJob(job)
      await addProject(makeProject({ paymentState: 'deposit_required' }))

      await seedFundedContext(job.id, 'offer-4')
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')

      // Force stale state
      const { getJobRepository } = await import('../../src/lib/jobs/repository')
      await getJobRepository().update(job.id, (j) => ({ ...j, paymentState: 'deposit_required' }))

      // Provider sees funded_in_escrow phase
      const { phase } = deriveProviderJobPhase(getJobById(job.id)!, 'funded', 'funded_in_escrow')
      expect(phase).toBe('funded_in_escrow')

      // Canonical projection for same context must NOT show outstanding
      const canonical = deriveCanonicalProjection(getProjectByJobId(job.id)!)
      expect(canonical.paymentState).not.toBe('deposit_required')
      expect(canonical.fundingConfirmed).toBe(true)
    })

    it('provider next action shows start_work (not wait_for_funding) when funded', async () => {
      const job = makeJob({
        status: 'new',
        paymentState: 'deposit_paid',
        sourceOfferId: 'offer-5',
      })
      await addJob(job)

      const action = deriveProviderNextAction(job, 'funded', 'funded_in_escrow')
      expect(action.actionId).toBe('start_work')
      expect(action.label).toBe('Arbeit starten')
    })
  })

  // ── 3. Premature completed/closed prevention ──────────────────────────

  describe('Completed/closed not projected before true completion', () => {
    it('completed + stale deposit_required does NOT project as payment_released', () => {
      // This is the exact contradiction: job is completed but payment never went terminal
      const result = deriveCustomerJobStage(
        'completed',
        'deposit_required',
        NOW - 72 * HOUR,
        NOW - 48 * HOUR,
      )
      expect(result.stage).not.toBe('payment_released')
      expect(result.stage).toBe('work_completed')
    })

    it('completed + in_escrow does NOT project as payment_released', () => {
      const result = deriveCustomerJobStage(
        'completed',
        'in_escrow',
        NOW - 72 * HOUR,
        NOW - 48 * HOUR,
      )
      expect(result.stage).not.toBe('payment_released')
      expect(result.stage).toBe('work_completed')
    })

    it('completed + released DOES project as payment_released', () => {
      const result = deriveCustomerJobStage(
        'completed',
        'released',
        NOW - 72 * HOUR,
        NOW - 48 * HOUR,
      )
      expect(result.stage).toBe('payment_released')
    })

    it('completed + refunded DOES project as payment_released', () => {
      const result = deriveCustomerJobStage(
        'completed',
        'refunded',
        NOW - 72 * HOUR,
        NOW - 48 * HOUR,
      )
      expect(result.stage).toBe('payment_released')
    })

    it('completed + fully_released escrow DOES project as payment_released', () => {
      const result = deriveCustomerJobStage(
        'completed',
        'in_escrow', // non-terminal payment state
        NOW - 72 * HOUR,
        NOW - 48 * HOUR,
        undefined,
        'fully_released', // but escrow confirms full release
      )
      expect(result.stage).toBe('payment_released')
    })

    it('cancelled + none does NOT project as payment_released', () => {
      const result = deriveCustomerJobStage(
        'cancelled',
        'none',
      )
      expect(result.stage).not.toBe('payment_released')
      expect(result.stage).toBe('work_completed')
    })

    it('accepted + funded does NOT project as completed', () => {
      // Funded but no work started — must not show as completed
      const result = deriveCustomerJobStage(
        'new',
        'deposit_paid',
        NOW - 72 * HOUR,
        NOW - 48 * HOUR,
        'funded',
      )
      expect(result.stage).toBe('funded_in_escrow')
      expect(result.stage).not.toBe('payment_released')
      expect(result.stage).not.toBe('work_completed')
    })
  })

  // ── 4. reconcilePaymentStateDownstream wired into sync bridge ─────────

  describe('reconcilePaymentStateDownstream is invoked by real paths', () => {
    it('syncAllProjectsFromJobs repairs stale downstream payment state', async () => {
      const job = makeJob({ paymentState: 'none' })
      await addJob(job)
      await addProject(makeProject({ paymentState: 'none' }))

      // Create canonical payment and advance to deposit_paid
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')

      // Verify sync worked
      expect(getJobById(job.id)!.paymentState).toBe('deposit_paid')

      // Force stale downstream state
      const { getJobRepository } = await import('../../src/lib/jobs/repository')
      const { getProjectRepository } = await import('../../src/lib/projects/repository')
      await getJobRepository().update(job.id, (j) => ({ ...j, paymentState: 'none' }))
      getProjectRepository().update('project-proj-1', { paymentState: 'none' })

      // Confirm divergence
      expect(getJobById(job.id)!.paymentState).toBe('none')
      expect(getProjectByJobId(job.id)!.paymentState).toBe('none')
      expect(getPaymentForJob(job.id)!.state).toBe('deposit_paid')

      // Bootstrap sync should repair divergence
      await syncAllProjectsFromJobs()

      // Downstream now matches canonical truth
      expect(getJobById(job.id)!.paymentState).toBe('deposit_paid')
      expect(getProjectByJobId(job.id)!.paymentState).toBe('deposit_paid')
    })

    it('syncAllProjectsFromJobs is a no-op when everything is in sync', async () => {
      const job = makeJob({ paymentState: 'deposit_paid' })
      await addJob(job)
      await addProject(makeProject({ paymentState: 'deposit_paid' }))
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')

      // All in sync — this should be a no-op
      await syncAllProjectsFromJobs()

      expect(getJobById(job.id)!.paymentState).toBe('deposit_paid')
      expect(getProjectByJobId(job.id)!.paymentState).toBe('deposit_paid')
    })
  })

  // ── 5. Direct reconciliation still works ──────────────────────────────

  describe('Stale downstream divergence repaired on recovery path', () => {
    it('reconcilePaymentStateDownstream fixes job + project divergence', async () => {
      const job = makeJob({ paymentState: 'none' })
      await addJob(job)
      await addProject(makeProject({ paymentState: 'none' }))

      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')
      await updatePaymentWorkflow(job.id, 'in_escrow')

      // Force stale state
      const { getJobRepository } = await import('../../src/lib/jobs/repository')
      const { getProjectRepository } = await import('../../src/lib/projects/repository')
      await getJobRepository().update(job.id, (j) => ({ ...j, paymentState: 'deposit_required' }))
      getProjectRepository().update('project-proj-1', { paymentState: 'deposit_required' })

      // Reconcile
      const result = await reconcilePaymentStateDownstream(job.id)
      expect(result).toBeDefined()
      expect(result!.jobSynced).toBe(true)
      expect(result!.projectSynced).toBe(true)

      // Fixed
      expect(getJobById(job.id)!.paymentState).toBe('in_escrow')
      expect(getProjectByJobId(job.id)!.paymentState).toBe('in_escrow')
    })
  })

  // ── 6. No regression to Block 1 hydration ─────────────────────────────

  describe('No regression to Block 1 hydration semantics', () => {
    it('InMemory repositories remain hydrated after projection operations', async () => {
      const { isJobRepositoryHydrated } = await import('../../src/lib/jobs')
      const { isProjectRepositoryHydrated } = await import('../../src/lib/projects')
      const { isPaymentRepositoryHydrated } = await import('../../src/lib/payments/service')

      expect(isJobRepositoryHydrated()).toBe(true)
      expect(isProjectRepositoryHydrated()).toBe(true)
      expect(isPaymentRepositoryHydrated()).toBe(true)

      // Perform operations
      const job = makeJob()
      await addJob(job)
      await addProject(makeProject())
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')
      await syncAllProjectsFromJobs()
      deriveCanonicalProjection(getProjectByJobId(job.id)!)

      expect(isJobRepositoryHydrated()).toBe(true)
      expect(isProjectRepositoryHydrated()).toBe(true)
      expect(isPaymentRepositoryHydrated()).toBe(true)
    })
  })

  // ── 7. No regression to Block 2 propagation hardening ──────────────────

  describe('No regression to Block 2 propagation hardening', () => {
    it('updatePaymentWorkflow still syncs to both job and project', async () => {
      const job = makeJob({ paymentState: 'none' })
      await addJob(job)
      await addProject(makeProject({ paymentState: 'none' }))

      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')

      expect(getJobById(job.id)!.paymentState).toBe('deposit_paid')
      expect(getProjectByJobId(job.id)!.paymentState).toBe('deposit_paid')
    })

    it('full lifecycle propagates every state downstream', async () => {
      const job = makeJob({ paymentState: 'none' })
      await addJob(job)
      await addProject(makeProject({ paymentState: 'none' }))

      await createPaymentForJob(job.id, 2000)

      const states = ['deposit_paid', 'in_escrow', 'work_in_progress', 'release_pending'] as const
      for (const state of states) {
        await updatePaymentWorkflow(job.id, state)
        expect(getJobById(job.id)!.paymentState).toBe(state)
        expect(getProjectByJobId(job.id)!.paymentState).toBe(state)
      }
    })
  })

  // ── BEFORE/AFTER failure traces ────────────────────────────────────────

  describe('Before/After failure traces', () => {
    it('TRACE: funded + outstanding contradiction → fixed by canonical projection', async () => {
      // BEFORE: canonical payment state = deposit_paid, job.paymentState = deposit_required (stale)
      //   → deriveCanonicalProjection returned paymentState: 'deposit_required'
      //   → customer screens showed "Einzahlung ausstehend" despite funded truth
      //
      // AFTER: deriveCanonicalProjection detects fundingConfirmed + stale paymentState
      //   → resolves effective payment state from canonical payment record
      //   → returns paymentState: 'deposit_paid'
      //   → customer screens show funded state

      const job = makeJob({
        paymentState: 'deposit_required',
        sourceOfferId: 'offer-trace-1',
      })
      await addJob(job)
      await addProject(makeProject({ paymentState: 'deposit_required' }))

      await seedFundedContext(job.id, 'offer-trace-1')
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')

      // Simulate stale downstream
      const { getJobRepository } = await import('../../src/lib/jobs/repository')
      await getJobRepository().update(job.id, (j) => ({ ...j, paymentState: 'deposit_required' }))

      const canonical = deriveCanonicalProjection(getProjectByJobId(job.id)!)
      // AFTER: funded truth dominates
      expect(canonical.paymentState).toBe('deposit_paid')
      expect(canonical.fundingConfirmed).toBe(true)
    })

    it('TRACE: ready-to-start + outstanding contradiction → fixed by canonical projection', async () => {
      // BEFORE: provider phase = funded_in_escrow ("Bereit zum Start")
      //   but canonical projection returned paymentState: 'deposit_required'
      //   → contradicting display
      //
      // AFTER: canonical projection returns deposit_paid when funded truth exists

      const job = makeJob({
        paymentState: 'deposit_required',
        sourceOfferId: 'offer-trace-2',
      })
      await addJob(job)
      await addProject(makeProject({ paymentState: 'deposit_required' }))

      await seedFundedContext(job.id, 'offer-trace-2')
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')
      await updatePaymentWorkflow(job.id, 'in_escrow')

      // Simulate stale downstream
      const { getJobRepository } = await import('../../src/lib/jobs/repository')
      await getJobRepository().update(job.id, (j) => ({ ...j, paymentState: 'deposit_required' }))

      // Provider sees funded phase
      const { phase } = deriveProviderJobPhase(getJobById(job.id)!, 'funded', 'funded_in_escrow')
      expect(phase).toBe('funded_in_escrow')

      // Canonical projection is now consistent — no outstanding
      const canonical = deriveCanonicalProjection(getProjectByJobId(job.id)!)
      expect(canonical.paymentState).toBe('in_escrow')
      expect(canonical.paymentState).not.toBe('deposit_required')
    })

    it('TRACE: completed-too-early contradiction → fixed by stage guard', () => {
      // BEFORE: jobStatus='completed' + paymentState='deposit_required'
      //   → deriveCustomerJobStage returned 'payment_released'
      //   → customer saw "Zahlung frei" when payment was never released
      //
      // AFTER: completed with non-terminal payment returns 'work_completed'
      //   → customer sees "Abgeschlossen" (work status) not "Zahlung frei"

      const result = deriveCustomerJobStage(
        'completed',
        'deposit_required',
        NOW - 72 * HOUR,
        NOW - 48 * HOUR,
      )
      expect(result.stage).toBe('work_completed')
      expect(result.stage).not.toBe('payment_released')
    })
  })
})
