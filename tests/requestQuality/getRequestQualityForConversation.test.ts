import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getRequestQualityForConversation,
} from '../../src/lib/messages'
import { addJob } from '../../src/lib/jobs'
import type { Conversation } from '../../src/lib/messages/types'
import type { Job } from '../../src/lib/jobs'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-rq-${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    projectId: overrides.projectId ?? `project-${id}`,
    customerName: 'RQ Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-rq-1',
    craftsmanName: 'RQ Handwerker',
    craftsmanHandle: 'rq-handler',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-rq-1',
    projectTitle: 'RQ-Projekt',
    projectSubtitle: 'Anfrage',
    inquiryOrigin: 'category',
    createdAt: Date.now(),
    ...overrides,
  }
}

function makeCompletedJob(customerUserId: string, status: Job['status'] = 'completed'): Job {
  return {
    id: `job-${Math.random().toString(36).slice(2, 8)}`,
    projectId: `project-job-${Math.random().toString(36).slice(2, 6)}`,
    title: 'Vorheriger Auftrag',
    customer: 'RQ Kundin',
    location: 'Berlin',
    dateLabel: 'Letzte Woche',
    status,
    amount: '1.000 €',
    description: '',
    paymentState: 'released',
    documentationStatus: 'none',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: 'craftsman-rq-1',
    customerUserId,
  }
}

describe('getRequestQualityForConversation — single source of truth', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('raises the score when the customer has a completed prior job (returning)', async () => {
    const conv = seedConversation({ customerUserId: 'cust-returning' })
    await addConversation(conv)

    const asNewCustomer = getRequestQualityForConversation(conv).score
    await addJob(makeCompletedJob('cust-returning', 'completed'))
    const asReturning = getRequestQualityForConversation(conv).score

    expect(asReturning).toBeGreaterThan(asNewCustomer)
  })

  it('does not treat a non-completed job as a returning customer', async () => {
    const conv = seedConversation({ customerUserId: 'cust-inprogress' })
    await addConversation(conv)

    const before = getRequestQualityForConversation(conv).score
    await addJob(makeCompletedJob('cust-inprogress', 'in_progress'))
    const after = getRequestQualityForConversation(conv).score

    expect(after).toBe(before)
  })

  it('does not credit a completed job belonging to a different customer', async () => {
    const conv = seedConversation({ customerUserId: 'cust-self' })
    await addConversation(conv)

    const before = getRequestQualityForConversation(conv).score
    await addJob(makeCompletedJob('someone-else', 'completed'))
    const after = getRequestQualityForConversation(conv).score

    expect(after).toBe(before)
  })

  it('scores the canonical conversation for the pair, so inbox and detail lookups agree', async () => {
    // Two rows for the same customer↔craftsman pair (the scenario dedup exists
    // for): a sparse older row and a rich newer row. Both lookups must resolve
    // to the canonical (newer) row and therefore return the same score.
    const older = seedConversation({
      id: 'conv-old',
      createdAt: 1_000,
    })
    const newer = seedConversation({
      id: 'conv-new',
      createdAt: 2_000,
      projectLocation: 'Linden',
      projectCostRange: '2.000–3.500 €',
      projectDuration: 'diesen Monat',
      projectDescription: 'Bad komplett neu fliesen, Boden und Wände, Untergrund ist vorbereitet.',
    })
    await addConversation(older)
    await addConversation(newer)

    const fromOlder = getRequestQualityForConversation(older).score
    const fromNewer = getRequestQualityForConversation(newer).score

    // The rich newer row is canonical → both calls score it identically.
    expect(fromOlder).toBe(fromNewer)
    expect(fromNewer).toBeGreaterThan(0)
  })
})
