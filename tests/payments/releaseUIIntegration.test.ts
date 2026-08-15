/**
 * Release Actions UI + Cross-Surface Release Integration Tests
 *
 * Validates:
 *  1. Eligible tranche shows real release state in provider operations
 *  2. Payout-blocked eligible tranche shows blocked reason
 *  3. Released tranche rehydrates correctly after reload/re-entry
 *  4. Partial and full release project different visible states
 *  5. Customer-facing surfaces reflect partial/full release correctly
 *  6. No regression to funding flow
 *  7. No regression to provider operations
 *  8. No regression to quote lifecycle
 *  9. Cross-surface state consistency
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
  deriveTrancheReleaseState,
  deriveTrancheBlockedReason,
} from '../../src/lib/workflow/releaseOperations'
import { startJob, completeJob } from '../../src/lib/workflow/craftsmanOperations'
import {
  markDepositPaidForJobWorkflow,
} from '../../src/lib/workflow/jobWorkflow'
import { lockEscrowWorkflow } from '../../src/lib/workflow/paymentWorkflow'
import { getJobById } from '../../src/lib/jobs'
import { deriveProviderJobPhase } from '../../src/lib/jobs/providerJobPhaseSelectors'
import { deriveProviderNextAction } from '../../src/lib/jobs/providerNextActionSelectors'
import {
  deriveCustomerJobStage,
  CUSTOMER_STAGE_LABELS,
} from '../../src/lib/jobs/customerJobStageSelectors'
import { deriveCustomerNextStep } from '../../src/lib/jobs/customerNextStepSelectors'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'
import type { Conversation } from '../../src/lib/messages/types'

// ── Helpers ───────────────────────────────────────────────────────────────

let convCounter = 8000

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  convCounter += 1
  return {
    id: `conv-release-ui-${convCounter}`,
    projectId: `project_release_ui_${convCounter}`,
    customerName: 'Test Kunde',
    customerUserId: 'customer-release-ui',
    craftsmanUserId: 'craftsman-release-ui',
    projectTitle: 'Test Projekt',
    projectLocation: 'München',
    messages: [
      {
        id: `msg-release-ui-${convCounter}`,
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
    providerUserId: 'craftsman-release-ui',
    stripeConnectAccountId: 'acct_ready',
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
    providerUserId: 'craftsman-release-ui',
    stripeConnectAccountId: 'acct_incomplete',
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
    customerUserId: 'customer-release-ui',
    craftsmanUserId: 'craftsman-release-ui',
    price,
  })

  const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
  installSessionForJobOwner({ craftsmanUserId: 'craftsman-release-ui' })
  return { conv, offer: accepted }
}

async function waitForEscrowPlanByOfferId(
  offerId: string,
  timeoutMs = 10_000,
  intervalMs = 25,
) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const plan = getEscrowPlanByOfferId(offerId)
    if (plan) return plan
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`Timed out waiting for escrow plan for offer ${offerId}`)
}

async function simulateCustomerFunding(jobId: string) {
  await markDepositPaidForJobWorkflow(jobId)
  await lockEscrowWorkflow(jobId)
  const escrowPlan = getEscrowPlanByJobId(jobId)!
  await confirmFunding(escrowPlan.id)
}

async function setupFundedPlanWithWorkStarted() {
  const plan = await ensureEscrowPlan({
    sourceOfferId: `offer-csui-${Date.now()}-${Math.random()}`,
    jobId: `job-csui-${Date.now()}-${Math.random()}`,
    customerUserId: 'customer-release-ui',
    providerId: 'provider-release-ui',
    totalAmount: 4000,
  })

  await confirmFunding(plan.id)
  await recordWorkStarted(plan.id, 'provider')

  const tranches = getEscrowTranches(plan.id)
  const depositTranche = tranches.find((t) => t.kind === 'deposit_release')!
  const finalTranche = tranches.find((t) => t.kind === 'final_release')!

  return { plan, depositTranche, finalTranche }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Tranche release state in provider operations
// ═══════════════════════════════════════════════════════════════════════════

describe('1 — eligible tranche shows real release state in provider operations', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 8000
  })

  it('eligible tranche shows "eligible" state', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()
    const state = deriveTrancheReleaseState(depositTranche, makeReadyPayoutAccount())
    expect(state).toBe('eligible')
  })

  it('provider phase shows work_started when tranche is eligible but not released', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = await waitForEscrowPlanByOfferId(offer.id)
    const job = getJobById(plan.jobId)!

    await simulateCustomerFunding(job.id)
    await startJob(job.id)

    const updatedJob = getJobById(plan.jobId)!
    const phaseVM = deriveProviderJobPhase(updatedJob, undefined, plan.status)
    // After work_started, before any release → work_started phase still
    expect(phaseVM.phase).toBe('work_started')
  })

  it('released tranche shows "released" state', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()
    await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())

    const updatedTranches = getEscrowTranches(depositTranche.planId)
    const updated = updatedTranches.find((t) => t.id === depositTranche.id)!
    const state = deriveTrancheReleaseState(updated, makeReadyPayoutAccount())
    expect(state).toBe('released')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Payout-blocked tranche shows blocked reason
// ═══════════════════════════════════════════════════════════════════════════

describe('2 — payout-blocked eligible tranche shows blocked reason', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 8100
  })

  it('shows payout_blocked state for incomplete account', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()
    const state = deriveTrancheReleaseState(depositTranche, makeIncompletePayoutAccount())
    expect(state).toBe('payout_blocked')
  })

  it('deriveTrancheBlockedReason returns specific message', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()
    const reason = deriveTrancheBlockedReason(depositTranche, makeIncompletePayoutAccount())
    expect(reason).toBeTruthy()
    expect(typeof reason).toBe('string')
  })

  it('shows payout_blocked for null account', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()
    const state = deriveTrancheReleaseState(depositTranche, null)
    expect(state).toBe('payout_blocked')
  })

  it('shows not_eligible for funded (not yet work_started) tranche', async () => {
    const plan = await ensureEscrowPlan({
      sourceOfferId: `offer-ne-ui-${Date.now()}`,
      jobId: `job-ne-ui-${Date.now()}`,
      customerUserId: 'customer-release-ui',
      providerId: 'provider-release-ui',
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
// 3. Released tranche rehydrates correctly after reload/re-entry
// ═══════════════════════════════════════════════════════════════════════════

describe('3 — released tranche rehydrates correctly', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 8200
  })

  it('re-reading tranche after release shows released status', async () => {
    const { depositTranche, plan } = await setupFundedPlanWithWorkStarted()
    await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())

    // Simulate re-read (like reload)
    const freshTranches = getEscrowTranches(plan.id)
    const freshDeposit = freshTranches.find((t) => t.id === depositTranche.id)!
    expect(freshDeposit.status).toBe('released')
    expect(freshDeposit.releasedAt).toBeDefined()
  })

  it('re-release of already-released tranche returns idempotent success', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()
    const first = await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())
    expect(first.ok).toBe(true)

    const second = await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.data.tranche.status).toBe('released')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Partial and full release project different visible states
// ═══════════════════════════════════════════════════════════════════════════

describe('4 — partial and full release project different visible states', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 8300
  })

  it('partial release → provider phase = partially_released', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = await waitForEscrowPlanByOfferId(offer.id)
    const job = getJobById(plan.jobId)!

    await simulateCustomerFunding(job.id)
    await startJob(job.id)
    await completeJob(job.id)

    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')!
    await releaseEligibleTranche(deposit.id, makeReadyPayoutAccount())

    const updatedPlan = getEscrowPlanByOfferId(offer.id)!
    const updatedJob = getJobById(plan.jobId)!
    const phaseVM = deriveProviderJobPhase(updatedJob, undefined, updatedPlan.status)
    expect(phaseVM.phase).toBe('partially_released')
  }, 15_000)

  it('full release → provider phase = payment_released', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = await waitForEscrowPlanByOfferId(offer.id)
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

  it('partial release → provider next action shows partial label', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = await waitForEscrowPlanByOfferId(offer.id)
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
    expect(nextAction.label).toContain('25%')
  })

  it('full release → provider next action shows completed', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = await waitForEscrowPlanByOfferId(offer.id)
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
    const nextAction = deriveProviderNextAction(updatedJob, undefined, updatedPlan.status)
    expect(nextAction.actionId).toBe('none')
    expect(nextAction.label).toContain('freigegeben')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Customer-facing surfaces reflect partial/full release correctly
// ═══════════════════════════════════════════════════════════════════════════

describe('5 — customer-facing surfaces reflect release correctly', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 8400
  })

  it('customer stage shows partially_released when escrow is partially released', () => {
    const stage = deriveCustomerJobStage(
      'waiting_payment', 'release_pending', 1000, 2000, 'funded', 'partially_released'
    )
    expect(stage.stage).toBe('partially_released')
  })

  it('customer stage shows payment_released when escrow is fully released', () => {
    const stage = deriveCustomerJobStage(
      'completed', 'released', 1000, 2000, 'funded', 'fully_released'
    )
    expect(stage.stage).toBe('payment_released')
  })

  it('customer stage label for partially_released is meaningful', () => {
    expect(CUSTOMER_STAGE_LABELS['partially_released']).toBe('Teilfreigabe')
  })

  it('customer next step for partially_released state is informative', () => {
    const job = {
      id: 'test-job',
      projectId: 'test-project',
      title: 'Test',
      status: 'waiting_payment' as const,
      proposalSentAt: 1000,
      proposalAcceptedAt: 2000,
      workCompletedAt: 3000,
    }
    // Pass escrowStatus to get partially_released stage
    const step = deriveCustomerNextStep(
      job as Parameters<typeof deriveCustomerNextStep>[0],
      undefined,
      'funded',
      'partially_released'
    )
    expect(step.label).toContain('Teilfreigabe')
    expect(step.hint).toContain('25 %')
  })

  it('customer next step for payment_released state shows complete', () => {
    const job = {
      id: 'test-job',
      projectId: 'test-project',
      title: 'Test',
      status: 'completed' as const,
      proposalSentAt: 1000,
      proposalAcceptedAt: 2000,
      workCompletedAt: 3000,
      paymentReleasedAt: 4000,
    }
    const step = deriveCustomerNextStep(
      job as Parameters<typeof deriveCustomerNextStep>[0],
      undefined,
      'funded',
      'fully_released'
    )
    expect(step.label).toBe('Auftrag abgeschlossen')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. No regression to funding flow
// ═══════════════════════════════════════════════════════════════════════════

describe('6 — no regression to funding flow', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 8500
  })

  it('funding still works correctly end-to-end', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = await waitForEscrowPlanByOfferId(offer.id)
    expect(plan.status).toBe('awaiting_customer_funding')

    await confirmFunding(plan.id)
    const funded = getEscrowPlanByOfferId(offer.id)!
    expect(funded.status).toBe('funded_in_escrow')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. No regression to provider operations
// ═══════════════════════════════════════════════════════════════════════════

describe('7 — no regression to provider operations', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 8600
  })

  it('startJob still makes 25% tranche eligible', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = await waitForEscrowPlanByOfferId(offer.id)
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
    const plan = await waitForEscrowPlanByOfferId(offer.id)
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
// 8. No regression to quote lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe('8 — no regression to quote lifecycle', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 8700
  })

  it('accepted quote still creates escrow plan with correct structure', async () => {
    const { offer } = await createAcceptedOffer('2.000 €')
    const plan = await waitForEscrowPlanByOfferId(offer.id)

    expect(plan).toBeDefined()
    expect(plan.totalAmount).toBe(2000)
    expect(plan.releaseModel).toBe('start_25_completion_75')

    const tranches = getEscrowTranches(plan.id)
    expect(tranches).toHaveLength(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. Cross-surface state consistency
// ═══════════════════════════════════════════════════════════════════════════

describe('9 — cross-surface state consistency', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 8800
  })

  it('provider and customer both reflect partially_released after first tranche release', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = await waitForEscrowPlanByOfferId(offer.id)
    const job = getJobById(plan.jobId)!

    await simulateCustomerFunding(job.id)
    await startJob(job.id)
    await completeJob(job.id)

    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')!
    await releaseEligibleTranche(deposit.id, makeReadyPayoutAccount())

    const updatedPlan = getEscrowPlanByOfferId(offer.id)!
    const updatedJob = getJobById(plan.jobId)!

    // Provider sees partially_released
    const providerPhase = deriveProviderJobPhase(updatedJob, undefined, updatedPlan.status)
    expect(providerPhase.phase).toBe('partially_released')

    // Customer sees partially_released
    const customerStage = deriveCustomerJobStage(
      updatedJob.status,
      updatedJob.paymentState,
      updatedJob.proposalSentAt,
      updatedJob.proposalAcceptedAt,
      undefined,
      updatedPlan.status
    )
    expect(customerStage.stage).toBe('partially_released')
  })

  it('provider and customer both reflect payment_released after full release', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = await waitForEscrowPlanByOfferId(offer.id)
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

    // Provider sees payment_released
    const providerPhase = deriveProviderJobPhase(updatedJob, undefined, updatedPlan.status)
    expect(providerPhase.phase).toBe('payment_released')

    // Customer sees payment_released
    const customerStage = deriveCustomerJobStage(
      updatedJob.status,
      updatedJob.paymentState,
      updatedJob.proposalSentAt,
      updatedJob.proposalAcceptedAt,
      undefined,
      updatedPlan.status
    )
    expect(customerStage.stage).toBe('payment_released')
  })

  it('escrow plan status is consistent with tranche states', async () => {
    const { depositTranche, finalTranche, plan } = await setupFundedPlanWithWorkStarted()
    const account = makeReadyPayoutAccount()

    // Before any release
    let updatedPlan = getEscrowPlanByJobId(plan.jobId)!
    expect(updatedPlan.status).toBe('funded_in_escrow')

    // After partial release
    await releaseEligibleTranche(depositTranche.id, account)
    updatedPlan = getEscrowPlanByJobId(plan.jobId)!
    expect(updatedPlan.status).toBe('partially_released')

    // After work completed and full release
    await recordWorkCompleted(plan.id, 'provider')
    await releaseEligibleTranche(finalTranche.id, account)
    updatedPlan = getEscrowPlanByJobId(plan.jobId)!
    expect(updatedPlan.status).toBe('fully_released')
  })
})
