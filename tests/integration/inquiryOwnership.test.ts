/**
 * Integration tests: Flows A & B — Inquiry / Conversation / Job Ownership
 *
 * Validates that:
 * - Conversations created via explore inquiry workflows carry the correct
 *   inquiry origin and craftsman identity fields.
 * - convertInquiryToProjectWorkflow propagates customerUserId and
 *   craftsmanUserId from the conversation to the resulting job.
 * - The sourceProject.customerUserId priority chain is respected when a
 *   builder-origin project exists.
 * - The resulting job starts in 'new' status with 'deposit_required' payment
 *   state and an intakeContext that reflects the inquiry origin.
 * - The conversion is idempotent: calling it twice returns the existing job.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { mockCustomerSession, installMockSession } from '../helpers/mockSession'

import {
  convertInquiryToProjectWorkflow,
  startReelInquiryWorkflow,
  startProfileInquiryWorkflow,
  startCategoryInquiryWorkflowFromProvider,
  startProjectInquiryWorkflowFromProvider,
} from '../../src/lib/workflow/exploreInquiryWorkflow'

import { addConversation, getConversationById, getConversations } from '../../src/lib/messages'
import { getJobs, getJobById } from '../../src/lib/jobs'
import { getProjectRepository } from '../../src/lib/projects/repository/registry'

import type { Conversation } from '../../src/lib/messages/types'
import type { ExploreReel, ExploreProviderCard } from '../../src/lib/explore/exploreTypes'
import type { ExploreCraftsmanProfile } from '../../src/lib/explore/exploreProfileService'
import type { Project } from '../../src/lib/projects/projectTypes'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CRAFTSMAN_HANDLE = 'meister-bauer'
const CRAFTSMAN_ID = 'user-craftsman-1'
const CUSTOMER_USER_ID = 'user-customer-abc'

const testReel: ExploreReel = {
  id: 'reel-1',
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'Hans Bauer',
  craftsmanHandle: CRAFTSMAN_HANDLE,
  craftsmanAvatarUrl: 'https://example.com/avatar.jpg',
  title: 'Badezimmer Renovierung',
  category: 'Bad',
  location: 'München',
  thumbnailUrl: 'https://example.com/thumb.jpg',
  likes: 10,
  saves: 2,
  projectTags: ['bad', 'fliesen'],
  searchTags: ['bad'],
  costLabel: '2.000 – 4.000 €',
  durationLabel: '2 Wochen',
  createdAt: Date.now(),
}

const testProfile: ExploreCraftsmanProfile = {
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'Hans Bauer',
  craftsmanHandle: CRAFTSMAN_HANDLE,
  craftsmanAvatarUrl: 'https://example.com/avatar.jpg',
  location: 'München',
  primaryCategory: 'Bad',
  bio: 'Professioneller Handwerker',
  tradeCategories: ['Bad', 'Sanitär'],
  reels: [],
  portfolioItems: [],
  trust: {
    completedJobsCount: 5,
    wouldHireAgainCount: 4,
    totalFeedbackCount: 4,
    hasPlatformBackedCompletion: true,
    badges: [],
  },
  stats: {
    reels: 0,
    likes: 0,
    saves: 0,
    completedJobs: 5,
    wouldHireAgainCount: 4,
  },
}

const testProvider: ExploreProviderCard = {
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'Hans Bauer',
  craftsmanHandle: CRAFTSMAN_HANDLE,
  craftsmanAvatarUrl: 'https://example.com/avatar.jpg',
  location: 'München',
  primaryCategory: 'Bad',
  tradeCategories: ['Bad', 'Sanitär'],
  servicesOffered: ['Badsanierung'],
  serviceRadiusKm: 50,
}

/** Seeds a conversation with the given fields into the in-memory repository. */
function seedConversation(overrides: Partial<Conversation> & { id: string }): Conversation {
  const conv: Conversation = {
    id: overrides.id,
    projectId: overrides.projectId ?? `project-${overrides.id}`,
    customerName: overrides.customerName ?? 'Test Kunde',
    customerAvatarUrl: overrides.customerAvatarUrl ?? '',
    craftsmanName: overrides.craftsmanName ?? 'Test Handwerker',
    craftsmanHandle: overrides.craftsmanHandle ?? 'test-handle',
    craftsmanAvatarUrl: overrides.craftsmanAvatarUrl ?? '',
    projectTitle: overrides.projectTitle ?? 'Test Projekt',
    projectSubtitle: overrides.projectSubtitle ?? 'Neue Anfrage',
    projectStatusLabel: overrides.projectStatusLabel ?? 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: overrides.inquiryOrigin,
    customerUserId: overrides.customerUserId,
    craftsmanUserId: overrides.craftsmanUserId,
    sourceProjectId: overrides.sourceProjectId,
    projectDescription: overrides.projectDescription,
    projectLocation: overrides.projectLocation,
    projectCostRange: overrides.projectCostRange,
    projectDuration: overrides.projectDuration,
    inquiryCriteria: overrides.inquiryCriteria,
  }
  addConversation(conv)
  return conv
}

