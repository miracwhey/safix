/**
 * Profile-origin inquiry: no fake project shell
 *
 * Validates the canonical flow for profile-origin inquiries:
 *   1. Profile inquiry → conversation/thread only (no project)
 *   2. No fake project card/detail for raw profile inquiry
 *   3. Craftsman can send offer from raw inquiry without project-completeness validation
 *   4. Customer home does not show a fake project for raw inquiry
 *   5. Real project only exists once the offer is accepted
 *   6. No regression to offer sent/accepted/payment semantics
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installMockSession, mockCustomerSession, resetMockSession } from '../helpers/mockSession'

import {
  startProfileInquiryWorkflow,
  convertInquiryToProjectWorkflow,
} from '../../src/lib/workflow/exploreInquiryWorkflow'

import {
  createOfferWorkflow,
  acceptOfferWorkflow,
} from '../../src/lib/workflow/offerWorkflow'

import {
  addConversation,
  getConversationById,
  updateConversation,
} from '../../src/lib/messages'

import {
  getThreadConversionState,
} from '../../src/lib/messages/selectors'

import { getJobById, getJobs } from '../../src/lib/jobs'
import { getProjectByJobId, getProjects } from '../../src/lib/projects'
import { isValidProjectId } from '../../src/lib/projects/projectId'
import { deriveProposalReadiness } from '../../src/lib/jobs/proposalReadinessSelectors'
import { getJobContextForThread } from '../../src/lib/workflow/messageWorkflow'
import { getOfferById } from '../../src/lib/offers'

import type { ExploreCraftsmanProfile } from '../../src/lib/explore/exploreProfileService'
import type { Conversation } from '../../src/lib/messages/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CRAFTSMAN_ID = 'craftsman-profile-test'
const CRAFTSMAN_HANDLE = 'meister-profil'
const CUSTOMER_USER_ID = 'customer-profile-test'

const testProfile: ExploreCraftsmanProfile = {
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'Anna Profil',
  craftsmanHandle: CRAFTSMAN_HANDLE,
  craftsmanAvatarUrl: 'https://example.com/avatar.jpg',
  location: 'Berlin',
  primaryCategory: 'Elektrik',
  bio: 'Elektrikermeisterin',
  tradeCategories: ['Elektrik'],
  reels: [],
  portfolioItems: [],
  trust: {
    completedJobsCount: 5,
    wouldHireAgainCount: 5,
    totalFeedbackCount: 5,
    hasPlatformBackedCompletion: true,
    badges: [],
  },
  stats: {
    reels: 0,
    likes: 0,
    saves: 0,
    completedJobs: 5,
    wouldHireAgainCount: 5,
  },
}

function makeProfileConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-profile-test',
    projectId: `project_profile_${CRAFTSMAN_ID}_conv-profile-test`,
    customerName: 'Max Tester',
    customerAvatarUrl: '',
    customerUserId: CUSTOMER_USER_ID,
    craftsmanName: 'Anna Profil',
    craftsmanHandle: CRAFTSMAN_HANDLE,
    craftsmanAvatarUrl: '',
    craftsmanUserId: CRAFTSMAN_ID,
    projectTitle: 'Anfrage an Anna Profil',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Berlin',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'profile',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  setupCleanRepositories()
  // H13: the installed session user must match the suite's customer —
  // acceptOfferWorkflow now enforces offer.customerUserId === caller.
  installMockSession(mockCustomerSession(CUSTOMER_USER_ID))
})

afterEach(() => {
  resetMockSession()
})

// ---------------------------------------------------------------------------
// REQ 1: Profile-origin inquiry renders as inquiry/thread only
// ---------------------------------------------------------------------------

describe('REQ 1 – Profile inquiry is inquiry/thread only', () => {
  it('profile inquiry creates a conversation but no project', async () => {
    const threadId = await startProfileInquiryWorkflow(testProfile)

    const conversation = getConversationById(threadId)
    expect(conversation).toBeDefined()
    expect(conversation!.inquiryOrigin).toBe('profile')

    // No projects should exist
    expect(getProjects()).toHaveLength(0)
  })

  it('conversation has a synthetic (non-UUID) projectId', async () => {
    const threadId = await startProfileInquiryWorkflow(testProfile)

    const conversation = getConversationById(threadId)
    expect(conversation!.projectId).toContain('project_profile_')
    expect(isValidProjectId(conversation!.projectId)).toBe(false)
  })

  it('thread conversion state is "inquiry" for raw profile inquiry', async () => {
    const threadId = await startProfileInquiryWorkflow(testProfile)

    const state = getThreadConversionState(threadId)
    expect(state).toBe('inquiry')
  })
})

// ---------------------------------------------------------------------------
// REQ 2: No fake project card/detail target for raw profile inquiry
// ---------------------------------------------------------------------------

describe('REQ 2 – No fake project for raw profile inquiry', () => {
  it('no project entity exists for a raw profile inquiry', async () => {
    const threadId = await startProfileInquiryWorkflow(testProfile)

    expect(getProjects()).toHaveLength(0)

    // The synthetic projectId does NOT correspond to any real project
    const conversation = getConversationById(threadId)
    const project = getProjects().find((p) => p.id === conversation!.projectId)
    expect(project).toBeUndefined()
  })

  it('conversion creates job but NO project for profile inquiry', async () => {
    const threadId = await startProfileInquiryWorkflow(testProfile)
    const jobId = await convertInquiryToProjectWorkflow(threadId)

    // Job exists
    const job = getJobById(jobId!)
    expect(job).toBeDefined()

    // No project exists
    const project = getProjectByJobId(jobId!)
    expect(project).toBeUndefined()
    expect(getProjects()).toHaveLength(0)
  })

  it('getJobContextForThread returns null customerProjectId for profile inquiry', async () => {
    const conv = makeProfileConversation()
    await addConversation(conv)
    await convertInquiryToProjectWorkflow(conv.id)

    const jobContext = getJobContextForThread(conv.id)
    expect(jobContext).toBeDefined()
    expect(jobContext!.customerProjectId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// REQ 3: Craftsman can send offer without project-completeness validation
// ---------------------------------------------------------------------------

describe('REQ 3 – Offer send not gated on project completeness', () => {
  it('profile-origin job has intake prerequisite always satisfied', async () => {
    const conv = makeProfileConversation()
    await addConversation(conv)
    const jobId = await convertInquiryToProjectWorkflow(conv.id)

    const job = getJobById(jobId!)!
    const readiness = deriveProposalReadiness(job)

    // Intake prerequisite should be satisfied for profile-origin jobs
    const intakePrereq = readiness.prerequisites.find((p) => p.id === 'intake')
    expect(intakePrereq).toBeDefined()
    expect(intakePrereq!.satisfied).toBe(true)
  })

  it('craftsman can create offer directly from thread without conversion', async () => {
    const conv = makeProfileConversation()
    await addConversation(conv)

    // No conversion, no job — just send an offer directly
    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: CUSTOMER_USER_ID,
      craftsmanUserId: CRAFTSMAN_ID,
      price: '1.200 €',
      description: 'Elektro-Installation',
    })

    expect(offer).toBeDefined()
    expect(offer.status).toBe('pending')
    expect(offer.price).toBe('1.200 €')
  })

  it('offer from raw profile inquiry does not require project or job to exist', async () => {
    const conv = makeProfileConversation()
    await addConversation(conv)

    // Before offer: no jobs, no projects
    expect(getJobs()).toHaveLength(0)
    expect(getProjects()).toHaveLength(0)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: CUSTOMER_USER_ID,
      craftsmanUserId: CRAFTSMAN_ID,
      price: '800 €',
    })

    expect(offer.status).toBe('pending')
    // Still no projects
    expect(getProjects()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// REQ 4: Customer home does not show fake project for raw inquiry
// ---------------------------------------------------------------------------

describe('REQ 4 – No fake project on customer home', () => {
  it('no projects exist for raw profile inquiry', async () => {
    await startProfileInquiryWorkflow(testProfile)

    // Customer home uses getProjects() — should be empty
    expect(getProjects()).toHaveLength(0)
  })

  it('no projects exist after conversion of profile inquiry', async () => {
    const threadId = await startProfileInquiryWorkflow(testProfile)
    await convertInquiryToProjectWorkflow(threadId)

    // Still no projects for customer home
    expect(getProjects()).toHaveLength(0)
  })

  it('no projects exist after sending offer on profile inquiry', async () => {
    const conv = makeProfileConversation()
    await addConversation(conv)

    await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: CUSTOMER_USER_ID,
      craftsmanUserId: CRAFTSMAN_ID,
      price: '2.500 €',
    })

    // Offer sent but not accepted — still no project
    expect(getProjects()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// REQ 5: Real project only appears once offer is accepted
// ---------------------------------------------------------------------------

describe('REQ 5 – Real project created at acceptance', () => {
  it('accepting offer creates real project with valid UUID', async () => {
    const conv = makeProfileConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: CUSTOMER_USER_ID,
      craftsmanUserId: CRAFTSMAN_ID,
      price: '3.000 €',
    })

    await acceptOfferWorkflow(offer.id)

    const projects = getProjects()
    expect(projects).toHaveLength(1)

    const project = projects[0]
    expect(isValidProjectId(project.id)).toBe(true)
    expect(project.sourceJobId).toBeDefined()
    expect(project.status).toBe('accepted')
  })

  it('accepted offer creates job with correct linkage', async () => {
    const conv = makeProfileConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: CUSTOMER_USER_ID,
      craftsmanUserId: CRAFTSMAN_ID,
      price: '3.000 €',
    })

    const accepted = await acceptOfferWorkflow(offer.id)
    expect(accepted!.createdJobId).toBeDefined()

    const job = getJobById(accepted!.createdJobId!)
    expect(job).toBeDefined()
    expect(job!.sourceConversationId).toBe(conv.id)

    const project = getProjectByJobId(job!.id)
    expect(project).toBeDefined()
    expect(project!.sourceJobId).toBe(job!.id)
  })

  it('thread shows job context after acceptance', async () => {
    const conv = makeProfileConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: CUSTOMER_USER_ID,
      craftsmanUserId: CRAFTSMAN_ID,
      price: '3.000 €',
    })

    await acceptOfferWorkflow(offer.id)

    const jobContext = getJobContextForThread(conv.id)
    expect(jobContext).toBeDefined()
    expect(jobContext!.customerProjectId).toBeDefined()
  })

  it('conversion state changes to "project" after acceptance', async () => {
    const conv = makeProfileConversation()
    await addConversation(conv)

    // Before acceptance
    expect(getThreadConversionState(conv.id)).toBe('inquiry')

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: CUSTOMER_USER_ID,
      craftsmanUserId: CRAFTSMAN_ID,
      price: '3.000 €',
    })

    await acceptOfferWorkflow(offer.id)

    // After acceptance — job exists, so conversion state is 'project'
    expect(getThreadConversionState(conv.id)).toBe('project')
  })
})

// ---------------------------------------------------------------------------
// REQ 6: No regression to accepted/payment-ready cases
// ---------------------------------------------------------------------------

describe('REQ 6 – No regression to accepted/payment semantics', () => {
  it('accepted offer has correct proposalSentAt and proposalAcceptedAt', async () => {
    const conv = makeProfileConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: CUSTOMER_USER_ID,
      craftsmanUserId: CRAFTSMAN_ID,
      price: '2.000 €',
    })

    await acceptOfferWorkflow(offer.id)

    const accepted = getOfferById(offer.id)!
    const job = getJobById(accepted.createdJobId!)!

    expect(job.proposalSentAt).toBeDefined()
    expect(job.proposalAcceptedAt).toBeDefined()
    expect(job.proposalAcceptedAt!).toBeGreaterThanOrEqual(job.proposalSentAt!)
  })

  it('project status is "accepted" after offer acceptance', async () => {
    const conv = makeProfileConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: CUSTOMER_USER_ID,
      craftsmanUserId: CRAFTSMAN_ID,
      price: '5.000 €',
    })

    await acceptOfferWorkflow(offer.id)

    const accepted = getOfferById(offer.id)!
    const project = getProjectByJobId(accepted.createdJobId!)!

    expect(project.status).toBe('accepted')
    expect(project.paymentState).toBe('deposit_required')
  })

  it('re-accepting already accepted offer is idempotent', async () => {
    const conv = makeProfileConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: CUSTOMER_USER_ID,
      craftsmanUserId: CRAFTSMAN_ID,
      price: '4.000 €',
    })

    await acceptOfferWorkflow(offer.id)
    const projectsBefore = getProjects().length

    await acceptOfferWorkflow(offer.id) // re-accept

    expect(getProjects()).toHaveLength(projectsBefore)
  })

  it('declined offer allows new offer to be created', async () => {
    const conv = makeProfileConversation()
    await addConversation(conv)

    const offer1 = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: CUSTOMER_USER_ID,
      craftsmanUserId: CRAFTSMAN_ID,
      price: '1.000 €',
    })

    const { declineOfferWorkflow } = await import('../../src/lib/workflow/offerWorkflow')
    await declineOfferWorkflow(offer1.id)

    // New offer can be created after decline
    const offer2 = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: CUSTOMER_USER_ID,
      craftsmanUserId: CRAFTSMAN_ID,
      price: '1.500 €',
    })

    expect(offer2.status).toBe('pending')
    expect(offer2.price).toBe('1.500 €')
  })

  it('full profile inquiry lifecycle: inquiry → offer → accept → project', async () => {
    const threadId = await startProfileInquiryWorkflow(testProfile)

    // In tests resolveCustomerUserId() returns undefined (no Supabase
    // session), but in production the customer is always authenticated.
    // Simulate that by patching the conversation.
    updateConversation(threadId, { customerUserId: CUSTOMER_USER_ID })

    // Step 1: Raw inquiry — no project
    expect(getProjects()).toHaveLength(0)
    expect(getThreadConversionState(threadId)).toBe('inquiry')

    // Step 2: Send offer from thread
    const conv = getConversationById(threadId)!
    const offer = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: conv.customerUserId!,
      craftsmanUserId: conv.craftsmanUserId!,
      price: '6.000 €',
      description: 'Komplette Elektro-Sanierung',
    })

    expect(offer.status).toBe('pending')
    expect(getProjects()).toHaveLength(0)

    // Step 3: Customer accepts offer
    await acceptOfferWorkflow(offer.id)

    // Step 4: Real project now exists
    const projects = getProjects()
    expect(projects).toHaveLength(1)

    const project = projects[0]
    expect(isValidProjectId(project.id)).toBe(true)
    expect(project.status).toBe('accepted')
    expect(project.source).toBe('inquiry')

    // Job is linked
    const accepted = getOfferById(offer.id)!
    const job = getJobById(accepted.createdJobId!)!
    expect(job.sourceConversationId).toBe(threadId)
    expect(getProjectByJobId(job.id)).toBeDefined()
  })
})
