/**
 * Release Execution + Payout Handoff Tests
 *
 * Validates the full release execution lifecycle through the
 * releaseEligibleTranche orchestration command:
 *
 *  1. 25% tranche release after work_started + payout ready
 *  2. 75% tranche release after work_completed + payout ready
 *  3. Release blocked when payout readiness is incomplete
 *  4. Duplicate release attempts do not create duplicate side effects
 *  5. Released tranche updates plan rollup correctly
 *  6. Release blocked / released states appear correctly in selectors
 *  7. No regression to funding flow
 *  8. No regression to provider operations
 *  9. No regression to quote lifecycle
 * 10. No regression to relationship-thread logic
 * 11. Blocked reason derivation
 * 12. Tranche release state derivation
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installSessionForJobOwner, mockCustomerSession } from '../helpers/mockSession'

import {
  createOfferWorkflow,
  acceptOfferWorkflow,
} from '../../src/lib/workflow/offerWorkflow'
import { addConversation } from '../../src/lib/messages'
import {
  getEscrowPlanByOfferId,
  getEscrowPlanByJobId,
  getEscrowTranches,
  ensureEscrowPlan,
  confirmFunding,
  recordWorkStarted,
  recordWorkCompleted,
} from '../../src/lib/payments/escrow'
import {
  releaseEligibleTranche,
  deriveTrancheBlockedReason,
  deriveTrancheReleaseState,
} from '../../src/lib/workflow/releaseOperations'
import { startJob, completeJob } from '../../src/lib/workflow/craftsmanOperations'
import {
  markDepositPaidForJobWorkflow,
} from '../../src/lib/workflow/jobWorkflow'
import { lockEscrowWorkflow, releaseTrancheWorkflow } from '../../src/lib/workflow/paymentWorkflow'
import { getJobById, updateJobStatus } from '../../src/lib/jobs'
import { getEscrowPlanRepository } from '../../src/lib/payments/escrow'
import { deriveProviderJobPhase } from '../../src/lib/jobs/providerJobPhaseSelectors'
import { deriveProviderNextAction } from '../../src/lib/jobs/providerNextActionSelectors'
import { getTimelineSignalsForJob } from '../../src/lib/timeline/timelineStore'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'
import type { Conversation } from '../../src/lib/messages/types'

// ── Helpers ───────────────────────────────────────────────────────────────

let convCounter = 5000

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  convCounter += 1
  return {
    id: `conv-release-${convCounter}`,
    projectId: `project_release_${convCounter}`,
    customerName: 'Test Kunde',
    customerUserId: 'customer-release',
    craftsmanUserId: 'craftsman-release',
    projectTitle: 'Test Projekt',
    projectLocation: 'München',
    messages: [
      {
        id: `msg-release-${convCounter}`,
        sender: 'user',
        text: 'Anfrage',
        sentAt: Date.now() - 60_000,
        createdAtLabel: 'Vor 1 Min',
      },
    ],
    ...overrides,
  }
}

function makeReadyPayoutAccount(): ProviderPayoutAccount {
  return {
    id: 'payout-acc-ready',
    providerUserId: 'craftsman-release',
    stripeConnectAccountId: 'acct_ready_release',
    onboardingStatus: 'onboarding_complete',
    chargesEnabled: true,
    payoutsEnabled: true,
    onboardingCompletedAt: Date.now(),
    requirementsDue: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function makeIncompletePayoutAccount(): ProviderPayoutAccount {
  return {
    id: 'payout-acc-incomplete',
    providerUserId: 'craftsman-release',
    stripeConnectAccountId: 'acct_incomplete_release',
    onboardingStatus: 'onboarding_in_progress',
    chargesEnabled: false,
    payoutsEnabled: false,
    onboardingCompletedAt: null,
    requirementsDue: 'Bankverbindung',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

async function createAcceptedOffer(price = '4.000 €') {
  const conv = makeConversation()
  await addConversation(conv)

  const offer = await createOfferWorkflow({
    conversationId: conv.id,
    customerUserId: 'customer-release',
    craftsmanUserId: 'craftsman-release',
    price,
  })

  const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
  installSessionForJobOwner({ craftsmanUserId: 'craftsman-release' })
  return { conv, offer: accepted }
}

/**
 * Simulates the full customer funding flow including old payment model:
 * deposit_required → deposit_paid → in_escrow
 * Also confirms funding on the escrow plan.
 */
