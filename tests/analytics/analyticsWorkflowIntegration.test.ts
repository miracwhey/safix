import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import { getPaymentRepository } from '../../src/lib/payments/repository/registry'
import { getAnalyticsRepository } from '../../src/lib/analytics/repository/registry'
import type { Job } from '../../src/lib/jobs'
import type { Payment } from '../../src/lib/payments/types'
import {
  submitProposalWorkflow,
  acceptProposalWorkflow,
  startJobWorkflow,
  markWorkCompleteWorkflow,
} from '../../src/lib/workflow/jobWorkflow'
import { submitRatingWorkflow } from '../../src/lib/workflow/ratingWorkflow'
import { recordAnalyticsEventOnce } from '../../src/lib/analytics'
import { installSessionForJobOwner } from '../helpers/mockSession'

function seedJob(id: string, overrides: Partial<Job> = {}): Job {
  const job: Job = {
    id,
    projectId: `project-${id}`,
    title: `Test Job ${id}`,
    customer: 'Test Customer',
    location: 'Test Location',
    dateLabel: 'Today',
    status: overrides.status ?? 'new',
    amount: '1.000 €',
    description: 'Test job description',
    paymentState: 'deposit_required',
    documentationStatus: '0 Fotos',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    customerUserId: overrides.customerUserId ?? 'customer-1',
    craftsmanUserId: overrides.craftsmanUserId ?? 'craftsman-1',
    ...overrides,
  }
  getJobRepository().add(job)
  return job
}

function seedPayment(jobId: string, state: Payment['state']): Payment {
  const payment: Payment = {
    id: `pay-${jobId}`,
    jobId,
    state,
    amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  getPaymentRepository().add(payment)
  return payment
}

describe('analytics workflow integration', () => {
  beforeEach(() => setupCleanRepositories())

  it('records job_created event via ensureOperationalArtifacts', async () => {
    // ensureOperationalArtifacts is called internally; let's use acceptProposalWorkflow
    // which calls it. First, set up a job with proposalSentAt.
    seedJob('job-a1', { proposalSentAt: Date.now() })

    await acceptProposalWorkflow('job-a1')

    const events = getAnalyticsRepository().getByEventType('job_created')
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0].entityId).toBe('job-a1')
  })

  it('records proposal_sent event on submitProposalWorkflow', async () => {
    seedJob('job-a2')

    await submitProposalWorkflow('job-a2')

    const events = getAnalyticsRepository().getByEventType('proposal_sent')
    expect(events).toHaveLength(1)
    expect(events[0].entityId).toBe('job-a2')
  })

  it('records proposal_accepted event on acceptProposalWorkflow', async () => {
    seedJob('job-a3', { proposalSentAt: Date.now() })

    await acceptProposalWorkflow('job-a3')

    const events = getAnalyticsRepository().getByEventType('proposal_accepted')
    expect(events).toHaveLength(1)
    expect(events[0].entityId).toBe('job-a3')
    expect(events[0].actorUserId).toBe('customer-1')
  })

  it('records job_started event on startJobWorkflow', async () => {
    seedJob('job-a4', { status: 'new' })
    seedPayment('job-a4', 'in_escrow')

    // startJobWorkflow is RBAC-guarded — install the matching owner session.
    // seedJob defaults to craftsmanUserId: 'craftsman-1'.
    installSessionForJobOwner({ craftsmanUserId: 'craftsman-1' })
    await startJobWorkflow('job-a4')

    const events = getAnalyticsRepository().getByEventType('job_started')
    expect(events).toHaveLength(1)
    expect(events[0].entityId).toBe('job-a4')
  })

  it('records job_completed event on markWorkCompleteWorkflow', async () => {
    const job = seedJob('job-a5', { status: 'in_progress' })

    installSessionForJobOwner(job)
    await markWorkCompleteWorkflow('job-a5')

    const events = getAnalyticsRepository().getByEventType('job_completed')
    expect(events).toHaveLength(1)
    expect(events[0].entityId).toBe('job-a5')
  })

  it('records rating_submitted event on submitRatingWorkflow', async () => {
    seedJob('job-a6', { status: 'completed' })

    await submitRatingWorkflow({
      jobId: 'job-a6',
      providerUserId: 'craftsman-1',
      customerUserId: 'customer-1',
      ratingScore: 5,
    })

    const events = getAnalyticsRepository().getByEventType('rating_submitted')
    expect(events).toHaveLength(1)
    expect(events[0].actorUserId).toBe('customer-1')
    expect(events[0].metadata?.ratingScore).toBe(5)
  })

  it('does not record analytics for idempotent workflow calls', async () => {
    seedJob('job-a7')

    await submitProposalWorkflow('job-a7')
    await submitProposalWorkflow('job-a7') // second call should be idempotent

    const events = getAnalyticsRepository().getByEventType('proposal_sent')
    expect(events).toHaveLength(1)
  })

  it('recordAnalyticsEventOnce prevents duplicates for same entity and event type', () => {
    recordAnalyticsEventOnce({
      eventType: 'onboarding_completed',
      entityType: 'provider',
      entityId: 'provider-dedup-1',
    })
    recordAnalyticsEventOnce({
      eventType: 'onboarding_completed',
      entityType: 'provider',
      entityId: 'provider-dedup-1',
    })

    const events = getAnalyticsRepository().getByEventType('onboarding_completed')
    expect(events).toHaveLength(1)
  })

  it('recordAnalyticsEventOnce allows same event type for different entities', () => {
    recordAnalyticsEventOnce({
      eventType: 'payout_ready',
      entityType: 'provider',
      entityId: 'acct_1',
    })
    recordAnalyticsEventOnce({
      eventType: 'payout_ready',
      entityType: 'provider',
      entityId: 'acct_2',
    })

    const events = getAnalyticsRepository().getByEventType('payout_ready')
    expect(events).toHaveLength(2)
  })

  it('recordAnalyticsEventOnce allows different event types for same entity', () => {
    recordAnalyticsEventOnce({
      eventType: 'onboarding_completed',
      entityType: 'provider',
      entityId: 'provider-multi-1',
    })
    recordAnalyticsEventOnce({
      eventType: 'provider_discovery_ready',
      entityType: 'provider',
      entityId: 'provider-multi-1',
    })

    expect(getAnalyticsRepository().getByEventType('onboarding_completed')).toHaveLength(1)
    expect(getAnalyticsRepository().getByEventType('provider_discovery_ready')).toHaveLength(1)
  })
})
