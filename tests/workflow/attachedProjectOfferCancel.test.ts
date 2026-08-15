/**
 * Attached Project + Offer Card + Cancel Flow Tests
 *
 * Validates the three product-critical requirements:
 *
 * 1. Attached project stage logic: real project survives reload but is NOT
 *    counted as active by default. Operational state starts only at the
 *    correct transition point (offer acceptance → sourceJobId + status >= accepted).
 *
 * 2. Offer card delivery: craftsman send creates a real offer artifact linked
 *    to the thread. Customer thread renders the offer card after reload.
 *    Project and offer cards coexist. Accepted offer becomes payment/deposit actionable.
 *
 * 3. Cancel/close flow: customer can withdraw before acceptance, craftsman can
 *    reject/close inquiry, cancelled cases disappear from active surfaces.
 *
 * Also verifies no regression to fake-project-shell removal.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getThreadArtifacts,
  persistProjectArtifact,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import {
  addProject,
  getProjectById,
  isProjectOperational,
  isProjectActive,
  isProjectCancelled,
  type Project,
} from '../../src/lib/projects'
import { getOffersByConversationId } from '../../src/lib/offers/service'
import { addJob, getJobById, type Job } from '../../src/lib/jobs'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
  cancelProjectWorkflow,
  cancelAcceptedProjectWorkflow,
  closeCaseWorkflow,
} from '../../src/lib/workflow'
import { setPaymentRepository } from '../../src/lib/payments'
import { InMemoryPaymentRepository } from '../../src/lib/payments/repository/InMemoryPaymentRepository'
import type { Payment, PaymentState } from '../../src/lib/payments'
import { setFundingRequestRepository } from '../../src/lib/payments/fundingRequest/fundingRequestRegistry'
import { InMemoryFundingRequestRepository } from '../../src/lib/payments/fundingRequest/InMemoryFundingRequestRepository'
import type { FundingRequest } from '../../src/lib/payments/fundingRequest'
import { setEscrowPlanRepository } from '../../src/lib/payments/escrow/escrowRegistry'
import { InMemoryEscrowPlanRepository } from '../../src/lib/payments/escrow/InMemoryEscrowPlanRepository'
import type { EscrowPaymentPlan } from '../../src/lib/payments/escrow/escrowTypes'

// ── Test Helpers ────────────────────────────────────────────────────────────

const REAL_PROJECT_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-123',
    craftsmanName: 'Peter Handwerker',
    craftsmanHandle: 'peter-h',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-456',
    projectTitle: 'Küche renovieren',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Berlin',
    projectCostRange: '€3,000–5,000',
    projectDuration: '1 Woche',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Vor 5 Minuten',
    inquiryOrigin: 'reel',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? `proj-${Date.now()}`,
    title: overrides.title ?? 'Test Projekt',
    category: 'Sanitär',
    description: 'Testbeschreibung',
    location: 'Berlin',
    status: 'request',
    source: 'builder',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedJob(overrides: Partial<Job> = {}): Job {
  return {
    id: overrides.id ?? `job-${Date.now()}`,
    projectId: overrides.projectId ?? REAL_PROJECT_UUID,
    title: 'Test Job',
    customer: 'Anna Kundin',
    location: 'Berlin',
    dateLabel: 'Termin offen',
    status: 'new',
    amount: '1500',
    description: 'Test Beschreibung',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: 'craftsman-456',
    customerUserId: 'customer-123',
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. ATTACHED PROJECT STAGE LOGIC
// ═══════════════════════════════════════════════════════════════════════════

describe('Attached Project Stage Logic', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('real attached customer project survives reload and is counted as active (not yet operational)', async () => {
    // Create a builder project — not yet linked to any job
    const project = seedProject({
      id: REAL_PROJECT_UUID,
      title: 'Dachsanierung',
      status: 'request',
      source: 'builder',
      // No sourceJobId — not yet linked to a job
    })
    await addProject(project)

    // Attach to conversation
    await addConversation(seedConversation({
      id: 'conv-attached-1',
      sourceProjectId: REAL_PROJECT_UUID,
    }))
    await persistProjectArtifact({ conversationId: 'conv-attached-1', projectId: REAL_PROJECT_UUID, customerUserId: 'customer-123', craftsmanUserId: 'craftsman-456' })

    // Project artifact should be visible (survives reload)
    const artifacts = getThreadArtifacts('conv-attached-1')
    expect(artifacts.projectArtifact).not.toBeNull()
    expect(artifacts.projectArtifact!.project.id).toBe(REAL_PROJECT_UUID)
    expect(artifacts.projectArtifact!.project.title).toBe('Dachsanierung')

    // Project IS active (not completed/cancelled) but NOT yet operational (no sourceJobId)
    const retrieved = getProjectById(REAL_PROJECT_UUID)
    expect(retrieved).toBeDefined()
    expect(isProjectOperational(retrieved!)).toBe(false)
    expect(isProjectActive(retrieved!)).toBe(true)
  })

  it('active/running state starts only at the correct transition point (offer acceptance)', async () => {
    // Phase 1: Create project in request state with a job (pre-acceptance)
    const project = seedProject({
      id: REAL_PROJECT_UUID,
      status: 'request',
      sourceJobId: 'job-1',
      source: 'inquiry',
    })
    await addProject(project)

    // With sourceJobId but 'request' status — NOT operational yet
    const phase1 = getProjectById(REAL_PROJECT_UUID)!
    expect(isProjectOperational(phase1)).toBe(false)
    expect(isProjectActive(phase1)).toBe(true) // active but not operational

    // Phase 2: Simulate offer acceptance — status becomes 'accepted'
    const { updateProject } = await import('../../src/lib/projects')
    updateProject(REAL_PROJECT_UUID, { status: 'accepted' })

    // Now it IS operational
    const phase2 = getProjectById(REAL_PROJECT_UUID)!
    expect(phase2.status).toBe('accepted')
    expect(isProjectOperational(phase2)).toBe(true)
    expect(isProjectActive(phase2)).toBe(true)
  })

  it('builder project without sourceJobId is active but not operational', async () => {
    const project = seedProject({
      id: 'builder-proj-1',
      status: 'request',
      source: 'builder',
      // No sourceJobId
    })
    await addProject(project)

    const retrieved = getProjectById('builder-proj-1')!
    expect(isProjectOperational(retrieved)).toBe(false)
    expect(isProjectActive(retrieved)).toBe(true)
  })

  it('completed project is not operational and not active', async () => {
    const project = seedProject({
      id: 'completed-proj',
      status: 'completed',
      sourceJobId: 'job-done',
    })
    await addProject(project)

    const retrieved = getProjectById('completed-proj')!
    expect(isProjectOperational(retrieved)).toBe(false)
    expect(isProjectActive(retrieved)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. OFFER CARD DELIVERY
// ═══════════════════════════════════════════════════════════════════════════

describe('Offer Card Delivery', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('craftsman send creates a real offer artifact linked to the thread', async () => {
    const threadId = 'conv-offer-delivery'

    await addConversation(seedConversation({
      id: threadId,
      inquiryOrigin: 'profile',
    }))

    // Craftsman sends offer
    const offer = await createOfferWorkflow({
      conversationId: threadId,
      craftsmanUserId: 'craftsman-456',
      customerUserId: 'customer-123',
      price: '2500 €',
      description: 'Badezimmer komplett renovieren',
    })

    // Verify offer was persisted
    expect(offer).toBeDefined()
    expect(offer.id).toBeTruthy()
    expect(offer.conversationId).toBe(threadId)
    expect(offer.status).toBe('pending')

    // Verify offer is retrievable by conversation
    const offers = getOffersByConversationId(threadId)
    expect(offers).toHaveLength(1)
    expect(offers[0].price).toBe('2500 €')
  })

  it('customer thread renders the offer card after reload', async () => {
    const threadId = 'conv-offer-render'

    await addConversation(seedConversation({
      id: threadId,
      inquiryOrigin: 'reel',
    }))

    await createOfferWorkflow({
      conversationId: threadId,
      craftsmanUserId: 'craftsman-456',
      customerUserId: 'customer-123',
      price: '3000 €',
    })

    // Derive artifacts — simulates what happens after customer page reload
    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.offerPaymentArtifact).not.toBeNull()
    expect(artifacts.offerPaymentArtifact!.kind).toBe('offer_payment')
    expect(artifacts.offerPaymentArtifact!.offer.price).toBe('3000 €')
    expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
  })

  it('project card and offer card coexist in the same thread', async () => {
    const projectId = REAL_PROJECT_UUID
    const threadId = 'conv-coexist-test'

    await addProject(seedProject({ id: projectId, title: 'Fenstereinbau' }))
    await addConversation(seedConversation({
      id: threadId,
      sourceProjectId: projectId,
      inquiryOrigin: 'reel',
    }))
    await persistProjectArtifact({ conversationId: threadId, projectId, customerUserId: 'customer-123', craftsmanUserId: 'craftsman-456' })

    // Create offer in same thread
    await createOfferWorkflow({
      conversationId: threadId,
      craftsmanUserId: 'craftsman-456',
      customerUserId: 'customer-123',
      price: '4000 €',
      description: 'Alle Fenster austauschen',
    })

    // Both artifacts must coexist — one does NOT suppress the other
    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifact).not.toBeNull()
    expect(artifacts.projectArtifact!.project.id).toBe(projectId)
    expect(artifacts.projectArtifact!.kind).toBe('project')

    expect(artifacts.offerPaymentArtifact).not.toBeNull()
    expect(artifacts.offerPaymentArtifact!.offer.price).toBe('4000 €')
    expect(artifacts.offerPaymentArtifact!.kind).toBe('offer_payment')
  })

  it('accepted offer becomes payment/deposit actionable', async () => {
    const threadId = 'conv-accept-payment'

    await addConversation(seedConversation({
      id: threadId,
      inquiryOrigin: 'profile',
    }))

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      craftsmanUserId: 'craftsman-456',
      customerUserId: 'customer-123',
      price: '5000 €',
      description: 'Komplette Sanierung',
    })

    // Accept the offer
    const accepted = await acceptOfferWorkflow(offer.id)
    expect(accepted).toBeDefined()
    expect(accepted!.status).toBe('accepted')
    expect(accepted!.createdJobId).toBeTruthy()

    // Verify artifacts reflect payment-actionable state
    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.offerPaymentArtifact).not.toBeNull()

    // Phase should be 'payment_due' or 'accepted' depending on job state
    const phase = artifacts.offerPaymentArtifact!.phase
    expect(['accepted', 'payment_due']).toContain(phase)

    // Job should exist with deposit_required payment state
    const jobId = artifacts.offerPaymentArtifact!.jobId
    expect(jobId).toBeTruthy()
    const job = getJobById(jobId!)
    expect(job).toBeDefined()
    expect(job!.paymentState).toBe('deposit_required')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. CANCEL / CLOSE / DELETE FLOW
// ═══════════════════════════════════════════════════════════════════════════

describe('Cancel / Close / Delete Flow', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('customer can withdraw/delete inquiry/project before acceptance', async () => {
    const project = seedProject({
      id: 'proj-withdraw-1',
      status: 'request',
      source: 'builder',
      customerUserId: 'customer-123',
    })
    await addProject(project)

    // Cancel the project
    const result = await cancelProjectWorkflow('proj-withdraw-1')
    expect(result).toBeDefined()
    expect(result!.status).toBe('cancelled')

    // Verify it's cancelled
    const retrieved = getProjectById('proj-withdraw-1')
    expect(retrieved).toBeDefined()
    expect(retrieved!.status).toBe('cancelled')
    expect(isProjectCancelled(retrieved!)).toBe(true)
    expect(isProjectActive(retrieved!)).toBe(false)
    expect(isProjectOperational(retrieved!)).toBe(false)
  })

  it('customer can withdraw project with linked pre-acceptance job', async () => {
    const jobId = 'job-pre-accept'
    const job = seedJob({
      id: jobId,
      status: 'new',
      projectId: 'proj-with-job',
    })
    await addJob(job)

    const project = seedProject({
      id: 'proj-with-job',
      status: 'request',
      sourceJobId: jobId,
      customerUserId: 'customer-123',
    })
    await addProject(project)

    // Cancel the project
    const result = await cancelProjectWorkflow('proj-with-job')
    expect(result).toBeDefined()
    expect(result!.status).toBe('cancelled')

    // Job should be removed (pre-acceptance)
    const jobAfter = getJobById(jobId)
    expect(jobAfter).toBeUndefined()
  })

  it('craftsman can reject/close inquiry via closeCaseWorkflow', async () => {
    const project = seedProject({
      id: 'proj-close-1',
      status: 'request',
      source: 'inquiry',
      craftsmanUserId: 'craftsman-456',
    })
    await addProject(project)

    // Craftsman closes the case
    const result = await closeCaseWorkflow('proj-close-1', 'craftsman-456')
    expect(result).toBe(true)

    // Verify cancelled
    const retrieved = getProjectById('proj-close-1')
    expect(retrieved).toBeDefined()
    expect(retrieved!.status).toBe('cancelled')
    expect(isProjectActive(retrieved!)).toBe(false)
  })

  it('cancel after acceptance sets project to cancelled and job to cancelled (not completed)', async () => {
    const jobId = 'job-post-accept'
    const job = seedJob({
      id: jobId,
      status: 'new',
      proposalSentAt: Date.now() - 10000,
      proposalAcceptedAt: Date.now() - 5000,
    })
    await addJob(job)

    const project = seedProject({
      id: 'proj-accepted-cancel',
      status: 'accepted',
      sourceJobId: jobId,
    })
    await addProject(project)

    // Cancel the accepted project
    const result = await cancelAcceptedProjectWorkflow('proj-accepted-cancel')
    expect(result).toBeDefined()
    expect(result!.status).toBe('cancelled')

    // Job should be set to cancelled (NOT completed — cancelled ≠ successfully finished)
    const jobAfter = getJobById(jobId)
    expect(jobAfter).toBeDefined()
    expect(jobAfter!.status).toBe('cancelled')
  })

  it('cancelled/closed cases disappear from active surfaces', async () => {
    // Create multiple projects with different statuses
    await addProject(seedProject({
      id: 'proj-active',
      status: 'accepted',
      sourceJobId: 'job-active',
    }))
    await addProject(seedProject({
      id: 'proj-cancelled',
      status: 'cancelled',
      sourceJobId: 'job-cancelled',
    }))
    await addProject(seedProject({
      id: 'proj-request',
      status: 'request',
      sourceJobId: 'job-request',
    }))
    await addProject(seedProject({
      id: 'proj-completed',
      status: 'completed',
      sourceJobId: 'job-completed',
    }))

    const active = getProjectById('proj-active')!
    const cancelled = getProjectById('proj-cancelled')!
    const request = getProjectById('proj-request')!
    const completed = getProjectById('proj-completed')!

    // Active (operational) — only accepted with sourceJobId
    expect(isProjectOperational(active)).toBe(true)
    expect(isProjectOperational(cancelled)).toBe(false)
    expect(isProjectOperational(request)).toBe(false)
    expect(isProjectOperational(completed)).toBe(false)

    // Active (visible on active surfaces) — not cancelled, not completed, has job
    expect(isProjectActive(active)).toBe(true)
    expect(isProjectActive(cancelled)).toBe(false)
    expect(isProjectActive(request)).toBe(true)  // active but not operational
    expect(isProjectActive(completed)).toBe(false)
  })

  it('cancel is idempotent — re-cancelling returns same result', async () => {
    await addProject(seedProject({
      id: 'proj-idem',
      status: 'request',
    }))

    const first = await cancelProjectWorkflow('proj-idem')
    expect(first).toBeDefined()
    expect(first!.status).toBe('cancelled')

    const second = await cancelProjectWorkflow('proj-idem')
    expect(second).toBeDefined()
    expect(second!.status).toBe('cancelled')
  })

  it('cannot cancel project that is already past request stage via cancelProjectWorkflow', async () => {
    await addProject(seedProject({
      id: 'proj-in-progress',
      status: 'in_progress',
      sourceJobId: 'job-running',
    }))

    // cancelProjectWorkflow should reject — use cancelAcceptedProjectWorkflow instead
    const result = await cancelProjectWorkflow('proj-in-progress')
    expect(result).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. NO REGRESSION: FAKE PROJECT SHELL REMOVAL
// ═══════════════════════════════════════════════════════════════════════════

describe('No regression to fake-project-shell removal', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('synthetic project ID does NOT produce a project artifact', async () => {
    await addConversation(seedConversation({
      id: 'conv-no-fake-regression',
      projectId: 'project_profile_craft_conv-no-fake',
      inquiryOrigin: 'profile',
    }))

    const artifacts = getThreadArtifacts('conv-no-fake-regression')
    expect(artifacts.projectArtifact).toBeNull()
  })

  it('profile inquiry without real project does not create fake active project', async () => {
    await addConversation(seedConversation({
      id: 'conv-profile-no-fake',
      projectId: 'project_profile_craft-1_conv-x',
      inquiryOrigin: 'profile',
    }))

    // No project should be in the store
    const { getProjects } = await import('../../src/lib/projects')
    const projects = getProjects()
    const fakes = projects.filter(p => p.id.startsWith('project_profile_'))
    expect(fakes).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. CANCEL/TERMINAL SEMANTICS — cancelled ≠ completed
// ═══════════════════════════════════════════════════════════════════════════

describe('Cancel/terminal semantics — cancelled is not completed', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('cancelled accepted case is NOT mislabeled as completed in job outcome', async () => {
    const jobId = 'job-cancel-vs-complete'
    const job = seedJob({
      id: jobId,
      status: 'new',
      proposalSentAt: Date.now() - 10000,
      proposalAcceptedAt: Date.now() - 5000,
    })
    await addJob(job)

    const project = seedProject({
      id: 'proj-cancel-vs-complete',
      status: 'accepted',
      sourceJobId: jobId,
    })
    await addProject(project)

    // Cancel the project
    await cancelAcceptedProjectWorkflow('proj-cancel-vs-complete')

    // Import outcome selector
    const { deriveJobOutcome } = await import('../../src/lib/jobs/jobOutcomeSelectors')

    const cancelledJob = getJobById(jobId)!
    expect(cancelledJob.status).toBe('cancelled')

    const outcome = deriveJobOutcome(cancelledJob)
    expect(outcome.outcomeType).toBe('cancelled')
    expect(outcome.isTerminal).toBe(true)
    // Crucially, it should NOT say "Abgeschlossen" (completed)
    expect(outcome.outcomeBadgeLabel).toBe('STORNIERT')
    expect(outcome.outcomeHeadline).toContain('storniert')
  })

  it('completed job with released payment is correctly labeled as released (not cancelled)', async () => {
    const { deriveJobOutcome } = await import('../../src/lib/jobs/jobOutcomeSelectors')

    const completedJob = seedJob({
      id: 'job-completed-released',
      status: 'completed',
      paymentState: 'released',
    })
    await addJob(completedJob)

    const job = getJobById('job-completed-released')!
    const outcome = deriveJobOutcome(job)
    expect(outcome.outcomeType).toBe('released')
    expect(outcome.isTerminal).toBe(true)
    expect(outcome.outcomeBadgeLabel).toBe('ABGESCHLOSSEN')
  })

  it('cancelled job is excluded from active job lists', async () => {
    const { isActiveJob, isCompletedJob } = await import('../../src/lib/jobs/service')

    const cancelledJob = seedJob({
      id: 'job-cancelled-active-check',
      status: 'cancelled',
    })
    await addJob(cancelledJob)

    const job = getJobById('job-cancelled-active-check')!
    expect(isActiveJob(job)).toBe(false)
    // isCompletedJob now returns true for both completed AND cancelled (terminal)
    expect(isCompletedJob(job)).toBe(true)
  })

  it('deriveProjectStatusFromJob maps cancelled job to cancelled project', async () => {
    const { deriveProjectStatusFromJob } = await import('../../src/lib/projects/projectStatusSync')

    const result = deriveProjectStatusFromJob({
      status: 'cancelled',
      proposalSentAt: Date.now() - 10000,
      proposalAcceptedAt: Date.now() - 5000,
    })
    expect(result).toBe('cancelled')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. CANCEL/CLOSE BLOCKED BY ACTIVE PAYMENT STATE
// ═══════════════════════════════════════════════════════════════════════════

function seedPayment(jobId: string, state: PaymentState): Payment {
  return {
    id: `payment-${jobId}`,
    jobId,
    state,
    amounts: { totalAmount: 1500, depositAmount: 375, finalAmount: 1125 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function seedFundingRequest(jobId: string): FundingRequest {
  return {
    id: `fr-${jobId}`,
    sourceOfferId: `offer-${jobId}`,
    jobId,
    escrowPlanId: `plan-${jobId}`,
    customerUserId: 'customer-123',
    providerId: 'provider-456',
    providerUserId: 'craftsman-456',
    type: 'full_escrow',
    status: 'funded',
    amount: 1500,
    currency: 'EUR',
    createdBy: 'provider',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function seedEscrowPlan(jobId: string): EscrowPaymentPlan {
  return {
    id: `plan-${jobId}`,
    sourceOfferId: `offer-${jobId}`,
    jobId,
    customerUserId: 'customer-123',
    providerId: 'provider-456',
    currency: 'EUR',
    totalAmount: 1500,
    fundingMode: 'full_upfront_escrow',
    releaseModel: 'start_25_completion_75',
    status: 'funded_in_escrow',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('Cancel/Close blocked by active payment state', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('cancelAcceptedProjectWorkflow returns undefined when payment state is in_escrow', async () => {
    const jobId = 'job-escrow-block'
    await addJob(seedJob({ id: jobId, status: 'new', proposalAcceptedAt: Date.now() - 5000 }))
    await addProject(seedProject({ id: 'proj-escrow-block', status: 'accepted', sourceJobId: jobId }))
    setPaymentRepository(new InMemoryPaymentRepository([seedPayment(jobId, 'in_escrow')]))

    const result = await cancelAcceptedProjectWorkflow('proj-escrow-block')
    expect(result).toBeUndefined()

    const project = getProjectById('proj-escrow-block')!
    expect(project.status).toBe('accepted')
  })

  it('cancelAcceptedProjectWorkflow returns undefined when payment state is disputed', async () => {
    const jobId = 'job-disputed-block'
    await addJob(seedJob({ id: jobId, status: 'new', proposalAcceptedAt: Date.now() - 5000 }))
    await addProject(seedProject({ id: 'proj-disputed-block', status: 'accepted', sourceJobId: jobId }))
    setPaymentRepository(new InMemoryPaymentRepository([seedPayment(jobId, 'disputed')]))

    const result = await cancelAcceptedProjectWorkflow('proj-disputed-block')
    expect(result).toBeUndefined()

    const project = getProjectById('proj-disputed-block')!
    expect(project.status).toBe('accepted')
  })

  it('cancelAcceptedProjectWorkflow succeeds when payment state is deposit_required', async () => {
    const jobId = 'job-deposit-required-ok'
    await addJob(seedJob({ id: jobId, status: 'new', proposalAcceptedAt: Date.now() - 5000 }))
    await addProject(seedProject({ id: 'proj-deposit-required-ok', status: 'accepted', sourceJobId: jobId }))
    setPaymentRepository(new InMemoryPaymentRepository([seedPayment(jobId, 'deposit_required')]))

    const result = await cancelAcceptedProjectWorkflow('proj-deposit-required-ok')
    expect(result).toBeDefined()
    expect(result!.status).toBe('cancelled')

    const job = getJobById(jobId)!
    expect(job.status).toBe('cancelled')
  })

  it('closeCaseWorkflow returns false when linked job payment state is work_in_progress', async () => {
    const jobId = 'job-wip-block'
    await addJob(seedJob({ id: jobId, status: 'new' }))
    await addProject(seedProject({ id: 'proj-wip-block', status: 'accepted', sourceJobId: jobId }))
    setPaymentRepository(new InMemoryPaymentRepository([seedPayment(jobId, 'work_in_progress')]))

    const result = await closeCaseWorkflow('proj-wip-block', 'craftsman-456')
    expect(result).toBe(false)

    const project = getProjectById('proj-wip-block')!
    expect(project.status).toBe('accepted')
  })

  it('closeCaseWorkflow returns false when linked job payment state is release_pending', async () => {
    const jobId = 'job-release-pending-block'
    await addJob(seedJob({ id: jobId, status: 'new' }))
    await addProject(seedProject({ id: 'proj-release-pending-block', status: 'accepted', sourceJobId: jobId }))
    setPaymentRepository(new InMemoryPaymentRepository([seedPayment(jobId, 'release_pending')]))

    const result = await closeCaseWorkflow('proj-release-pending-block', 'craftsman-456')
    expect(result).toBe(false)

    const project = getProjectById('proj-release-pending-block')!
    expect(project.status).toBe('accepted')
  })

  it('closeCaseWorkflow succeeds when job has no active payment', async () => {
    const jobId = 'job-no-payment-ok'
    await addJob(seedJob({ id: jobId, status: 'new' }))
    await addProject(seedProject({ id: 'proj-no-payment-ok', status: 'request', sourceJobId: jobId }))
    // No payment seeded — empty repo from setupCleanRepositories

    const result = await closeCaseWorkflow('proj-no-payment-ok', 'craftsman-456')
    expect(result).toBe(true)

    const project = getProjectById('proj-no-payment-ok')!
    expect(project.status).toBe('cancelled')
  })

  // ── Stale payment row + canonical funding truth ────────────────────────────

  it('cancelAcceptedProjectWorkflow blocked when FundingRequest is funded but payment.state is deposit_required', async () => {
    const jobId = 'job-stale-pay-fr-funded'
    await addJob(seedJob({ id: jobId, status: 'new', proposalAcceptedAt: Date.now() - 5000 }))
    await addProject(seedProject({ id: 'proj-stale-pay-fr-funded', status: 'accepted', sourceJobId: jobId }))
    // Payment row is stale — still at deposit_required
    setPaymentRepository(new InMemoryPaymentRepository([seedPayment(jobId, 'deposit_required')]))
    // But FundingRequest confirms funding already secured
    setFundingRequestRepository(new InMemoryFundingRequestRepository([seedFundingRequest(jobId)]))

    const result = await cancelAcceptedProjectWorkflow('proj-stale-pay-fr-funded')
    expect(result).toBeUndefined()

    // Project must not have been cancelled
    expect(getProjectById('proj-stale-pay-fr-funded')!.status).toBe('accepted')
  })

  it('cancelAcceptedProjectWorkflow blocked when EscrowPlan is funded_in_escrow but payment.state is deposit_required', async () => {
    const jobId = 'job-stale-pay-escrow-funded'
    await addJob(seedJob({ id: jobId, status: 'new', proposalAcceptedAt: Date.now() - 5000 }))
    await addProject(seedProject({ id: 'proj-stale-pay-escrow', status: 'accepted', sourceJobId: jobId }))
    // Payment row is stale — still at deposit_required
    setPaymentRepository(new InMemoryPaymentRepository([seedPayment(jobId, 'deposit_required')]))
    // But EscrowPlan confirms funding already in escrow
    setEscrowPlanRepository(new InMemoryEscrowPlanRepository([seedEscrowPlan(jobId)]))

    const result = await cancelAcceptedProjectWorkflow('proj-stale-pay-escrow')
    expect(result).toBeUndefined()

    expect(getProjectById('proj-stale-pay-escrow')!.status).toBe('accepted')
  })

  it('closeCaseWorkflow blocked when linked job FundingRequest is funded but payment.state is deposit_required', async () => {
    const jobId = 'job-close-stale-fr-funded'
    await addJob(seedJob({ id: jobId, status: 'new' }))
    await addProject(seedProject({ id: 'proj-close-stale-fr', status: 'accepted', sourceJobId: jobId }))
    // Stale payment row
    setPaymentRepository(new InMemoryPaymentRepository([seedPayment(jobId, 'deposit_required')]))
    // Canonical funding truth: already funded
    setFundingRequestRepository(new InMemoryFundingRequestRepository([seedFundingRequest(jobId)]))

    const result = await closeCaseWorkflow('proj-close-stale-fr', 'craftsman-456')
    expect(result).toBe(false)

    expect(getProjectById('proj-close-stale-fr')!.status).toBe('accepted')
  })
})