async function simulateCustomerFunding(jobId: string) {
  await markDepositPaidForJobWorkflow(jobId)
  await lockEscrowWorkflow(jobId)
  const escrowPlan = getEscrowPlanByJobId(jobId)!
  await confirmFunding(escrowPlan.id)
}

async function setupFundedPlanWithWorkStarted() {
  const plan = await ensureEscrowPlan({
    sourceOfferId: `offer-release-exec-${Date.now()}-${Math.random()}`,
    jobId: `job-release-exec-${Date.now()}-${Math.random()}`,
    customerUserId: 'customer-release',
    providerId: 'provider-release',
    totalAmount: 4000,
  })

  await confirmFunding(plan.id)
  await recordWorkStarted(plan.id, 'provider')

  const tranches = getEscrowTranches(plan.id)
  const depositTranche = tranches.find((t) => t.kind === 'deposit_release')!
  const finalTranche = tranches.find((t) => t.kind === 'final_release')!

  return { plan, depositTranche, finalTranche }
}

async function setupFundedPlanWithWorkCompleted() {
  const setup = await setupFundedPlanWithWorkStarted()
  await recordWorkCompleted(setup.plan.id, 'provider')

  const tranches = getEscrowTranches(setup.plan.id)
  const depositTranche = tranches.find((t) => t.kind === 'deposit_release')!
  const finalTranche = tranches.find((t) => t.kind === 'final_release')!

  return { plan: setup.plan, depositTranche, finalTranche }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. 25% tranche release after work_started + payout ready
// ═══════════════════════════════════════════════════════════════════════════

describe('1 — 25% tranche release after work_started + payout ready', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 5000
  })

  it('releases 25% deposit tranche when eligible and payout ready', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()

    const result = await releaseEligibleTranche(
      depositTranche.id,
      makeReadyPayoutAccount(),
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.tranche.status).toBe('released')
      expect(result.data.tranche.releasedAt).toBeDefined()
      expect(result.data.tranche.releasedBy).toBe('system')
      expect(result.data.plan.status).toBe('partially_released')
      expect(result.data.planFullyReleased).toBe(false)
    }
  })

  it('persists external release reference', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()

    const result = await releaseEligibleTranche(
      depositTranche.id,
      makeReadyPayoutAccount(),
      'tr_stripe_transfer_123',
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.tranche.externalReleaseRef).toBe('tr_stripe_transfer_123')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. 75% tranche release after work_completed + payout ready
// ═══════════════════════════════════════════════════════════════════════════

describe('2 — 75% tranche release after work_completed + payout ready', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 5100
  })

  it('releases 75% final tranche when eligible and payout ready', async () => {
    const { finalTranche } = await setupFundedPlanWithWorkCompleted()

    const result = await releaseEligibleTranche(
      finalTranche.id,
      makeReadyPayoutAccount(),
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.tranche.status).toBe('released')
      expect(result.data.tranche.kind).toBe('final_release')
      expect(result.data.tranche.releasedAt).toBeDefined()
    }
  })

  it('fully released plan when both tranches are released', async () => {
    const { depositTranche, finalTranche } = await setupFundedPlanWithWorkCompleted()
    const account = makeReadyPayoutAccount()

    // Release 25%
    const first = await releaseEligibleTranche(depositTranche.id, account)
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.data.plan.status).toBe('partially_released')
      expect(first.data.planFullyReleased).toBe(false)
    }

    // Release 75%
    const second = await releaseEligibleTranche(finalTranche.id, account)
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.data.plan.status).toBe('fully_released')
      expect(second.data.planFullyReleased).toBe(true)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Release blocked when payout readiness is incomplete
// ═══════════════════════════════════════════════════════════════════════════

