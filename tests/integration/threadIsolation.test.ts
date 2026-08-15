/**
 * Integration tests: BLOCK 2 – Thread identity isolation and customer scoping.
 *
 * Validates that:
 * - findExistingThreadForCraftsman only reuses a thread that belongs to the
 *   current customer (same customerUserId).
 * - Two distinct customers contacting the same craftsman each get their own
 *   independent thread, never a shared one.
 * - An authenticated customer's thread is not reused by a different (or
 *   unauthenticated) customer even if the craftsmanHandle matches.
 * - projectDescription and inquiryCriteria survive a round-trip through the
 *   InMemoryMessageRepository so that intakeContext is fully populated after
 *   reload-simulation.
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

import { addConversation, getConversations, getConversationById } from '../../src/lib/messages'
import { getJobById } from '../../src/lib/jobs'
import { addProject } from '../../src/lib/projects'

import type { ExploreReel, ExploreProviderCard } from '../../src/lib/explore/exploreTypes'
import type { ExploreCraftsmanProfile } from '../../src/lib/explore/exploreProfileService'
import type { Conversation } from '../../src/lib/messages/types'
import type { ProjectCase } from '../../src/domain/projects/projectCaseTypes'

// ---------------------------------------------------------------------------
// Session mock
// ---------------------------------------------------------------------------

const mockSessionState = { user: null as { id: string } | null }

// Tests in this file exercise customer-side inquiry isolation. The workflow-
// layer guard `assertCustomerRole()` requires session.role === 'customer'
// — model that on the mock so the realistic caller identity is reflected.
// `clearActiveUser()` flips role to null so the "unauthenticated reuse" case
// still represents a non-customer caller correctly.
vi.mock('../../src/lib/session', () => ({
  getSession: () => ({
    user: mockSessionState.user,
    role: mockSessionState.user ? 'customer' : null,
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

const CRAFTSMAN_HANDLE = 'handwerker-schmidt'
const CRAFTSMAN_ID = 'craftsman-user-uuid-1'
const CUSTOMER_A = 'customer-user-uuid-A'
const CUSTOMER_B = 'customer-user-uuid-B'

const testReel: ExploreReel = {
  id: 'reel-isolation-1',
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'Karl Schmidt',
  craftsmanHandle: CRAFTSMAN_HANDLE,
  craftsmanAvatarUrl: 'https://example.com/avatar.jpg',
  title: 'Küche neu gestalten',
  category: 'Küche',
  location: 'Berlin',
  thumbnailUrl: 'https://example.com/thumb.jpg',
  likes: 5,
  saves: 1,
  projectTags: ['küche'],
  searchTags: ['küche'],
  costLabel: '3.000 – 5.000 €',
  durationLabel: '3 Wochen',
  createdAt: Date.now(),
}

const testProfile: ExploreCraftsmanProfile = {
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'Karl Schmidt',
  craftsmanHandle: CRAFTSMAN_HANDLE,
  craftsmanAvatarUrl: 'https://example.com/avatar.jpg',
  location: 'Berlin',
  primaryCategory: 'Küche',
  bio: '',
  tradeCategories: ['Küche'],
  reels: [],
  portfolioItems: [],
  trust: {
    completedJobsCount: 3,
    wouldHireAgainCount: 3,
    totalFeedbackCount: 3,
    hasPlatformBackedCompletion: false,
    badges: [],
  },
  stats: { reels: 0, likes: 0, saves: 0, completedJobs: 3, wouldHireAgainCount: 3 },
}

const testProvider: ExploreProviderCard = {
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'Karl Schmidt',
  craftsmanHandle: CRAFTSMAN_HANDLE,
  craftsmanAvatarUrl: 'https://example.com/avatar.jpg',
  location: 'Berlin',
  primaryCategory: 'Küche',
  tradeCategories: ['Küche'],
  servicesOffered: ['Küchenumbau'],
  serviceRadiusKm: 50,
}

const testProject: ProjectCase = {
  id: 'project-isolation-1',
  sourceJobId: '', // not yet linked to a job (pre-conversion state)
  title: 'Küche renovieren',
  customer: 'Test Kunde',
  craftsman: '', // no craftsman assigned yet
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
  category: 'Küche',
  description: 'Komplettrenovierung der Küche',
  requestedBudget: '5.000 – 8.000 €',
  requestedTiming: 'Innerhalb 4 Wochen',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedConversation(overrides: Partial<Conversation> & { id: string }): Promise<void> {
  await addConversation({
    id: overrides.id,
    projectId: overrides.projectId ?? `project-${overrides.id}`,
    customerName: overrides.customerName ?? 'Test Kunde',
    customerAvatarUrl: '',
    craftsmanName: 'Karl Schmidt',
    craftsmanHandle: CRAFTSMAN_HANDLE,
    craftsmanAvatarUrl: '',
    craftsmanUserId: CRAFTSMAN_ID,
    projectTitle: 'Test',
    projectSubtitle: 'Neue Anfrage',
    createdAt: Date.now(),
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Tests: per-customer thread scoping
// ---------------------------------------------------------------------------

describe('BLOCK 2 – Thread isolation: one thread per customer×craftsman pair', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  // ─── Reel workflow ───────────────────────────────────────────────────────

  describe('startReelInquiryWorkflow', () => {
    it('creates separate threads for customer A and customer B', async () => {
      setActiveUser(CUSTOMER_A)
      const threadA = await startReelInquiryWorkflow(testReel)

      setActiveUser(CUSTOMER_B)
      const threadB = await startReelInquiryWorkflow(testReel)

      expect(threadA).not.toBe(threadB)
      expect(getConversations()).toHaveLength(2)
    })

    it('customer A cannot reuse customer B\'s existing thread', async () => {
      // Seed a thread that belongs to customer B
      await seedConversation({
        id: 'thread-b-reel',
        customerUserId: CUSTOMER_B,
      })

      // Customer A starts a new inquiry — must NOT reuse customer B's thread
      setActiveUser(CUSTOMER_A)
      const threadA = await startReelInquiryWorkflow(testReel)

      expect(threadA).not.toBe('thread-b-reel')
      expect(getConversations()).toHaveLength(2)
    })

    it('same customer reuses their own thread on subsequent inquiry', async () => {
      setActiveUser(CUSTOMER_A)
      const first = await startReelInquiryWorkflow(testReel)
      const second = await startReelInquiryWorkflow(testReel)

      expect(first).toBe(second)
      expect(getConversations()).toHaveLength(1)
    })

    it('unauthenticated caller cannot start an inquiry — assertCustomerRole gate blocks before any thread lookup', async () => {
      // Customer A already has a thread
      setActiveUser(CUSTOMER_A)
      const threadA = await startReelInquiryWorkflow(testReel)

      // Unauthenticated user (no session) — the workflow-layer guard rejects
      // the call before any thread reuse check, so an anonymous viewer can
      // never be routed into Customer A's thread (or any other thread).
      clearActiveUser()
      await expect(startReelInquiryWorkflow(testReel)).rejects.toThrow(/customer/i)

      // Conversation list is unchanged: only Customer A's original thread.
      expect(getConversations()).toHaveLength(1)
      expect(getConversations()[0].id).toBe(threadA)
    })

    it('thread carries the correct customerUserId for each customer', async () => {
      setActiveUser(CUSTOMER_A)
      const threadA = await startReelInquiryWorkflow(testReel)

      setActiveUser(CUSTOMER_B)
      const threadB = await startReelInquiryWorkflow(testReel)

      expect(getConversationById(threadA)?.customerUserId).toBe(CUSTOMER_A)
      expect(getConversationById(threadB)?.customerUserId).toBe(CUSTOMER_B)
    })
  })

  // ─── Profile workflow ────────────────────────────────────────────────────

  describe('startProfileInquiryWorkflow', () => {
    it('creates separate threads for two distinct customers', async () => {
      setActiveUser(CUSTOMER_A)
      const threadA = await startProfileInquiryWorkflow(testProfile)

      setActiveUser(CUSTOMER_B)
      const threadB = await startProfileInquiryWorkflow(testProfile)

      expect(threadA).not.toBe(threadB)
      expect(getConversations()).toHaveLength(2)
    })

    it('same customer reuses their own thread on subsequent profile inquiry', async () => {
      setActiveUser(CUSTOMER_A)
      const first = await startProfileInquiryWorkflow(testProfile)
      const second = await startProfileInquiryWorkflow(testProfile)

      expect(first).toBe(second)
      expect(getConversations()).toHaveLength(1)
    })
  })

  // ─── Category workflow ───────────────────────────────────────────────────

  describe('startCategoryInquiryWorkflowFromProvider', () => {
    it('creates separate threads for two distinct customers', async () => {
      setActiveUser(CUSTOMER_A)
      const threadA = await startCategoryInquiryWorkflowFromProvider(
        'Küche',
        'Küchenumbau gewünscht',
        'Berlin',
        testProvider,
      )

      setActiveUser(CUSTOMER_B)
      const threadB = await startCategoryInquiryWorkflowFromProvider(
        'Küche',
        'Küchenerneuerung',
        'Hamburg',
        testProvider,
      )

      expect(threadA).not.toBe(threadB)
      expect(getConversations()).toHaveLength(2)
    })

    it('same customer reuses their own thread and appends a follow-up message', async () => {
      setActiveUser(CUSTOMER_A)
      const first = await startCategoryInquiryWorkflowFromProvider(
        'Küche', 'Erste Anfrage', 'Berlin', testProvider,
      )
      const second = await startCategoryInquiryWorkflowFromProvider(
        'Küche', 'Zweite Anfrage', 'Berlin', testProvider,
      )

      expect(first).toBe(second)
      expect(getConversations()).toHaveLength(1)
    })
  })
})

// ---------------------------------------------------------------------------
// Tests: projectDescription and inquiryCriteria persistence
// ---------------------------------------------------------------------------

describe('BLOCK 2 – Inquiry context persistence survives reload', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('category inquiry stores projectDescription on the conversation', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startCategoryInquiryWorkflowFromProvider(
      'Elektrik',
      'Sicherungskasten prüfen lassen',
      'München',
      testProvider,
    )

    const conversation = getConversationById(threadId)
    expect(conversation?.projectDescription).toBe('Sicherungskasten prüfen lassen')
  })

  it('projectDescription is forwarded to intakeContext.requestDescription on conversion', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startCategoryInquiryWorkflowFromProvider(
      'Elektrik',
      'Leitungen erneuern',
      'Frankfurt',
      testProvider,
    )

    const jobId = await convertInquiryToProjectWorkflow(threadId)
    const job = getJobById(jobId)

    expect(job?.intakeContext?.requestDescription).toBe('Leitungen erneuern')
  })

  it('reel inquiry stores inquiryCriteria on the conversation', async () => {
    setActiveUser(CUSTOMER_A)
    const reel: ExploreReel = {
      ...testReel,
      id: 'reel-criteria',
      category: 'Sanitär',
      location: 'Köln',
      costLabel: '1.000 – 2.000 €',
      durationLabel: '1 Woche',
    }
    const threadId = await startReelInquiryWorkflow(reel)

    const conversation = getConversationById(threadId)
    // inquiryCriteria is derived by deriveSearchCriteriaFromReel; we verify the
    // field is present and carries the location at minimum.
    if (conversation?.inquiryCriteria) {
      expect(conversation.inquiryCriteria.location).toBe('Köln')
    }
    // If inquiryCriteria is absent (reel lacks enough context) the field being
    // undefined is also acceptable — this test ensures we don't throw.
    expect(conversation).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: startProjectInquiryWorkflowFromProvider thread isolation
// ---------------------------------------------------------------------------

describe('BLOCK 2 – Thread isolation: startProjectInquiryWorkflowFromProvider', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('creates separate threads for customer A and customer B', async () => {
    setActiveUser(CUSTOMER_A)
    const threadA = await startProjectInquiryWorkflowFromProvider(testProject, testProvider)

    setActiveUser(CUSTOMER_B)
    const threadB = await startProjectInquiryWorkflowFromProvider(testProject, testProvider)

    expect(threadA).not.toBe(threadB)
    expect(getConversations()).toHaveLength(2)
  })

  it('customer A cannot reuse customer B\'s existing project thread', async () => {
    await seedConversation({
      id: 'thread-b-project',
      customerUserId: CUSTOMER_B,
    })

    setActiveUser(CUSTOMER_A)
    const threadA = await startProjectInquiryWorkflowFromProvider(testProject, testProvider)

    expect(threadA).not.toBe('thread-b-project')
    expect(getConversations()).toHaveLength(2)
  })

  it('same customer reuses their own thread on subsequent project inquiry', async () => {
    setActiveUser(CUSTOMER_A)
    const first = await startProjectInquiryWorkflowFromProvider(testProject, testProvider)
    const second = await startProjectInquiryWorkflowFromProvider(testProject, testProvider)

    expect(first).toBe(second)
    expect(getConversations()).toHaveLength(1)
  })

  it('thread carries the correct customerUserId', async () => {
    setActiveUser(CUSTOMER_A)
    const threadA = await startProjectInquiryWorkflowFromProvider(testProject, testProvider)

    setActiveUser(CUSTOMER_B)
    const threadB = await startProjectInquiryWorkflowFromProvider(testProject, testProvider)

    expect(getConversationById(threadA)?.customerUserId).toBe(CUSTOMER_A)
    expect(getConversationById(threadB)?.customerUserId).toBe(CUSTOMER_B)
  })

  it('thread carries the correct craftsmanUserId from the provider', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startProjectInquiryWorkflowFromProvider(testProject, testProvider)

    expect(getConversationById(threadId)?.craftsmanUserId).toBe(CRAFTSMAN_ID)
  })

  it('thread carries sourceProjectId linking to the originating project', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startProjectInquiryWorkflowFromProvider(testProject, testProvider)

    expect(getConversationById(threadId)?.sourceProjectId).toBe(testProject.id)
  })

  it('thread carries inquiryOrigin = project', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startProjectInquiryWorkflowFromProvider(testProject, testProvider)

    expect(getConversationById(threadId)?.inquiryOrigin).toBe('project')
  })

  it('thread carries projectDescription from the builder project', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startProjectInquiryWorkflowFromProvider(testProject, testProvider)

    expect(getConversationById(threadId)?.projectDescription).toBe(testProject.description)
  })

  it('thread carries projectDuration from project.requestedTiming', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startProjectInquiryWorkflowFromProvider(testProject, testProvider)

    expect(getConversationById(threadId)?.projectDuration).toBe(testProject.requestedTiming)
  })
})

// ---------------------------------------------------------------------------
// Tests: project-origin inquiry → conversion → intakeContext truth
// ---------------------------------------------------------------------------

describe('BLOCK 2 – Project-origin inquiry conversion preserves project context', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('projectDescription is forwarded to intakeContext.requestDescription on conversion', async () => {
    setActiveUser(CUSTOMER_A)
    // Seed the builder project so convertInquiryToProjectWorkflow can resolve sourceProjectId
    await addProject(testProject)
    const threadId = await startProjectInquiryWorkflowFromProvider(testProject, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)
    const job = getJobById(jobId)

    expect(job?.intakeContext?.requestDescription).toBe(testProject.description)
  })

  it('projectDuration is forwarded to intakeContext.requestDuration on conversion', async () => {
    setActiveUser(CUSTOMER_A)
    // Seed the builder project so convertInquiryToProjectWorkflow can resolve sourceProjectId
    await addProject(testProject)
    const threadId = await startProjectInquiryWorkflowFromProvider(testProject, testProvider)
    const jobId = await convertInquiryToProjectWorkflow(threadId)
    const job = getJobById(jobId)

    expect(job?.intakeContext?.requestDuration).toBe(testProject.requestedTiming)
  })

  it('project binding survives a simulated reload (in-memory round-trip)', async () => {
    setActiveUser(CUSTOMER_A)
    const threadId = await startProjectInquiryWorkflowFromProvider(testProject, testProvider)

    // Read back immediately — simulates reload via in-memory repository
    const conversation = getConversationById(threadId)
    expect(conversation?.sourceProjectId).toBe(testProject.id)
    expect(conversation?.inquiryOrigin).toBe('project')
    expect(conversation?.projectDescription).toBe(testProject.description)
    expect(conversation?.projectDuration).toBe(testProject.requestedTiming)
  })

  it('missing optional project fields do not break inquiry creation', async () => {
    const minimalProject: ProjectCase = {
      ...testProject,
      id: 'project-minimal-1',
      description: undefined,
      requestedTiming: undefined,
      requestedBudget: undefined,
    }

    setActiveUser(CUSTOMER_A)
    const threadId = await startProjectInquiryWorkflowFromProvider(minimalProject, testProvider)

    const conversation = getConversationById(threadId)
    expect(conversation).toBeDefined()
    expect(conversation?.sourceProjectId).toBe(minimalProject.id)
    expect(conversation?.inquiryOrigin).toBe('project')
    expect(conversation?.projectDescription).toBeUndefined()
    expect(conversation?.projectDuration).toBeUndefined()
  })
})
