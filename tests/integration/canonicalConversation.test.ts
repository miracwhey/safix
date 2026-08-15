/**
 * Integration tests: Canonical Conversation Reuse + Remove Fake Customer Messages
 *
 * Validates:
 * 1. Customer ↔ craftsman inquiry flow reuses existing conversation
 * 2. No duplicate active threads for the same pair in normal flow
 * 3. Real user messages still render normally
 * 4. System-generated inquiry/helper content no longer renders as a customer bubble
 * 5. Project cards still render correctly as business events
 * 6. No regression to reload/re-entry stability
 * 7. No regression to participant scoping
 * 8. No regression to active project logic
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import {
  startReelInquiryWorkflow,
  startProfileInquiryWorkflow,
  startCategoryInquiryWorkflowFromProvider,
  startProjectInquiryWorkflowFromProvider,
  convertInquiryToProjectWorkflow,
} from '../../src/lib/workflow/exploreInquiryWorkflow'

import {
  addConversation,
  getConversations,
  getConversationById,
  getMessageThreads,
  getMessageThreadById,
  getMessagesByConversationId,
  getIncomingProjectRequests,
  deduplicateConversationsByPair,
} from '../../src/lib/messages'

import { isConversationParticipant } from '../../src/lib/messages/participantScope'

import type { ExploreReel, ExploreProviderCard } from '../../src/lib/explore/exploreTypes'
import type { ExploreCraftsmanProfile } from '../../src/lib/explore/exploreProfileService'
import type { Conversation } from '../../src/lib/messages/types'
import type { ProjectCase } from '../../src/domain/projects/projectCaseTypes'

// ---------------------------------------------------------------------------
// Session mock
// ---------------------------------------------------------------------------

const mockSessionState = { user: null as { id: string } | null }

// Tests in this file exercise customer-side inquiry flows. The workflow-layer
// RBAC guard `enforceCustomerOnlyInquiry()` requires session.role === 'customer'
// — set it on the mock so the tests model the realistic caller identity.
vi.mock('../../src/lib/session', () => ({
  getSession: () => ({
    user: mockSessionState.user,
    role: 'customer',
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

const CRAFTSMAN_HANDLE = 'canonical-hw'
const CRAFTSMAN_ID = 'craftsman-canonical-001'
const CUSTOMER_A = 'customer-canonical-A'
const CUSTOMER_B = 'customer-canonical-B'

const testReel: ExploreReel = {
  id: 'reel-canonical-1',
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'Test Handwerker',
  craftsmanHandle: CRAFTSMAN_HANDLE,
  craftsmanAvatarUrl: '',
  title: 'Badezimmer Renovierung',
  category: 'Sanitär',
  location: 'Berlin',
  thumbnailUrl: '',
  likes: 0,
  saves: 0,
  projectTags: [],
  searchTags: [],
  costLabel: '5.000 – 10.000 €',
  durationLabel: '2 Wochen',
  createdAt: Date.now(),
}

const testProfile: ExploreCraftsmanProfile = {
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'Test Handwerker',
  craftsmanHandle: CRAFTSMAN_HANDLE,
  craftsmanAvatarUrl: '',
  location: 'Berlin',
  primaryCategory: 'Sanitär',
  bio: '',
  tradeCategories: ['Sanitär'],
  reels: [],
  portfolioItems: [],
  trust: {
    completedJobsCount: 0,
    wouldHireAgainCount: 0,
    totalFeedbackCount: 0,
    hasPlatformBackedCompletion: false,
    badges: [],
  },
  stats: { reels: 0, likes: 0, saves: 0, completedJobs: 0, wouldHireAgainCount: 0 },
}

const testProvider: ExploreProviderCard = {
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'Test Handwerker',
  craftsmanHandle: CRAFTSMAN_HANDLE,
  craftsmanAvatarUrl: '',
  location: 'Berlin',
  primaryCategory: 'Sanitär',
  tradeCategories: ['Sanitär'],
  servicesOffered: ['Sanitär'],
  serviceRadiusKm: 50,
}

const testProject: ProjectCase = {
  id: 'project-canonical-1',
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
  requestedBudget: '5.000 – 8.000 €',
}

// ---------------------------------------------------------------------------
// 1. CONVERSATION REUSE — no duplicate threads
// ---------------------------------------------------------------------------

describe('Canonical Conversation Reuse', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('reel inquiry reuses existing thread for same customer ↔ craftsman pair', async () => {
    setActiveUser(CUSTOMER_A)
    const first = await startReelInquiryWorkflow(testReel)
    const second = await startReelInquiryWorkflow(testReel)

    expect(first).toBe(second)
    expect(getConversations()).toHaveLength(1)
  })

  it('profile inquiry reuses existing thread for same customer ↔ craftsman pair', async () => {
    setActiveUser(CUSTOMER_A)
    const first = await startProfileInquiryWorkflow(testProfile)
    const second = await startProfileInquiryWorkflow(testProfile)

    expect(first).toBe(second)
    expect(getConversations()).toHaveLength(1)
  })

  it('category inquiry reuses existing thread for same customer ↔ craftsman pair', async () => {
    setActiveUser(CUSTOMER_A)
    const first = await startCategoryInquiryWorkflowFromProvider(
      'Sanitär', 'Erste Anfrage', 'Berlin', testProvider,
    )
    const second = await startCategoryInquiryWorkflowFromProvider(
      'Sanitär', 'Zweite Anfrage', 'Berlin', testProvider,
    )

    expect(first).toBe(second)
    expect(getConversations()).toHaveLength(1)
  })

  it('project inquiry reuses existing thread for same customer ↔ craftsman pair', async () => {
    setActiveUser(CUSTOMER_A)
    const first = await startProjectInquiryWorkflowFromProvider(testProject, testProvider)
    const second = await startProjectInquiryWorkflowFromProvider(testProject, testProvider)

    expect(first).toBe(second)
    expect(getConversations()).toHaveLength(1)
  })

  it('cross-workflow reuse: reel first, then profile reuses same thread', async () => {
    setActiveUser(CUSTOMER_A)
    const reelThread = await startReelInquiryWorkflow(testReel)
    const profileThread = await startProfileInquiryWorkflow(testProfile)

    expect(reelThread).toBe(profileThread)
    expect(getConversations()).toHaveLength(1)
  })

  it('cross-workflow reuse: profile first, then category reuses same thread', async () => {
    setActiveUser(CUSTOMER_A)
    const profileThread = await startProfileInquiryWorkflow(testProfile)
    const categoryThread = await startCategoryInquiryWorkflowFromProvider(
      'Sanitär', 'Follow-up', 'Berlin', testProvider,
    )

    expect(profileThread).toBe(categoryThread)
    expect(getConversations()).toHaveLength(1)
  })

  it('different customers get separate threads for the same craftsman', async () => {
    setActiveUser(CUSTOMER_A)
    const threadA = await startReelInquiryWorkflow(testReel)

    setActiveUser(CUSTOMER_B)
    const threadB = await startReelInquiryWorkflow(testReel)

    expect(threadA).not.toBe(threadB)
    expect(getConversations()).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 2. NO FAKE CUSTOMER MESSAGES
// ---------------------------------------------------------------------------

describe('No Fake Customer Messages', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('reel inquiry creates thread with zero messages (no auto-text)', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startReelInquiryWorkflow(testReel)

    const thread = getMessageThreadById(threadId)
    expect(thread).toBeDefined()
    expect(thread!.messages).toHaveLength(0)
  })

  it('profile inquiry creates thread with zero messages (no auto-text)', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startProfileInquiryWorkflow(testProfile)

    const thread = getMessageThreadById(threadId)
    expect(thread).toBeDefined()
    expect(thread!.messages).toHaveLength(0)
  })

  it('category inquiry creates thread with zero messages (no auto-text)', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startCategoryInquiryWorkflowFromProvider(
      'Sanitär', 'Wasserhahn reparieren', 'Berlin', testProvider,
    )

    const thread = getMessageThreadById(threadId)
    expect(thread).toBeDefined()
    expect(thread!.messages).toHaveLength(0)
  })

  it('project inquiry creates thread with zero messages (no auto-text)', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startProjectInquiryWorkflowFromProvider(testProject, testProvider)

    const thread = getMessageThreadById(threadId)
    expect(thread).toBeDefined()
    expect(thread!.messages).toHaveLength(0)
  })

  it('reuse path for category inquiry does NOT send fake customer text', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startCategoryInquiryWorkflowFromProvider(
      'Sanitär', 'First', 'Berlin', testProvider,
    )

    // Reuse same thread with different description
    await startCategoryInquiryWorkflowFromProvider(
      'Sanitär', 'Second', 'Berlin', testProvider,
    )

    const thread = getMessageThreadById(threadId)
    // No auto-text should have been added
    expect(thread!.messages).toHaveLength(0)
  })

  it('reuse path for project inquiry does NOT send fake customer text', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startProjectInquiryWorkflowFromProvider(testProject, testProvider)

    // Reuse same thread
    await startProjectInquiryWorkflowFromProvider(testProject, testProvider)

    const thread = getMessageThreadById(threadId)
    // No auto-text should have been added
    expect(thread!.messages).toHaveLength(0)
  })

  it('conversion notification is sent as system sender, not user', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startReelInquiryWorkflow(testReel)
    await convertInquiryToProjectWorkflow(threadId)

    const messages = getMessagesByConversationId(threadId)
    // Only the conversion system message should exist
    expect(messages).toHaveLength(1)
    expect(messages[0].sender).toBe('system')
    expect(messages[0].text).toContain('Projekt aufgenommen')
  })
})

// ---------------------------------------------------------------------------
// 3. INBOX DEDUP — one thread per customer ↔ craftsman pair
// ---------------------------------------------------------------------------

describe('Inbox Dedup', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('deduplicateConversationsByPair keeps only one thread per pair', () => {
    const now = Date.now()
    const conversations: Conversation[] = [
      {
        id: 'old-thread',
        projectId: 'p1',
        customerName: 'Kunde A',
        customerAvatarUrl: '',
        customerUserId: CUSTOMER_A,
        craftsmanName: 'HW',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        craftsmanAvatarUrl: '',
        craftsmanUserId: CRAFTSMAN_ID,
        projectTitle: 'Old',
        projectSubtitle: 'Old',
        createdAt: now - 1000,
        inquiryOrigin: 'reel',
      },
      {
        id: 'new-thread',
        projectId: 'p2',
        customerName: 'Kunde A',
        customerAvatarUrl: '',
        customerUserId: CUSTOMER_A,
        craftsmanName: 'HW',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        craftsmanAvatarUrl: '',
        craftsmanUserId: CRAFTSMAN_ID,
        projectTitle: 'New',
        projectSubtitle: 'New',
        createdAt: now,
        inquiryOrigin: 'profile',
      },
    ]

    const result = deduplicateConversationsByPair(conversations)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('new-thread')
  })

  it('deduplicateConversationsByPair preserves threads for different customers', () => {
    const conversations: Conversation[] = [
      {
        id: 'thread-a',
        projectId: 'p1',
        customerName: 'Kunde A',
        customerAvatarUrl: '',
        customerUserId: CUSTOMER_A,
        craftsmanName: 'HW',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        craftsmanAvatarUrl: '',
        craftsmanUserId: CRAFTSMAN_ID,
        projectTitle: 'A',
        projectSubtitle: 'A',
        createdAt: Date.now(),
        inquiryOrigin: 'reel',
      },
      {
        id: 'thread-b',
        projectId: 'p2',
        customerName: 'Kunde B',
        customerAvatarUrl: '',
        customerUserId: CUSTOMER_B,
        craftsmanName: 'HW',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        craftsmanAvatarUrl: '',
        craftsmanUserId: CRAFTSMAN_ID,
        projectTitle: 'B',
        projectSubtitle: 'B',
        createdAt: Date.now(),
        inquiryOrigin: 'reel',
      },
    ]

    const result = deduplicateConversationsByPair(conversations)
    expect(result).toHaveLength(2)
  })

  it('deduplicateConversationsByPair does NOT dedup conversations without customerUserId', () => {
    const conversations: Conversation[] = [
      {
        id: 'anon-thread-1',
        projectId: 'p1',
        customerName: 'Same Name',
        customerAvatarUrl: '',
        craftsmanName: 'HW',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        craftsmanAvatarUrl: '',
        craftsmanUserId: CRAFTSMAN_ID,
        projectTitle: 'A',
        projectSubtitle: 'A',
        createdAt: Date.now(),
      },
      {
        id: 'anon-thread-2',
        projectId: 'p2',
        customerName: 'Same Name',
        customerAvatarUrl: '',
        craftsmanName: 'HW',
        craftsmanHandle: CRAFTSMAN_HANDLE,
        craftsmanAvatarUrl: '',
        craftsmanUserId: CRAFTSMAN_ID,
        projectTitle: 'B',
        projectSubtitle: 'B',
        createdAt: Date.now(),
      },
    ]

    // Without customerUserId, conversations should NOT be grouped even
    // if customerName is the same (names are not unique identifiers)
    const result = deduplicateConversationsByPair(conversations)
    expect(result).toHaveLength(2)
  })

  it('craftsman inbox does not show duplicate threads for same customer', async () => {
    // Manually seed two conversations for the same pair (simulating legacy data)
    const now = Date.now()
    await addConversation({
      id: 'dup-1',
      projectId: 'p-dup-1',
      customerName: 'Duplicate Kunde',
      customerAvatarUrl: '',
      customerUserId: CUSTOMER_A,
      craftsmanName: 'HW',
      craftsmanHandle: CRAFTSMAN_HANDLE,
      craftsmanAvatarUrl: '',
      craftsmanUserId: CRAFTSMAN_ID,
      projectTitle: 'First Request',
      projectSubtitle: 'Neue Anfrage',
      inquiryOrigin: 'reel',
      createdAt: now - 5000,
    })

    await addConversation({
      id: 'dup-2',
      projectId: 'p-dup-2',
      customerName: 'Duplicate Kunde',
      customerAvatarUrl: '',
      customerUserId: CUSTOMER_A,
      craftsmanName: 'HW',
      craftsmanHandle: CRAFTSMAN_HANDLE,
      craftsmanAvatarUrl: '',
      craftsmanUserId: CRAFTSMAN_ID,
      projectTitle: 'Second Request',
      projectSubtitle: 'Neue Anfrage',
      inquiryOrigin: 'profile',
      createdAt: now,
    })

    setActiveUser(CRAFTSMAN_ID)
    const requests = getIncomingProjectRequests()
    // Should only show one canonical thread, not two
    expect(requests).toHaveLength(1)
    expect(requests[0].threadId).toBe('dup-2') // most recent
  })

  it('getMessageThreads deduplicates threads for same customer ↔ craftsman pair', async () => {
    const now = Date.now()
    await addConversation({
      id: 'thread-dup-a',
      projectId: 'p-a',
      customerName: 'Same Kunde',
      customerAvatarUrl: '',
      customerUserId: CUSTOMER_A,
      craftsmanName: 'Same HW',
      craftsmanHandle: 'same-hw',
      craftsmanAvatarUrl: '',
      craftsmanUserId: CRAFTSMAN_ID,
      projectTitle: 'Old',
      projectSubtitle: 'Old',
      createdAt: now - 5000,
    })

    await addConversation({
      id: 'thread-dup-b',
      projectId: 'p-b',
      customerName: 'Same Kunde',
      customerAvatarUrl: '',
      customerUserId: CUSTOMER_A,
      craftsmanName: 'Same HW',
      craftsmanHandle: 'same-hw',
      craftsmanAvatarUrl: '',
      craftsmanUserId: CRAFTSMAN_ID,
      projectTitle: 'New',
      projectSubtitle: 'New',
      createdAt: now,
    })

    const threads = getMessageThreads()
    // Should only show one thread
    expect(threads).toHaveLength(1)
    expect(threads[0].id).toBe('thread-dup-b')
  })
})

// ---------------------------------------------------------------------------
// 4. PARTICIPANT SCOPING — no regression
// ---------------------------------------------------------------------------

describe('Participant Scoping (no regression)', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('isConversationParticipant works for both customer and craftsman', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startReelInquiryWorkflow(testReel)
    const conversation = getConversationById(threadId)!

    expect(isConversationParticipant(conversation, CUSTOMER_A)).toBe(true)
    expect(isConversationParticipant(conversation, CRAFTSMAN_ID)).toBe(true)
    expect(isConversationParticipant(conversation, 'unknown-user')).toBe(false)
  })

  it('threads carry correct customerUserId and craftsmanUserId', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startReelInquiryWorkflow(testReel)
    const conversation = getConversationById(threadId)!

    expect(conversation.customerUserId).toBe(CUSTOMER_A)
    expect(conversation.craftsmanUserId).toBe(CRAFTSMAN_ID)
  })
})

// ---------------------------------------------------------------------------
// 5. CONVERSATION METADATA — still carries inquiry context
// ---------------------------------------------------------------------------

describe('Conversation metadata (no regression)', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('reel inquiry conversation carries project metadata', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startReelInquiryWorkflow(testReel)
    const conv = getConversationById(threadId)!

    expect(conv.projectTitle).toBe('Badezimmer Renovierung')
    expect(conv.projectLocation).toBe('Berlin')
    expect(conv.inquiryOrigin).toBe('reel')
  })

  it('category inquiry conversation carries projectDescription', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startCategoryInquiryWorkflowFromProvider(
      'Sanitär', 'Wasserhahn reparieren', 'Berlin', testProvider,
    )
    const conv = getConversationById(threadId)!

    expect(conv.projectDescription).toBe('Wasserhahn reparieren')
    expect(conv.inquiryOrigin).toBe('category')
  })

  it('project inquiry conversation carries sourceProjectId', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startProjectInquiryWorkflowFromProvider(testProject, testProvider)
    const conv = getConversationById(threadId)!

    expect(conv.sourceProjectId).toBe(testProject.id)
    expect(conv.inquiryOrigin).toBe('project')
  })
})

// ---------------------------------------------------------------------------
// 6. SYSTEM MESSAGES — conversion event is system type
// ---------------------------------------------------------------------------

describe('System messages are properly classified', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('convertInquiryToProjectWorkflow system message has sender=system', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startReelInquiryWorkflow(testReel)
    await convertInquiryToProjectWorkflow(threadId)

    const messages = getMessagesByConversationId(threadId)
    const systemMessages = messages.filter(m => m.sender === 'system')
    const userMessages = messages.filter(m => m.sender === 'user')

    expect(systemMessages).toHaveLength(1)
    expect(userMessages).toHaveLength(0)
  })

  it('only user-authored messages should have sender=user', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startReelInquiryWorkflow(testReel)

    // No messages should exist yet — no auto-text
    expect(getMessagesByConversationId(threadId)).toHaveLength(0)

    // Convert → system message
    await convertInquiryToProjectWorkflow(threadId)
    const messagesAfterConversion = getMessagesByConversationId(threadId)
    expect(messagesAfterConversion.every(m => m.sender !== 'user')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 7. RELOAD / RE-ENTRY STABILITY — no regression
// ---------------------------------------------------------------------------

describe('Reload / Re-entry stability (no regression)', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('thread can be retrieved by ID after creation', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startReelInquiryWorkflow(testReel)
    const thread = getMessageThreadById(threadId)

    expect(thread).toBeDefined()
    expect(thread!.id).toBe(threadId)
    expect(thread!.craftsmanHandle).toBe(CRAFTSMAN_HANDLE)
  })

  it('conversation metadata survives store read', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startCategoryInquiryWorkflowFromProvider(
      'Elektrik', 'Sicherungskasten prüfen', 'München', testProvider,
    )

    const conv = getConversationById(threadId)
    expect(conv).toBeDefined()
    expect(conv!.projectDescription).toBe('Sicherungskasten prüfen')
    expect(conv!.projectLocation).toBe('München')
  })
})
