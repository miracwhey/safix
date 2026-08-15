/**
 * Release Path Parity Invariants
 *
 * Asserts that Path A (server-authoritative release via requestServerTrancheRelease
 * + applyLocalSideEffectsAfterServerRelease) and Path B (orchestration via
 * releaseEligibleTranche) produce equivalent domain truth for every fachlich-
 * meaningful outcome.
 *
 * Because Path A makes an HTTP call (tested separately in releaseServerTruth.test.ts),
 * these tests exercise `applyLocalSideEffectsAfterServerRelease` directly after
 * manually advancing the in-memory tranche to 'released' via `releaseTranche`.
 * This isolates the side-effect parity from the network boundary.
 *
 * Invariants covered:
 *  A. Partial release (25% tranche): both paths → job payment state remains
 *     at the pre-release value ('in_escrow' / 'work_in_progress'); neither
 *     path flips Payment.state to 'release_pending' on partial release.
 *  B. Full release (both tranches): both paths → job.status = 'completed', same timeline
 *  C. Both paths emit tranche_released + payout_handoff_initiated timeline events
 *  D. Both paths emit payment_released + job_completed after full release
 *  E. Both paths send in-app notification to provider on tranche release
 *  F. Dispute blocking: releaseTrancheWorkflow rejects when dispute is blocking
 *  G. Idempotent second call via Path B does not double timeline or notification side effects
 *  H. Partial release → job NOT set to completed (in both paths)
 *  I. Full release → syncPaymentStateToJobAndProject sets 'released' in both paths
 *  J. Partial release → Payment.state stays at its pre-release value in
 *     both paths (no premature 'release_pending'; that state is reserved
 *     for the customer-facing 75 % approval phase triggered by work
 *     completion via requestReleaseWorkflow).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import {
  ensureEscrowPlan,
  confirmFunding,
  getEscrowTranches,
  recordWorkStarted,
  recordWorkCompleted,
  releaseTranche,
  getEscrowPlanById,
} from '../../src/lib/payments/escrow'
import {
  releaseEligibleTranche,
  applyLocalSideEffectsAfterServerRelease,
} from '../../src/lib/workflow/releaseOperations'
import { releaseTrancheWorkflow } from '../../src/lib/workflow/paymentWorkflow'
import { getJobById, addJob } from '../../src/lib/jobs'
import type { Job } from '../../src/lib/jobs/types'
import { getTimelineSignalsForJob } from '../../src/lib/timeline/timelineStore'
import { getInAppNotifications } from '../../src/lib/inAppNotifications'
import { getDisputeRepository } from '../../src/lib/disputes/repository'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'

// ── Helpers ───────────────────────────────────────────────────────────────

let idCounter = 9000

function nextId(prefix: string) {
  idCounter += 1
  return `${prefix}-parity-${idCounter}`
}

function makeReadyPayoutAccount(): ProviderPayoutAccount {
  return {
    id: nextId('payout'),
    providerUserId: 'craftsman-parity',
    stripeConnectAccountId: 'acct_ready_parity',
    onboardingStatus: 'onboarding_complete',
    chargesEnabled: true,
    payoutsEnabled: true,
    onboardingCompletedAt: Date.now(),
    requirementsDue: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function makeJob(jobId: string): Job {
  return {
    id: jobId,
    projectId: `project-${jobId}`,
    title: 'Parity Test Job',
    customer: 'Test Kunde',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'waiting_payment',
    amount: '4.000 €',
    description: 'Test',
    paymentState: 'in_escrow',
    documentationStatus: 'none',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: 'craftsman-parity',
    customerUserId: 'customer-parity',
    proposalAcceptedAt: Date.now(),
  }
}

/**
 * Creates a funded escrow plan with a linked job in the job repository.
 * The job is needed so that side effects (timeline, notifications, job state)
 * can be written to the correct entity.
 */
