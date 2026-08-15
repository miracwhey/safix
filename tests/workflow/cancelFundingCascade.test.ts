/**
 * Cancel → FundingRequest cascade tests
 *
 * Closes the funding-after-cancel money hole at the TypeScript/workflow layer.
 *
 * A job can be cancelled while a FundingRequest is still OPEN (cancel is only
 * blocked once funds are CONFIRMED; pre-funding states are not blocked). If the
 * funding path is not closed on cancel, a customer can still fund a cancelled
 * job → real money parked in escrow on a dead order.
 *
 * The cascade (cancelWorkflow.cancelLinkedFundingRequestIfSafe) cancels the
 * linked FundingRequest, but ONLY when it is in a SAFE pre-PaymentIntent state.
 * It MUST leave 'funding_initiated' (live Stripe PaymentIntent) untouched —
 * that narrow window is closed by the deferred confirm_funding_atomic RPC
 * job-status check, not here.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { addProject, type Project } from '../../src/lib/projects'
import { addJob, getJobById, type Job } from '../../src/lib/jobs'
import {
  cancelAcceptedProjectWorkflow,
  closeCaseWorkflow,
} from '../../src/lib/workflow'
import { setFundingRequestRepository } from '../../src/lib/payments/fundingRequest/fundingRequestRegistry'
import { InMemoryFundingRequestRepository } from '../../src/lib/payments/fundingRequest/InMemoryFundingRequestRepository'
import {
  getFundingRequestByJobId,
  type FundingRequest,
  type FundingRequestStatus,
} from '../../src/lib/payments/fundingRequest'

// ── Helpers ──────────────────────────────────────────────────────────────────

function seedJob(overrides: Partial<Job> = {}): Job {
  return {
    id: overrides.id ?? `job-${Date.now()}`,
    projectId: overrides.projectId ?? 'project-x',
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
    proposalAcceptedAt: Date.now() - 5000,
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? `proj-${Date.now()}`,
    title: 'Test Projekt',
    category: 'Sanitär',
    description: 'Testbeschreibung',
    location: 'Berlin',
    status: 'accepted',
    source: 'inquiry',
    createdAt: Date.now(),
    customerUserId: 'customer-123',
    ...overrides,
  }
}

function seedFundingRequest(jobId: string, status: FundingRequestStatus): FundingRequest {
  return {
    id: `fr-${jobId}`,
    sourceOfferId: `offer-${jobId}`,
    jobId,
    escrowPlanId: `plan-${jobId}`,
    customerUserId: 'customer-123',
    providerId: 'provider-456',
    providerUserId: 'craftsman-456',
    type: 'full_escrow',
    status,
    amount: 1500,
    currency: 'EUR',
    createdBy: 'provider',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Cancel → FundingRequest cascade', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('(a) cancelling an accepted project cancels an OPEN pre-initiated FundingRequest', async () => {
    const jobId = 'job-cascade-open'
    await addJob(seedJob({ id: jobId }))
    await addProject(seedProject({ id: 'proj-cascade-open', sourceJobId: jobId }))
    setFundingRequestRepository(
      new InMemoryFundingRequestRepository([seedFundingRequest(jobId, 'sent')]),
    )

    const result = await cancelAcceptedProjectWorkflow('proj-cascade-open')
    expect(result).toBeDefined()
    expect(result!.status).toBe('cancelled')

    // Job cancelled …
    expect(getJobById(jobId)!.status).toBe('cancelled')
    // … and the funding path is closed so the dead order can no longer be funded.
    expect(getFundingRequestByJobId(jobId)!.status).toBe('cancelled')
  })

  it('(a²) the same cascade fires for funding_started and funding_failed', async () => {
    for (const openStatus of ['created', 'funding_started', 'funding_failed'] as const) {
      setupCleanRepositories()
      const jobId = `job-cascade-${openStatus}`
      await addJob(seedJob({ id: jobId }))
      await addProject(seedProject({ id: `proj-${openStatus}`, sourceJobId: jobId }))
      setFundingRequestRepository(
        new InMemoryFundingRequestRepository([seedFundingRequest(jobId, openStatus)]),
      )

      await cancelAcceptedProjectWorkflow(`proj-${openStatus}`)

      expect(getFundingRequestByJobId(jobId)!.status).toBe('cancelled')
    }
  })

  it('(b) a funding_initiated FundingRequest is left UNTOUCHED by the cascade', async () => {
    const jobId = 'job-cascade-initiated'
    await addJob(seedJob({ id: jobId }))
    await addProject(seedProject({ id: 'proj-cascade-initiated', sourceJobId: jobId }))
    setFundingRequestRepository(
      new InMemoryFundingRequestRepository([
        seedFundingRequest(jobId, 'funding_initiated'),
      ]),
    )

    const result = await cancelAcceptedProjectWorkflow('proj-cascade-initiated')
    expect(result).toBeDefined()
    expect(result!.status).toBe('cancelled')

    // Job is cancelled, but the live-PI funding request is NOT cancelled here —
    // that window is owned by the deferred confirm_funding_atomic RPC fix.
    expect(getJobById(jobId)!.status).toBe('cancelled')
    expect(getFundingRequestByJobId(jobId)!.status).toBe('funding_initiated')
  })

  it('(c) the cascade is a no-op when no FundingRequest exists', async () => {
    const jobId = 'job-cascade-none'
    await addJob(seedJob({ id: jobId }))
    await addProject(seedProject({ id: 'proj-cascade-none', sourceJobId: jobId }))
    // No funding request seeded — empty repo from setupCleanRepositories.

    const result = await cancelAcceptedProjectWorkflow('proj-cascade-none')
    expect(result).toBeDefined()
    expect(result!.status).toBe('cancelled')

    expect(getJobById(jobId)!.status).toBe('cancelled')
    expect(getFundingRequestByJobId(jobId)).toBeUndefined()
  })

  it('closeCaseWorkflow also cancels an OPEN FundingRequest and skips funding_initiated', async () => {
    // Open request → cancelled
    const openJobId = 'job-close-open'
    await addJob(seedJob({ id: openJobId }))
    await addProject(seedProject({ id: 'proj-close-open', sourceJobId: openJobId }))
    setFundingRequestRepository(
      new InMemoryFundingRequestRepository([seedFundingRequest(openJobId, 'sent')]),
    )

    const closed = await closeCaseWorkflow('proj-close-open', 'craftsman-456')
    expect(closed).toBe(true)
    expect(getFundingRequestByJobId(openJobId)!.status).toBe('cancelled')
  })

  it('closeCaseWorkflow leaves a funding_initiated FundingRequest untouched', async () => {
    const initiatedJobId = 'job-close-initiated'
    await addJob(seedJob({ id: initiatedJobId }))
    await addProject(seedProject({ id: 'proj-close-initiated', sourceJobId: initiatedJobId }))
    setFundingRequestRepository(
      new InMemoryFundingRequestRepository([
        seedFundingRequest(initiatedJobId, 'funding_initiated'),
      ]),
    )

    const closed = await closeCaseWorkflow('proj-close-initiated', 'craftsman-456')
    expect(closed).toBe(true)
    expect(getFundingRequestByJobId(initiatedJobId)!.status).toBe('funding_initiated')
  })
})
