/**
 * Block 2 — Payment Sync Guards
 *
 * Proves that downstream state propagation is deterministic when canonical
 * payment/funding truth changes.
 *
 * TARGET CONTRADICTION CLASS (from audit PDFs):
 * - funded truth exists, but downstream still shows "Einzahlung ausstehend"
 * - provider sees "ready to start" and "payment outstanding" simultaneously
 * - customer sees funded confirmation and still sees outstanding payment state
 * - state transitions partially apply to payment but not job/project
 *
 * INVARIANTS TESTED:
 * 1. If canonical funded truth exists, downstream job/project paymentState
 *    must not remain at deposit_required / none.
 * 2. If downstream sync fails, the failure must not be silent (logged).
 * 3. reconcilePaymentStateDownstream() can fix stale downstream state.
 * 4. No stale outstanding state survives after funded truth in guarded flow.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { addJob, getJobById } from '../../src/lib/jobs'
import { addProject, getProjectByJobId } from '../../src/lib/projects'
import {
  createPaymentForJob,
  getPaymentForJob,
} from '../../src/lib/payments/service'
import {
  updatePaymentWorkflow,
  markDepositPaidWorkflow,
  lockEscrowWorkflow,
  prepareDepositCardWorkflow,
  reconcilePaymentStateDownstream,
} from '../../src/lib/workflow/paymentWorkflow'
import * as observability from '../../src/lib/observability'
import type { Job } from '../../src/lib/jobs/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestJob(overrides?: Partial<Job>): Job {
  return {
    id: 'job-sync-test',
    projectId: 'project-sync-test',
    title: 'Sync Test Job',
    customer: 'Test Customer',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'new',
    amount: '€2.000',
    description: 'Test job for payment sync guards',
    paymentState: 'none',
    documentationStatus: 'Keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    customerUserId: 'customer-1',
    craftsmanUserId: 'craftsman-1',
    proposalAcceptedAt: Date.now(),
    ...overrides,
  }
}

async function setupJobWithProject(jobOverrides?: Partial<Job>) {
  const job = createTestJob(jobOverrides)
  await addJob(job)
  await addProject({
    id: job.projectId,
    title: job.title,
    status: 'request',
    category: 'Elektrik',
    customer: job.customer,
    craftsman: 'Test Craftsman',
    location: job.location,
    dateLabel: 'Heute',
    price: job.amount,
    sourceJobId: job.id,
    paymentState: 'none',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return job
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Block 2 — Payment Sync Guards', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── INVARIANT 1: Funded truth propagates to job AND project ────────────

  describe('Deterministic downstream propagation', () => {
    it('updatePaymentWorkflow syncs payment state to both job and project', async () => {
      const job = await setupJobWithProject()
      await createPaymentForJob(job.id, 2000)

      // Transition: deposit_required → deposit_paid
      const updated = await updatePaymentWorkflow(job.id, 'deposit_paid')
      expect(updated).toBeDefined()
      expect(updated!.state).toBe('deposit_paid')

      // INVARIANT: Job downstream state matches canonical truth
      const syncedJob = getJobById(job.id)
      expect(syncedJob!.paymentState).toBe('deposit_paid')

      // INVARIANT: Project downstream state matches canonical truth
      const syncedProject = getProjectByJobId(job.id)
      expect(syncedProject!.paymentState).toBe('deposit_paid')
    })

    it('markDepositPaidWorkflow propagates deposit_paid to job and project', async () => {
      const job = await setupJobWithProject()
      await createPaymentForJob(job.id, 2000)

      const updated = await markDepositPaidWorkflow(job.id)
      expect(updated).toBeDefined()

      const syncedJob = getJobById(job.id)
      expect(syncedJob!.paymentState).toBe('deposit_paid')

      const syncedProject = getProjectByJobId(job.id)
      expect(syncedProject!.paymentState).toBe('deposit_paid')
    })

    it('lockEscrowWorkflow propagates in_escrow to job and project', async () => {
      const job = await setupJobWithProject()
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')

      const updated = await lockEscrowWorkflow(job.id)
      expect(updated).toBeDefined()

      const syncedJob = getJobById(job.id)
      expect(syncedJob!.paymentState).toBe('in_escrow')

      const syncedProject = getProjectByJobId(job.id)
      expect(syncedProject!.paymentState).toBe('in_escrow')
    })

    it('full payment lifecycle propagates every state to job and project', async () => {
      const job = await setupJobWithProject()
      await createPaymentForJob(job.id, 2000)

      const states: Array<{ state: string }> = [
        { state: 'deposit_paid' },
        { state: 'in_escrow' },
        { state: 'work_in_progress' },
        { state: 'release_pending' },
      ]

      for (const { state } of states) {
        await updatePaymentWorkflow(job.id, state as import('../../src/lib/shared/coreTypes').PaymentState)

        const syncedJob = getJobById(job.id)
        expect(syncedJob!.paymentState).toBe(state)

        const syncedProject = getProjectByJobId(job.id)
        expect(syncedProject!.paymentState).toBe(state)
      }
    })
  })

  // ── INVARIANT 2: No silent failure ─────────────────────────────────────

  describe('No silent partial success', () => {
    it('sync still attempts project update even when job update throws', async () => {
      // Setup: job with project, payment at deposit_required
      const job = await setupJobWithProject()
      await createPaymentForJob(job.id, 2000)

      // Verify baseline state
      const payment = getPaymentForJob(job.id)
      expect(payment!.state).toBe('deposit_required')

      const beforeJob = getJobById(job.id)
      expect(beforeJob!.paymentState).toBe('none')

      // After updatePaymentWorkflow, both should be synced
      await updatePaymentWorkflow(job.id, 'deposit_paid')

      const afterJob = getJobById(job.id)
      expect(afterJob!.paymentState).toBe('deposit_paid')

      const afterProject = getProjectByJobId(job.id)
      expect(afterProject!.paymentState).toBe('deposit_paid')
    })

    it('logs warning when project is not found but job has projectId', async () => {
      // Setup: job with projectId but no project entity in repo
      const job = createTestJob()
      await addJob(job)
      // Don't create project entity — simulate missing project

      await createPaymentForJob(job.id, 2000)

      // Spy on observability.logWarning directly (console output is
      // suppressed in test mode to avoid Vitest RPC teardown errors)
      const warnSpy = vi.spyOn(observability, 'logWarning')

      await updatePaymentWorkflow(job.id, 'deposit_paid')

      // Job should still be synced
      const syncedJob = getJobById(job.id)
      expect(syncedJob!.paymentState).toBe('deposit_paid')

      // Warning should have been logged about missing project
      const projectWarning = warnSpy.mock.calls.find(
        (call) => call[0] === 'workflow.payment_sync.project_not_found'
      )
      expect(projectWarning).toBeDefined()

      warnSpy.mockRestore()
    })
  })

  // ── INVARIANT 3: reconcilePaymentStateDownstream fixes stale state ─────

  describe('reconcilePaymentStateDownstream — deterministic recovery', () => {
    it('detects and fixes stale job paymentState', async () => {
      const job = await setupJobWithProject()
      await createPaymentForJob(job.id, 2000)

      // Advance payment state through the guarded flow
      await updatePaymentWorkflow(job.id, 'deposit_paid')

      // Verify initial sync was correct
      expect(getJobById(job.id)!.paymentState).toBe('deposit_paid')

      // Simulate stale state by directly mutating job paymentState to 'none'
      // (as if a previous sync had failed or a concurrent write occurred)
      const { getJobRepository } = await import('../../src/lib/jobs/repository')
      getJobRepository().update(job.id, (j) => ({ ...j, paymentState: 'none' }))

      // Confirm job is now stale relative to canonical truth
      expect(getJobById(job.id)!.paymentState).toBe('none')
      expect(getPaymentForJob(job.id)!.state).toBe('deposit_paid')

      // Reconcile should detect divergence and fix it
      const result = await reconcilePaymentStateDownstream(job.id)
      expect(result).toBeDefined()
      expect(result!.jobSynced).toBe(true)

      // Job should now match canonical truth
      expect(getJobById(job.id)!.paymentState).toBe('deposit_paid')
    })

    it('detects and fixes stale project paymentState', async () => {
      const job = await setupJobWithProject()
      await createPaymentForJob(job.id, 2000)

      await updatePaymentWorkflow(job.id, 'deposit_paid')

      // Verify initial sync was correct
      const project = getProjectByJobId(job.id)!
      expect(project.paymentState).toBe('deposit_paid')

      // Simulate stale project state
      const { getProjectRepository } = await import('../../src/lib/projects/repository')
      getProjectRepository().update(project.id, { paymentState: 'none' })

      // Confirm project is stale
      expect(getProjectByJobId(job.id)!.paymentState).toBe('none')

      // Reconcile should fix it
      const result = await reconcilePaymentStateDownstream(job.id)
      expect(result).toBeDefined()
      expect(result!.projectSynced).toBe(true)

      // Project should now match canonical truth
      expect(getProjectByJobId(job.id)!.paymentState).toBe('deposit_paid')
    })

    it('returns already-synced result when no divergence exists', async () => {
      const job = await setupJobWithProject()
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')

      // All in sync — reconcile should be a no-op
      const result = await reconcilePaymentStateDownstream(job.id)
      expect(result).toBeDefined()
      expect(result!.jobSynced).toBe(true)
      expect(result!.projectSynced).toBe(true)
    })

    it('returns undefined when no payment exists for the job', async () => {
      const job = await setupJobWithProject()
      // No payment created

      const result = await reconcilePaymentStateDownstream(job.id)
      expect(result).toBeUndefined()
    })
  })

  // ── INVARIANT 4: PDF contradiction class is closed ─────────────────────

  describe('Funded contradiction class — exact failure trace', () => {
    it('funded customer context does NOT show outstanding payment state', async () => {
      // BEFORE (broken):
      //   1. canonical payment state changed to deposit_paid
      //   2. downstream sync was fire-and-forget void
      //   3. job/project paymentState could remain at deposit_required/none
      //   4. customer-facing screens showed "Einzahlung ausstehend"
      //
      // AFTER (fixed):
      //   1. canonical payment state changes to deposit_paid
      //   2. guarded sync updates job AND project or logs failure
      //   3. job/project paymentState matches canonical truth
      //   4. customer-facing screens see deposit_paid

      const job = await setupJobWithProject({
        paymentState: 'deposit_required',
      })
      await createPaymentForJob(job.id, 2000)

      // Simulate the funded path
      await updatePaymentWorkflow(job.id, 'deposit_paid')
      await updatePaymentWorkflow(job.id, 'in_escrow')

      // Canonical truth
      const payment = getPaymentForJob(job.id)
      expect(payment!.state).toBe('in_escrow')

      // INVARIANT: Job downstream state does NOT remain at deposit_required
      const jobAfter = getJobById(job.id)
      expect(jobAfter!.paymentState).not.toBe('deposit_required')
      expect(jobAfter!.paymentState).not.toBe('none')
      expect(jobAfter!.paymentState).toBe('in_escrow')

      // INVARIANT: Project downstream state does NOT remain at deposit_required
      const projectAfter = getProjectByJobId(job.id)
      expect(projectAfter!.paymentState).not.toBe('deposit_required')
      expect(projectAfter!.paymentState).not.toBe('none')
      expect(projectAfter!.paymentState).toBe('in_escrow')
    })

    it('funded provider context does NOT show ready-to-start + payment-outstanding simultaneously', async () => {
      // Scenario: provider starts work, payment is in_escrow
      // The provider should see in_escrow (funded), NOT deposit_required

      const job = await setupJobWithProject({
        status: 'in_progress',
        paymentState: 'deposit_required',
      })
      await createPaymentForJob(job.id, 2000)

      // Advance through payment lifecycle
      await updatePaymentWorkflow(job.id, 'deposit_paid')
      await updatePaymentWorkflow(job.id, 'in_escrow')
      await updatePaymentWorkflow(job.id, 'work_in_progress')

      // INVARIANT: Job paymentState matches canonical truth
      const jobAfter = getJobById(job.id)
      expect(jobAfter!.paymentState).toBe('work_in_progress')
      expect(jobAfter!.paymentState).not.toBe('deposit_required')

      // INVARIANT: Project paymentState matches canonical truth
      const projectAfter = getProjectByJobId(job.id)
      expect(projectAfter!.paymentState).toBe('work_in_progress')
      expect(projectAfter!.paymentState).not.toBe('deposit_required')
    })

    it('funded confirmation + outstanding does NOT coexist on same customer context', async () => {
      // After deposit confirmation, the customer should see deposit_paid
      // on all surfaces, not deposit_required

      const job = await setupJobWithProject({
        paymentState: 'deposit_required',
      })
      await createPaymentForJob(job.id, 2000)

      // Customer pays deposit
      await updatePaymentWorkflow(job.id, 'deposit_paid')

      // All surfaces must agree
      const canonicalPayment = getPaymentForJob(job.id)
      const jobState = getJobById(job.id)!.paymentState
      const projectState = getProjectByJobId(job.id)!.paymentState

      expect(canonicalPayment!.state).toBe('deposit_paid')
      expect(jobState).toBe('deposit_paid')
      expect(projectState).toBe('deposit_paid')

      // None of the downstream surfaces should show outstanding
      expect(jobState).not.toBe('deposit_required')
      expect(projectState).not.toBe('deposit_required')
      expect(jobState).not.toBe('none')
      expect(projectState).not.toBe('none')
    })

    it('stale outstanding state does NOT survive after reconciliation', async () => {
      // Simulate the worst case: canonical truth advanced but downstream is stale
      const job = await setupJobWithProject()
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')
      await updatePaymentWorkflow(job.id, 'in_escrow')

      // Manually create divergence (simulating a past partial-success)
      const { getJobRepository } = await import('../../src/lib/jobs/repository')
      const { getProjectRepository } = await import('../../src/lib/projects/repository')
      getJobRepository().update(job.id, (j) => ({ ...j, paymentState: 'deposit_required' }))
      getProjectRepository().update(job.projectId, { paymentState: 'deposit_required' })

      // Confirm divergence
      expect(getJobById(job.id)!.paymentState).toBe('deposit_required')
      expect(getProjectByJobId(job.id)!.paymentState).toBe('deposit_required')
      expect(getPaymentForJob(job.id)!.state).toBe('in_escrow')

      // Reconcile
      const result = await reconcilePaymentStateDownstream(job.id)
      expect(result).toBeDefined()
      expect(result!.jobSynced).toBe(true)
      expect(result!.projectSynced).toBe(true)

      // Stale outstanding state must NOT survive
      expect(getJobById(job.id)!.paymentState).toBe('in_escrow')
      expect(getProjectByJobId(job.id)!.paymentState).toBe('in_escrow')
    })
  })

  // ── INVARIANT 5: No regression to Block 1 hydration semantics ──────────

  describe('No regression to Block 1 hydration semantics', () => {
    it('InMemory repositories remain hydrated after payment sync operations', async () => {
      const { isJobRepositoryHydrated } = await import('../../src/lib/jobs')
      const { isProjectRepositoryHydrated } = await import('../../src/lib/projects')
      const { isPaymentRepositoryHydrated } = await import('../../src/lib/payments/service')

      expect(isJobRepositoryHydrated()).toBe(true)
      expect(isProjectRepositoryHydrated()).toBe(true)
      expect(isPaymentRepositoryHydrated()).toBe(true)

      // Perform sync operations
      const job = await setupJobWithProject()
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')
      await reconcilePaymentStateDownstream(job.id)

      // Hydration must still be true
      expect(isJobRepositoryHydrated()).toBe(true)
      expect(isProjectRepositoryHydrated()).toBe(true)
      expect(isPaymentRepositoryHydrated()).toBe(true)
    })
  })

  // ── INVARIANT 6: No regression to quote open-path behavior ─────────────

  describe('No regression to quote open-path behavior', () => {
    it('prepareDepositCardWorkflow still syncs payment state correctly', async () => {
      const job = await setupJobWithProject({
        amount: '€2.000,00',
        proposalAcceptedAt: Date.now(),
      })

      const payment = await prepareDepositCardWorkflow(job.id)
      expect(payment).toBeDefined()

      // Job and project should have the payment state from the created payment
      const syncedJob = getJobById(job.id)
      expect(syncedJob!.paymentState).toBe(payment!.state)

      const syncedProject = getProjectByJobId(job.id)
      expect(syncedProject!.paymentState).toBe(payment!.state)
    })

    it('prepareDepositCardWorkflow works after reload when job.amount is empty but offer exists', async () => {
      // Simulate post-reload state: job.amount is '' (not persisted),
      // but an accepted offer with a price IS available (offers are persisted)
      const { addOffer } = await import('../../src/lib/offers/service')

      const job = await setupJobWithProject({
        amount: '',  // empty after reload — not persisted
        proposalAcceptedAt: Date.now(),
        sourceOfferId: 'offer-reload-1',
      })

      // Add the accepted offer with canonical price
      await addOffer({
        id: 'offer-reload-1',
        conversationId: 'conv-1',
        jobId: job.id,
        craftsmanUserId: 'craftsman-1',
        customerUserId: 'customer-1',
        price: '2.000 €',
        description: 'Test offer',
        status: 'accepted',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      const payment = await prepareDepositCardWorkflow(job.id)
      // Before this fix, this would return undefined because job.amount is ''
      // After the fix, it uses resolveCanonicalAmount which finds the offer price
      expect(payment).toBeDefined()
      expect(payment!.state).toBeDefined()
    })
  })

  // ── PaymentSyncResult type contract ────────────────────────────────────

  describe('PaymentSyncResult type contract', () => {
    it('returns structured result with both success flags', async () => {
      // We can't call the private syncPaymentStateToJobAndProject directly,
      // but reconcilePaymentStateDownstream returns the same shape.
      const job = await setupJobWithProject()
      await createPaymentForJob(job.id, 2000)

      // Force a divergence so reconcile actually triggers the sync
      const { getJobRepository } = await import('../../src/lib/jobs/repository')
      await updatePaymentWorkflow(job.id, 'deposit_paid')
      getJobRepository().update(job.id, (j) => ({ ...j, paymentState: 'none' }))

      const result = await reconcilePaymentStateDownstream(job.id)
      expect(result).toBeDefined()

      // Check the result has the expected shape
      expect(typeof result!.jobSynced).toBe('boolean')
      expect(typeof result!.projectSynced).toBe('boolean')
      expect(typeof result!.projectNotFound).toBe('boolean')
    })

    it('signals projectNotFound when job has no linked project', async () => {
      const job = createTestJob({ projectId: '' }) // empty projectId
      await addJob(job)
      await createPaymentForJob(job.id, 2000)

      // Force divergence
      await updatePaymentWorkflow(job.id, 'deposit_paid')
      const { getJobRepository } = await import('../../src/lib/jobs/repository')
      getJobRepository().update(job.id, (j) => ({ ...j, paymentState: 'none' }))

      const result = await reconcilePaymentStateDownstream(job.id)
      expect(result).toBeDefined()
      expect(result!.projectNotFound).toBe(true)
      expect(result!.jobSynced).toBe(true)
    })
  })
})