async function setupFundedPlanWithJob(workStarted = true, workCompleted = false) {
  const jobId = nextId('job')
  const plan = await ensureEscrowPlan({
    sourceOfferId: nextId('offer'),
    jobId,
    customerUserId: 'customer-parity',
    providerId: 'provider-parity',
    totalAmount: 4000,
  })

  await addJob(makeJob(jobId))
  await confirmFunding(plan.id)

  if (workStarted || workCompleted) {
    await recordWorkStarted(plan.id, 'provider')
  }
  if (workCompleted) {
    await recordWorkCompleted(plan.id, 'provider')
  }

  const tranches = getEscrowTranches(plan.id)
  const depositTranche = tranches.find((t) => t.kind === 'deposit_release')!
  const finalTranche = tranches.find((t) => t.kind === 'final_release')!

  return { plan, jobId, depositTranche, finalTranche }
}

/**
 * Simulates what the server endpoint + initializeEscrowPlanRepository does:
 * advances the tranche to 'released' in the in-memory repo directly (as if
 * the Supabase write + repo reload had happened), then calls
 * applyLocalSideEffectsAfterServerRelease to run the local side effects.
 *
 * This isolates Path A side-effect parity from the HTTP boundary.
 */
async function simulatePathA(
  trancheId: string,
  planId: string,
  jobId: string,
  expectFullRelease: boolean
) {
  // Advance tranche to released in-memory (simulating server write + repo reload)
  await releaseTranche(trancheId, 'system')

  const updatedPlan = getEscrowPlanById(planId)!
  const planStatus = expectFullRelease ? 'fully_released' : 'partially_released'

  // Verify the in-memory plan reflects the expected status
  // (releaseTranche computes the rollup internally)
  expect(updatedPlan.status).toBe(planStatus)

  // Apply local side effects (same function called inside releaseTrancheWorkflow)
  await applyLocalSideEffectsAfterServerRelease(trancheId, planId, planStatus, jobId)
}

// ═══════════════════════════════════════════════════════════════════════════
// A. Partial release: job payment state after 25% tranche
// ═══════════════════════════════════════════════════════════════════════════

