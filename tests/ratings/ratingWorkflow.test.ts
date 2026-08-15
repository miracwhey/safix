import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { submitRatingWorkflow } from '../../src/lib/workflow/ratingWorkflow'
import { getRatingByJobId, getRatingsByProviderUserId } from '../../src/lib/ratings/service'
import { getRatingRepository } from '../../src/lib/ratings/repository/registry'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import type { Job } from '../../src/lib/jobs/types'

function seedJob(id: string, overrides: Partial<Job> = {}): Job {
  const job: Job = {
    id,
    projectId: `project-${id}`,
    title: `Test Job ${id}`,
    customer: 'Test Customer',
    location: 'Test Location',
    dateLabel: 'Today',
    status: 'completed',
    amount: '500 €',
    description: 'Test job',
    paymentState: 'released',
    documentationStatus: '0 Fotos',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    customerUserId: 'customer-1',
    craftsmanUserId: 'provider-1',
    ...overrides,
  }
  getJobRepository().add(job)
  return job
}

describe('submitRatingWorkflow', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('creates a rating for a completed job', async () => {
    seedJob('job-r1')

    const rating = await submitRatingWorkflow({
      jobId: 'job-r1',
      providerUserId: 'provider-1',
      customerUserId: 'customer-1',
      ratingScore: 5,
      ratingComment: 'Excellent work!',
    })

    expect(rating).toBeDefined()
    expect(rating!.jobId).toBe('job-r1')
    expect(rating!.ratingScore).toBe(5)
    expect(rating!.ratingComment).toBe('Excellent work!')
    expect(rating!.providerUserId).toBe('provider-1')
    expect(rating!.customerUserId).toBe('customer-1')
  })

  it('persists the rating in the repository', async () => {
    seedJob('job-r2')

    await submitRatingWorkflow({
      jobId: 'job-r2',
      providerUserId: 'provider-1',
      customerUserId: 'customer-1',
      ratingScore: 4,
    })

    const saved = getRatingByJobId('job-r2')
    expect(saved).toBeDefined()
    expect(saved!.ratingScore).toBe(4)
  })

  it('returns undefined and does not persist when job does not exist', async () => {
    const result = await submitRatingWorkflow({
      jobId: 'nonexistent-job',
      providerUserId: 'provider-1',
      customerUserId: 'customer-1',
      ratingScore: 3,
    })

    expect(result).toBeUndefined()
    expect(getRatingByJobId('nonexistent-job')).toBeUndefined()
  })

  it('returns undefined when job is not completed', async () => {
    seedJob('job-r3', { status: 'in_progress' })

    const result = await submitRatingWorkflow({
      jobId: 'job-r3',
      providerUserId: 'provider-1',
      customerUserId: 'customer-1',
      ratingScore: 4,
    })

    expect(result).toBeUndefined()
    expect(getRatingByJobId('job-r3')).toBeUndefined()
  })

  it('returns undefined when caller is not the customer', async () => {
    seedJob('job-r4')

    const result = await submitRatingWorkflow({
      jobId: 'job-r4',
      providerUserId: 'provider-1',
      customerUserId: 'different-customer',
      ratingScore: 4,
    })

    expect(result).toBeUndefined()
    expect(getRatingByJobId('job-r4')).toBeUndefined()
  })

  it('prevents duplicate ratings for the same job', async () => {
    seedJob('job-r5')

    const first = await submitRatingWorkflow({
      jobId: 'job-r5',
      providerUserId: 'provider-1',
      customerUserId: 'customer-1',
      ratingScore: 5,
    })
    expect(first).toBeDefined()

    const second = await submitRatingWorkflow({
      jobId: 'job-r5',
      providerUserId: 'provider-1',
      customerUserId: 'customer-1',
      ratingScore: 1,
    })
    expect(second).toBeUndefined()

    // Only one rating should be stored
    expect(getRatingsByProviderUserId('provider-1')).toHaveLength(1)
    expect(getRatingByJobId('job-r5')!.ratingScore).toBe(5)
  })

  it('creates a rating without a comment', async () => {
    seedJob('job-r6')

    const rating = await submitRatingWorkflow({
      jobId: 'job-r6',
      providerUserId: 'provider-1',
      customerUserId: 'customer-1',
      ratingScore: 3,
    })

    expect(rating).toBeDefined()
    expect(rating!.ratingComment).toBeUndefined()
  })

  it('accumulates multiple ratings for the same provider from different jobs', async () => {
    seedJob('job-r7a')
    seedJob('job-r7b', { customerUserId: 'customer-2' })

    await submitRatingWorkflow({
      jobId: 'job-r7a',
      providerUserId: 'provider-1',
      customerUserId: 'customer-1',
      ratingScore: 5,
    })
    await submitRatingWorkflow({
      jobId: 'job-r7b',
      providerUserId: 'provider-1',
      customerUserId: 'customer-2',
      ratingScore: 3,
    })

    const all = getRatingsByProviderUserId('provider-1')
    expect(all).toHaveLength(2)

    // All ratings are in the repo
    expect(getRatingRepository().getAll()).toHaveLength(2)
  })
})
