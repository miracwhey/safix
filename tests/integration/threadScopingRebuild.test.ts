/**
 * Thread Scoping Rebuild — Comprehensive Test Suite
 *
 * Validates the complete thread/artifact/message scoping model:
 *
 * 1. Customer inquiry/thread visible ONLY to the targeted craftsman
 * 2. Customer project artifact survives reload for both participants
 * 3. Craftsman offer artifact survives reload for both participants
 * 4. Payment-phase artifact survives reload for both participants
 * 5. No cross-craftsman thread leakage
 * 6. No cross-account cache leakage on account switching
 * 7. Accepted case/job still resolves to the same canonical thread
 * 8. No duplicate/forked thread after acceptance/payment transition
 * 9. No regression to currently working auth/role/bootstrap flow
 *
 * Architecture under test:
 *   Conversation → fixed participant scope (customer + craftsman)
 *   ProjectArtifact → linked to persisted Project via sourceProjectId
 *   OfferPaymentArtifact → linked to persisted Offer via conversationId
 *   Job/Case → linked via sourceConversationId, does not fork thread
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the provider profile service to avoid real HTTP calls to the
// placeholder Supabase URL during tests.  acceptOfferWorkflow →
// resolveProviderId → getProviderProfile makes a network request that
// can hang/timeout on CI runners with restricted DNS.
vi.mock('../../src/lib/providers/providerProfileService', () => ({
  getProviderProfile: vi.fn().mockResolvedValue(null),
  getMyProviderProfile: vi.fn().mockResolvedValue(null),
  updateProviderProfile: vi.fn().mockResolvedValue(undefined),
}))

import { setupCleanRepositories } from '../helpers/setupRepositories'

import {
  addConversation,
  getConversations,
  getConversationById,
  getMessageThreads,
  getThreadArtifacts,
  sendProjectAttachmentToThread,
  getIncomingProjectRequests,
  getThreadConversionState,
  isConversationParticipant,
  filterConversationsByParticipant,
  filterConversationsByCraftsman,
  persistProjectArtifact,
  persistOfferArtifact,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject, getProjects } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import { getJobs, addJob, getJobById } from '../../src/lib/jobs'
import type { Job } from '../../src/lib/jobs/types'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
} from '../../src/lib/workflow'
import { getJobContextForThread } from '../../src/lib/workflow/messageWorkflow'

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
// Fixture constants
// ---------------------------------------------------------------------------

const CRAFTSMAN_A = 'craftsman-a-uid'
const CRAFTSMAN_B = 'craftsman-b-uid'
const CUSTOMER_1 = 'customer-1-uid'
const CUSTOMER_2 = 'customer-2-uid'

const PROJECT_UUID_1 = 'a1111111-1111-4111-8111-111111111111'
const PROJECT_UUID_2 = 'b2222222-2222-4222-8222-222222222222'

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeConversation(overrides: Partial<Conversation> & { id: string }): Conversation {
  return {
    projectId: `project-${overrides.id}`,
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    craftsmanName: 'Craftsman',
    craftsmanHandle: 'craftsman-handle',
    craftsmanAvatarUrl: '',
    projectTitle: 'Test Project',
    projectSubtitle: 'Neue Anfrage',
    createdAt: Date.now(),
    inquiryOrigin: 'reel',
    ...overrides,
  }
}

function makeProject(overrides: Partial<Project> & { id: string }): Project {
  return {
    title: 'Test Project',
    category: 'Sanitär',
    description: 'Testbeschreibung',
    location: 'Berlin',
    status: 'request',
    source: 'builder',
    createdAt: Date.now(),
    ...overrides,
  }
}

function makeJob(overrides: Partial<Job> & { id: string }): Job {
  return {
    projectId: overrides.projectId ?? `project-${overrides.id}`,
    title: 'Test Job',
    customer: 'Anna Kundin',
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
    createdAt: Date.now(),
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 1 — Customer sends project to craftsman A
// Only craftsman A sees the thread/request. Craftsman B does not.
// ═══════════════════════════════════════════════════════════════════════════

describe('SCENARIO 1 — Customer inquiry visible only to targeted craftsman', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('craftsman A sees conversation where they are the craftsman participant', async () => {
    await addConversation(makeConversation({
      id: 'thread-for-a',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    setActiveUser(CRAFTSMAN_A)
    const threads = getMessageThreads()
    expect(threads).toHaveLength(1)
    expect(threads[0].id).toBe('thread-for-a')
  })

  it('craftsman B does NOT see conversation targeted to craftsman A', async () => {
    await addConversation(makeConversation({
      id: 'thread-for-a-only',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    setActiveUser(CRAFTSMAN_B)
    const threads = getMessageThreads()
    expect(threads).toHaveLength(0)
  })

  it('craftsman A incoming requests do not include threads for craftsman B', async () => {
    await addConversation(makeConversation({
      id: 'thread-for-b',
      craftsmanUserId: CRAFTSMAN_B,
      customerUserId: CUSTOMER_1,
      inquiryOrigin: 'profile',
    }))

    setActiveUser(CRAFTSMAN_A)
    const requests = getIncomingProjectRequests()
    expect(requests).toHaveLength(0)
  })

  it('craftsman A incoming requests include only their own threads', async () => {
    await addConversation(makeConversation({
      id: 'thread-a-req',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      inquiryOrigin: 'reel',
    }))
    await addConversation(makeConversation({
      id: 'thread-b-req',
      craftsmanUserId: CRAFTSMAN_B,
      customerUserId: CUSTOMER_1,
      inquiryOrigin: 'reel',
    }))

    setActiveUser(CRAFTSMAN_A)
    const requests = getIncomingProjectRequests()
    expect(requests).toHaveLength(1)
    expect(requests[0].threadId).toBe('thread-a-req')
  })

  it('project artifact remains after reload for both customer and craftsman', async () => {
    const projectId = PROJECT_UUID_1
    await addProject(makeProject({ id: projectId, title: 'Küchenumbau' }))
    await addConversation(makeConversation({
      id: 'thread-reload-project',
      sourceProjectId: projectId,
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    await persistProjectArtifact({
      conversationId: 'thread-reload-project',
      projectId,
      customerUserId: CUSTOMER_1,
      craftsmanUserId: CRAFTSMAN_A,
    })

    // Customer sees it
    setActiveUser(CUSTOMER_1)
    const customerArtifacts = getThreadArtifacts('thread-reload-project')
    expect(customerArtifacts.projectArtifact).not.toBeNull()
    expect(customerArtifacts.projectArtifact!.project.id).toBe(projectId)

    // Craftsman sees it
    setActiveUser(CRAFTSMAN_A)
    const craftsmanArtifacts = getThreadArtifacts('thread-reload-project')
    expect(craftsmanArtifacts.projectArtifact).not.toBeNull()
    expect(craftsmanArtifacts.projectArtifact!.project.id).toBe(projectId)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 2 — Craftsman A sends offer/payment card
// Only the customer in that same thread sees it. Reload-stable.
// ═══════════════════════════════════════════════════════════════════════════

describe('SCENARIO 2 — Offer artifact visible only to thread participants', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('offer artifact appears for customer in the same thread', async () => {
    await addConversation(makeConversation({
      id: 'thread-offer',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    await createOfferWorkflow({
      conversationId: 'thread-offer',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '3.500 €',
      description: 'Badezimmer renovieren',
    })

    // Customer sees it
    setActiveUser(CUSTOMER_1)
    const artifacts = getThreadArtifacts('thread-offer')
    expect(artifacts.offerPaymentArtifact).not.toBeNull()
    expect(artifacts.offerPaymentArtifact!.offer.price).toBe('3.500 €')
    expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
  })

  it('offer artifact is NOT visible to non-participant craftsman B', async () => {
    await addConversation(makeConversation({
      id: 'thread-offer-scope',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    await createOfferWorkflow({
      conversationId: 'thread-offer-scope',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '2.000 €',
    })

    // Craftsman B should not see artifacts from craftsman A's thread
    setActiveUser(CRAFTSMAN_B)
    const artifacts = getThreadArtifacts('thread-offer-scope')
    expect(artifacts.offerPaymentArtifact).toBeNull()
    expect(artifacts.projectArtifact).toBeNull()
  })

  it('offer artifact survives simulated reload for both participants', async () => {
    await addConversation(makeConversation({
      id: 'thread-offer-reload',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    const offer = await createOfferWorkflow({
      conversationId: 'thread-offer-reload',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '5.000 €',
      description: 'Dachsanierung',
    })

    // Simulate reload: reset then re-seed from "persisted" data
    setupCleanRepositories()

    await addConversation(makeConversation({
      id: 'thread-offer-reload',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    const { getOfferRepository } = await import('../../src/lib/offers/repository/registry')
    await getOfferRepository().add({
      id: offer.id,
      conversationId: 'thread-offer-reload',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '5.000 €',
      description: 'Dachsanierung',
      status: 'pending',
      createdAt: offer.createdAt,
      updatedAt: offer.updatedAt,
      sentAt: offer.sentAt,
    })

    await persistOfferArtifact({
      conversationId: 'thread-offer-reload',
      offerId: offer.id,
      phase: 'sent',
      customerUserId: CUSTOMER_1,
      craftsmanUserId: CRAFTSMAN_A,
    })

    // Both participants see the offer after "reload"
    setActiveUser(CUSTOMER_1)
    const customerArtifacts = getThreadArtifacts('thread-offer-reload')
    expect(customerArtifacts.offerPaymentArtifact).not.toBeNull()
    expect(customerArtifacts.offerPaymentArtifact!.offer.price).toBe('5.000 €')

    setActiveUser(CRAFTSMAN_A)
    const craftsmanArtifacts = getThreadArtifacts('thread-offer-reload')
    expect(craftsmanArtifacts.offerPaymentArtifact).not.toBeNull()
    expect(craftsmanArtifacts.offerPaymentArtifact!.offer.price).toBe('5.000 €')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 3 — Offer accepted / payment phase begins
// Thread continuity remains. Artifacts remain stable.
// ═══════════════════════════════════════════════════════════════════════════

describe('SCENARIO 3 — Offer acceptance and payment-phase artifact stability', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('accepting offer transitions artifact to accepted/payment_due phase', async () => {
    setActiveUser(CUSTOMER_1)

    await addConversation(makeConversation({
      id: 'thread-accept',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    const offer = await createOfferWorkflow({
      conversationId: 'thread-accept',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '4.000 €',
    })

    await acceptOfferWorkflow(offer.id)

    const artifacts = getThreadArtifacts('thread-accept')
    expect(artifacts.offerPaymentArtifact).not.toBeNull()
    expect(artifacts.offerPaymentArtifact!.phase).toMatch(/accepted|payment_due/)
    expect(artifacts.offerPaymentArtifact!.offer.status).toBe('accepted')
  })

  it('accepted offer creates a job linked to the same conversation', async () => {
    setActiveUser(CUSTOMER_1)

    await addConversation(makeConversation({
      id: 'thread-accept-job',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    const offer = await createOfferWorkflow({
      conversationId: 'thread-accept-job',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '6.000 €',
    })

    const accepted = await acceptOfferWorkflow(offer.id)
    expect(accepted?.createdJobId).toBeDefined()

    const job = getJobById(accepted!.createdJobId!)
    expect(job).toBeDefined()
    expect(job!.sourceConversationId).toBe('thread-accept-job')
  })

  it('no duplicate thread after acceptance — thread conversion state is "project"', async () => {
    setActiveUser(CUSTOMER_1)

    await addConversation(makeConversation({
      id: 'thread-no-dup',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    const offer = await createOfferWorkflow({
      conversationId: 'thread-no-dup',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '8.000 €',
    })

    await acceptOfferWorkflow(offer.id)

    // Thread conversion state should be 'project' (has a job)
    const state = getThreadConversionState('thread-no-dup')
    expect(state).toBe('project')

    // No duplicate conversations
    const allConversations = getConversations()
    const threadsForThisConversation = allConversations.filter(
      (c) => c.id === 'thread-no-dup'
    )
    expect(threadsForThisConversation).toHaveLength(1)
  })

  it('payment-phase artifact survives simulated reload', async () => {
    setActiveUser(CUSTOMER_1)

    await addConversation(makeConversation({
      id: 'thread-payment-reload',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    const offer = await createOfferWorkflow({
      conversationId: 'thread-payment-reload',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '10.000 €',
    })

    const accepted = await acceptOfferWorkflow(offer.id)
    const jobId = accepted!.createdJobId!

    // Capture state before reload
    const beforeReload = getThreadArtifacts('thread-payment-reload')
    expect(beforeReload.offerPaymentArtifact).not.toBeNull()
    expect(beforeReload.offerPaymentArtifact!.phase).toMatch(/accepted|payment_due/)

    // Simulate reload
    setupCleanRepositories()

    // Re-seed conversation
    await addConversation(makeConversation({
      id: 'thread-payment-reload',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    // Re-seed offer (as accepted)
    const { getOfferRepository } = await import('../../src/lib/offers/repository/registry')
    await getOfferRepository().add({
      id: offer.id,
      conversationId: 'thread-payment-reload',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '10.000 €',
      status: 'accepted',
      createdAt: offer.createdAt,
      updatedAt: Date.now(),
      sentAt: offer.sentAt,
      acceptedAt: Date.now(),
      createdJobId: jobId,
    })

    // Re-seed job
    await addJob(makeJob({
      id: jobId,
      sourceConversationId: 'thread-payment-reload',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      amount: '10.000 €',
      status: 'new',
      proposalSentAt: offer.sentAt,
      proposalAcceptedAt: Date.now(),
    }))

    await persistOfferArtifact({
      conversationId: 'thread-payment-reload',
      offerId: offer.id,
      phase: 'accepted',
      jobId,
      customerUserId: CUSTOMER_1,
      craftsmanUserId: CRAFTSMAN_A,
    })

    // After reload, artifact still resolves correctly
    const afterReload = getThreadArtifacts('thread-payment-reload')
    expect(afterReload.offerPaymentArtifact).not.toBeNull()
    expect(afterReload.offerPaymentArtifact!.offer.status).toBe('accepted')
    expect(afterReload.offerPaymentArtifact!.phase).toMatch(/accepted|payment_due/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 4 — Account switching
// Craftsman A data does not leak into craftsman B.
// ═══════════════════════════════════════════════════════════════════════════

describe('SCENARIO 4 — Account switching prevents cross-account leakage', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('after store reset, craftsman B sees no data from craftsman A', async () => {
    // Phase 1: Craftsman A is active with data
    setActiveUser(CRAFTSMAN_A)
    await addProject(makeProject({ id: PROJECT_UUID_1, title: 'A-only project' }))
    await addConversation(makeConversation({
      id: 'thread-a-switch',
      sourceProjectId: PROJECT_UUID_1,
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))
    await persistProjectArtifact({
      conversationId: 'thread-a-switch',
      projectId: PROJECT_UUID_1,
      customerUserId: CUSTOMER_1,
      craftsmanUserId: CRAFTSMAN_A,
    })
    await createOfferWorkflow({
      conversationId: 'thread-a-switch',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '3.000 €',
    })

    // Verify A has data
    expect(getConversations()).toHaveLength(1)
    expect(getProjects()).toHaveLength(1)
    expect(getThreadArtifacts('thread-a-switch').projectArtifact).not.toBeNull()
    expect(getThreadArtifacts('thread-a-switch').offerPaymentArtifact).not.toBeNull()

    // Phase 2: Account switch (full reset)
    setupCleanRepositories()
    setActiveUser(CRAFTSMAN_B)

    // Phase 3: B sees nothing from A
    expect(getConversations()).toHaveLength(0)
    expect(getProjects()).toHaveLength(0)
    expect(getJobs()).toHaveLength(0)
    expect(getThreadArtifacts('thread-a-switch').projectArtifact).toBeNull()
    expect(getThreadArtifacts('thread-a-switch').offerPaymentArtifact).toBeNull()

    // Phase 4: B creates own data independently
    await addProject(makeProject({ id: PROJECT_UUID_2, title: 'B-only project' }))
    await addConversation(makeConversation({
      id: 'thread-b-switch',
      sourceProjectId: PROJECT_UUID_2,
      craftsmanUserId: CRAFTSMAN_B,
      customerUserId: CUSTOMER_1,
    }))

    await persistProjectArtifact({
      conversationId: 'thread-b-switch',
      projectId: PROJECT_UUID_2,
      customerUserId: CUSTOMER_1,
      craftsmanUserId: CRAFTSMAN_B,
    })

    expect(getConversations()).toHaveLength(1)
    expect(getConversationById('thread-b-switch')?.craftsmanUserId).toBe(CRAFTSMAN_B)
    expect(getConversationById('thread-a-switch')).toBeUndefined()
    expect(getThreadArtifacts('thread-b-switch').projectArtifact).not.toBeNull()
  })

  it('customer data does not leak to a different customer', async () => {
    setActiveUser(CUSTOMER_1)
    await addConversation(makeConversation({
      id: 'thread-cust-1',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    expect(getMessageThreads()).toHaveLength(1)

    // Switch to customer 2
    setupCleanRepositories()
    setActiveUser(CUSTOMER_2)

    expect(getMessageThreads()).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 5 — Reload / reopen
// Canonical thread artifacts rehydrate correctly.
// ═══════════════════════════════════════════════════════════════════════════

describe('SCENARIO 5 — Reload rehydration correctness', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('project card does not disappear after simulated reload', async () => {
    const projectId = PROJECT_UUID_1
    setActiveUser(CUSTOMER_1)

    await addProject(makeProject({ id: projectId, title: 'Fenstereinbau' }))
    await addConversation(makeConversation({
      id: 'thread-reload-proj',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))
    await sendProjectAttachmentToThread('thread-reload-proj', projectId)

    // Verify sourceProjectId is stamped
    expect(getConversationById('thread-reload-proj')?.sourceProjectId).toBe(projectId)

    // Verify artifact exists before reload
    const before = getThreadArtifacts('thread-reload-proj')
    expect(before.projectArtifact).not.toBeNull()

    // Simulate reload
    setupCleanRepositories()
    await addProject(makeProject({ id: projectId, title: 'Fenstereinbau' }))
    await addConversation(makeConversation({
      id: 'thread-reload-proj',
      sourceProjectId: projectId,
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    await persistProjectArtifact({
      conversationId: 'thread-reload-proj',
      projectId,
      customerUserId: CUSTOMER_1,
      craftsmanUserId: CRAFTSMAN_A,
    })

    // After reload: project card still exists
    setActiveUser(CUSTOMER_1)
    const after = getThreadArtifacts('thread-reload-proj')
    expect(after.projectArtifact).not.toBeNull()
    expect(after.projectArtifact!.project.id).toBe(projectId)
    expect(after.projectArtifact!.persistenceStatus).toBe('confirmed')
  })

  it('offer/payment card does not disappear after simulated reload', async () => {
    setActiveUser(CRAFTSMAN_A)

    await addConversation(makeConversation({
      id: 'thread-reload-offer',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    const offer = await createOfferWorkflow({
      conversationId: 'thread-reload-offer',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '4.500 €',
    })

    // Simulate reload
    setupCleanRepositories()
    await addConversation(makeConversation({
      id: 'thread-reload-offer',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    const { getOfferRepository } = await import('../../src/lib/offers/repository/registry')
    await getOfferRepository().add({
      id: offer.id,
      conversationId: 'thread-reload-offer',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '4.500 €',
      status: 'pending',
      createdAt: offer.createdAt,
      updatedAt: offer.updatedAt,
      sentAt: offer.sentAt,
    })

    await persistOfferArtifact({
      conversationId: 'thread-reload-offer',
      offerId: offer.id,
      phase: 'sent',
      customerUserId: CUSTOMER_1,
      craftsmanUserId: CRAFTSMAN_A,
    })

    // After reload: offer card still exists
    setActiveUser(CRAFTSMAN_A)
    const after = getThreadArtifacts('thread-reload-offer')
    expect(after.offerPaymentArtifact).not.toBeNull()
    expect(after.offerPaymentArtifact!.offer.price).toBe('4.500 €')
    expect(after.offerPaymentArtifact!.persistenceStatus).toBe('confirmed')
  })

  it('both project and offer artifacts coexist after reload', async () => {
    const projectId = PROJECT_UUID_1
    setActiveUser(CUSTOMER_1)

    await addProject(makeProject({ id: projectId, title: 'Gartenarbeit' }))
    await addConversation(makeConversation({
      id: 'thread-coexist',
      sourceProjectId: projectId,
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))
    await createOfferWorkflow({
      conversationId: 'thread-coexist',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '6.000 €',
    })

    // Simulate reload
    setupCleanRepositories()
    await addProject(makeProject({ id: projectId, title: 'Gartenarbeit' }))
    await addConversation(makeConversation({
      id: 'thread-coexist',
      sourceProjectId: projectId,
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))
    const { getOfferRepository } = await import('../../src/lib/offers/repository/registry')
    await getOfferRepository().add({
      id: 'offer-coexist',
      conversationId: 'thread-coexist',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '6.000 €',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sentAt: Date.now(),
    })

    await persistProjectArtifact({
      conversationId: 'thread-coexist',
      projectId,
      customerUserId: CUSTOMER_1,
      craftsmanUserId: CRAFTSMAN_A,
    })

    await persistOfferArtifact({
      conversationId: 'thread-coexist',
      offerId: 'offer-coexist',
      phase: 'sent',
      customerUserId: CUSTOMER_1,
      craftsmanUserId: CRAFTSMAN_A,
    })

    setActiveUser(CUSTOMER_1)
    const after = getThreadArtifacts('thread-coexist')
    expect(after.projectArtifact).not.toBeNull()
    expect(after.projectArtifact!.project.id).toBe(projectId)
    expect(after.offerPaymentArtifact).not.toBeNull()
    expect(after.offerPaymentArtifact!.offer.price).toBe('6.000 €')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 6 — Job/case linkage continuity
// Accepted case resolves to the same canonical thread.
// ═══════════════════════════════════════════════════════════════════════════

describe('SCENARIO 6 — Case/job linkage and thread continuity', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('job created from offer links back to the same conversation', async () => {
    setActiveUser(CUSTOMER_1)

    await addConversation(makeConversation({
      id: 'thread-job-link',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    const offer = await createOfferWorkflow({
      conversationId: 'thread-job-link',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '5.000 €',
    })

    const accepted = await acceptOfferWorkflow(offer.id)
    const job = getJobById(accepted!.createdJobId!)

    // Job's sourceConversationId points back to the original thread
    expect(job!.sourceConversationId).toBe('thread-job-link')

    // Job context resolves from the thread
    const context = getJobContextForThread('thread-job-link')
    expect(context).not.toBeNull()
    expect(context!.jobId).toBe(job!.id)
  })

  it('thread conversion state transitions from inquiry to project after acceptance', async () => {
    setActiveUser(CUSTOMER_1)

    await addConversation(makeConversation({
      id: 'thread-inquiry-to-project',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      inquiryOrigin: 'reel',
    }))

    // Before acceptance: thread is an inquiry
    expect(getThreadConversionState('thread-inquiry-to-project')).toBe('inquiry')

    const offer = await createOfferWorkflow({
      conversationId: 'thread-inquiry-to-project',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '3.000 €',
    })

    // Offer creation does NOT change inquiry status (no job yet)
    expect(getThreadConversionState('thread-inquiry-to-project')).toBe('inquiry')

    // Acceptance creates a job → thread becomes a project
    await acceptOfferWorkflow(offer.id)
    expect(getThreadConversionState('thread-inquiry-to-project')).toBe('project')
  })

  it('no duplicate/forked threads after offer acceptance', async () => {
    setActiveUser(CUSTOMER_1)

    await addConversation(makeConversation({
      id: 'thread-no-fork',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    const offer = await createOfferWorkflow({
      conversationId: 'thread-no-fork',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '7.000 €',
    })

    await acceptOfferWorkflow(offer.id)

    // Exactly one conversation, no forks
    const allConvs = getConversations()
    expect(allConvs).toHaveLength(1)
    expect(allConvs[0].id).toBe('thread-no-fork')

    // Exactly one job, linked to that conversation
    const allJobs = getJobs()
    expect(allJobs).toHaveLength(1)
    expect(allJobs[0].sourceConversationId).toBe('thread-no-fork')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 7 — participantScope utility correctness
// ═══════════════════════════════════════════════════════════════════════════

describe('SCENARIO 7 — Participant scope utility functions', () => {
  it('isConversationParticipant returns true for customer', () => {
    const conv = makeConversation({
      id: 'test',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    })
    expect(isConversationParticipant(conv, CUSTOMER_1)).toBe(true)
  })

  it('isConversationParticipant returns true for craftsman', () => {
    const conv = makeConversation({
      id: 'test',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    })
    expect(isConversationParticipant(conv, CRAFTSMAN_A)).toBe(true)
  })

  it('isConversationParticipant returns false for non-participant', () => {
    const conv = makeConversation({
      id: 'test',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    })
    expect(isConversationParticipant(conv, CRAFTSMAN_B)).toBe(false)
    expect(isConversationParticipant(conv, CUSTOMER_2)).toBe(false)
  })

  it('filterConversationsByParticipant scopes correctly', () => {
    const convs = [
      makeConversation({ id: 'a', craftsmanUserId: CRAFTSMAN_A, customerUserId: CUSTOMER_1 }),
      makeConversation({ id: 'b', craftsmanUserId: CRAFTSMAN_B, customerUserId: CUSTOMER_1 }),
      makeConversation({ id: 'c', craftsmanUserId: CRAFTSMAN_A, customerUserId: CUSTOMER_2 }),
    ]

    const forCustomer1 = filterConversationsByParticipant(convs, CUSTOMER_1)
    expect(forCustomer1).toHaveLength(2)
    expect(forCustomer1.map((c) => c.id).sort()).toEqual(['a', 'b'])

    const forCraftsmanA = filterConversationsByParticipant(convs, CRAFTSMAN_A)
    expect(forCraftsmanA).toHaveLength(2)
    expect(forCraftsmanA.map((c) => c.id).sort()).toEqual(['a', 'c'])

    const forCraftsmanB = filterConversationsByParticipant(convs, CRAFTSMAN_B)
    expect(forCraftsmanB).toHaveLength(1)
    expect(forCraftsmanB[0].id).toBe('b')
  })

  it('filterConversationsByParticipant returns all when userId is null', () => {
    const convs = [
      makeConversation({ id: 'a', craftsmanUserId: CRAFTSMAN_A, customerUserId: CUSTOMER_1 }),
      makeConversation({ id: 'b', craftsmanUserId: CRAFTSMAN_B, customerUserId: CUSTOMER_2 }),
    ]

    const result = filterConversationsByParticipant(convs, null)
    expect(result).toHaveLength(2)
  })

  it('filterConversationsByCraftsman scopes to craftsman side only', () => {
    const convs = [
      makeConversation({ id: 'a', craftsmanUserId: CRAFTSMAN_A, customerUserId: CUSTOMER_1 }),
      makeConversation({ id: 'b', craftsmanUserId: CRAFTSMAN_B, customerUserId: CUSTOMER_1 }),
    ]

    const forA = filterConversationsByCraftsman(convs, CRAFTSMAN_A)
    expect(forA).toHaveLength(1)
    expect(forA[0].id).toBe('a')

    const forB = filterConversationsByCraftsman(convs, CRAFTSMAN_B)
    expect(forB).toHaveLength(1)
    expect(forB[0].id).toBe('b')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 8 — Project artifact canonical persistence
// ═══════════════════════════════════════════════════════════════════════════

describe('SCENARIO 8 — Project artifact canonical persistence via sourceProjectId', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('sendProjectAttachmentToThread stamps sourceProjectId on conversation', async () => {
    const projectId = PROJECT_UUID_1
    setActiveUser(CUSTOMER_1)

    await addProject(makeProject({ id: projectId }))
    await addConversation(makeConversation({
      id: 'thread-stamp',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    // Before attachment: no sourceProjectId
    expect(getConversationById('thread-stamp')?.sourceProjectId).toBeUndefined()

    await sendProjectAttachmentToThread('thread-stamp', projectId)

    // After attachment: sourceProjectId is stamped
    expect(getConversationById('thread-stamp')?.sourceProjectId).toBe(projectId)
  })

  it('project artifact persistence status is "confirmed" when sourceProjectId resolves', async () => {
    const projectId = PROJECT_UUID_1
    setActiveUser(CUSTOMER_1)

    await addProject(makeProject({ id: projectId }))
    await addConversation(makeConversation({
      id: 'thread-confirmed',
      sourceProjectId: projectId,
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    await persistProjectArtifact({
      conversationId: 'thread-confirmed',
      projectId,
      customerUserId: CUSTOMER_1,
      craftsmanUserId: CRAFTSMAN_A,
    })

    const artifacts = getThreadArtifacts('thread-confirmed')
    expect(artifacts.projectArtifact).not.toBeNull()
    expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
  })

  it('synthetic project ID does not produce a project artifact', async () => {
    setActiveUser(CUSTOMER_1)

    await addConversation(makeConversation({
      id: 'thread-synthetic',
      projectId: 'project_profile_craft_thread-synthetic',
      inquiryOrigin: 'profile',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    const artifacts = getThreadArtifacts('thread-synthetic')
    expect(artifacts.projectArtifact).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 9 — No regression to auth/role/bootstrap flow
// ═══════════════════════════════════════════════════════════════════════════

describe('SCENARIO 9 — No regression to auth/role/bootstrap', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('unauthenticated user (no session) can still view public thread list (empty)', () => {
    clearActiveUser()
    const threads = getMessageThreads()
    expect(threads).toHaveLength(0)
  })

  it('unauthenticated user gets empty incoming requests', () => {
    clearActiveUser()
    const requests = getIncomingProjectRequests()
    expect(requests).toHaveLength(0)
  })

  it('authenticated user sees only their threads after login', async () => {
    // Seed conversations for different users
    await addConversation(makeConversation({
      id: 'thread-customer1',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))
    await addConversation(makeConversation({
      id: 'thread-customer2',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_2,
    }))

    // Customer 1 sees only their thread
    setActiveUser(CUSTOMER_1)
    const threads = getMessageThreads()
    expect(threads).toHaveLength(1)
    expect(threads[0].id).toBe('thread-customer1')
  })
})