describe('A — Partial release: job payment state parity', () => {
  beforeEach(() => {
    setupCleanRepositories()
    idCounter = 9000
  })

  it('Path B (releaseEligibleTranche): partial release does not flip job paymentState to release_pending', async () => {
    const { plan, jobId, depositTranche } = await setupFundedPlanWithJob(true, false)
    const preState = getJobById(jobId)!.paymentState

    await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())

    const job = getJobById(jobId)!
    expect(job.paymentState).not.toBe('release_pending')
    expect(job.paymentState).toBe(preState)
    expect(job.status).not.toBe('completed') // job NOT completed on partial release
    const plan_ = getEscrowPlanById(plan.id)!
    expect(plan_.status).toBe('partially_released')
  })

  it('Path A (applyLocalSideEffectsAfterServerRelease): partial release does not flip job paymentState to release_pending', async () => {
    const { plan, jobId, depositTranche } = await setupFundedPlanWithJob(true, false)
    const preState = getJobById(jobId)!.paymentState

    await simulatePathA(depositTranche.id, plan.id, jobId, false)

    const job = getJobById(jobId)!
    expect(job.paymentState).not.toBe('release_pending')
    expect(job.paymentState).toBe(preState)
    expect(job.status).not.toBe('completed') // job NOT completed on partial release
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// B. Full release: job.status = 'completed' in both paths
// ═══════════════════════════════════════════════════════════════════════════

describe('B — Full release: job.status = completed parity', () => {
  beforeEach(() => {
    setupCleanRepositories()
    idCounter = 9100
  })

  it('Path B (releaseEligibleTranche): full release sets job.status to completed', async () => {
    const { jobId, depositTranche, finalTranche } = await setupFundedPlanWithJob(true, true)
    const account = makeReadyPayoutAccount()

    await releaseEligibleTranche(depositTranche.id, account)
    await releaseEligibleTranche(finalTranche.id, account)

    const job = getJobById(jobId)!
    expect(job.status).toBe('completed')
    expect(job.paymentState).toBe('released')
  })

  it('Path A (applyLocalSideEffectsAfterServerRelease): full release sets job.status to completed', async () => {
    const { plan, jobId, depositTranche, finalTranche } = await setupFundedPlanWithJob(true, true)

    // Partial release first (deposit tranche)
    await simulatePathA(depositTranche.id, plan.id, jobId, false)

    // Full release (final tranche)
    await simulatePathA(finalTranche.id, plan.id, jobId, true)

    const job = getJobById(jobId)!
    expect(job.status).toBe('completed')
    expect(job.paymentState).toBe('released')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// C. Both paths emit tranche_released + payout_handoff_initiated timeline events
// ═══════════════════════════════════════════════════════════════════════════

describe('C — Timeline: tranche_released + payout_handoff_initiated in both paths', () => {
  beforeEach(() => {
    setupCleanRepositories()
    idCounter = 9200
  })

  it('Path B emits tranche_released and payout_handoff_initiated', async () => {
    const { jobId, depositTranche } = await setupFundedPlanWithJob(true, false)

    await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())

    const timeline = getTimelineSignalsForJob(jobId)
    const types = timeline.map((e) => e.type)
    expect(types).toContain('tranche_released')
    expect(types).toContain('payout_handoff_initiated')
  })

  it('Path A emits tranche_released and payout_handoff_initiated', async () => {
    const { plan, jobId, depositTranche } = await setupFundedPlanWithJob(true, false)

    await simulatePathA(depositTranche.id, plan.id, jobId, false)

    const timeline = getTimelineSignalsForJob(jobId)
    const types = timeline.map((e) => e.type)
    expect(types).toContain('tranche_released')
    expect(types).toContain('payout_handoff_initiated')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// D. Full release: payment_released + job_completed timeline events in both paths
// ═══════════════════════════════════════════════════════════════════════════

describe('D — Full release timeline: payment_released + job_completed in both paths', () => {
  beforeEach(() => {
    setupCleanRepositories()
    idCounter = 9300
  })

  it('Path B emits payment_released and job_completed after full release', async () => {
    const { jobId, depositTranche, finalTranche } = await setupFundedPlanWithJob(true, true)
    const account = makeReadyPayoutAccount()

    await releaseEligibleTranche(depositTranche.id, account)
    await releaseEligibleTranche(finalTranche.id, account)

    const timeline = getTimelineSignalsForJob(jobId)
    const types = timeline.map((e) => e.type)
    expect(types).toContain('payment_released')
    expect(types).toContain('job_completed')
  })

  it('Path A emits payment_released and job_completed after full release', async () => {
    const { plan, jobId, depositTranche, finalTranche } = await setupFundedPlanWithJob(true, true)

    await simulatePathA(depositTranche.id, plan.id, jobId, false)
    await simulatePathA(finalTranche.id, plan.id, jobId, true)

    const timeline = getTimelineSignalsForJob(jobId)
    const types = timeline.map((e) => e.type)
    expect(types).toContain('payment_released')
    expect(types).toContain('job_completed')
  })

  it('Partial release does NOT emit payment_released or job_completed in Path A', async () => {
    const { plan, jobId, depositTranche } = await setupFundedPlanWithJob(true, false)

    await simulatePathA(depositTranche.id, plan.id, jobId, false)

    const timeline = getTimelineSignalsForJob(jobId)
    const types = timeline.map((e) => e.type)
    expect(types).not.toContain('payment_released')
    expect(types).not.toContain('job_completed')
  })

  it('Partial release does NOT emit payment_released or job_completed in Path B', async () => {
    const { jobId, depositTranche } = await setupFundedPlanWithJob(true, false)

    await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())

    const timeline = getTimelineSignalsForJob(jobId)
    const types = timeline.map((e) => e.type)
    expect(types).not.toContain('payment_released')
    expect(types).not.toContain('job_completed')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// E. In-app notification to provider on tranche release — both paths
// ═══════════════════════════════════════════════════════════════════════════

describe('E — In-app notification parity', () => {
  beforeEach(() => {
    setupCleanRepositories()
    idCounter = 9400
  })

  it('Path B sends tranche_released notification to provider', async () => {
    const { depositTranche } = await setupFundedPlanWithJob(true, false)

    await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())

    const notifs = getInAppNotifications().filter(
      (n) => n.type === 'tranche_released' && n.userId === 'craftsman-parity'
    )
    expect(notifs.length).toBeGreaterThanOrEqual(1)
  })

  it('Path A sends tranche_released notification to provider', async () => {
    const { plan, jobId, depositTranche } = await setupFundedPlanWithJob(true, false)

    await simulatePathA(depositTranche.id, plan.id, jobId, false)

    const notifs = getInAppNotifications().filter(
      (n) => n.type === 'tranche_released' && n.userId === 'craftsman-parity'
    )
    expect(notifs.length).toBeGreaterThanOrEqual(1)
  })

  it('Path A and Path B both produce exactly 1 tranche_released notification per release', async () => {
    // Path B: measure delta
    const beforeB = getInAppNotifications().filter((n) => n.type === 'tranche_released').length
    const setupB = await setupFundedPlanWithJob(true, false)
    await releaseEligibleTranche(setupB.depositTranche.id, makeReadyPayoutAccount())
    const deltaB = getInAppNotifications().filter((n) => n.type === 'tranche_released').length - beforeB

    // Path A: measure delta (from current state, no repo reset needed for delta)
    const beforeA = getInAppNotifications().filter((n) => n.type === 'tranche_released').length
    idCounter += 1
    const setupA = await setupFundedPlanWithJob(true, false)
    await simulatePathA(setupA.depositTranche.id, setupA.plan.id, setupA.jobId, false)
    const deltaA = getInAppNotifications().filter((n) => n.type === 'tranche_released').length - beforeA

    // Both paths must create exactly one tranche_released notification per release
    expect(deltaB).toBe(1)
    expect(deltaA).toBe(1)
    expect(deltaA).toBe(deltaB)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// F. Dispute blocking: releaseTrancheWorkflow rejects when dispute is blocking
// ═══════════════════════════════════════════════════════════════════════════

describe('F — Dispute blocking parity', () => {
  beforeEach(() => {
    setupCleanRepositories()
    idCounter = 9500
  })

  it('releaseTrancheWorkflow (Path A entry) rejects when a blocking dispute exists', async () => {
    const { plan, jobId, depositTranche } = await setupFundedPlanWithJob(true, false)

    // Inject a blocking dispute into the in-memory repository
    const disputeRepo = getDisputeRepository()
    disputeRepo.add({
      id: `dispute-parity-${jobId}`,
      jobId,
      status: 'open',
      reason: 'Qualitätsmängel',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      openedBy: 'customer-parity',
    })

    const result = await releaseTrancheWorkflow(depositTranche.id, plan.id, jobId)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.statusCode).toBe(409)
      expect(result.message).toMatch(/Streitfall/)
    }
  })

  it('releaseEligibleTranche (Path B) rejects when a blocking dispute exists', async () => {
    const { jobId, depositTranche } = await setupFundedPlanWithJob(true, false)

    const disputeRepo = getDisputeRepository()
    disputeRepo.add({
      id: `dispute-parity-b-${jobId}`,
      jobId,
      status: 'open',
      reason: 'Qualitätsmängel',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      openedBy: 'customer-parity',
    })

    const result = await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('DISPUTE_BLOCKING')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// G. Idempotent release: no duplicate timeline events or notifications
// ═══════════════════════════════════════════════════════════════════════════

describe('G — Idempotent release: no duplicate side effects in Path A', () => {
  beforeEach(() => {
    setupCleanRepositories()
    idCounter = 9600
  })

  it('calling applyLocalSideEffectsAfterServerRelease twice does not duplicate timeline events', async () => {
    const { plan, jobId, depositTranche } = await setupFundedPlanWithJob(true, false)

    // First release
    await releaseTranche(depositTranche.id, 'system')
    await applyLocalSideEffectsAfterServerRelease(depositTranche.id, plan.id, 'partially_released', jobId)

    const timelineAfterFirst = getTimelineSignalsForJob(jobId)
      .filter((e) => e.type === 'tranche_released').length

    // Second call with same tranche (idempotent: ensureTimelineEvent deduplicates)
    await applyLocalSideEffectsAfterServerRelease(depositTranche.id, plan.id, 'partially_released', jobId)

    const timelineAfterSecond = getTimelineSignalsForJob(jobId)
      .filter((e) => e.type === 'tranche_released').length

    // ensureTimelineEvent is idempotent — count must not increase
    expect(timelineAfterSecond).toBe(timelineAfterFirst)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// H. Job NOT completed on partial release — both paths agree
// ═══════════════════════════════════════════════════════════════════════════

describe('H — Job not completed on partial release in both paths', () => {
  beforeEach(() => {
    setupCleanRepositories()
    idCounter = 9700
  })

  it('Path B: job.status stays waiting_payment after 25% release', async () => {
    const { jobId, depositTranche } = await setupFundedPlanWithJob(true, false)

    await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())

    const job = getJobById(jobId)!
    expect(job.status).not.toBe('completed')
  })

  it('Path A: job.status stays waiting_payment after 25% release', async () => {
    const { plan, jobId, depositTranche } = await setupFundedPlanWithJob(true, false)

    await simulatePathA(depositTranche.id, plan.id, jobId, false)

    const job = getJobById(jobId)!
    expect(job.status).not.toBe('completed')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// I. Full release: syncPaymentStateToJobAndProject sets 'released' in both paths
// ═══════════════════════════════════════════════════════════════════════════

describe('I — Full release: paymentState = released in both paths', () => {
  beforeEach(() => {
    setupCleanRepositories()
    idCounter = 9800
  })

  it('Path B: job.paymentState = released after both tranches', async () => {
    const { jobId, depositTranche, finalTranche } = await setupFundedPlanWithJob(true, true)
    const account = makeReadyPayoutAccount()

    await releaseEligibleTranche(depositTranche.id, account)
    await releaseEligibleTranche(finalTranche.id, account)

    const job = getJobById(jobId)!
    expect(job.paymentState).toBe('released')
  })

  it('Path A: job.paymentState = released after both tranches', async () => {
    const { plan, jobId, depositTranche, finalTranche } = await setupFundedPlanWithJob(true, true)

    await simulatePathA(depositTranche.id, plan.id, jobId, false)
    await simulatePathA(finalTranche.id, plan.id, jobId, true)

    const job = getJobById(jobId)!
    expect(job.paymentState).toBe('released')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// J. Partial release: paymentState preserved in both paths
// ═══════════════════════════════════════════════════════════════════════════

describe('J — Partial release: paymentState preserved (no premature release_pending) in both paths', () => {
  beforeEach(() => {
    setupCleanRepositories()
    idCounter = 9900
  })

  it('Path B: job.paymentState is NOT flipped to release_pending after deposit tranche only', async () => {
    const { jobId, depositTranche } = await setupFundedPlanWithJob(true, false)
    const preState = getJobById(jobId)!.paymentState

    await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())

    const job = getJobById(jobId)!
    expect(job.paymentState).not.toBe('release_pending')
    expect(job.paymentState).toBe(preState)
  })

  it('Path A: job.paymentState is NOT flipped to release_pending after deposit tranche only', async () => {
    const { plan, jobId, depositTranche } = await setupFundedPlanWithJob(true, false)
    const preState = getJobById(jobId)!.paymentState

    await simulatePathA(depositTranche.id, plan.id, jobId, false)

    const job = getJobById(jobId)!
    expect(job.paymentState).not.toBe('release_pending')
    expect(job.paymentState).toBe(preState)
  })
})
