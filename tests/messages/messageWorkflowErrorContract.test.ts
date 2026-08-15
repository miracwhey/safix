/**
 * Error-contract proof for sendJobConversationMessage / appendJobMessageViaWorkflow.
 *
 * Invariants:
 * 1. Successful send: message appears in thread
 * 2. Missing job: resolves silently (logWarning, no throw)
 * 3. Missing conversation: resolves silently (logWarning, no throw)
 * 4. Repository failure: error propagates — not swallowed
 * 5. appendJobMessageViaWorkflow: propagates error from underlying send
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { setMessageRepository } from '../../src/lib/messages/repository/registry'
import { InMemoryMessageRepository } from '../../src/lib/messages/repository/InMemoryMessageRepository'
import { addConversation } from '../../src/lib/messages'
import { addJob } from '../../src/lib/jobs'
import {
  sendJobConversationMessage,
  appendJobMessageViaWorkflow,
  getConversationMessagesForJob,
} from '../../src/lib/workflow/messageWorkflow'
import type { Conversation, Message } from '../../src/lib/messages/types'
import type { Job } from '../../src/lib/jobs/types'

class ThrowingMessageRepository extends InMemoryMessageRepository {
  constructor(private readonly errorMessage: string) {
    super([], [])
  }

  override async addMessageAndUpdateConversation(
    _message: Message,
    _conversationId: string,
    _patch: Partial<Omit<Conversation, 'id'>>
  ): Promise<void> {
    throw new Error(this.errorMessage)
  }
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-test',
    projectId: 'proj-test',
    customerName: 'Anna K.',
    customerAvatarUrl: '',
    craftsmanName: 'Peter H.',
    craftsmanHandle: 'peter-h',
    craftsmanAvatarUrl: '',
    projectTitle: 'Test Projekt',
    projectSubtitle: 'Anfrage',
    ...overrides,
  }
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-test',
    projectId: 'proj-test',
    sourceConversationId: 'conv-test',
    title: 'Test Job',
    customer: 'Anna K.',
    location: 'Berlin',
    dateLabel: 'Termin offen',
    status: 'new',
    amount: '1000',
    description: '',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  }
}

describe('sendJobConversationMessage — error contract', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('sends message and resolves — message appears in thread', async () => {
    await addConversation(makeConversation())
    await addJob(makeJob())

    const before = getConversationMessagesForJob('job-test').length
    await sendJobConversationMessage({ jobId: 'job-test', sender: 'business', text: 'Auftrag geprüft.' })
    const after = getConversationMessagesForJob('job-test').length
    expect(after).toBe(before + 1)
  })

  it('resolves silently when job not found — no throw', async () => {
    await expect(
      sendJobConversationMessage({ jobId: 'nonexistent-job', sender: 'business', text: 'test' })
    ).resolves.toBeUndefined()
  })

  it('resolves silently when conversation not found for job — no throw', async () => {
    await addJob(makeJob({ id: 'job-noconv', sourceConversationId: undefined, projectId: 'proj-noconv' }))
    await expect(
      sendJobConversationMessage({ jobId: 'job-noconv', sender: 'business', text: 'test' })
    ).resolves.toBeUndefined()
  })

  it('rejects with repository error — error is not swallowed', async () => {
    setMessageRepository(new ThrowingMessageRepository('Datenbankfehler'))
    await addConversation(makeConversation())
    await addJob(makeJob())

    await expect(
      sendJobConversationMessage({ jobId: 'job-test', sender: 'business', text: 'test' })
    ).rejects.toThrow('Datenbankfehler')
  })

  it('appendJobMessageViaWorkflow propagates repository error', async () => {
    setMessageRepository(new ThrowingMessageRepository('Verbindung unterbrochen'))
    await addConversation(makeConversation())
    await addJob(makeJob())

    await expect(
      appendJobMessageViaWorkflow({ jobId: 'job-test', sender: 'business', text: 'test' })
    ).rejects.toThrow('Verbindung unterbrochen')
  })
})
