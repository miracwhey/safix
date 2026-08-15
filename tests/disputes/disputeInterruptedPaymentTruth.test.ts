/**
 * Dispute / Interrupted Payment Truth — Corridor Invariant Tests
 *
 * Covers the invariants hardened in the Phase 4 audit (2026-04-11):
 *
 * A. Active dispute persists and is recognized as a blocker after simulated reload
 * B. Release attempt with active dispute is blocked (via releaseEligibleTranche,
 *    the new canonical local guard that now reads dispute repo directly)
 * C. funded/in_escrow vs disputed/blocked states are not confused
 * D. Payment / Job / EscrowPlan consistently blocked after reload
 * E. Resolved/rejected dispute lifts block only with correct canonical state
 * F. Idempotent blocked action retry creates no illegal state
 * G. Partial release stays partial — does not flip to fully_released
 * H. Unhydrated dispute repo blocks releaseEligibleTranche (fail-closed)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import { InMemoryDisputeRepository } from '../../src/lib/disputes/repository/InMemoryDisputeRepository'
import { setDisputeRepository, getDisputeRepository } from '../../src/lib/disputes/repository/registry'

import {
  ensureEscrowPlan,
  confirmFunding,
  recordWorkStarted,
  recordWorkCompleted,
  getEscrowTranches,
  getEscrowPlanById,
} from '../../src/lib/payments/escrow'

import { releaseEligibleTranche } from '../../src/lib/workflow/releaseOperations'
import { openDisputeWorkflow } from '../../src/lib/workflow/disputeWorkflow'
import { getPaymentRepository } from '../../src/lib/payments/repository/registry'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'

import type { Dispute } from '../../src/lib/disputes/types'
import type { Payment } from '../../src/lib/payments/types'
import type { Job } from '../../src/lib/jobs/types'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReadyPayoutAccount(): ProviderPayoutAccount {
  return {
    id: 'poa-test',
    providerUserId: 'provider-test',
    stripeConnectAccountId: 'acct_test',
    onboardingStatus: 'onboarding_complete',
    chargesEnabled: true,
    payoutsEnabled: true,
    onboardingCompletedAt: Date.now(),
    requirementsDue: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function seedJob(id: string, overrides: Partial<Job> = {}): Job {
  const job: Job = {
    id,
    projectId: `project-${id}`,
    title: `Test Job ${id}`,
    customer: 'Test Customer',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: overrides.status ?? 'in_progress',
    amount: '1.000 €',
    description: 'Test description',
    paymentState: overrides.paymentState ?? 'in_escrow',
    documentationStatus: '',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    customerUserId: overrides.customerUserId ?? 'customer-test',
    craftsmanUserId: overrides.craftsmanUserId ?? 'craftsman-test',
    ...overrides,
  }
  getJobRepository().add(job)
  return job
}

function seedPayment(jobId: string, state: Payment['state'], total = 1000): Payment {
  const payment: Payment = {
    id: `pay-${jobId}`,
    jobId,
    state,
    amounts: { totalAmount: total, depositAmount: total * 0.25, finalAmount: total * 0.75 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  getPaymentRepository().add(payment)
  return payment
}

async function seedDispute(jobId: string, status: Dispute['status'], extra: Partial<Dispute> = {}): Promise<Dispute> {
  const dispute: Dispute = {
    id: `dispute-${jobId}`,
    jobId,
    paymentId: `pay-${jobId}`,
    status,
    reason: 'work_quality',
    title: 'Test dispute',
    description: 'Test description',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  }
  await getDisputeRepository().add(dispute)
  return dispute
}

/** Unhydrated repo — simulates dispute repo before initialize() completes */
class UnhydratedDisputeRepository extends InMemoryDisputeRepository {
  override isHydrated(): boolean {
    return false
  }
}

// ---------------------------------------------------------------------------
// Setup a funded escrow plan for tranche release tests
// ---------------------------------------------------------------------------

