/**
 * Integration tests: Canonical Conversation Selection + Project Send Routing
 *
 * Validates:
 * 1. resolveCanonicalConversation / resolveCanonicalThreadId select the
 *    deterministic canonical winner (most recent by createdAt).
 * 2. Inbox uses that canonical thread (no duplicates visible).
 * 3. Opening chat uses that canonical thread.
 * 4. Sending a new project card appends to the canonical visible thread.
 * 5. New project card appears immediately in visible chat history.
 * 6. No hidden duplicate conversation receives the project send instead.
 * 7. No regression to multi-send project history.
 * 8. No regression to active project logic.
 * 9. No regression to reload/re-entry stability.
 * 10. No regression to participant scoping.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import {
  addConversation,
  getConversationById,
  getMessageThreads,
  getMessageThreadById,
  getMessagesByConversationId,
  getIncomingProjectRequests,
  deduplicateConversationsByPair,
  resolveCanonicalConversation,
  resolveCanonicalThreadId,
  sendProjectAttachmentToThread,
  sendMessageToThread,
} from '../../src/lib/messages'

import { addProject } from '../../src/lib/projects'
import {
  sendProjectAttachmentWorkflow,
  sendDirectMessageWorkflow,
} from '../../src/lib/workflow/messageWorkflow'

import type { Conversation } from '../../src/lib/messages/types'
import type { ProjectCase } from '../../src/domain/projects/projectCaseTypes'

// ---------------------------------------------------------------------------
// Session mock
// ---------------------------------------------------------------------------

const mockSessionState = { user: null as { id: string } | null }

vi.mock('../../src/lib/session', () => ({
  getSession: () => ({
    user: mockSessionState.user,
    role: null,
    craftsmanRole: null,
    isOperator: false,
    loading: false,
    error: null,
    errorKind: null,
  }),
}))

function setActiveUser(id: string): void {
  mockSessionState.user = { id }
}

function clearActiveUser(): void {
  mockSessionState.user = null
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CRAFTSMAN_HANDLE = 'hw-routing-test'
const CRAFTSMAN_ID = 'craftsman-routing-001'
const CUSTOMER_A = 'customer-routing-A'
const CUSTOMER_B = 'customer-routing-B'

let seedCounter = 0

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  seedCounter++
  return {
    id: `conv-seed-${seedCounter}`,
    projectId: `proj-seed-${seedCounter}`,
    customerName: 'Test Kunde',
    customerAvatarUrl: '',
    customerUserId: CUSTOMER_A,
    craftsmanName: 'Test HW',
    craftsmanHandle: CRAFTSMAN_HANDLE,
    craftsmanAvatarUrl: '',
    craftsmanUserId: CRAFTSMAN_ID,
    projectTitle: 'Test Projekt',
    projectSubtitle: 'Neue Anfrage',
    inquiryOrigin: 'reel',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<ProjectCase> = {}): ProjectCase {
  seedCounter++
  return {
    id: `project-seed-${seedCounter}`,
    sourceJobId: '',
    title: 'Bad renovieren',
    customer: 'Test Kunde',
    craftsman: '',
    location: 'Berlin',
    dateLabel: '',
    price: '',
    status: 'request',
    paymentState: 'deposit_required',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    category: 'Sanitär',
    description: 'Komplettrenovierung',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. CANONICAL CONVERSATION RESOLUTION
// ---------------------------------------------------------------------------

describe('Canonical Conversation Resolution', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('resolveCanonicalConversation picks the most recent conversation for a pair', () => {
    const now = Date.now()
    const old: Conversation = seedConversation({
      id: 'old-conv',
      createdAt: now - 5000,
    })
    const recent: Conversation = seedConversation({
      id: 'recent-conv',
      createdAt: now,
    })
    const allConversations = [old, recent]

    const canonicalFromOld = resolveCanonicalConversation(old, allConversations)
    const canonicalFromRecent = resolveCanonicalConversation(recent, allConversations)

    // Both should resolve to the same canonical winner
    expect(canonicalFromOld.id).toBe('recent-conv')
    expect(canonicalFromRecent.id).toBe('recent-conv')
  })

  it('resolveCanonicalConversation returns target when no customerUserId', () => {
    const target: Conversation = seedConversation({
      id: 'anon-conv',
      customerUserId: undefined,
    })
    const other: Conversation = seedConversation({
      id: 'other-conv',
    })

    const result = resolveCanonicalConversation(target, [target, other])
    expect(result.id).toBe('anon-conv')
  })

  it('resolveCanonicalConversation returns target when it is the only conversation for pair', () => {
    const target: Conversation = seedConversation({ id: 'only-conv' })

    const result = resolveCanonicalConversation(target, [target])
    expect(result.id).toBe('only-conv')
  })

  it('resolveCanonicalConversation does not cross-contaminate different pairs', () => {
    const convA: Conversation = seedConversation({
      id: 'conv-a',
      customerUserId: CUSTOMER_A,
      createdAt: Date.now() - 1000,
    })
    const convB: Conversation = seedConversation({
      id: 'conv-b',
      customerUserId: CUSTOMER_B,
      createdAt: Date.now(),
    })

    const result = resolveCanonicalConversation(convA, [convA, convB])
    // convB belongs to a different customer, so convA should be returned as-is
    expect(result.id).toBe('conv-a')
  })

  it('resolveCanonicalThreadId resolves from store', async () => {
    const now = Date.now()
    await addConversation(seedConversation({
      id: 'store-old',
      createdAt: now - 5000,
    }))
    await addConversation(seedConversation({
      id: 'store-new',
      createdAt: now,
    }))

    expect(resolveCanonicalThreadId('store-old')).toBe('store-new')
    expect(resolveCanonicalThreadId('store-new')).toBe('store-new')
  })

  it('resolveCanonicalThreadId returns unknown ID unchanged', () => {
    expect(resolveCanonicalThreadId('nonexistent')).toBe('nonexistent')
  })

  it('deduplicateConversationsByPair and resolveCanonicalConversation agree on the winner', () => {
    const now = Date.now()
    const conversations: Conversation[] = [
      seedConversation({ id: 'dup-1', createdAt: now - 3000 }),
      seedConversation({ id: 'dup-2', createdAt: now - 1000 }),
      seedConversation({ id: 'dup-3', createdAt: now }),
    ]

    const deduped = deduplicateConversationsByPair(conversations)
    expect(deduped).toHaveLength(1)
    expect(deduped[0].id).toBe('dup-3')

    // resolveCanonicalConversation must agree
    const canonical = resolveCanonicalConversation(conversations[0], conversations)
    expect(canonical.id).toBe('dup-3')
  })
})

// ---------------------------------------------------------------------------
// 2. INBOX SHOWS ONLY THE CANONICAL THREAD
// ---------------------------------------------------------------------------

describe('Inbox shows only canonical thread', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('getMessageThreads returns one thread per pair when duplicates exist', async () => {
    const now = Date.now()
    await addConversation(seedConversation({
      id: 'inbox-old',
      createdAt: now - 5000,
    }))
    await addConversation(seedConversation({
      id: 'inbox-new',
      createdAt: now,
    }))

    const threads = getMessageThreads()
    expect(threads).toHaveLength(1)
    expect(threads[0].id).toBe('inbox-new')
  })

  it('getIncomingProjectRequests returns one request per pair when duplicates exist', async () => {
    const now = Date.now()
    await addConversation(seedConversation({
      id: 'req-old',
      createdAt: now - 5000,
    }))
    await addConversation(seedConversation({
      id: 'req-new',
      createdAt: now,
    }))

    setActiveUser(CRAFTSMAN_ID)
    const requests = getIncomingProjectRequests()
    expect(requests).toHaveLength(1)
    expect(requests[0].threadId).toBe('req-new')
  })
})

// ---------------------------------------------------------------------------
// 3. PROJECT SEND ROUTING — always targets canonical thread
// ---------------------------------------------------------------------------

describe('Project send routing targets canonical thread', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('sendProjectAttachmentToThread routes to canonical when given non-canonical ID', async () => {
    const now = Date.now()
    const projectId = 'routing-project-1'

    await addConversation(seedConversation({
      id: 'non-canonical',
      createdAt: now - 5000,
    }))
    await addConversation(seedConversation({
      id: 'canonical',
      createdAt: now,
    }))
    await addProject(seedProject({ id: projectId }))

    // Send to the non-canonical thread
    await sendProjectAttachmentToThread('non-canonical', projectId)

    // The message and sourceProjectId should appear on the canonical thread
    const canonicalConv = getConversationById('canonical')
    expect(canonicalConv?.sourceProjectId).toBe(projectId)

    const canonicalMessages = getMessagesByConversationId('canonical')
    expect(canonicalMessages.length).toBeGreaterThan(0)
    expect(canonicalMessages.some(m => m.attachmentType === 'project')).toBe(true)

    // The non-canonical thread should NOT have received the message
    const nonCanonicalMessages = getMessagesByConversationId('non-canonical')
    expect(nonCanonicalMessages).toHaveLength(0)
  })

  it('sendProjectAttachmentWorkflow routes to canonical when given non-canonical ID', async () => {
    const now = Date.now()
    const projectId = 'wf-routing-project-1'

    await addConversation(seedConversation({
      id: 'wf-non-canonical',
      createdAt: now - 5000,
    }))
    await addConversation(seedConversation({
      id: 'wf-canonical',
      createdAt: now,
    }))
    await addProject(seedProject({ id: projectId }))

    const result = await sendProjectAttachmentWorkflow('wf-non-canonical', projectId)
    expect(result).toBe(true)

    // The canonical thread should have the project
    const canonicalConv = getConversationById('wf-canonical')
    expect(canonicalConv?.sourceProjectId).toBe(projectId)

    // Canonical thread should have the message
    const canonicalMessages = getMessagesByConversationId('wf-canonical')
    expect(canonicalMessages.some(m => m.attachmentType === 'project')).toBe(true)
  })

  it('sendMessageToThread routes text messages to canonical', async () => {
    const now = Date.now()

    await addConversation(seedConversation({
      id: 'msg-non-canonical',
      createdAt: now - 5000,
    }))
    await addConversation(seedConversation({
      id: 'msg-canonical',
      createdAt: now,
    }))

    await sendMessageToThread('msg-non-canonical', 'Hallo!', 'user')

    const canonicalMessages = getMessagesByConversationId('msg-canonical')
    expect(canonicalMessages).toHaveLength(1)
    expect(canonicalMessages[0].text).toBe('Hallo!')

    const nonCanonicalMessages = getMessagesByConversationId('msg-non-canonical')
    expect(nonCanonicalMessages).toHaveLength(0)
  })

  it('sendDirectMessageWorkflow routes to canonical', async () => {
    const now = Date.now()

    await addConversation(seedConversation({
      id: 'dm-non-canonical',
      createdAt: now - 5000,
    }))
    await addConversation(seedConversation({
      id: 'dm-canonical',
      createdAt: now,
    }))

    await sendDirectMessageWorkflow('dm-non-canonical', 'Guten Tag!')

    const canonicalMessages = getMessagesByConversationId('dm-canonical')
    expect(canonicalMessages).toHaveLength(1)
    expect(canonicalMessages[0].text).toBe('Guten Tag!')

    const nonCanonicalMessages = getMessagesByConversationId('dm-non-canonical')
    expect(nonCanonicalMessages).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4. NEW PROJECT CARD APPEARS IN VISIBLE CHAT HISTORY
// ---------------------------------------------------------------------------

describe('New project card appears in visible chat history', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('project card appears in canonical thread messages after send', async () => {
    const now = Date.now()
    const projectId = 'visible-project-1'

    await addConversation(seedConversation({
      id: 'visible-canonical',
      createdAt: now,
    }))
    await addProject(seedProject({ id: projectId, title: 'Badezimmer' }))

    await sendProjectAttachmentToThread('visible-canonical', projectId)

    const thread = getMessageThreadById('visible-canonical')
    expect(thread).toBeDefined()
    expect(thread!.messages).toHaveLength(1)
    expect(thread!.messages[0].attachmentType).toBe('project')
    expect(thread!.messages[0].projectAttachment?.projectId).toBe(projectId)
  })

  it('project card appears in canonical thread even when sent via non-canonical ID', async () => {
    const now = Date.now()
    const projectId = 'rerouted-project-1'

    await addConversation(seedConversation({
      id: 'hidden-dup',
      createdAt: now - 5000,
    }))
    await addConversation(seedConversation({
      id: 'visible-thread',
      createdAt: now,
    }))
    await addProject(seedProject({ id: projectId }))

    // Send via the hidden duplicate
    await sendProjectAttachmentToThread('hidden-dup', projectId)

    // The visible thread (canonical) should have the project card
    const visibleThread = getMessageThreadById('visible-thread')
    expect(visibleThread).toBeDefined()
    expect(visibleThread!.messages).toHaveLength(1)
    expect(visibleThread!.messages[0].attachmentType).toBe('project')
  })
})

// ---------------------------------------------------------------------------
// 5. NO HIDDEN DUPLICATE WRITES
// ---------------------------------------------------------------------------

describe('No hidden duplicate conversation receives project send', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('hidden duplicate thread has zero messages after project send', async () => {
    const now = Date.now()
    const projectId = 'no-dup-project-1'

    await addConversation(seedConversation({
      id: 'dup-hidden',
      createdAt: now - 5000,
    }))
    await addConversation(seedConversation({
      id: 'dup-visible',
      createdAt: now,
    }))
    await addProject(seedProject({ id: projectId }))

    // Send from any reference
    await sendProjectAttachmentToThread('dup-hidden', projectId)

    // Hidden thread should have nothing
    const hiddenMessages = getMessagesByConversationId('dup-hidden')
    expect(hiddenMessages).toHaveLength(0)

    // Visible (canonical) thread should have the message
    const visibleMessages = getMessagesByConversationId('dup-visible')
    expect(visibleMessages).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 6. MULTI-SEND PROJECT HISTORY — no regression
// ---------------------------------------------------------------------------

describe('Multi-send project history (no regression)', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('multiple project sends to canonical thread create multiple messages', async () => {
    const now = Date.now()

    await addConversation(seedConversation({
      id: 'multi-send',
      createdAt: now,
    }))
    await addProject(seedProject({ id: 'proj-multi-1' }))
    await addProject(seedProject({ id: 'proj-multi-2' }))

    await sendProjectAttachmentToThread('multi-send', 'proj-multi-1')
    await sendProjectAttachmentToThread('multi-send', 'proj-multi-2')

    const messages = getMessagesByConversationId('multi-send')
    expect(messages).toHaveLength(2)
    expect(messages[0].attachmentType).toBe('project')
    expect(messages[1].attachmentType).toBe('project')
  })

  it('first project send stamps sourceProjectId, second does not overwrite', async () => {
    const now = Date.now()

    await addConversation(seedConversation({
      id: 'multi-source',
      createdAt: now,
    }))
    await addProject(seedProject({ id: 'first-proj' }))
    await addProject(seedProject({ id: 'second-proj' }))

    await sendProjectAttachmentToThread('multi-source', 'first-proj')
    const afterFirst = getConversationById('multi-source')
    expect(afterFirst?.sourceProjectId).toBe('first-proj')

    await sendProjectAttachmentToThread('multi-source', 'second-proj')
    const afterSecond = getConversationById('multi-source')
    // sourceProjectId should NOT be overwritten
    expect(afterSecond?.sourceProjectId).toBe('first-proj')
  })
})

// ---------------------------------------------------------------------------
// 7. ACTIVE PROJECT LOGIC — no regression
// ---------------------------------------------------------------------------

describe('Active project logic (no regression)', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('project send via canonical resolution stamps sourceProjectId on canonical conversation', async () => {
    const now = Date.now()
    const projectId = 'active-proj-1'

    await addConversation(seedConversation({
      id: 'active-dup',
      createdAt: now - 5000,
    }))
    await addConversation(seedConversation({
      id: 'active-canonical',
      createdAt: now,
    }))
    await addProject(seedProject({ id: projectId }))

    await sendProjectAttachmentToThread('active-dup', projectId)

    // sourceProjectId should be on the canonical conversation
    const canonical = getConversationById('active-canonical')
    expect(canonical?.sourceProjectId).toBe(projectId)

    // Non-canonical conversation should NOT have sourceProjectId
    const nonCanonical = getConversationById('active-dup')
    expect(nonCanonical?.sourceProjectId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 8. PREVIEW CONSISTENCY
// ---------------------------------------------------------------------------

describe('Preview consistency', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('inbox preview reflects messages on canonical thread, not duplicates', async () => {
    const now = Date.now()

    await addConversation(seedConversation({
      id: 'preview-old',
      createdAt: now - 5000,
    }))
    await addConversation(seedConversation({
      id: 'preview-canonical',
      createdAt: now,
    }))

    // Send a message to canonical
    await sendMessageToThread('preview-canonical', 'Neueste Nachricht', 'user')

    const threads = getMessageThreads()
    expect(threads).toHaveLength(1)
    expect(threads[0].id).toBe('preview-canonical')
    expect(threads[0].lastMessagePreview).toBe('Neueste Nachricht')
  })

  it('inbox preview shows project attachment label when last message is project', async () => {
    const now = Date.now()

    await addConversation(seedConversation({
      id: 'prev-proj-canonical',
      createdAt: now,
    }))
    await addProject(seedProject({ id: 'prev-project' }))

    await sendProjectAttachmentToThread('prev-proj-canonical', 'prev-project')

    const threads = getMessageThreads()
    expect(threads).toHaveLength(1)
    expect(threads[0].lastMessagePreview).toBe('📋 Projekt angehängt')
  })
})

// ---------------------------------------------------------------------------
// 9. RELOAD / RE-ENTRY STABILITY — no regression
// ---------------------------------------------------------------------------

describe('Reload / Re-entry stability (no regression)', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('canonical thread can be retrieved by ID after creation', async () => {
    await addConversation(seedConversation({
      id: 'reload-conv',
      createdAt: Date.now(),
    }))

    const thread = getMessageThreadById('reload-conv')
    expect(thread).toBeDefined()
    expect(thread!.id).toBe('reload-conv')
  })

  it('resolveCanonicalThreadId is stable across multiple calls', async () => {
    const now = Date.now()
    await addConversation(seedConversation({
      id: 'stable-old',
      createdAt: now - 5000,
    }))
    await addConversation(seedConversation({
      id: 'stable-new',
      createdAt: now,
    }))

    const first = resolveCanonicalThreadId('stable-old')
    const second = resolveCanonicalThreadId('stable-old')
    const third = resolveCanonicalThreadId('stable-new')

    expect(first).toBe('stable-new')
    expect(second).toBe('stable-new')
    expect(third).toBe('stable-new')
  })
})

// ---------------------------------------------------------------------------
// 10. PARTICIPANT SCOPING — no regression
// ---------------------------------------------------------------------------

describe('Participant scoping (no regression)', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('canonical resolution does not cross customer boundaries', async () => {
    const now = Date.now()

    await addConversation(seedConversation({
      id: 'scope-a',
      customerUserId: CUSTOMER_A,
      createdAt: now - 5000,
    }))
    await addConversation(seedConversation({
      id: 'scope-b',
      customerUserId: CUSTOMER_B,
      createdAt: now,
    }))

    // Customer A's conversation should resolve to itself, not B
    expect(resolveCanonicalThreadId('scope-a')).toBe('scope-a')
    // Customer B's conversation should resolve to itself
    expect(resolveCanonicalThreadId('scope-b')).toBe('scope-b')
  })

  it('canonical resolution does not cross craftsman boundaries', async () => {
    const now = Date.now()

    await addConversation(seedConversation({
      id: 'craft-a',
      craftsmanHandle: 'craftsman-one',
      createdAt: now - 5000,
    }))
    await addConversation(seedConversation({
      id: 'craft-b',
      craftsmanHandle: 'craftsman-two',
      createdAt: now,
    }))

    // Different craftsmen, should each be their own canonical
    expect(resolveCanonicalThreadId('craft-a')).toBe('craft-a')
    expect(resolveCanonicalThreadId('craft-b')).toBe('craft-b')
  })
})
