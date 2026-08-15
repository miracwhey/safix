/**
 * Chat-Cutover Slice C — chat-domain request-inbox selectors.
 *
 * Coverage (mirrors the legacy selector contract):
 *   1. No session → empty inbox (craftsman surface).
 *   2. Threads without inquiryOrigin / declined / job-linked are filtered.
 *   3. Job linkage via sourceConversationId, syntheticProjectId AND
 *      sourceProjectId all mark a request as converted.
 *   4. Triage status derivation (new_unread / needs_response /
 *      in_conversation) from unread count, reviewedAt and message senders.
 *   5. Message-less threads degrade to thread-level preview/activity fields.
 *   6. Pair-dedup keeps the most recently created thread.
 *   7. Quality score/tier present; richer metadata scores higher.
 *   8. Counts + sort (newest / quality).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
  getIncomingProjectRequestsFromChat,
  getIncomingRequestCountsFromChat,
  getIncomingRequestForThreadFromChat,
  sortIncomingRequestsFromChat,
} from '../../src/lib/chat/requestInboxSelectors'
import { setChatRepository } from '../../src/lib/chat/repository'
import type { ChatRepository } from '../../src/lib/chat/repository/ChatRepository'
import type {
  ChatMessageViewModel,
  ChatThreadViewModel,
} from '../../src/lib/chat/types'

const CRAFTSMAN_ID = 'craftsman-inbox-test'
const CUSTOMER_ID = 'customer-inbox-test'

// ── Module mocks ────────────────────────────────────────────────────────────

const sessionState = vi.hoisted(() => ({ userId: 'craftsman-inbox-test' as string | null }))

vi.mock('../../src/lib/session', () => ({
  getSession: () => ({
    user: sessionState.userId ? { id: sessionState.userId } : null,
    role: 'craftsman',
    loading: false,
  }),
  subscribeSession: () => () => {},
}))

const jobsState = vi.hoisted(() => ({
  jobs: [] as Array<Record<string, unknown>>,
}))

vi.mock('../../src/lib/jobs', () => ({
  getJobs: () => jobsState.jobs,
}))

vi.mock('../../src/lib/projects', () => ({
  getProjectById: (id: string) =>
    id === 'real-project-1'
      ? { id, category: 'Sanitär', description: 'Komplettes Bad neu, 12qm, Fliesen vorhanden.' }
      : undefined,
}))

// ── Fake repository (selector reads only getThreads + getMessages) ──────────

let threads: ChatThreadViewModel[] = []
let messagesByThread: Record<string, ChatMessageViewModel[]> = {}

const fakeRepo = {
  getThreads: (channelType?: string) =>
    channelType ? threads.filter((t) => t.channelType === channelType) : threads,
  getMessages: (threadId: string) => messagesByThread[threadId] ?? [],
} as unknown as ChatRepository

function makeThread(overrides: Partial<ChatThreadViewModel>): ChatThreadViewModel {
  return {
    id: 'thread-1',
    channelType: 'customer',
    customerUserId: CUSTOMER_ID,
    craftsmanUserId: CRAFTSMAN_ID,
    providerId: 'prov-1',
    disputeId: null,
    legacyThreadId: null,
    legacySource: null,
    title: null,
    lastMessageId: null,
    lastMessageAt: null,
    lastMessageBody: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    closedAt: null,
    displayMetadata: {
      customerName: 'Kunde K',
      customerAvatarUrl: '',
      projectTitle: 'Bad-Sanierung',
      projectSubtitle: 'Neue Anfrage',
    },
    inquiryOrigin: 'profile',
    declinedAt: null,
    reviewedAt: null,
    sourceProjectId: null,
    inquiryCriteria: null,
    participants: [],
    unreadCount: 0,
    migrationStatus: 'migration_complete',
    ...overrides,
  }
}

function makeMessage(
  threadId: string,
  senderUserId: string,
  overrides: Partial<ChatMessageViewModel> = {},
): ChatMessageViewModel {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    threadId,
    senderUserId,
    clientMessageId: `c_${Math.random().toString(36).slice(2, 10)}`,
    body: 'Hallo',
    messageType: 'text',
    artifactType: null,
    artifactId: null,
    replyToMessageId: null,
    createdAt: 2_000,
    serverReceivedAt: 2_000,
    deliveredAt: null,
    legacyMessageId: null,
    legacySource: null,
    deletedAt: null,
    redacted: false,
    redactedAt: null,
    redactedReason: null,
    attachments: [],
    status: 'sent',
    sender: { userId: senderUserId, role: 'customer', displayName: null, avatarUrl: null },
    ...overrides,
  }
}

beforeEach(() => {
  threads = []
  messagesByThread = {}
  jobsState.jobs = []
  sessionState.userId = CRAFTSMAN_ID
  setChatRepository(fakeRepo)
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe('getIncomingProjectRequestsFromChat — filtering', () => {
  it('returns empty without a session', () => {
    sessionState.userId = null
    threads = [makeThread({})]
    expect(getIncomingProjectRequestsFromChat()).toEqual([])
  })

  it('only surfaces inquiry threads for the current craftsman', () => {
    threads = [
      makeThread({ id: 't-mine' }),
      makeThread({ id: 't-no-origin', inquiryOrigin: null }),
      makeThread({ id: 't-foreign', craftsmanUserId: 'someone-else' }),
      makeThread({ id: 't-office', channelType: 'office' }),
    ]
    const items = getIncomingProjectRequestsFromChat()
    expect(items.map((i) => i.threadId)).toEqual(['t-mine'])
  })

  it('filters declined requests', () => {
    threads = [makeThread({ id: 't-declined', declinedAt: 123 }), makeThread({ id: 't-open', customerUserId: 'other-customer' })]
    expect(getIncomingProjectRequestsFromChat().map((i) => i.threadId)).toEqual(['t-open'])
  })

  it('filters converted requests via sourceConversationId, syntheticProjectId and sourceProjectId', () => {
    threads = [
      makeThread({ id: 't-by-conv', customerUserId: 'c1' }),
      makeThread({
        id: 't-by-synth',
        customerUserId: 'c2',
        displayMetadata: { syntheticProjectId: 'project_profile_x_1' },
      }),
      makeThread({ id: 't-by-source', customerUserId: 'c3', sourceProjectId: 'proj-real' }),
      makeThread({ id: 't-open', customerUserId: 'c4' }),
    ]
    jobsState.jobs = [
      { id: 'j1', sourceConversationId: 't-by-conv', projectId: 'p-x', status: 'new' },
      { id: 'j2', sourceConversationId: '', projectId: 'project_profile_x_1', status: 'new' },
      { id: 'j3', sourceConversationId: '', projectId: 'proj-real', status: 'new' },
    ]
    expect(getIncomingProjectRequestsFromChat().map((i) => i.threadId)).toEqual(['t-open'])
  })

  it('dedups by customer↔craftsman pair, keeping the most recent thread', () => {
    threads = [
      makeThread({ id: 't-old', createdAt: 1_000 }),
      makeThread({ id: 't-new', createdAt: 5_000 }),
    ]
    const items = getIncomingProjectRequestsFromChat()
    expect(items.map((i) => i.threadId)).toEqual(['t-new'])
  })
})

describe('getIncomingProjectRequestsFromChat — status + degradation', () => {
  it('derives new_unread for unread, unreviewed threads without craftsman reply', () => {
    threads = [makeThread({ id: 't1', unreadCount: 2 })]
    messagesByThread['t1'] = [makeMessage('t1', CUSTOMER_ID)]
    expect(getIncomingProjectRequestsFromChat()[0].status).toBe('new_unread')
  })

  it('derives needs_response after review without reply', () => {
    threads = [makeThread({ id: 't1', unreadCount: 0, reviewedAt: 1_500 })]
    messagesByThread['t1'] = [makeMessage('t1', CUSTOMER_ID)]
    expect(getIncomingProjectRequestsFromChat()[0].status).toBe('needs_response')
  })

  it('derives in_conversation once the craftsman replied', () => {
    threads = [makeThread({ id: 't1', unreadCount: 0 })]
    messagesByThread['t1'] = [
      makeMessage('t1', CUSTOMER_ID),
      makeMessage('t1', CRAFTSMAN_ID, { createdAt: 3_000 }),
    ]
    expect(getIncomingProjectRequestsFromChat()[0].status).toBe('in_conversation')
  })

  it('system messages never count as replies', () => {
    threads = [makeThread({ id: 't1', unreadCount: 0, reviewedAt: 1_500 })]
    messagesByThread['t1'] = [
      makeMessage('t1', CUSTOMER_ID),
      makeMessage('t1', CRAFTSMAN_ID, { messageType: 'system', createdAt: 3_000 }),
    ]
    expect(getIncomingProjectRequestsFromChat()[0].status).toBe('needs_response')
  })

  it('degrades to thread-level preview + activity when messages are not cached', () => {
    threads = [
      makeThread({
        id: 't1',
        lastMessageBody: 'Vorschau aus Thread-Row',
        lastMessageAt: 4_200,
      }),
    ]
    const item = getIncomingProjectRequestsFromChat()[0]
    expect(item.lastMessagePreview).toBe('Vorschau aus Thread-Row')
    expect(item.lastActivityAt).toBe(4_200)
  })

  it('flags project attachments and uses the attachment preview', () => {
    threads = [makeThread({ id: 't1' })]
    messagesByThread['t1'] = [
      makeMessage('t1', CUSTOMER_ID, {
        messageType: 'artifact_card',
        artifactType: 'project',
        artifactId: 'real-project-1',
        body: null,
        createdAt: 3_000,
      }),
    ]
    const item = getIncomingProjectRequestsFromChat()[0]
    expect(item.hasProjectAttachment).toBe(true)
    expect(item.lastMessagePreview).toBe('📋 Projekt angehängt')
  })
})

describe('quality score + counts + sort', () => {
  it('scores every item and richer metadata scores higher', () => {
    threads = [
      makeThread({ id: 't-thin', customerUserId: 'c-thin' }),
      makeThread({
        id: 't-rich',
        customerUserId: 'c-rich',
        inquiryOrigin: 'project',
        sourceProjectId: 'real-project-1',
        displayMetadata: {
          customerName: 'Kunde R',
          projectTitle: 'Badsanierung',
          projectSubtitle: 'Projektanfrage',
          projectDescription: 'Komplettes Bad neu, 12qm, Fliesen vorhanden, Termin flexibel.',
          projectLocation: 'Hannover',
          projectCostRange: '8.000–12.000 €',
          projectDuration: '2 Wochen',
        },
      }),
    ]
    const items = getIncomingProjectRequestsFromChat()
    const thin = items.find((i) => i.threadId === 't-thin')!
    const rich = items.find((i) => i.threadId === 't-rich')!
    expect(typeof thin.qualityScore).toBe('number')
    expect(['top', 'solide', 'pruefen']).toContain(thin.qualityTier)
    expect(rich.qualityScore).toBeGreaterThan(thin.qualityScore)
  })

  it('returns badge-ready counts', () => {
    threads = [
      makeThread({ id: 't-unread', customerUserId: 'c1', unreadCount: 1 }),
      makeThread({ id: 't-needs', customerUserId: 'c2', reviewedAt: 1_500 }),
    ]
    messagesByThread['t-unread'] = [makeMessage('t-unread', 'c1')]
    messagesByThread['t-needs'] = [makeMessage('t-needs', 'c2')]
    expect(getIncomingRequestCountsFromChat()).toEqual({
      total: 2,
      unread: 1,
      needsResponse: 1,
    })
  })

  it('resolves a single thread item or null', () => {
    threads = [makeThread({ id: 't1' })]
    expect(getIncomingRequestForThreadFromChat('t1')?.threadId).toBe('t1')
    expect(getIncomingRequestForThreadFromChat('missing')).toBeNull()
  })

  it('sorts by newest and by quality without mutating', () => {
    threads = [
      makeThread({ id: 't-old-rich', customerUserId: 'c1', lastMessageAt: 1_000, displayMetadata: {
        projectDescription: 'Sehr ausführliche Beschreibung des Vorhabens mit allen Details.',
        projectLocation: 'Hannover',
        projectCostRange: '5.000 €',
        projectDuration: '1 Woche',
      } }),
      makeThread({ id: 't-new-thin', customerUserId: 'c2', lastMessageAt: 9_000 }),
    ]
    const items = getIncomingProjectRequestsFromChat()
    const orderBefore = items.map((i) => i.threadId)
    const byNewest = sortIncomingRequestsFromChat(items, 'newest')
    const byQuality = sortIncomingRequestsFromChat(items, 'quality')
    expect(byNewest[0].threadId).toBe('t-new-thin')
    expect(byQuality[0].threadId).toBe('t-old-rich')
    // Pure: input order untouched.
    expect(items.map((i) => i.threadId)).toEqual(orderBefore)
  })
})