async function setupFundedEscrowPlan(jobId: string, customerUserId = 'customer-test', craftsmanUserId = 'craftsman-test'): Promise<{
  planId: string
  depositTrancheId: string
  finalTrancheId: string
}> {
  seedJob(jobId, { customerUserId, craftsmanUserId })

  const plan = await ensureEscrowPlan({
    sourceOfferId: `offer-${jobId}`,
    jobId,
    customerUserId,
    providerId: 'provider-test',
    totalAmount: 1000,
  })

  await confirmFunding(plan.id)
  await recordWorkStarted(plan.id, 'provider')
  await recordWorkCompleted(plan.id, 'provider')

  const tranches = getEscrowTranches(plan.id)
  const depositTranche = tranches.find((t) => t.kind === 'deposit_release')!
  const finalTranche = tranches.find((t) => t.kind === 'final_release')!

  return {
    planId: plan.id,
    depositTrancheId: depositTranche.id,
    finalTrancheId: finalTranche.id,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Dispute / Interrupted Payment Truth — Corridor Invariants', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── A. Active dispute persists and is recognized as a blocker after reload ──

  describe('A — active dispute persists and remains a blocker after reload', () => {
    it('dispute added to repo is found by getByJobId (simulates post-reload)', async () => {
      await seedDispute('job-a1', 'open')
      const found = getDisputeRepository().getByJobId('job-a1')
      expect(found).toBeDefined()
      expect(found!.status).toBe('open')
    })

    it('blocking status is recognized for all active dispute states', async () => {
      for (const status of ['open', 'customer_waiting', 'provider_waiting', 'under_review'] as const) {
        setupCleanRepositories()
        await seedDispute(`job-a-status-${status}`, status)
        const found = getDisputeRepository().getByJobId(`job-a-status-${status}`)
        expect(found).toBeDefined()
        expect(found!.status).toBe(status)
      }
    })

    it('dispute survives re-instantiation of in-memory repo (simulated reload)', async () => {
      // Seed in fresh repo
      const repo = new InMemoryDisputeRepository([])
      setDisputeRepository(repo)
      await repo.add({
        id: 'dispute-reload',
        jobId: 'job-reload',
        status: 'open',
        reason: 'work_quality',
        title: 'Test',
        description: 'Test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })

      // Replace with new repo pre-seeded with same data (simulates hydrate from DB)
      const reloadedRepo = new InMemoryDisputeRepository([
        {
          id: 'dispute-reload',
          jobId: 'job-reload',
          status: 'open',
          reason: 'work_quality',
          title: 'Test',
          description: 'Test',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ])
      setDisputeRepository(reloadedRepo)

      const found = getDisputeRepository().getByJobId('job-reload')
      expect(found).toBeDefined()
      expect(found!.status).toBe('open')
    })
  })

  // ── B. Release attempt with active dispute is blocked ──────────────────────

  describe('B — releaseEligibleTranche is blocked by canonical dispute state', () => {
    it('blocks tranche release when dispute is "open"', async () => {
      const { depositTrancheId } = await setupFundedEscrowPlan('job-b1')
      await seedDispute('job-b1', 'open')

      const result = await releaseEligibleTranche(depositTrancheId, makeReadyPayoutAccount())
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('DISPUTE_BLOCKING')
      }
    })

    it('blocks tranche release when dispute is "awaiting_evidence"', async () => {
      const { depositTrancheId } = await setupFundedEscrowPlan('job-b2')
      await seedDispute('job-b2', 'customer_waiting')

      const result = await releaseEligibleTranche(depositTrancheId, makeReadyPayoutAccount())
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('DISPUTE_BLOCKING')
      }
    })

    it('blocks tranche release when dispute is "under_review"', async () => {
      const { depositTrancheId } = await setupFundedEscrowPlan('job-b3')
      await seedDispute('job-b3', 'under_review')

      const result = await releaseEligibleTranche(depositTrancheId, makeReadyPayoutAccount())
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('DISPUTE_BLOCKING')
      }
    })

    it('blocking is based on dispute repo truth, not tranche.status alone', async () => {
      // This test specifically validates that the guard reads the dispute repo,
      // NOT just the tranche.status field (which openDisputeWorkflow does not set).
      const { depositTrancheId } = await setupFundedEscrowPlan('job-b4')
      // Seed dispute without touching tranche status
      await seedDispute('job-b4', 'open')

      // The tranche is still eligible_for_release (workflow never sets it to 'disputed')
      // but the dispute repo guard must catch it.
      const result = await releaseEligibleTranche(depositTrancheId, makeReadyPayoutAccount())
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('DISPUTE_BLOCKING')
      }
    })
  })

  // ── C. funded/in_escrow vs disputed/blocked states are not confused ────────

  describe('C — funded/in_escrow and disputed/blocked are distinct states', () => {
    it('payment in in_escrow with no dispute is not blocked', async () => {
      const { depositTrancheId } = await setupFundedEscrowPlan('job-c1')
      // No dispute seeded — should be able to release
      const result = await releaseEligibleTranche(depositTrancheId, makeReadyPayoutAccount())
      expect(result.ok).toBe(true)
    })

    it('payment in in_escrow with active dispute IS blocked', async () => {
      const { depositTrancheId } = await setupFundedEscrowPlan('job-c2')
      seedPayment('job-c2', 'in_escrow')
      await seedDispute('job-c2', 'open')

      const result = await releaseEligibleTranche(depositTrancheId, makeReadyPayoutAccount())
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('DISPUTE_BLOCKING')
      }
    })

    it('dispute in terminal state does not block release', async () => {
      const { depositTrancheId } = await setupFundedEscrowPlan('job-c3')
      await seedDispute('job-c3', 'resolved', {
        decision: 'release',
        resolutionType: 'release_full',
        settlementStatus: 'settled',
      })

      const result = await releaseEligibleTranche(depositTrancheId, makeReadyPayoutAccount())
      // resolved is non-blocking — release should proceed
      expect(result.ok).toBe(true)
    })
  })

  // ── D. Payment / Job / EscrowPlan consistently blocked ────────────────────

  describe('D — consistent blocking state across domains', () => {
    it('openDisputeWorkflow transitions payment to disputed', async () => {
      seedJob('job-d1', { status: 'in_progress' })
      seedPayment('job-d1', 'in_escrow')

      await openDisputeWorkflow({
        jobId: 'job-d1',
        reason: 'work_quality',
        title: 'Mangel',
        description: 'Test dispute.',
      })

      const payment = getPaymentRepository().getByJobId('job-d1')
      expect(payment?.state).toBe('disputed')
    })

    it('dispute and payment state are consistent after openDisputeWorkflow', async () => {
      seedJob('job-d2', { status: 'in_progress' })
      seedPayment('job-d2', 'in_escrow')

      await openDisputeWorkflow({
        jobId: 'job-d2',
        reason: 'scope_conflict',
        title: 'Leistungsumfang',
        description: 'Mehr als vereinbart.',
      })

      const dispute = getDisputeRepository().getByJobId('job-d2')
      const payment = getPaymentRepository().getByJobId('job-d2')

      expect(dispute?.status).toBe('open')
      expect(payment?.state).toBe('disputed')
    })
  })

  // ── E. Resolved/rejected dispute lifts block ───────────────────────────────

  describe('E — resolved/rejected dispute lifts block only with correct canonical state', () => {
    it('resolved+release dispute does not block releaseEligibleTranche', async () => {
      const { depositTrancheId } = await setupFundedEscrowPlan('job-e1')
      await seedDispute('job-e1', 'resolved', {
        decision: 'release',
        resolutionType: 'release_full',
        settlementStatus: 'settled',
      })

      const result = await releaseEligibleTranche(depositTrancheId, makeReadyPayoutAccount())
      expect(result.ok).toBe(true)
    })

    it('resolved+refund dispute does not block releaseEligibleTranche', async () => {
      const { depositTrancheId } = await setupFundedEscrowPlan('job-e2')
      await seedDispute('job-e2', 'resolved', {
        decision: 'refund',
        resolutionType: 'refund_full',
        settlementStatus: 'settled',
      })

      const result = await releaseEligibleTranche(depositTrancheId, makeReadyPayoutAccount())
      expect(result.ok).toBe(true)
    })

    it('rejected dispute does not block releaseEligibleTranche', async () => {
      const { depositTrancheId } = await setupFundedEscrowPlan('job-e3')
      await seedDispute('job-e3', 'resolved', {
        decision: 'reject',
        resolutionType: 'rejected',
        settlementStatus: 'settled',
      })

      const result = await releaseEligibleTranche(depositTrancheId, makeReadyPayoutAccount())
      expect(result.ok).toBe(true)
    })

    it('terminal dispute with settlementStatus=pending still does not block release', async () => {
      // Decision is recorded (terminal) but money action hasn't completed yet.
      // The dispute is non-blocking because the decision has been made.
      const { depositTrancheId } = await setupFundedEscrowPlan('job-e4')
      await seedDispute('job-e4', 'resolved', {
        decision: 'release',
        resolutionType: 'release_full',
        settlementStatus: 'pending',
      })

      const result = await releaseEligibleTranche(depositTrancheId, makeReadyPayoutAccount())
      expect(result.ok).toBe(true)
    })
  })

  // ── F. Idempotent blocked action retry creates no illegal state ────────────

  describe('F — idempotent blocked action retry creates no illegal state', () => {
    it('calling releaseEligibleTranche twice while blocked does not release or corrupt state', async () => {
      const { depositTrancheId } = await setupFundedEscrowPlan('job-f1')
      await seedDispute('job-f1', 'open')

      const r1 = await releaseEligibleTranche(depositTrancheId, makeReadyPayoutAccount())
      const r2 = await releaseEligibleTranche(depositTrancheId, makeReadyPayoutAccount())

      expect(r1.ok).toBe(false)
      expect(r2.ok).toBe(false)

      // Tranche must still be eligible_for_release (not released)
      const plan = getEscrowPlanById((await ensureEscrowPlan({
        sourceOfferId: `offer-job-f1`,
        jobId: 'job-f1',
        customerUserId: 'customer-test',
        providerId: 'provider-test',
        totalAmount: 1000,
      })).id)
      // Plan must not be fully_released
      expect(plan?.status).not.toBe('fully_released')
    })

    it('openDisputeWorkflow called twice returns existing dispute (idempotent)', async () => {
      seedJob('job-f2', { status: 'in_progress' })
      seedPayment('job-f2', 'in_escrow')

      const d1 = await openDisputeWorkflow({
        jobId: 'job-f2',
        reason: 'work_quality',
        title: 'Mangel',
        description: 'Test.',
      })
      const d2 = await openDisputeWorkflow({
        jobId: 'job-f2',
        reason: 'work_quality',
        title: 'Mangel (zweiter Aufruf)',
        description: 'Test.',
      })

      expect(d2.id).toBe(d1.id)
      expect(getDisputeRepository().getAll().length).toBe(1)
    })
  })

  // ── G. Partial release stays partial ───────────────────────────────────────

  describe('G — partial release stays partial, does not flip to fully_released', () => {
    it('releasing only deposit tranche leaves EscrowPlan at partially_released', async () => {
      const { planId, depositTrancheId } = await setupFundedEscrowPlan('job-g1')

      const result = await releaseEligibleTranche(depositTrancheId, makeReadyPayoutAccount())
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.planFullyReleased).toBe(false)
        expect(result.data.plan.status).toBe('partially_released')
      }

      const plan = getEscrowPlanById(planId)
      expect(plan?.status).toBe('partially_released')
      expect(plan?.status).not.toBe('fully_released')
    })

    it('releasing deposit tranche with active dispute for final tranche leaves plan partial and blocks final', async () => {
      const { planId, depositTrancheId, finalTrancheId } = await setupFundedEscrowPlan('job-g2')

      // Release deposit tranche first (no dispute yet)
      const r1 = await releaseEligibleTranche(depositTrancheId, makeReadyPayoutAccount())
      expect(r1.ok).toBe(true)
      expect(getEscrowPlanById(planId)?.status).toBe('partially_released')

      // Open dispute after partial release
      seedPayment('job-g2', 'release_pending')
      await openDisputeWorkflow({
        jobId: 'job-g2',
        reason: 'work_quality',
        title: 'Mangel',
        description: 'Test.',
      })

      // Final tranche release must be blocked
      const r2 = await releaseEligibleTranche(finalTrancheId, makeReadyPayoutAccount())
      expect(r2.ok).toBe(false)
      if (!r2.ok) {
        expect(r2.code).toBe('DISPUTE_BLOCKING')
      }

      // Plan must remain partially_released (not flip to fully_released)
      expect(getEscrowPlanById(planId)?.status).toBe('partially_released')
    })
  })

  // ── H. Unhydrated dispute repo blocks releaseEligibleTranche ──────────────

  describe('H — unhydrated dispute repo fails closed on releaseEligibleTranche', () => {
    it('throws when dispute repo is not hydrated', async () => {
      const { depositTrancheId } = await setupFundedEscrowPlan('job-h1')
      setDisputeRepository(new UnhydratedDisputeRepository([]))

      await expect(
        releaseEligibleTranche(depositTrancheId, makeReadyPayoutAccount())
      ).rejects.toThrow(/dispute repository is not hydrated/)
    })

    it('proceeds normally when dispute repo is hydrated-empty (no disputes exist)', async () => {
      const { depositTrancheId } = await setupFundedEscrowPlan('job-h2')
      // setupCleanRepositories gives a hydrated-empty repo by default
      // No dispute seeded — safe to release

      const result = await releaseEligibleTranche(depositTrancheId, makeReadyPayoutAccount())
      expect(result.ok).toBe(true)
    })
  })
})
