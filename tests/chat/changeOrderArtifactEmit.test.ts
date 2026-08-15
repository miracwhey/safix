/**
 * R5 — ChangeOrder (Nachtrag) thread-artifact: emit on create.
 *
 * Since Block 1 removed the persistent top-cards (ThreadArtifactCards), a
 * ChangeOrder needs a real artifact_card chat message to appear in the stream
 * (the Project/Invoice producer model). createChangeOrderWorkflow now does the
 * two coordinated writes — persistChangeOrderArtifact (ta_co_<id> snapshot) +
 * sendMessageWorkflow(artifactType='ChangeOrder') — resolved from
 * job.sourceConversationId (the chat_threads id), mirroring the invoice emit.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { createChangeOrderWorkflow } from '../../src/lib/workflow/changeOrderWorkflow'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import { getThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'
import { InMemoryChatRepository } from '../../src/lib/chat/repository/InMemoryChatRepository'
import { setChatRepository } from '../../src/lib/chat/repository/registry'
import type { ChatThreadViewModel } from '../../src/lib/chat/types'
import type { Job } from '../../src/lib/jobs'

const THREAD_ID = 'thread-co-1'
const CUSTOMER_UID = 'cust-co-1'
const CRAFTSMAN_UID = 'craft-co-1'

function makeJob(jobId: string, opts: { sourceConversationId?: string } = {}): Job {
  return {
    id: jobId,
    title: 'Sanitärarbeiten',
    customer: 'Max Mustermann',
    amount: '1.000 €',
    status: 'in_progress',
    customerUserId: CUSTOMER_UID,
    craftsmanUserId: CRAFTSMAN_UID,
    sourceConversationId: opts.sourceConversationId,
  } as unknown as Job
}

function seedThread(repo: InMemoryChatRepository, id = THREAD_ID): void {
  const now = Date.now()
  repo._seedThread({
    id,
    channelType: 'customer',
    customerUserId: CUSTOMER_UID,
    craftsmanUserId: CRAFTSMAN_UID,
    providerId: 'prov-1',
    legacyThreadId: null,
    legacySource: null,
    title: null,
    lastMessageId: null,
    lastMessageAt: null,
    lastMessageBody: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    participants: [],
    unreadCount: 0,
    migrationStatus: 'migration_complete',
  } as ChatThreadViewModel)
}

function createParams(jobId: string) {
  return {
    jobId,
    craftsmanUserId: CRAFTSMAN_UID,
    customerUserId: CUSTOMER_UID,
    description: 'Zusätzliche Steckdose im Bad',
    price: '150 €',
    grossTotal: 15_000,
    conversationId: THREAD_ID,
  }
}

describe('ChangeOrder thread-artifact — emit on create', () => {
  let chatRepo: InMemoryChatRepository

  beforeEach(async () => {
    setupCleanRepositories()
    chatRepo = new InMemoryChatRepository()
    await chatRepo.initialize()
    setChatRepository(chatRepo)
  })

  it('emits the artifact_card chat message (artifactType ChangeOrder) into the stream', async () => {
    const jobId = 'job-co-emit'
    await getJobRepository().add(makeJob(jobId, { sourceConversationId: THREAD_ID }))
    seedThread(chatRepo)

    const co = await createChangeOrderWorkflow(createParams(jobId))

    const card = chatRepo
      .getMessages(THREAD_ID)
      .find((m) => m.artifactType === 'ChangeOrder' && m.artifactId === co.id)
    expect(card).toBeDefined()
    expect(card!.clientMessageId).toBe(`co-card-${co.id}`)
  })

  it('persists the ta_co_<id> snapshot record (phase pending, change_order)', async () => {
    const jobId = 'job-co-snap'
    await getJobRepository().add(makeJob(jobId, { sourceConversationId: THREAD_ID }))
    seedThread(chatRepo)

    const co = await createChangeOrderWorkflow(createParams(jobId))

    const record = getThreadArtifactRepository()
      .getAll()
      .find((r) => r.id === `ta_co_${co.id}`)
    expect(record).toBeDefined()
    expect(record!.artifactType).toBe('change_order')
    expect(record!.conversationId).toBe(THREAD_ID)
    expect(record!.phase).toBe('pending')
  })

  it('skips the emit when the job has no sourceConversationId (legacy-only)', async () => {
    const jobId = 'job-co-no-thread'
    await getJobRepository().add(makeJob(jobId)) // no sourceConversationId
    seedThread(chatRepo)

    const co = await createChangeOrderWorkflow({ ...createParams(jobId), conversationId: undefined })

    expect(
      chatRepo.getMessages(THREAD_ID).find((m) => m.artifactId === co.id),
    ).toBeUndefined()
    expect(
      getThreadArtifactRepository().getAll().find((r) => r.id === `ta_co_${co.id}`),
    ).toBeUndefined()
  })
})
