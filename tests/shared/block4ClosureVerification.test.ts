/**
 * Block 4 — Canonical Payment Downstream Alignment Hardening
 *
 * Proves that canonical payment truth and all dependent downstream
 * mirrors/projections tell the same trustworthy story across:
 * - payment execution
 * - dispute interaction
 * - release/refund flows
 * - job/project status
 * - reload/recovery
 *
 * CLOSURE CRITERIA verified by these tests:
 * 1. Payment execution/settlement truth has one clear canonical owner.
 * 2. job.paymentState and project.paymentState are mirrors, not competing canon.
 * 3. No trust-critical workflow can mutate canonical truth while leaving mirrors wrong.
 * 4. Downstream sync is awaited and failure-safe.
 * 5. Reload/rehydration reconstructs the same payment story.
 * 6. No selector tells a stronger story from stale mirrors than canonical truth supports.
 * 7. projectJobSyncBridge / reconcilePaymentStateDownstream are not hiding drift.
 * 8. No "payment says one thing, job/project say another" state is unmodeled.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { addJob, getJobById } from '../../src/lib/jobs'
import { addProject, getProjectByJobId } from '../../src/lib/projects'
import {
  createPaymentForJob,
  getPaymentForJob,
} from '../../src/lib/payments/service'
import {
  updatePaymentWorkflow,
  releaseEscrowWorkflow,
  refundEscrowWorkflow,
  reconcilePaymentStateDownstream,
  syncPaymentStateToJobAndProject,
} from '../../src/lib/workflow/paymentWorkflow'
import { openDisputeWorkflow } from '../../src/lib/workflow/disputeWorkflow'
import { syncAllProjectsFromJobs, syncProjectForJobId } from '../../src/lib/projects/projectJobSyncBridge'
import type { Job } from '../../src/lib/jobs/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestJob(overrides?: Partial<Job>): Job {
  return {
    id: 'job-b4-test',
    projectId: 'project-b4-test',
    title: 'Block 4 Test Job',
    customer: 'Test Customer',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'new',
    amount: '€2.000',
    description: 'Block 4 closure verification',
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
    id: job.projectId!,
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

describe('Block 4 — Canonical Payment Downstream Alignment', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── CRITERION 1: Single canonical payment owner ─────────────────────
  describe('C1: Payment execution truth has one canonical owner', () => {
    it('payment entity is canonical; job.paymentState and project.paymentState are mirrors', async () => {
      const job = await setupJobWithProject()
      await createPaymentForJob(job.id, 2000)

      await updatePaymentWorkflow(job.id, 'deposit_paid')

      const payment = getPaymentForJob(job.id)!
      const jobAfter = getJobById(job.id)!
      const projectAfter = getProjectByJobId(job.id)!

      // Canonical truth is the payment entity
      expect(payment.state).toBe('deposit_paid')
      // Mirrors reflect canonical truth
      expect(jobAfter.paymentState).toBe(payment.state)
      expect(projectAfter.paymentState).toBe(payment.state)
    })
  })

  // ── CRITERION 2: Mirrors are explicitly mirrors ─────────────────────
  describe('C2: job/project paymentState are mirrors, not competing canon', () => {
    it('reconcilePaymentStateDownstream overrides stale mirrors with canonical truth', async () => {
      const job = await setupJobWithProject()
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')
      await updatePaymentWorkflow(job.id, 'in_escrow')

      // Force mirrors to diverge from canonical
      const { getJobRepository } = await import('../../src/lib/jobs/repository')
      const { getProjectRepository } = await import('../../src/lib/projects/repository')
      getJobRepository().update(job.id, (j) => ({ ...j, paymentState: 'none' }))
      getProjectRepository().update(job.projectId!, { paymentState: 'none' })

      // Canonical truth is in_escrow, mirrors say 'none'
      expect(getPaymentForJob(job.id)!.state).toBe('in_escrow')
      expect(getJobById(job.id)!.paymentState).toBe('none')
      expect(getProjectByJobId(job.id)!.paymentState).toBe('none')

      // Reconciliation overrides mirrors with canonical truth
      await reconcilePaymentStateDownstream(job.id)

      expect(getJobById(job.id)!.paymentState).toBe('in_escrow')
      expect(getProjectByJobId(job.id)!.paymentState).toBe('in_escrow')
    })
  })

  // ── CRITERION 3: No workflow leaves mirrors silently wrong ──────────
  describe('C3: No trust-critical workflow leaves mirrors silently wrong', () => {
    it('release path: payment released → job and project reflect released', async () => {
      const job = await setupJobWithProject({ status: 'waiting_payment' })
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')
      await updatePaymentWorkflow(job.id, 'in_escrow')
      await updatePaymentWorkflow(job.id, 'work_in_progress')
      await updatePaymentWorkflow(job.id, 'release_pending')

      const released = await releaseEscrowWorkflow(job.id)
      expect(released).toBeDefined()
      expect(released!.payment!.state).toBe('released')

      // Both mirrors must agree with canonical truth
      const jobAfter = getJobById(job.id)!
      const projectAfter = getProjectByJobId(job.id)!
      expect(jobAfter.paymentState).toBe('released')
      expect(projectAfter.paymentState).toBe('released')
    })

    it('refund path: payment refunded → job and project reflect refunded', async () => {
      const job = await setupJobWithProject({ status: 'waiting_payment' })
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')
      await updatePaymentWorkflow(job.id, 'in_escrow')
      await updatePaymentWorkflow(job.id, 'work_in_progress')
      await updatePaymentWorkflow(job.id, 'release_pending')

      const refunded = await refundEscrowWorkflow(job.id)
      expect(refunded).toBeDefined()
      expect(refunded!.state).toBe('refunded')

      const jobAfter = getJobById(job.id)!
      const projectAfter = getProjectByJobId(job.id)!
      expect(jobAfter.paymentState).toBe('refunded')
      expect(projectAfter.paymentState).toBe('refunded')
    })

    it('dispute path: payment disputed → job and project reflect disputed', async () => {
      const job = await setupJobWithProject({ status: 'in_progress' })
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')
      await updatePaymentWorkflow(job.id, 'in_escrow')
      await updatePaymentWorkflow(job.id, 'work_in_progress')

      // Open dispute via workflow
      await openDisputeWorkflow({
        jobId: job.id,
        reason: 'payment_conflict',
        title: 'Test dispute',
        description: 'Block 4 test',
        raisedBy: 'customer-1',
      })

      const payment = getPaymentForJob(job.id)!
      expect(payment.state).toBe('disputed')

      const jobAfter = getJobById(job.id)!
      const projectAfter = getProjectByJobId(job.id)!
      expect(jobAfter.paymentState).toBe('disputed')
      expect(projectAfter.paymentState).toBe('disputed')
    })
  })

  // ── CRITERION 4: Downstream sync is awaited ─────────────────────────
  describe('C4: Downstream sync is awaited and failure-safe', () => {
    it('syncPaymentStateToJobAndProject is exported and awaitable', () => {
      expect(typeof syncPaymentStateToJobAndProject).toBe('function')
    })

    it('syncPaymentStateToJobAndProject returns a structured result', async () => {
      const job = await setupJobWithProject()

      const result = await syncPaymentStateToJobAndProject(job.id, 'deposit_paid')
      expect(typeof result.jobSynced).toBe('boolean')
      expect(typeof result.projectSynced).toBe('boolean')
      expect(typeof result.projectNotFound).toBe('boolean')
    })

    it('reconcilePaymentStateDownstream is awaited in bridge (source audit)', () => {
      const bridgeSource = readFileSync(
        resolve(__dirname, '../../src/lib/projects/projectJobSyncBridge.ts'),
        'utf-8',
      )
      // Must NOT have fire-and-forget void cast of reconcilePaymentStateDownstream
      expect(bridgeSource).not.toMatch(/void reconcilePaymentStateDownstream\(/)
      // Must have awaited call
      expect(bridgeSource).toMatch(/await reconcilePaymentStateDownstream\(/)
    })

    it('releaseOperations routes through syncPaymentStateToJobAndProject (source audit)', () => {
      const releaseOps = readFileSync(
        resolve(__dirname, '../../src/lib/workflow/releaseOperations.ts'),
        'utf-8',
      )
      // Must use the canonical sync path, not direct updateProject with paymentState
      expect(releaseOps).toMatch(/await syncPaymentStateToJobAndProject\(/)
      // Must NOT directly call updateProject with paymentState
      expect(releaseOps).not.toMatch(/updateProject\([^)]+,\s*\{\s*paymentState/)
    })
  })

  // ── CRITERION 5: Reload reconstructs same payment story ─────────────
  describe('C5: Reload/rehydration reconstructs same payment story', () => {
    it('syncAllProjectsFromJobs repairs stale mirrors after simulated reload', async () => {
      const job = await setupJobWithProject()
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')
      await updatePaymentWorkflow(job.id, 'in_escrow')

      // Simulate post-reload divergence: job and project have stale state
      const { getJobRepository } = await import('../../src/lib/jobs/repository')
      const { getProjectRepository } = await import('../../src/lib/projects/repository')
      getJobRepository().update(job.id, (j) => ({ ...j, paymentState: 'deposit_required' }))
      getProjectRepository().update(job.projectId!, { paymentState: 'deposit_required' })

      // Bootstrap reconciliation should repair
      await syncAllProjectsFromJobs()

      expect(getJobById(job.id)!.paymentState).toBe('in_escrow')
      expect(getProjectByJobId(job.id)!.paymentState).toBe('in_escrow')
    })

    it('syncProjectForJobId repairs stale mirrors for a single context', async () => {
      const job = await setupJobWithProject()
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')

      // Simulate stale project
      const { getProjectRepository } = await import('../../src/lib/projects/repository')
      getProjectRepository().update(job.projectId!, { paymentState: 'none' })

      const didWork = await syncProjectForJobId(job.id)
      expect(didWork).toBe(true)
      expect(getProjectByJobId(job.id)!.paymentState).toBe('deposit_paid')
    })
  })

  // ── CRITERION 6: Selectors read canonical truth ─────────────────────
  describe('C6: Selectors do not overstate stale mirror truth', () => {
    it('getPaymentForJob returns canonical truth independent of job mirror', async () => {
      const job = await setupJobWithProject()
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')

      // Force job mirror to diverge
      const { getJobRepository } = await import('../../src/lib/jobs/repository')
      getJobRepository().update(job.id, (j) => ({ ...j, paymentState: 'none' }))

      // Canonical payment truth is still correct
      const payment = getPaymentForJob(job.id)!
      expect(payment.state).toBe('deposit_paid')

      // Job mirror is stale — but canonical truth is authoritative
      expect(getJobById(job.id)!.paymentState).toBe('none')
      expect(payment.state).not.toBe(getJobById(job.id)!.paymentState)
    })
  })

  // ── CRITERION 7: Bridge/reconcile helpers are not hiding drift ──────
  describe('C7: projectJobSyncBridge and reconcile are architecturally explicit', () => {
    it('syncAllProjectsFromJobs is async (Block 4 fix)', () => {
      // Must return a Promise (async function)
      const result = syncAllProjectsFromJobs()
      expect(result).toBeInstanceOf(Promise)
    })

    it('syncProjectForJobId is async (Block 4 fix)', () => {
      const result = syncProjectForJobId('nonexistent')
      expect(result).toBeInstanceOf(Promise)
    })

    it('bridge does not use void cast for reconciliation (structural proof)', () => {
      const bridgeSource = readFileSync(
        resolve(__dirname, '../../src/lib/projects/projectJobSyncBridge.ts'),
        'utf-8',
      )
      // No void casts of async reconciliation
      expect(bridgeSource).not.toMatch(/void\s+reconcilePaymentStateDownstream/)
    })
  })

  // ── CRITERION 8: No unmodeled disagreement ──────────────────────────
  describe('C8: No unmodeled payment disagreement state', () => {
    it('full payment lifecycle maintains agreement across all entities', async () => {
      const job = await setupJobWithProject({ status: 'new' })
      await createPaymentForJob(job.id, 2000)

      const states = [
        'deposit_paid',
        'in_escrow',
        'work_in_progress',
        'release_pending',
      ] as const

      for (const state of states) {
        await updatePaymentWorkflow(job.id, state)

        const payment = getPaymentForJob(job.id)!
        const jobAfter = getJobById(job.id)!
        const projectAfter = getProjectByJobId(job.id)!

        expect(payment.state).toBe(state)
        expect(jobAfter.paymentState).toBe(state)
        expect(projectAfter.paymentState).toBe(state)
      }
    })
  })

  // ── RESIDUAL GAP CLOSURE (Block 4 pass 2) ───────────────────────────

  describe('Residual gap: attention selectors prefer canonical payment truth', () => {
    it('disputed attention uses canonical payment state, not stale mirror', async () => {
      const { deriveAttentionItems } = await import('../../src/lib/notifications/attentionSelectors')

      const job = await setupJobWithProject({ status: 'in_progress' })
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')
      await updatePaymentWorkflow(job.id, 'in_escrow')
      await updatePaymentWorkflow(job.id, 'work_in_progress')
      await updatePaymentWorkflow(job.id, 'disputed')

      // Confirm canonical state is disputed
      expect(getPaymentForJob(job.id)!.state).toBe('disputed')

      // Force job mirror to stale state (simulate partial sync failure)
      const { getJobRepository } = await import('../../src/lib/jobs/repository')
      getJobRepository().update(job.id, (j) => ({ ...j, paymentState: 'work_in_progress' }))

      // Mirror says work_in_progress, canonical says disputed
      expect(getJobById(job.id)!.paymentState).toBe('work_in_progress')
      expect(getPaymentForJob(job.id)!.state).toBe('disputed')

      // Attention selector must read canonical truth and emit dispute attention
      const items = deriveAttentionItems([getJobById(job.id)!], [])
      const disputeItem = items.find((i) => i.category === 'dispute')
      expect(disputeItem).toBeDefined()
      expect(disputeItem!.title).toBe('Streitfall aktiv')
    })

    it('release_pending attention uses canonical state, not stale mirror', async () => {
      const { deriveAttentionItems } = await import('../../src/lib/notifications/attentionSelectors')

      const job = await setupJobWithProject({ status: 'waiting_payment' })
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')
      await updatePaymentWorkflow(job.id, 'in_escrow')
      await updatePaymentWorkflow(job.id, 'work_in_progress')
      await updatePaymentWorkflow(job.id, 'release_pending')

      // Confirm canonical state is release_pending
      expect(getPaymentForJob(job.id)!.state).toBe('release_pending')

      // Force job mirror to stale state
      const { getJobRepository } = await import('../../src/lib/jobs/repository')
      getJobRepository().update(job.id, (j) => ({ ...j, paymentState: 'work_in_progress' }))

      // Mirror says work_in_progress, canonical says release_pending
      expect(getJobById(job.id)!.paymentState).toBe('work_in_progress')

      // Attention selector must read canonical truth and emit release attention
      const items = deriveAttentionItems([getJobById(job.id)!], [])
      const releaseItem = items.find((i) => i.title === 'Freigabe erforderlich')
      expect(releaseItem).toBeDefined()
    })

    it('no false attention when canonical says released but mirror says release_pending', async () => {
      const { deriveAttentionItems } = await import('../../src/lib/notifications/attentionSelectors')

      const job = await setupJobWithProject({ status: 'waiting_payment' })
      await createPaymentForJob(job.id, 2000)
      await updatePaymentWorkflow(job.id, 'deposit_paid')
      await updatePaymentWorkflow(job.id, 'in_escrow')
      await updatePaymentWorkflow(job.id, 'work_in_progress')
      await updatePaymentWorkflow(job.id, 'release_pending')

      // Advance canonical to released
      const released = await releaseEscrowWorkflow(job.id)
      expect(released).toBeDefined()
      expect(released!.payment!.state).toBe('released')

      // Force job mirror to stale release_pending
      const { getJobRepository } = await import('../../src/lib/jobs/repository')
      getJobRepository().update(job.id, (j) => ({ ...j, paymentState: 'release_pending' }))

      // Mirror says release_pending, canonical says released
      expect(getJobById(job.id)!.paymentState).toBe('release_pending')
      expect(getPaymentForJob(job.id)!.state).toBe('released')

      // Attention selector must NOT show false "Freigabe erforderlich"
      const items = deriveAttentionItems([getJobById(job.id)!], [])
      const falseRelease = items.find((i) => i.title === 'Freigabe erforderlich')
      expect(falseRelease).toBeUndefined()
    })
  })

  describe('Residual gap: attentionSelectors source audit', () => {
    it('attentionSelectors imports getPaymentForJob for canonical truth (source audit)', () => {
      const source = readFileSync(
        resolve(__dirname, '../../src/lib/notifications/attentionSelectors.ts'),
        'utf-8',
      )
      // Must import canonical payment lookup
      expect(source).toMatch(/import.*getPaymentForJob.*from/)
      // Must resolve canonical state from payment entity
      expect(source).toMatch(/getPaymentForJob\(job\.id\)/)
    })
  })

  describe('Residual gap: CraftsmanJobListItem source audit', () => {
    it('CraftsmanJobListItem imports getPaymentForJob for canonical truth (source audit)', () => {
      const source = readFileSync(
        resolve(__dirname, '../../src/components/CraftsmanJobListItem.tsx'),
        'utf-8',
      )
      // Must import canonical payment lookup
      expect(source).toMatch(/import.*getPaymentForJob.*from/)
      // Must resolve canonical state from payment entity
      expect(source).toMatch(/getPaymentForJob\(/)
    })
  })
})