describe('3 — release blocked when payout readiness is incomplete', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 5200
  })

  it('blocks release with incomplete payout account', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()

    const result = await releaseEligibleTranche(
      depositTranche.id,
      makeIncompletePayoutAccount(),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('PAYOUT_NOT_READY')
      expect(result.message).toBeTruthy()
    }
  })

  it('blocks release with null payout account', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()

    const result = await releaseEligibleTranche(depositTranche.id, null)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('PAYOUT_NOT_READY')
    }
  })

  it('blocks release when charges not enabled', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()

    const result = await releaseEligibleTranche(depositTranche.id, {
      ...makeReadyPayoutAccount(),
      chargesEnabled: false,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('PAYOUT_NOT_READY')
    }
  })

  it('blocks release when payouts not enabled', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()

    const result = await releaseEligibleTranche(depositTranche.id, {
      ...makeReadyPayoutAccount(),
      payoutsEnabled: false,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('PAYOUT_NOT_READY')
    }
  })

  it('returns blocking reason details', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()

    const result = await releaseEligibleTranche(depositTranche.id, null)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.blockingReason).toBeDefined()
      expect(result.blockingReason?.code).toBe('no_stripe_account')
    }
  })

  it('rejects release of non-eligible tranche', async () => {
    const plan = await ensureEscrowPlan({
      sourceOfferId: `offer-ne-${Date.now()}`,
      jobId: `job-ne-${Date.now()}`,
      customerUserId: 'customer-release',
      providerId: 'provider-release',
      totalAmount: 4000,
    })

    await confirmFunding(plan.id)
    // Note: work NOT started, so deposit tranche is still 'funded', not 'eligible_for_release'

    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')!

    const result = await releaseEligibleTranche(deposit.id, makeReadyPayoutAccount())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('TRANCHE_NOT_ELIGIBLE')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Duplicate release attempts — idempotency
// ═══════════════════════════════════════════════════════════════════════════

describe('4 — duplicate release attempts do not create duplicate side effects', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 5300
  })

  it('second release of same tranche returns idempotent success', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()
    const account = makeReadyPayoutAccount()

    const first = await releaseEligibleTranche(depositTranche.id, account)
    expect(first.ok).toBe(true)

    const second = await releaseEligibleTranche(depositTranche.id, account)
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.data.tranche.status).toBe('released')
    }
  })

  it('already-released tranche bypasses payout readiness check', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()

    // First release with ready account
    const first = await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())
    expect(first.ok).toBe(true)

    // Second with null account — should still succeed because already released
    const second = await releaseEligibleTranche(depositTranche.id, null)
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.data.tranche.status).toBe('released')
    }
  })

  it('returns error for non-existent tranche', async () => {
    const result = await releaseEligibleTranche('non-existent-id', makeReadyPayoutAccount())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('TRANCHE_NOT_FOUND')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Released tranche updates plan rollup correctly
// ═══════════════════════════════════════════════════════════════════════════

describe('5 — released tranche updates plan rollup correctly', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 5400
  })

  it('single tranche released → partially_released', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()

    const result = await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.plan.status).toBe('partially_released')
    }
  })

  it('all tranches released → fully_released', async () => {
    const { depositTranche, finalTranche } = await setupFundedPlanWithWorkCompleted()
    const account = makeReadyPayoutAccount()

    await releaseEligibleTranche(depositTranche.id, account)
    const result = await releaseEligibleTranche(finalTranche.id, account)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.plan.status).toBe('fully_released')
      expect(result.data.planFullyReleased).toBe(true)
    }
  })

  it('no released tranches → funded_in_escrow', async () => {
    const { plan } = await setupFundedPlanWithWorkStarted()

    // Plan should still be funded_in_escrow since no tranches released
    const currentPlan = getEscrowPlanByJobId(plan.jobId)
    expect(currentPlan?.status).toBe('funded_in_escrow')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. Release blocked / released states in selectors
// ═══════════════════════════════════════════════════════════════════════════

describe('6 — release blocked / released states in selectors', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 5500
  })

  it('provider phase shows partially_released when 25% is released', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!
    const job = getJobById(plan.jobId)!

    // Full funding simulation through old payment model
    await simulateCustomerFunding(job.id)

    // Start job to make deposit eligible
    const startResult = await startJob(job.id)
    expect(startResult.ok).toBe(true)

    // Complete job
    const completeResult = await completeJob(job.id)
    expect(completeResult.ok).toBe(true)

    // Release 25% deposit tranche
    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')!
    await releaseEligibleTranche(deposit.id, makeReadyPayoutAccount())

    const updatedPlan = getEscrowPlanByOfferId(offer.id)!
    const updatedJob = getJobById(plan.jobId)!

    const phaseVM = deriveProviderJobPhase(updatedJob, undefined, updatedPlan.status)
    expect(phaseVM.phase).toBe('partially_released')
  })

  it('provider phase shows payment_released when fully released', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!
    const job = getJobById(plan.jobId)!

    await simulateCustomerFunding(job.id)
    await startJob(job.id)
    await completeJob(job.id)

    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')!
    const final = tranches.find((t) => t.kind === 'final_release')!
    const account = makeReadyPayoutAccount()

    await releaseEligibleTranche(deposit.id, account)
    await releaseEligibleTranche(final.id, account)

    const updatedPlan = getEscrowPlanByOfferId(offer.id)!
    const updatedJob = getJobById(plan.jobId)!

    const phaseVM = deriveProviderJobPhase(updatedJob, undefined, updatedPlan.status)
    expect(phaseVM.phase).toBe('payment_released')
  })

  it('provider next action shows waiting for release when awaiting_release', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!
    const job = getJobById(plan.jobId)!

    await simulateCustomerFunding(job.id)
    await startJob(job.id)
    await completeJob(job.id)

    const updatedJob = getJobById(plan.jobId)!
    const nextAction = deriveProviderNextAction(updatedJob)

    expect(nextAction.actionId).toBe('wait_for_release')
    expect(nextAction.enabled).toBe(false)
  })

  it('provider next action shows partially released when 25% released', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!
    const job = getJobById(plan.jobId)!

    await simulateCustomerFunding(job.id)
    await startJob(job.id)
    await completeJob(job.id)

    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')!
    await releaseEligibleTranche(deposit.id, makeReadyPayoutAccount())

    const updatedPlan = getEscrowPlanByOfferId(offer.id)!
    const updatedJob = getJobById(plan.jobId)!

    const nextAction = deriveProviderNextAction(updatedJob, undefined, updatedPlan.status)
    expect(nextAction.actionId).toBe('wait_for_release')
    expect(nextAction.label).toContain('25%')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. No regression to funding flow
// ═══════════════════════════════════════════════════════════════════════════

describe('7 — no regression to funding flow', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 5600
  })

  it('funding still works correctly with release operations available', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    expect(plan.status).toBe('awaiting_customer_funding')
    expect(plan.totalAmount).toBe(4000)

    await confirmFunding(plan.id)
    const funded = getEscrowPlanByOfferId(offer.id)!
    expect(funded.status).toBe('funded_in_escrow')

    const tranches = getEscrowTranches(plan.id)
    expect(tranches).toHaveLength(2)
    expect(tranches.every((t) => t.status === 'funded')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. No regression to provider operations
// ═══════════════════════════════════════════════════════════════════════════

describe('8 — no regression to provider operations', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 5700
  })

  it('startJob still makes 25% tranche eligible', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!
    const job = getJobById(plan.jobId)!

    await simulateCustomerFunding(job.id)

    const result = await startJob(job.id)
    expect(result.ok).toBe(true)

    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')!
    expect(deposit.status).toBe('eligible_for_release')
  })

  it('completeJob still makes 75% tranche eligible', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!
    const job = getJobById(plan.jobId)!

    await simulateCustomerFunding(job.id)
    await startJob(job.id)

    const result = await completeJob(job.id)
    expect(result.ok).toBe(true)

    const tranches = getEscrowTranches(plan.id)
    const final = tranches.find((t) => t.kind === 'final_release')!
    expect(final.status).toBe('eligible_for_release')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. No regression to quote lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe('9 — no regression to quote lifecycle', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 5800
  })

  it('accepted quote still creates escrow plan with correct structure', async () => {
    const { offer } = await createAcceptedOffer('2.000 €')
    const plan = getEscrowPlanByOfferId(offer.id)!

    expect(plan).toBeDefined()
    expect(plan.totalAmount).toBe(2000)
    expect(plan.fundingMode).toBe('full_upfront_escrow')
    expect(plan.releaseModel).toBe('start_25_completion_75')
    expect(plan.status).toBe('awaiting_customer_funding')

    const tranches = getEscrowTranches(plan.id)
    expect(tranches).toHaveLength(2)
    expect(tranches.find((t) => t.kind === 'deposit_release')?.amount).toBe(500)
    expect(tranches.find((t) => t.kind === 'final_release')?.amount).toBe(1500)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10. Timeline events
// ═══════════════════════════════════════════════════════════════════════════

describe('10 — timeline events for release', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 5900
  })

  it('emits tranche_released timeline event on release', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!
    const job = getJobById(plan.jobId)!

    await simulateCustomerFunding(job.id)
    await startJob(job.id)

    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')!

    await releaseEligibleTranche(deposit.id, makeReadyPayoutAccount())

    const signals = getTimelineSignalsForJob(job.id)
    const types = signals.map((s) => s.type)

    expect(types).toContain('tranche_released')
    expect(types).toContain('payout_handoff_initiated')
  })

  it('emits release_blocked timeline event when blocked', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!
    const job = getJobById(plan.jobId)!

    await simulateCustomerFunding(job.id)
    await startJob(job.id)

    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')!

    await releaseEligibleTranche(deposit.id, makeIncompletePayoutAccount())

    const signals = getTimelineSignalsForJob(job.id)
    const types = signals.map((s) => s.type)

    expect(types).toContain('release_blocked')
  })

  it('emits payment_released and job_completed when fully released', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!
    const job = getJobById(plan.jobId)!

    await simulateCustomerFunding(job.id)
    await startJob(job.id)
    await completeJob(job.id)

    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')!
    const final = tranches.find((t) => t.kind === 'final_release')!
    const account = makeReadyPayoutAccount()

    await releaseEligibleTranche(deposit.id, account)
    await releaseEligibleTranche(final.id, account)

    const signals = getTimelineSignalsForJob(job.id)
    const types = signals.map((s) => s.type)

    expect(types).toContain('payment_released')
    expect(types).toContain('job_completed')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 11. Blocked reason derivation
// ═══════════════════════════════════════════════════════════════════════════

describe('11 — blocked reason derivation', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 6000
  })

  it('returns null for released tranche', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()
    await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())

    const updated = getEscrowTranches(depositTranche.planId)
      .find((t) => t.id === depositTranche.id)!

    const reason = deriveTrancheBlockedReason(updated, makeReadyPayoutAccount())
    expect(reason).toBeNull()
  })

  it('returns payout reason for eligible tranche with no account', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()

    const reason = deriveTrancheBlockedReason(depositTranche, null)
    expect(reason).toBeTruthy()
    expect(reason).toContain('Auszahlungskonto')
  })

  it('returns not-eligible reason for funded tranche', async () => {
    const plan = await ensureEscrowPlan({
      sourceOfferId: `offer-br-${Date.now()}`,
      jobId: `job-br-${Date.now()}`,
      customerUserId: 'customer-release',
      providerId: 'provider-release',
      totalAmount: 4000,
    })

    await confirmFunding(plan.id)
    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')!

    const reason = deriveTrancheBlockedReason(deposit, makeReadyPayoutAccount())
    expect(reason).toContain('nicht freigabefähig')
  })

  it('returns dispute reason for disputed tranche', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()

    // Manually simulate a disputed status for testing
    const repo = getEscrowPlanRepository()
    repo.updateTranche(depositTranche.id, (t) => ({
      ...t,
      status: 'disputed' as const,
    }))

    const updated = getEscrowTranches(depositTranche.planId)
      .find((t) => t.id === depositTranche.id)!

    const reason = deriveTrancheBlockedReason(updated, makeReadyPayoutAccount())
    expect(reason).toContain('Streitfall')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 12. Tranche release state derivation
// ═══════════════════════════════════════════════════════════════════════════

describe('12 — tranche release state derivation', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 6100
  })

  it('returns eligible when tranche is eligible and payout ready', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()
    const state = deriveTrancheReleaseState(depositTranche, makeReadyPayoutAccount())
    expect(state).toBe('eligible')
  })

  it('returns payout_blocked when eligible but payout not ready', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()
    const state = deriveTrancheReleaseState(depositTranche, makeIncompletePayoutAccount())
    expect(state).toBe('payout_blocked')
  })

  it('returns payout_blocked when eligible but no account', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()
    const state = deriveTrancheReleaseState(depositTranche, null)
    expect(state).toBe('payout_blocked')
  })

  it('returns released after release', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()
    await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())

    const updated = getEscrowTranches(depositTranche.planId)
      .find((t) => t.id === depositTranche.id)!

    const state = deriveTrancheReleaseState(updated, makeReadyPayoutAccount())
    expect(state).toBe('released')
  })

  it('returns not_eligible for funded (not yet eligible) tranche', async () => {
    const plan = await ensureEscrowPlan({
      sourceOfferId: `offer-state-${Date.now()}`,
      jobId: `job-state-${Date.now()}`,
      customerUserId: 'customer-release',
      providerId: 'provider-release',
      totalAmount: 4000,
    })

    await confirmFunding(plan.id)
    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')!

    const state = deriveTrancheReleaseState(deposit, makeReadyPayoutAccount())
    expect(state).toBe('not_eligible')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 13. Legacy reconciliation — in_progress + funded tranche
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — Legacy reconciliation: in_progress job with funded deposit tranche', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 5000
  })

  /**
   * Simulates the pre-fix legacy state:
   *   job.status === 'in_progress'
   *   deposit tranche.status === 'funded'  (recordWorkStarted never ran)
   */
  async function createLegacyState() {
    const { offer } = await createAcceptedOffer()
    const jobId = offer.createdJobId!
    await simulateCustomerFunding(jobId)

    // Directly set job to in_progress WITHOUT calling startJobWorkflow.
    // This simulates the old bug where updateJobStatus ran before recordWorkStarted.
    await updateJobStatus(jobId, 'in_progress')

    const escrowPlan = getEscrowPlanByJobId(jobId)!
    const tranches = getEscrowTranches(escrowPlan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')!
    const final = tranches.find((t) => t.kind === 'final_release')!

    // Verify legacy state is correctly set up
    expect(deposit.status).toBe('funded') // NOT eligible_for_release
    expect(getJobById(jobId)!.status).toBe('in_progress')

    return { jobId, escrowPlan, deposit, final }
  }

  it('deriveTrancheReleaseState returns "eligible" for legacy funded + in_progress', async () => {
    const { deposit } = await createLegacyState()
    const state = deriveTrancheReleaseState(deposit, makeReadyPayoutAccount(), 'in_progress')
    expect(state).toBe('eligible')
  })

  it('deriveTrancheBlockedReason returns null for legacy funded + in_progress', async () => {
    const { deposit } = await createLegacyState()
    const reason = deriveTrancheBlockedReason(deposit, makeReadyPayoutAccount(), 'in_progress')
    expect(reason).toBeNull()
  })

  it('deriveTrancheReleaseState returns "not_eligible" without jobStatus context', async () => {
    const { deposit } = await createLegacyState()
    // Without jobStatus, funded tranche is NOT eligible
    const state = deriveTrancheReleaseState(deposit, makeReadyPayoutAccount())
    expect(state).toBe('not_eligible')
  })

  it('recordWorkStarted fixes the legacy tranche to eligible_for_release', async () => {
    const { escrowPlan, deposit } = await createLegacyState()
    expect(deposit.status).toBe('funded')

    const result = await recordWorkStarted(escrowPlan.id, 'provider')
    expect('error' in result).toBe(false)

    const fixed = getEscrowTranches(escrowPlan.id).find((t) => t.kind === 'deposit_release')!
    expect(fixed.status).toBe('eligible_for_release')
  })

  it('releaseTrancheWorkflow reconciles legacy tranche before server call', async () => {
    const { jobId, escrowPlan, deposit } = await createLegacyState()
    expect(deposit.status).toBe('funded')

    // releaseTrancheWorkflow will:
    // 1. Reconcile tranche (funded → eligible_for_release) ← this is what we test
    // 2. Call server (fails in test env — no running server)
    await releaseTrancheWorkflow(deposit.id, escrowPlan.id, jobId, 'system')

    // Regardless of server result, the local tranche should be reconciled
    const reconciled = getEscrowTranches(escrowPlan.id).find((t) => t.kind === 'deposit_release')!
    expect(reconciled.status).toBe('eligible_for_release')
  })
})
