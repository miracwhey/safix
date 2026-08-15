/**
 * Block 6 — Cross-Surface Projection Alignment Tests
 *
 * Validates that the same business context resolves to one coherent
 * interpreted truth across ALL customer/provider/operational surfaces.
 *
 * These tests verify semantic agreement — not string snapshots — ensuring:
 * 1. Same funded context → same underlying status/payment/phase truth
 * 2. Next-step/progress/status branches agree for the same context
 * 3. Completed/work-completed/payment-released semantics don't diverge
 * 4. Weaker stale fallbacks never win over canonical truth
 * 5. No regression to Blocks 1–5.1
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import { deriveCustomerJobStage } from '../../src/lib/jobs/customerJobStageSelectors'
import { deriveCustomerNextStep } from '../../src/lib/jobs/customerNextStepSelectors'
import { deriveCustomerNextAction } from '../../src/lib/jobs/customerNextActionSelectors'
import { deriveProviderJobPhase } from '../../src/lib/jobs/providerJobPhaseSelectors'
import { deriveProviderNextAction } from '../../src/lib/jobs/providerNextActionSelectors'
import {
  deriveJobOperationalSummary,
} from '../../src/lib/jobs/operationalSummarySelectors'

import { addJob } from '../../src/lib/jobs'
import { getPaymentForJob } from '../../src/lib/payments/service'
import { getActionablePaymentState } from '../../src/lib/jobs/helpers'
import { getFundingRequestRepository } from '../../src/lib/payments/fundingRequest/fundingRequestRegistry'
import { getEscrowPlanRepository } from '../../src/lib/payments/escrow/escrowRegistry'

import type { Job } from '../../src/lib/jobs/types'
import type { FundingRequest } from '../../src/lib/payments/fundingRequest/types'
import type { PaymentState, JobStatus } from '../../src/lib/shared/coreTypes'

// ── Helpers ───────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    projectId: 'project-1',
    title: 'Test Job',
    customer: 'Max Mustermann',
    location: 'Berlin',
    dateLabel: 'Morgen',
    status: 'new',
    amount: '5.000 €',
    description: 'Badezimmer renovieren',
    paymentState: 'none',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: 'craftsman-1',
    customerUserId: 'customer-1',
    ...overrides,
  }
}

function seedFundedFundingRequest(jobId: string, id = 'fr-1') {
  const fr: FundingRequest = {
    id,
    sourceOfferId: 'offer-1',
    jobId,
    escrowPlanId: 'ep-1',
    customerUserId: 'customer-1',
    providerId: 'provider-1',
    providerUserId: 'craftsman-1',
    type: 'full_escrow',
    status: 'funded',
    amount: 5000,
    currency: 'EUR',
    createdBy: 'provider',
    createdAt: NOW,
    updatedAt: NOW,
    fundedAt: NOW,
  }
  getFundingRequestRepository().add(fr)
}

function seedFundedEscrowPlan(jobId: string, id = 'ep-1') {
  getEscrowPlanRepository().addPlan({
    id,
    jobId,
    offerId: 'offer-1',
    totalAmount: 5000,
    currency: 'EUR',
    status: 'funded_in_escrow',
    createdAt: NOW,
    updatedAt: NOW,
  })
}

function buildOperationalSummary(
  job: Job,
  paymentState: PaymentState | undefined,
  fundingStatus?: string
) {
  return deriveJobOperationalSummary({
    jobId: job.id,
    jobStatus: job.status,
    paymentState,
    disputeStatus: undefined,
    schedulingStatus: undefined,
    schedule: undefined,
    artifactCount: 0,
    timelineSignals: [],
    proposalSentAt: job.proposalSentAt,
    proposalAcceptedAt: job.proposalAcceptedAt,
    fundingStatus,
  })
}

// ── Setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  setupCleanRepositories()
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. FUNDED CONTEXT — cross-surface agreement
// ═══════════════════════════════════════════════════════════════════════════

describe('funded context — all surfaces agree', () => {
  it('customer stage, next-step, next-action, and provider phase all project funded truth when fundingStatus=funded but paymentState is stale', () => {
    const job = makeJob({
      proposalSentAt: NOW - 10_000,
      proposalAcceptedAt: NOW - 5_000,
      paymentState: 'deposit_required', // stale — hasn't caught up to funded yet
    })
    addJob(job)

    const payment = getPaymentForJob(job.id) ?? undefined
    const effectivePaymentState = getActionablePaymentState(job, payment)

    // Customer stage: should see funded_in_escrow, not offer_accepted
    const stage = deriveCustomerJobStage(
      job.status,
      effectivePaymentState,
      job.proposalSentAt,
      job.proposalAcceptedAt,
      'funded',
      'funded_in_escrow'
    )
    expect(stage.stage).toBe('funded_in_escrow')

    // Customer next step: should reflect funded truth
    const nextStep = deriveCustomerNextStep(job, payment, 'funded', 'funded_in_escrow')
    expect(nextStep.label).toBe('Zahlung abgesichert')
    expect(nextStep.hint).toContain('bestätigt')

    // Customer next action: should reflect funded truth, not "Angebot angenommen"
    const customerAction = deriveCustomerNextAction(
      job.status, effectivePaymentState, undefined,
      job.proposalSentAt, job.proposalAcceptedAt, 'funded'
    )
    expect(customerAction.domain).toBe('payment')
    expect(customerAction.label).toBe('Zahlung gesichert')

    // Provider phase: should see funded_in_escrow
    const providerPhase = deriveProviderJobPhase(job, 'funded', 'funded_in_escrow')
    expect(providerPhase.phase).toBe('funded_in_escrow')

    // Provider next action: should see start_work
    const providerAction = deriveProviderNextAction(job, 'funded', 'funded_in_escrow')
    expect(providerAction.actionId).toBe('start_work')

    // Operational summary: should NOT show awaiting_deposit blocker
    const summary = buildOperationalSummary(job, effectivePaymentState, 'funded')
    expect(summary.blocker.reason).not.toBe('awaiting_deposit')

    // Craftsman next action in operational summary: should reflect funded truth
    expect(summary.nextAction.domain).toBe('payment')
    expect(summary.nextAction.label).toBe('Zahlung abgesichert')
  })

  it('all surfaces agree for funded+accepted context with no Payment record', () => {
    const job = makeJob({
      proposalSentAt: NOW - 10_000,
      proposalAcceptedAt: NOW - 5_000,
      paymentState: 'none', // no payment record created yet
    })
    addJob(job)
    seedFundedFundingRequest(job.id)
    seedFundedEscrowPlan(job.id)

    const effectivePaymentState = getActionablePaymentState(job, undefined)

    // Customer stage
    const stage = deriveCustomerJobStage(
      job.status,
      effectivePaymentState,
      job.proposalSentAt, job.proposalAcceptedAt,
      'funded', 'funded_in_escrow'
    )
    expect(stage.stage).toBe('funded_in_escrow')

    // Customer next action — must NOT fall through to "Angebot angenommen"
    const customerAction = deriveCustomerNextAction(
      job.status, effectivePaymentState, undefined,
      job.proposalSentAt, job.proposalAcceptedAt, 'funded'
    )
    expect(customerAction.label).not.toBe('Angebot angenommen')
    expect(customerAction.domain).toBe('payment')

    // Provider phase
    const providerPhase = deriveProviderJobPhase(job, 'funded', 'funded_in_escrow')
    expect(providerPhase.phase).toBe('funded_in_escrow')

    // Operational summary blocker must NOT say awaiting_deposit
    const summary = buildOperationalSummary(job, effectivePaymentState, 'funded')
    expect(summary.blocker.reason).not.toBe('awaiting_deposit')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. WORK COMPLETED — cross-surface agreement
// ═══════════════════════════════════════════════════════════════════════════

describe('work completed context — all surfaces agree', () => {
  it('customer stage, next-action, and provider phase agree for waiting_payment + release_pending', () => {
    const job = makeJob({
      status: 'waiting_payment' as JobStatus,
      proposalSentAt: NOW - 20_000,
      proposalAcceptedAt: NOW - 15_000,
      paymentState: 'release_pending' as PaymentState,
      workCompletedAt: NOW - 1_000,
    })
    addJob(job)

    // Customer stage: work_completed
    const stage = deriveCustomerJobStage(
      job.status, 'release_pending',
      job.proposalSentAt, job.proposalAcceptedAt,
      'funded'
    )
    expect(stage.stage).toBe('work_completed')

    // Customer next action: payment release urgent
    const customerAction = deriveCustomerNextAction(
      job.status, 'release_pending', undefined,
      job.proposalSentAt, job.proposalAcceptedAt, 'funded'
    )
    expect(customerAction.priority).toBe('urgent')
    expect(customerAction.label).toBe('Bestätigen & freigeben')

    // Provider phase: awaiting_release
    const providerPhase = deriveProviderJobPhase(job, 'funded')
    expect(providerPhase.phase).toBe('awaiting_release')

    // Provider next action: wait for release
    const providerAction = deriveProviderNextAction(job, 'funded')
    expect(providerAction.actionId).toBe('wait_for_release')

    // Operational summary: awaiting_release phase, customer must act
    const summary = buildOperationalSummary(job, 'release_pending', 'funded')
    expect(summary.phase).toBe('awaiting_release')
    expect(summary.requiresCustomerAction).toBe(true)
    expect(summary.requiresCraftsmanAction).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. PAYMENT RELEASED — cross-surface agreement
// ═══════════════════════════════════════════════════════════════════════════

describe('payment released context — all surfaces agree', () => {
  it('terminal payment state produces consistent terminal projection everywhere', () => {
    const job = makeJob({
      status: 'completed' as JobStatus,
      proposalSentAt: NOW - 30_000,
      proposalAcceptedAt: NOW - 25_000,
      paymentState: 'released' as PaymentState,
      paymentReleasedAt: NOW - 500,
    })
    addJob(job)

    // Customer stage: payment_released (terminal)
    const stage = deriveCustomerJobStage(
      job.status, 'released',
      job.proposalSentAt, job.proposalAcceptedAt,
      'funded', 'fully_released'
    )
    expect(stage.stage).toBe('payment_released')

    // Customer next action: idle, payment released
    const customerAction = deriveCustomerNextAction(
      job.status, 'released', undefined,
      job.proposalSentAt, job.proposalAcceptedAt, 'funded'
    )
    expect(customerAction.priority).toBe('idle')
    expect(customerAction.label).toBe('Zahlung freigegeben')

    // Provider phase: payment_released
    const providerPhase = deriveProviderJobPhase(job, 'funded', 'fully_released')
    expect(providerPhase.phase).toBe('payment_released')

    // Operational summary: complete
    const summary = buildOperationalSummary(job, 'released', 'funded')
    expect(summary.phase).toBe('complete')
    expect(summary.isComplete).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. PRE-FUNDED ACCEPTED — no stale "deposit blocker" when funded
// ═══════════════════════════════════════════════════════════════════════════

describe('funded dominance — blocker alignment', () => {
  it('operational summary does NOT show awaiting_deposit when funded', () => {
    const job = makeJob({
      proposalSentAt: NOW - 10_000,
      proposalAcceptedAt: NOW - 5_000,
      paymentState: 'deposit_required' as PaymentState,
    })
    addJob(job)

    const summary = buildOperationalSummary(job, 'deposit_required', 'funded')
    expect(summary.blocker.reason).not.toBe('awaiting_deposit')
    expect(summary.blocker.isBlocking).toBe(false)
  })

  it('operational summary DOES show awaiting_deposit when NOT funded', () => {
    const job = makeJob({
      proposalSentAt: NOW - 10_000,
      proposalAcceptedAt: NOW - 5_000,
      paymentState: 'deposit_required' as PaymentState,
    })
    addJob(job)

    const summary = buildOperationalSummary(job, 'deposit_required', 'sent')
    expect(summary.blocker.reason).toBe('awaiting_deposit')
    expect(summary.blocker.isBlocking).toBe(true)
  })

  it('operational summary shows awaiting_deposit with undefined fundingStatus (backward compat)', () => {
    const job = makeJob({
      proposalSentAt: NOW - 10_000,
      proposalAcceptedAt: NOW - 5_000,
      paymentState: 'deposit_required' as PaymentState,
    })
    addJob(job)

    const summary = buildOperationalSummary(job, 'deposit_required', undefined)
    expect(summary.blocker.reason).toBe('awaiting_deposit')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. CUSTOMER STAGE + NEXT-STEP consistency across payment state sources
// ═══════════════════════════════════════════════════════════════════════════

describe('payment state source consistency', () => {
  it('stages bar and next-step banner agree when using getActionablePaymentState', () => {
    // Scenario: job.paymentState is set but no Payment record exists
    const job = makeJob({
      proposalSentAt: NOW - 10_000,
      proposalAcceptedAt: NOW - 5_000,
      paymentState: 'deposit_required' as PaymentState,
    })
    addJob(job)

    // Both should use getActionablePaymentState → 'deposit_required' (job is operational)
    const effectivePayment = getActionablePaymentState(job, undefined)
    expect(effectivePayment).toBe('deposit_required')

    // Stages bar uses this value
    const stage = deriveCustomerJobStage(
      job.status, effectivePayment,
      job.proposalSentAt, job.proposalAcceptedAt
    )

    // Next step also uses this value (via internal getActionablePaymentState)
    const nextStep = deriveCustomerNextStep(job, undefined)

    // Both should agree on the same lifecycle phase
    // Stage: offer_accepted (deposit_required triggers the override in next-step, not stage)
    // Next step: "Zahlung einzahlen" for offer_accepted + deposit_required
    // These are consistent: stage says "accepted", next step says "now pay"
    expect(stage.stage).toBe('offer_accepted')
    expect(nextStep.label).toBe('Zahlung einzahlen')
    expect(nextStep.actionLabel).toBe('Jetzt einzahlen')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. NO REGRESSION — pre-funded contexts still work correctly
// ═══════════════════════════════════════════════════════════════════════════

describe('no regression — pre-funded contexts', () => {
  it('inquiry stage (no proposal) projects consistently', () => {
    const job = makeJob({ paymentState: 'none' })
    addJob(job)

    const stage = deriveCustomerJobStage(job.status, undefined)
    expect(stage.stage).toBe('inquiry_sent')

    const customerAction = deriveCustomerNextAction(job.status, undefined, undefined)
    expect(customerAction.label).toBe('Anfrage in Prüfung')

    const providerPhase = deriveProviderJobPhase(job)
    expect(providerPhase.phase).toBe('quote_sent')

    const summary = buildOperationalSummary(job, undefined, undefined)
    expect(summary.phase).toBe('intake')
  })

  it('offer sent (no acceptance) projects consistently', () => {
    const job = makeJob({
      proposalSentAt: NOW - 5_000,
      paymentState: 'none',
    })
    addJob(job)

    const stage = deriveCustomerJobStage(job.status, undefined, job.proposalSentAt)
    expect(stage.stage).toBe('offer_received')

    const providerPhase = deriveProviderJobPhase(job)
    expect(providerPhase.phase).toBe('quote_sent')
  })

  it('offer accepted, not funded, deposit_required projects consistently', () => {
    const job = makeJob({
      proposalSentAt: NOW - 10_000,
      proposalAcceptedAt: NOW - 5_000,
      paymentState: 'deposit_required' as PaymentState,
    })
    addJob(job)

    const effectivePayment = getActionablePaymentState(job, undefined)

    const stage = deriveCustomerJobStage(
      job.status, effectivePayment,
      job.proposalSentAt, job.proposalAcceptedAt
    )
    expect(stage.stage).toBe('offer_accepted')

    const customerAction = deriveCustomerNextAction(
      job.status, effectivePayment, undefined,
      job.proposalSentAt, job.proposalAcceptedAt
    )
    expect(customerAction.label).toBe('Zahlung leisten')
    expect(customerAction.domain).toBe('payment')

    const summary = buildOperationalSummary(job, effectivePayment, undefined)
    expect(summary.blocker.reason).toBe('awaiting_deposit')
  })

  it('in_progress projects consistently across surfaces', () => {
    const job = makeJob({
      status: 'in_progress' as JobStatus,
      proposalSentAt: NOW - 20_000,
      proposalAcceptedAt: NOW - 15_000,
      paymentState: 'in_escrow' as PaymentState,
    })
    addJob(job)

    const stage = deriveCustomerJobStage(
      job.status, 'in_escrow',
      job.proposalSentAt, job.proposalAcceptedAt,
      'funded'
    )
    expect(stage.stage).toBe('work_in_progress')

    const providerPhase = deriveProviderJobPhase(job, 'funded', 'funded_in_escrow')
    expect(providerPhase.phase).toBe('work_started')

    const summary = buildOperationalSummary(job, 'in_escrow', 'funded')
    expect(summary.phase).toBe('active')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. PARTIALLY RELEASED — surfaces agree
// ═══════════════════════════════════════════════════════════════════════════

describe('partially released — cross-surface agreement', () => {
  it('customer stage and provider phase both reflect partial release', () => {
    const job = makeJob({
      status: 'waiting_payment' as JobStatus,
      proposalSentAt: NOW - 30_000,
      proposalAcceptedAt: NOW - 25_000,
      paymentState: 'in_escrow' as PaymentState,
      workCompletedAt: NOW - 2_000,
    })
    addJob(job)

    const stage = deriveCustomerJobStage(
      job.status, 'in_escrow',
      job.proposalSentAt, job.proposalAcceptedAt,
      'funded', 'partially_released'
    )
    expect(stage.stage).toBe('partially_released')

    const providerPhase = deriveProviderJobPhase(job, 'funded', 'partially_released')
    expect(providerPhase.phase).toBe('partially_released')
  })
})
