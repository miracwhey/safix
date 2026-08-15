/**
 * Canonical Customer Lifecycle Projection Consistency Tests
 *
 * Validates that ALL customer-facing surfaces project the same canonical
 * lifecycle state for the same accepted/booked/funded context.
 *
 * Covers:
 * 1. Accepted/booked context never projects as inquiry/request
 * 2. Customer lifecycle/progress reflects the strongest canonical state
 * 3. Customer next-step reflects the correct stage
 * 4. Funded context never emits payment-required next-step
 * 5. Customer project list chip agrees with canonical lifecycle truth
 * 6. Customer home/status summary agrees with canonical lifecycle truth
 * 7. Weaker request-state fields do not override stronger accepted/funding truth
 * 8. No regression to working payment route and funding screen
 * 9. English "Fund Escrow" no longer appears from the early-exit deposit_required path
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import {
  deriveProjectStatusFromJob,
  syncProjectFromJob,
} from '../../src/lib/projects/projectStatusSync'
import { deriveCanonicalProjection } from '../../src/lib/shared/canonicalCustomerLifecycle'
import { deriveCustomerJobStage } from '../../src/lib/jobs/customerJobStageSelectors'
import { deriveCustomerNextStep } from '../../src/lib/jobs/customerNextStepSelectors'
import { deriveCustomerNextAction } from '../../src/lib/jobs/customerNextActionSelectors'
import { addJob } from '../../src/lib/jobs'
import { addProject } from '../../src/lib/projects'
import { isFundingConfirmedForJob } from '../../src/lib/payments/fundingRequest/fundingDominance'
import { getFundingRequestRepository } from '../../src/lib/payments/fundingRequest/fundingRequestRegistry'
import { getEscrowPlanRepository } from '../../src/lib/payments/escrow/escrowRegistry'
import type { FundingRequest } from '../../src/lib/payments/fundingRequest/types'

import type { Job } from '../../src/lib/jobs/types'
import type { Project } from '../../src/lib/projects/projectTypes'

// ── Helpers ───────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000
const HOUR = 3_600_000

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

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    sourceJobId: 'job-1',
    title: 'Badezimmer Renovierung',
    customer: 'Max Mustermann',
    craftsman: 'Müller Bau GmbH',
    location: 'Berlin',
    dateLabel: 'Morgen',
    price: '5.000 €',
    status: 'request',
    paymentState: 'none',
    messageCount: 3,
    noteCount: 0,
    photoCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
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

// ── Setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  setupCleanRepositories()
})

// ── 1. Accepted context must not project as inquiry/request ──────────────

describe('1. Accepted context never projects as inquiry/request', () => {
  it('deriveCanonicalProjection returns accepted when job is accepted but project.status is stale request', () => {
    const job = makeJob({
      status: 'new',
      proposalSentAt: NOW - 48 * HOUR,
      proposalAcceptedAt: NOW - 24 * HOUR,
    })
    addJob(job)

    // Project store is stale — still says 'request'
    const project = makeProject({ status: 'request', paymentState: 'none' })
    addProject(project)

    const canonical = deriveCanonicalProjection(project)
    expect(canonical.status).toBe('accepted')
    expect(canonical.status).not.toBe('request')
  })

  it('deriveCanonicalProjection returns in_progress when job is in_progress but project.status is stale request', () => {
    const job = makeJob({
      status: 'in_progress',
      proposalSentAt: NOW - 72 * HOUR,
      proposalAcceptedAt: NOW - 48 * HOUR,
      paymentState: 'in_escrow',
    })
    addJob(job)

    const project = makeProject({ status: 'request', paymentState: 'none' })
    addProject(project)

    const canonical = deriveCanonicalProjection(project)
    expect(canonical.status).toBe('in_progress')
    expect(canonical.paymentState).toBe('in_escrow')
  })

  it('deriveCanonicalProjection returns scheduled when job is scheduled but project.status is stale request', () => {
    const job = makeJob({ status: 'scheduled' })
    addJob(job)

    const project = makeProject({ status: 'request' })
    addProject(project)

    const canonical = deriveCanonicalProjection(project)
    expect(canonical.status).toBe('scheduled')
  })

  it('booked job dominates stale request project status', () => {
    const job = makeJob({ status: 'booked' })
    addJob(job)

    const project = makeProject({ status: 'request' })
    addProject(project)

    const canonical = deriveCanonicalProjection(project)
    expect(canonical.status).toBe('accepted')
  })
})

// ── 2. Customer lifecycle/progress reflects the strongest canonical state ─

describe('2. Lifecycle stage reflects strongest canonical state', () => {
  it('accepted job with deposit_required shows offer_accepted stage', () => {
    const stage = deriveCustomerJobStage(
      'new', 'deposit_required',
      NOW - 48 * HOUR, NOW - 24 * HOUR,
      undefined, undefined
    )
    expect(stage.stage).toBe('offer_accepted')
  })

  it('accepted job with funding request shows funding_pending stage', () => {
    const stage = deriveCustomerJobStage(
      'new', 'deposit_required',
      NOW - 48 * HOUR, NOW - 24 * HOUR,
      'sent', undefined
    )
    expect(stage.stage).toBe('funding_pending')
  })

  it('funded job shows funded_in_escrow stage', () => {
    const stage = deriveCustomerJobStage(
      'new', 'deposit_paid',
      NOW - 48 * HOUR, NOW - 24 * HOUR,
      'funded', undefined
    )
    expect(stage.stage).toBe('funded_in_escrow')
  })

  it('in_progress job shows work_in_progress stage', () => {
    const stage = deriveCustomerJobStage(
      'in_progress', 'in_escrow',
      NOW - 96 * HOUR, NOW - 72 * HOUR,
      'funded', undefined
    )
    expect(stage.stage).toBe('work_in_progress')
  })

  it('stage activeIndex increases monotonically through lifecycle', () => {
    const inquiry = deriveCustomerJobStage('new', 'none')
    const accepted = deriveCustomerJobStage(
      'new', 'deposit_required', NOW - 48 * HOUR, NOW - 24 * HOUR
    )
    const funding = deriveCustomerJobStage(
      'new', 'deposit_required', NOW - 48 * HOUR, NOW - 24 * HOUR, 'sent'
    )
    const funded = deriveCustomerJobStage(
      'new', 'deposit_paid', NOW - 48 * HOUR, NOW - 24 * HOUR, 'funded'
    )
    const wip = deriveCustomerJobStage(
      'in_progress', 'in_escrow', NOW - 96 * HOUR, NOW - 72 * HOUR, 'funded'
    )

    expect(inquiry.activeIndex).toBeLessThan(accepted.activeIndex)
    expect(accepted.activeIndex).toBeLessThan(funding.activeIndex)
    expect(funding.activeIndex).toBeLessThan(funded.activeIndex)
    expect(funded.activeIndex).toBeLessThan(wip.activeIndex)
  })
})

// ── 3. Customer next-step reflects the correct stage ─────────────────────

describe('3. Customer next-step reflects the correct stage', () => {
  it('accepted job with deposit_required shows escrow funding CTA (not generic inquiry)', () => {
    const job = makeJob({
      status: 'new',
      paymentState: 'deposit_required',
      proposalSentAt: NOW - 48 * HOUR,
      proposalAcceptedAt: NOW - 24 * HOUR,
    })
    const step = deriveCustomerNextStep(job)
    expect(step.label).toBe('Zahlung einzahlen')
    expect(step.actionLabel).toBe('Jetzt einzahlen')
    expect(step.actionRoute).toBeDefined()
  })

  it('funding_pending stage shows Fund Escrow CTA', () => {
    const job = makeJob({
      status: 'new',
      paymentState: 'deposit_required',
      proposalSentAt: NOW - 48 * HOUR,
      proposalAcceptedAt: NOW - 24 * HOUR,
    })
    const step = deriveCustomerNextStep(job, undefined, 'sent')
    expect(step.label).toBe('Zahlung einzahlen')
    expect(step.actionLabel).toBe('Jetzt einzahlen')
  })

  it('funded job shows Escrow Funded (no action CTA)', () => {
    const job = makeJob({
      status: 'new',
      paymentState: 'deposit_paid',
      proposalSentAt: NOW - 48 * HOUR,
      proposalAcceptedAt: NOW - 24 * HOUR,
    })
    const step = deriveCustomerNextStep(job, undefined, 'funded')
    expect(step.label).toBe('Zahlung abgesichert')
    expect(step.actionLabel).toBeUndefined()
  })

  it('in_progress job shows Work In Progress (not stale payment CTA)', () => {
    const job = makeJob({
      status: 'in_progress',
      paymentState: 'in_escrow',
      proposalSentAt: NOW - 96 * HOUR,
      proposalAcceptedAt: NOW - 72 * HOUR,
    })
    const step = deriveCustomerNextStep(job, undefined, 'funded')
    expect(step.label).toBe('Arbeit läuft')
    expect(step.actionLabel).toBeUndefined()
  })

  it('inquiry stage does NOT show deposit CTA even if paymentState is deposit_required', () => {
    // No proposal sent — still an inquiry
    const job = makeJob({
      status: 'new',
      paymentState: 'deposit_required',
    })
    const step = deriveCustomerNextStep(job)
    // Should show inquiry stage, not funding CTA
    expect(step.label).toBe('Antwort ausstehend')
    expect(step.actionLabel).toBeUndefined()
  })

  it('offer_received stage does NOT show deposit CTA even if paymentState is deposit_required', () => {
    const job = makeJob({
      status: 'new',
      paymentState: 'deposit_required',
      proposalSentAt: NOW - 24 * HOUR,
      // Not accepted yet
    })
    const step = deriveCustomerNextStep(job)
    expect(step.label).toBe('Angebot liegt vor')
    expect(step.actionLabel).toBe('Angebot ansehen')
  })
})

// ── 4. Funded context never emits payment-required next-step ─────────────

describe('4. Funded context never emits payment-required next-step', () => {
  it('customerNextAction suppresses deposit_required CTA when fundingStatus is funded', () => {
    const action = deriveCustomerNextAction(
      'new', 'deposit_required', undefined,
      NOW - 48 * HOUR, NOW - 24 * HOUR,
      'funded'
    )
    // Should NOT show 'Zahlung leisten' — funded truth dominates
    expect(action.label).not.toBe('Zahlung leisten')
  })

  it('customerNextStep deposit_paid path returns funded state', () => {
    const job = makeJob({
      status: 'new',
      paymentState: 'deposit_paid',
      proposalSentAt: NOW - 48 * HOUR,
      proposalAcceptedAt: NOW - 24 * HOUR,
    })
    const step = deriveCustomerNextStep(job)
    expect(step.label).toBe('Zahlung abgesichert')
    expect(step.actionLabel).toBeUndefined()
  })

  it('isFundingConfirmedForJob returns true when FundingRequest status is funded', () => {
    const jobId = 'test-funded-job'
    seedFundedFundingRequest(jobId)
    expect(isFundingConfirmedForJob(jobId)).toBe(true)
  })

  it('isFundingConfirmedForJob returns true when EscrowPlan status is funded_in_escrow', () => {
    const jobId = 'test-escrow-funded-job'
    seedFundedEscrowPlan(jobId)
    expect(isFundingConfirmedForJob(jobId)).toBe(true)
  })
})

// ── 5. Customer project list chip agrees with canonical lifecycle truth ──

describe('5. Customer project list chip agrees with canonical lifecycle', () => {
  it('stale project.status=request derives as accepted when job is accepted', () => {
    const job = makeJob({
      status: 'new',
      proposalSentAt: NOW - 48 * HOUR,
      proposalAcceptedAt: NOW - 24 * HOUR,
      paymentState: 'deposit_required',
    })
    addJob(job)

    const project = makeProject({
      status: 'request',
      paymentState: 'none',
    })
    addProject(project)

    const canonical = deriveCanonicalProjection(project)
    expect(canonical.status).toBe('accepted')
    expect(canonical.paymentState).toBe('deposit_required')
  })

  it('stale project.paymentState=none derives as deposit_required from job', () => {
    const job = makeJob({
      status: 'new',
      paymentState: 'deposit_required',
      proposalSentAt: NOW - 48 * HOUR,
      proposalAcceptedAt: NOW - 24 * HOUR,
    })
    addJob(job)

    const project = makeProject({ paymentState: 'none' })
    addProject(project)

    const canonical = deriveCanonicalProjection(project)
    expect(canonical.paymentState).toBe('deposit_required')
  })

  it('funded job sets fundingConfirmed on canonical projection', () => {
    const job = makeJob({
      id: 'funded-chip-job',
      status: 'new',
      paymentState: 'deposit_paid',
      proposalSentAt: NOW - 48 * HOUR,
      proposalAcceptedAt: NOW - 24 * HOUR,
    })
    addJob(job)

    seedFundedFundingRequest('funded-chip-job', 'fr-chip-1')

    const project = makeProject({
      sourceJobId: 'funded-chip-job',
      status: 'request',
      paymentState: 'deposit_required',
    })
    addProject(project)

    const canonical = deriveCanonicalProjection(project)
    expect(canonical.fundingConfirmed).toBe(true)
    expect(canonical.status).toBe('accepted')
  })
})

// ── 6. Customer home/status summary agrees with canonical lifecycle truth ─

describe('6. Home/summary surfaces agree with canonical lifecycle', () => {
  it('deriveCustomerNextAction for accepted job shows Angebot angenommen', () => {
    const action = deriveCustomerNextAction(
      'new', undefined, undefined,
      NOW - 48 * HOUR, NOW - 24 * HOUR
    )
    expect(action.label).toBe('Angebot angenommen')
    expect(action.domain).toBe('job')
  })

  it('mapProjectStatusToJobStatus equivalent: accepted maps to new (distinguished by proposal timestamps)', () => {
    // Simulating what CustomerHomeScreen does
    const action = deriveCustomerNextAction(
      'new', // accepted maps to 'new' in mapProjectStatusToJobStatus
      'deposit_required',
      undefined,
      NOW - 48 * HOUR,
      NOW - 24 * HOUR,
      undefined
    )
    // With proposal accepted, should show payment CTA not inquiry
    expect(action.label).toBe('Zahlung leisten')
    expect(action.domain).toBe('payment')
  })

  it('deriveCustomerNextAction for in_progress job shows Auftrag läuft', () => {
    const action = deriveCustomerNextAction(
      'in_progress', undefined, undefined,
      NOW - 96 * HOUR, NOW - 72 * HOUR
    )
    expect(action.label).toBe('Auftrag läuft')
    expect(action.domain).toBe('job')
  })

  it('deriveCustomerNextAction for release_pending shows escrow-aware confirm CTA', () => {
    const action = deriveCustomerNextAction(
      'waiting_payment', 'release_pending', undefined,
      NOW - 120 * HOUR, NOW - 96 * HOUR
    )
    expect(action.label).toBe('Bestätigen & freigeben')
    expect(action.priority).toBe('urgent')
    expect(action.domain).toBe('payment')
  })
})

// ── 7. Weaker request-state fields do not override stronger truth ────────

describe('7. No request-state shadowing', () => {
  it('project.status=request does not override job.accepted in canonical projection', () => {
    const job = makeJob({
      status: 'new',
      proposalSentAt: NOW - 48 * HOUR,
      proposalAcceptedAt: NOW - 24 * HOUR,
    })
    addJob(job)

    const project = makeProject({ status: 'request' })
    addProject(project)

    const canonical = deriveCanonicalProjection(project)
    expect(canonical.status).toBe('accepted')
  })

  it('project.paymentState=none does not override job.paymentState=deposit_required', () => {
    const job = makeJob({ paymentState: 'deposit_required' })
    addJob(job)

    const project = makeProject({ paymentState: 'none' })
    addProject(project)

    const canonical = deriveCanonicalProjection(project)
    expect(canonical.paymentState).toBe('deposit_required')
  })

  it('project.paymentState=deposit_required does not override funded truth', () => {
    const job = makeJob({
      id: 'funded-shadow-job',
      paymentState: 'deposit_paid',
      proposalSentAt: NOW - 48 * HOUR,
      proposalAcceptedAt: NOW - 24 * HOUR,
    })
    addJob(job)

    seedFundedFundingRequest('funded-shadow-job', 'fr-shadow-1')

    const project = makeProject({
      sourceJobId: 'funded-shadow-job',
      status: 'request',
      paymentState: 'deposit_required',
    })
    addProject(project)

    const canonical = deriveCanonicalProjection(project)
    expect(canonical.fundingConfirmed).toBe(true)
    expect(canonical.paymentState).toBe('deposit_paid')
    expect(canonical.status).toBe('accepted')
  })

  it('deriveProjectStatusFromJob never returns request for accepted job', () => {
    const job = makeJob({
      status: 'new',
      proposalSentAt: NOW - 48 * HOUR,
      proposalAcceptedAt: NOW - 24 * HOUR,
    })
    expect(deriveProjectStatusFromJob(job)).toBe('accepted')
  })

  it('syncProjectFromJob updates both status and paymentState', () => {
    const job = makeJob({
      status: 'in_progress',
      paymentState: 'in_escrow',
      proposalSentAt: NOW - 72 * HOUR,
      proposalAcceptedAt: NOW - 48 * HOUR,
    })
    const sync = syncProjectFromJob(job)
    expect(sync.status).toBe('in_progress')
    expect(sync.paymentState).toBe('in_escrow')
  })
})

// ── 8. No regression to funding screen ───────────────────────────────────

describe('8. No regression to funding flow', () => {
  it('deriveCustomerNextStep funding_pending stage provides actionRoute', () => {
    const job = makeJob({
      status: 'new',
      paymentState: 'deposit_required',
      proposalSentAt: NOW - 48 * HOUR,
      proposalAcceptedAt: NOW - 24 * HOUR,
    })
    const step = deriveCustomerNextStep(job, undefined, 'sent')
    expect(step.actionRoute).toBeDefined()
    expect(step.actionLabel).toBeDefined()
  })

  it('deriveCustomerNextStep offer_accepted + deposit_required provides actionRoute', () => {
    const job = makeJob({
      status: 'new',
      paymentState: 'deposit_required',
      proposalSentAt: NOW - 48 * HOUR,
      proposalAcceptedAt: NOW - 24 * HOUR,
    })
    const step = deriveCustomerNextStep(job)
    expect(step.actionRoute).toBeDefined()
    expect(step.actionLabel).toBe('Jetzt einzahlen')
  })

  it('deriveCustomerNextStep work_completed stage provides release action', () => {
    const job = makeJob({
      status: 'waiting_payment',
      paymentState: 'release_pending',
      proposalSentAt: NOW - 120 * HOUR,
      proposalAcceptedAt: NOW - 96 * HOUR,
    })
    const step = deriveCustomerNextStep(job, undefined, 'funded')
    expect(step.label).toBe('Bestätigen & freigeben')
    expect(step.actionLabel).toBe('Bestätigen & freigeben')
  })
})

// ── 9. Early-exit deposit_required path fixed (was wrong-branch projection) ─

describe('9. Early-exit deposit_required path fixed', () => {
  it('offer_accepted + deposit_required returns German label (was English "Fund Escrow" from wrong-branch projection)', () => {
    const job = makeJob({
      status: 'new',
      paymentState: 'deposit_required',
      proposalSentAt: NOW - 48 * HOUR,
      proposalAcceptedAt: NOW - 24 * HOUR,
    })
    const step = deriveCustomerNextStep(job)
    expect(step.label).not.toBe('Fund Escrow')
    expect(step.label).toBe('Zahlung einzahlen')
    expect(step.actionLabel).toBe('Jetzt einzahlen')
  })

  it('inquiry_sent + deposit_required does NOT show any deposit CTA', () => {
    const job = makeJob({
      status: 'new',
      paymentState: 'deposit_required',
      // No proposal sent or accepted
    })
    const step = deriveCustomerNextStep(job)
    expect(step.label).not.toContain('Fund')
    expect(step.label).not.toContain('Zahlung')
    expect(step.label).toBe('Antwort ausstehend')
  })

  it('work_in_progress + stale deposit_required does NOT show deposit CTA', () => {
    const job = makeJob({
      status: 'in_progress',
      paymentState: 'deposit_required',
      proposalSentAt: NOW - 96 * HOUR,
      proposalAcceptedAt: NOW - 72 * HOUR,
    })
    const step = deriveCustomerNextStep(job)
    expect(step.label).toBe('Arbeit läuft')
    expect(step.label).not.toContain('Fund')
    expect(step.label).not.toContain('Zahlung')
  })

  it('completed + stale deposit_required does NOT show deposit CTA', () => {
    const job = makeJob({
      status: 'completed',
      paymentState: 'deposit_required',
      proposalSentAt: NOW - 200 * HOUR,
      proposalAcceptedAt: NOW - 180 * HOUR,
    })
    const step = deriveCustomerNextStep(job)
    // Block 2.1: completed with non-terminal payment no longer prematurely
    // projects as payment_released ("Project Complete"). Instead it shows
    // work_completed (escrow-aware confirm CTA) — crucially NOT a deposit CTA.
    expect(step.label).toBe('Bestätigen & freigeben')
    expect(step.label).not.toContain('Fund')
    expect(step.label).not.toContain('einzahlen')
  })

  it('funding_pending stage still returns "Fund Escrow" from its correct switch case (not a projection bug — copy-polish only)', () => {
    const job = makeJob({
      status: 'new',
      paymentState: 'deposit_required',
      proposalSentAt: NOW - 48 * HOUR,
      proposalAcceptedAt: NOW - 24 * HOUR,
    })
    // With explicit fundingStatus='sent', stage becomes funding_pending
    const step = deriveCustomerNextStep(job, undefined, 'sent')
    expect(step.label).toBe('Zahlung einzahlen')
    expect(step.actionLabel).toBe('Jetzt einzahlen')
  })
})

// ── 10. Canonical projection fallback for projects without sourceJobId ───

describe('10. Fallback for builder/no-job projects', () => {
  it('project without sourceJobId uses project.status directly', () => {
    const project = makeProject({
      sourceJobId: '',
      status: 'request',
      paymentState: 'none',
    })
    addProject(project)

    const canonical = deriveCanonicalProjection(project)
    expect(canonical.status).toBe('request')
    expect(canonical.paymentState).toBe('none')
    expect(canonical.fundingConfirmed).toBe(false)
  })

  it('project whose linked job does not exist falls back to project.status', () => {
    // Job not added to store
    const project = makeProject({
      sourceJobId: 'nonexistent-job',
      status: 'request',
    })
    addProject(project)

    const canonical = deriveCanonicalProjection(project)
    expect(canonical.status).toBe('request')
  })
})
