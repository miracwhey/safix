import { beforeEach, describe, expect, it } from 'vitest'

import { setupCleanRepositories } from '../helpers/setupRepositories'
import { deriveAttentionItems } from '../../src/lib/notifications/attentionSelectors'
import { addJob } from '../../src/lib/jobs'
import { addProject } from '../../src/lib/projects'
import type { Job } from '../../src/lib/jobs/types'

function buildDepositJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-attn-1',
    projectId: 'synthetic-project-ref',
    title: 'Test Job',
    customer: 'Customer',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'new',
    amount: '€1.000',
    description: 'Deposit required job',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  }
}

describe('Attention selectors – canonical payment destination', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('links deposit attention to the real project tied to the job', async () => {
    const job = buildDepositJob({ id: 'job-attn-link' })
    await addJob(job)

    const project = {
      id: 'real-project-attn',
      sourceJobId: job.id,
      title: 'Projekt für Zahlung',
      customer: job.customer,
      craftsman: 'Handwerker',
      location: job.location,
      dateLabel: job.dateLabel,
      price: job.amount,
      status: 'accepted' as const,
      paymentState: 'deposit_required' as const,
      messageCount: 0,
      noteCount: 0,
      photoCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      customerUserId: 'customer-1',
      craftsmanUserId: 'craft-1',
    }
    await addProject(project)

    const items = deriveAttentionItems([job], [], 123456)
    const depositItem = items.find((item) => item.id === `attn-deposit-${job.id}`)

    expect(depositItem).toBeDefined()
    expect(depositItem?.linkTo).toBe(`/projects/${project.id}?focus=payment`)
  })

  it('suppresses deposit attention when no real project exists', async () => {
    const job = buildDepositJob({ id: 'job-attn-missing-project' })
    await addJob(job)

    const items = deriveAttentionItems([job], [], 123456)
    const depositItem = items.find((item) => item.id === `attn-deposit-${job.id}`)

    expect(depositItem).toBeUndefined()
  })
})