/** Seeds a project into the in-memory repository. */
function seedProject(id: string, customerUserId: string): Project {
  const project: Project = {
    id,
    sourceJobId: '',
    title: 'Builder Projekt',
    customer: 'Kunde',
    craftsman: '',
    location: 'Berlin',
    dateLabel: 'Offen',
    price: '2.000 €',
    status: 'request',
    paymentState: 'deposit_required',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    customerUserId,
    source: 'builder',
  }
  getProjectRepository().add(project)
  return project
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Inquiry → Conversation → Job Ownership (Flows A & B)', () => {
  beforeEach(() => {
    setupCleanRepositories()
    // Inquiry workflows enforce assertCustomerRole(); install a customer session
    // so the integration scenarios model the realistic caller identity.
    installMockSession(mockCustomerSession(CUSTOMER_USER_ID))
  })

  // ---- Flow A: Direct conversation ownership propagation -----------------

  describe('convertInquiryToProjectWorkflow – ownership propagation', () => {
    it('propagates customerUserId from conversation to resulting job', async () => {
      seedConversation({
        id: 'thread-own-1',
        customerUserId: CUSTOMER_USER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        inquiryOrigin: 'reel',
      })

      const jobId = await convertInquiryToProjectWorkflow('thread-own-1')

      expect(jobId).not.toBeNull()
      const job = getJobById(jobId!)
      expect(job?.customerUserId).toBe(CUSTOMER_USER_ID)
    })

    it('propagates craftsmanUserId from conversation to resulting job', async () => {
      seedConversation({
        id: 'thread-own-2',
        customerUserId: CUSTOMER_USER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        inquiryOrigin: 'profile',
      })

      const jobId = await convertInquiryToProjectWorkflow('thread-own-2')

      expect(jobId).not.toBeNull()
      const job = getJobById(jobId!)
      expect(job?.craftsmanUserId).toBe(CRAFTSMAN_ID)
    })

    it('returns null when the thread does not exist', async () => {
      const result = await convertInquiryToProjectWorkflow('thread-nonexistent')
      expect(result).toBeNull()
    })

    it('is idempotent – second call returns the existing job ID', async () => {
      seedConversation({
        id: 'thread-own-3',
        customerUserId: CUSTOMER_USER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        inquiryOrigin: 'reel',
      })

      const first = await convertInquiryToProjectWorkflow('thread-own-3')
      const second = await convertInquiryToProjectWorkflow('thread-own-3')

      expect(first).not.toBeNull()
      expect(first).toBe(second)
      expect(getJobs()).toHaveLength(1)
    })

    it('resulting job starts in "new" status with "deposit_required" payment state', async () => {
      seedConversation({
        id: 'thread-own-4',
        customerUserId: CUSTOMER_USER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        inquiryOrigin: 'category',
      })

      const jobId = await convertInquiryToProjectWorkflow('thread-own-4')
      const job = getJobById(jobId)

      expect(job?.status).toBe('new')
      expect(job?.paymentState).toBe('deposit_required')
    })

    it('sets intakeContext.origin to "inquiry_reel" for reel inquiries', async () => {
      seedConversation({
        id: 'thread-own-5',
        inquiryOrigin: 'reel',
        customerUserId: CUSTOMER_USER_ID,
      })

      const jobId = await convertInquiryToProjectWorkflow('thread-own-5')
      const job = getJobById(jobId)

      expect(job?.intakeContext?.origin).toBe('inquiry_reel')
    })

    it('sets intakeContext.origin to "inquiry_profile" for profile inquiries', async () => {
      seedConversation({
        id: 'thread-own-6',
        inquiryOrigin: 'profile',
        customerUserId: CUSTOMER_USER_ID,
      })

      const jobId = await convertInquiryToProjectWorkflow('thread-own-6')
      const job = getJobById(jobId)

      expect(job?.intakeContext?.origin).toBe('inquiry_profile')
    })

    it('sets intakeContext.origin to "inquiry_category" for category inquiries', async () => {
      seedConversation({
        id: 'thread-own-7',
        inquiryOrigin: 'category',
        projectDescription: 'Ich brauche Elektriker',
        customerUserId: CUSTOMER_USER_ID,
      })

      const jobId = await convertInquiryToProjectWorkflow('thread-own-7')
      const job = getJobById(jobId)

      expect(job?.intakeContext?.origin).toBe('inquiry_category')
    })

    it('sets intakeContext.requestDescription from projectDescription', async () => {
      seedConversation({
        id: 'thread-own-8',
        inquiryOrigin: 'category',
        projectDescription: 'Fliesen verlegen im Bad',
        customerUserId: CUSTOMER_USER_ID,
      })

      const jobId = await convertInquiryToProjectWorkflow('thread-own-8')
      const job = getJobById(jobId)

      expect(job?.intakeContext?.requestDescription).toBe('Fliesen verlegen im Bad')
    })

    it('uses conversation without customerUserId when none is set (no session)', async () => {
      seedConversation({
        id: 'thread-own-9',
        craftsmanUserId: CRAFTSMAN_ID,
        inquiryOrigin: 'reel',
        // no customerUserId
      })

      const jobId = await convertInquiryToProjectWorkflow('thread-own-9')
      const job = getJobById(jobId)

      expect(job).toBeDefined()
      expect(job?.craftsmanUserId).toBe(CRAFTSMAN_ID)
      expect(job?.customerUserId).toBeUndefined()
    })
  })

  // ---- sourceProject.customerUserId priority chain -----------------------

  describe('sourceProject.customerUserId takes priority over conversation.customerUserId', () => {
    it('uses sourceProject.customerUserId when project exists', async () => {
      const sourceCustomerId = 'user-project-owner'
      const conversationCustomerId = 'user-conversation-owner'

      seedProject('proj-builder-1', sourceCustomerId)

      seedConversation({
        id: 'thread-proj-1',
        customerUserId: conversationCustomerId,
        craftsmanUserId: CRAFTSMAN_ID,
        sourceProjectId: 'proj-builder-1',
        inquiryOrigin: 'project',
      })

      const jobId = await convertInquiryToProjectWorkflow('thread-proj-1')
      const job = getJobById(jobId)

      expect(job?.customerUserId).toBe(sourceCustomerId)
    })

    it('rejects and removes the job when sourceProject is not found', async () => {
      seedConversation({
        id: 'thread-proj-2',
        customerUserId: CUSTOMER_USER_ID,
        craftsmanUserId: CRAFTSMAN_ID,
        sourceProjectId: 'proj-nonexistent',
        inquiryOrigin: 'project',
      })

      const jobsBefore = getJobs().length
      await expect(convertInquiryToProjectWorkflow('thread-proj-2')).rejects.toThrow(
        /sourceProjectId.*not found/
      )
      // Compensation must have cleaned up the job that was temporarily created.
      expect(getJobs().length).toBe(jobsBefore)
    })

    it('links sourceProject to resulting job via sourceJobId', async () => {
      seedProject('proj-builder-2', 'user-builder')

      seedConversation({
        id: 'thread-proj-3',
        customerUserId: 'user-builder',
        craftsmanUserId: CRAFTSMAN_ID,
        sourceProjectId: 'proj-builder-2',
        inquiryOrigin: 'project',
      })

      const jobId = await convertInquiryToProjectWorkflow('thread-proj-3')

      const project = getProjectRepository().getById('proj-builder-2')
      expect(project?.sourceJobId).toBe(jobId)
    })

    it('stamps craftsmanUserId on the source project when linking', async () => {
      seedProject('proj-builder-3', 'user-builder')

      seedConversation({
        id: 'thread-proj-4',
        customerUserId: 'user-builder',
        craftsmanUserId: CRAFTSMAN_ID,
        sourceProjectId: 'proj-builder-3',
        inquiryOrigin: 'project',
      })

      await convertInquiryToProjectWorkflow('thread-proj-4')

      const project = getProjectRepository().getById('proj-builder-3')
      expect(project?.craftsmanUserId).toBe(CRAFTSMAN_ID)
    })
  })

  // ---- Flow B: Provider-card / profile / category inquiry workflows ------

  describe('startReelInquiryWorkflow (Flow A: reel-origin)', () => {
    it('creates a conversation with the correct inquiry origin', async () => {
      const threadId = await startReelInquiryWorkflow(testReel)

      const conversation = getConversationById(threadId)
      expect(conversation).toBeDefined()
      expect(conversation?.inquiryOrigin).toBe('reel')
    })

    it('stamps craftsmanUserId from reel.craftsmanId', async () => {
      const threadId = await startReelInquiryWorkflow(testReel)

      const conversation = getConversationById(threadId)
      expect(conversation?.craftsmanUserId).toBe(CRAFTSMAN_ID)
    })

    it('reuses existing thread for the same craftsman handle', async () => {
      const first = await startReelInquiryWorkflow(testReel)
      const second = await startReelInquiryWorkflow(testReel)

      expect(first).toBe(second)
      expect(getConversations()).toHaveLength(1)
    })

    it('resulting job has inquiry_reel origin in intakeContext after conversion', async () => {
      const threadId = await startReelInquiryWorkflow(testReel)
      const jobId = await convertInquiryToProjectWorkflow(threadId)

      const job = getJobById(jobId)
      expect(job?.intakeContext?.origin).toBe('inquiry_reel')
    })

    it('resulting job carries craftsmanUserId after conversion', async () => {
      const threadId = await startReelInquiryWorkflow(testReel)
      const jobId = await convertInquiryToProjectWorkflow(threadId)

      const job = getJobById(jobId)
      expect(job?.craftsmanUserId).toBe(CRAFTSMAN_ID)
    })
  })

  describe('startProfileInquiryWorkflow (Flow B: profile-origin)', () => {
    it('creates a conversation with profile inquiry origin', async () => {
      const threadId = await startProfileInquiryWorkflow(testProfile)

      const conversation = getConversationById(threadId)
      expect(conversation?.inquiryOrigin).toBe('profile')
    })

    it('stamps craftsmanUserId from profile.craftsmanId', async () => {
      const threadId = await startProfileInquiryWorkflow(testProfile)

      const conversation = getConversationById(threadId)
      expect(conversation?.craftsmanUserId).toBe(CRAFTSMAN_ID)
    })

    it('reuses existing thread for the same craftsman handle', async () => {
      const first = await startProfileInquiryWorkflow(testProfile)
      const second = await startProfileInquiryWorkflow(testProfile)

      expect(first).toBe(second)
      expect(getConversations()).toHaveLength(1)
    })

    it('resulting job has inquiry_profile origin in intakeContext after conversion', async () => {
      const threadId = await startProfileInquiryWorkflow(testProfile)
      const jobId = await convertInquiryToProjectWorkflow(threadId)

      const job = getJobById(jobId)
      expect(job?.intakeContext?.origin).toBe('inquiry_profile')
    })
  })

  describe('startCategoryInquiryWorkflowFromProvider (Flow B: category-origin)', () => {
    it('creates a conversation with category inquiry origin', async () => {
      const threadId = await startCategoryInquiryWorkflowFromProvider(
        'Elektrik',
        'Steckdosen erneuern',
        'München',
        testProvider,
      )

      const conversation = getConversationById(threadId)
      expect(conversation?.inquiryOrigin).toBe('category')
    })

    it('stamps craftsmanUserId from provider.craftsmanId', async () => {
      const threadId = await startCategoryInquiryWorkflowFromProvider(
        'Elektrik',
        'Kabelverlegung',
        'Hamburg',
        testProvider,
      )

      const conversation = getConversationById(threadId)
      expect(conversation?.craftsmanUserId).toBe(CRAFTSMAN_ID)
    })

    it('stores projectDescription from the request description', async () => {
      const threadId = await startCategoryInquiryWorkflowFromProvider(
        'Bad',
        'Badewanne einbauen',
        'Berlin',
        testProvider,
      )

      const conversation = getConversationById(threadId)
      expect(conversation?.projectDescription).toBe('Badewanne einbauen')
    })

    it('resulting job has inquiry_category origin in intakeContext after conversion', async () => {
      const threadId = await startCategoryInquiryWorkflowFromProvider(
        'Bad',
        'Dusche reparieren',
        'Frankfurt',
        testProvider,
      )
      const jobId = await convertInquiryToProjectWorkflow(threadId)

      const job = getJobById(jobId)
      expect(job?.intakeContext?.origin).toBe('inquiry_category')
    })

    it('attaches sourceProjectId to conversation when provided', async () => {
      seedProject('proj-src-1', CUSTOMER_USER_ID)

      const threadId = await startCategoryInquiryWorkflowFromProvider(
        'Elektrik',
        'Sicherungskasten prüfen',
        'München',
        testProvider,
        'proj-src-1',
      )

      const conversation = getConversationById(threadId)
      expect(conversation?.sourceProjectId).toBe('proj-src-1')
    })
  })

  describe('startProjectInquiryWorkflowFromProvider (Flow B: project-origin)', () => {
    it('creates a conversation with project inquiry origin', async () => {
      seedProject('proj-from-1', CUSTOMER_USER_ID)

      const project = getProjectRepository().getById('proj-from-1')!
      const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)

      const conversation = getConversationById(threadId)
      expect(conversation?.inquiryOrigin).toBe('project')
    })

    it('links the conversation to the source project', async () => {
      seedProject('proj-from-2', CUSTOMER_USER_ID)

      const project = getProjectRepository().getById('proj-from-2')!
      const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)

      const conversation = getConversationById(threadId)
      expect(conversation?.sourceProjectId).toBe('proj-from-2')
    })

    it('resulting job has inquiry_project origin in intakeContext after conversion', async () => {
      seedProject('proj-from-3', CUSTOMER_USER_ID)

      const project = getProjectRepository().getById('proj-from-3')!
      const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
      const jobId = await convertInquiryToProjectWorkflow(threadId)

      const job = getJobById(jobId)
      expect(job?.intakeContext?.origin).toBe('inquiry_project')
    })

    it('resulting job uses sourceProject.customerUserId for ownership', async () => {
      seedProject('proj-from-4', CUSTOMER_USER_ID)

      const project = getProjectRepository().getById('proj-from-4')!
      const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
      const jobId = await convertInquiryToProjectWorkflow(threadId)

      const job = getJobById(jobId)
      expect(job?.customerUserId).toBe(CUSTOMER_USER_ID)
    })

    it('resulting job has craftsmanUserId from provider', async () => {
      seedProject('proj-from-5', CUSTOMER_USER_ID)

      const project = getProjectRepository().getById('proj-from-5')!
      const threadId = await startProjectInquiryWorkflowFromProvider(project, testProvider)
      const jobId = await convertInquiryToProjectWorkflow(threadId)

      const job = getJobById(jobId)
      expect(job?.craftsmanUserId).toBe(CRAFTSMAN_ID)
    })
  })
})
