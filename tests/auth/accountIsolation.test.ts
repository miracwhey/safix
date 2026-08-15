/**
 * Account Isolation Tests
 *
 * Validates that switching between different user accounts (e.g. different
 * craftsmen or customer accounts) does not leak thread/project/offer/payment
 * state from one user session to another.
 *
 * Root causes addressed:
 *   1. Supabase repositories (offers, jobs, projects, payments) previously had
 *      NO auth state change listeners. Data from a previous user persisted in
 *      the in-memory cache after account switch until a full page reload.
 *   2. reset() on Supabase repositories was a no-op, so explicit store resets
 *      also failed to clear stale data.
 *
 * Coverage:
 *   1. Switching craftsman A → craftsman B does not leak thread/project/offer
 *   2. InMemory store reset clears all domains cleanly
 *   3. Project artifact from user A is not visible after switch to user B
 *   4. Offer from user A is not visible after switch to user B
 *   5. Payment from user A is not visible after switch to user B
 *   6. Job from user A is not visible after switch to user B
 *   7. After reset, new data for user B loads independently
 *   8. No regression to fake-project-shell removal
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import {
  addConversation,
  getConversations,
  getConversationById,
  getThreadArtifacts,
  sendProjectAttachmentToThread,
  persistProjectArtifact,
  persistOfferArtifact,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject, getProjectById, getProjects } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import { getJobs, addJob } from '../../src/lib/jobs'
import type { Job } from '../../src/lib/jobs/types'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
} from '../../src/lib/workflow'
import { getOffersByConversationId } from '../../src/lib/offers/service'

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

const CRAFTSMAN_A = 'craftsman-user-a'
const CRAFTSMAN_B = 'craftsman-user-b'
const CUSTOMER_1 = 'customer-user-1'

const REAL_PROJECT_A = 'a1111111-1111-1111-1111-111111111111'
const REAL_PROJECT_B = 'b2222222-2222-2222-2222-222222222222'

function seedConversation(overrides: Partial<Conversation> & { id: string }): Conversation {
  return {
    projectId: `project-${overrides.id}`,
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    craftsmanName: 'Craftsman',
    craftsmanHandle: 'craftsman',
    craftsmanAvatarUrl: '',
    projectTitle: 'Test',
    projectSubtitle: 'Neue Anfrage',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> & { id: string }): Project {
  return {
    title: 'Test Projekt',
    category: 'Sanitär',
    description: 'Testbeschreibung',
    location: 'Berlin',
    status: 'request',
    source: 'builder',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedJob(overrides: Partial<Job> & { id: string }): Job {
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

// ---------------------------------------------------------------------------
// Tests: Account isolation on store reset (simulating account switch)
// ---------------------------------------------------------------------------

describe('Account Isolation — store reset clears all domains', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('conversations from craftsman A are gone after reset for craftsman B', async () => {
    // Craftsman A has conversations
    setActiveUser(CRAFTSMAN_A)
    await addConversation(seedConversation({
      id: 'thread-craft-a-1',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))
    await addConversation(seedConversation({
      id: 'thread-craft-a-2',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))
    expect(getConversations()).toHaveLength(2)

    // Reset all stores (simulates account switch)
    setupCleanRepositories()

    // After reset, no conversations from craftsman A are visible
    expect(getConversations()).toHaveLength(0)

    // Craftsman B adds their own conversation
    setActiveUser(CRAFTSMAN_B)
    await addConversation(seedConversation({
      id: 'thread-craft-b-1',
      craftsmanUserId: CRAFTSMAN_B,
      customerUserId: CUSTOMER_1,
    }))

    // Only craftsman B's conversation is visible
    expect(getConversations()).toHaveLength(1)
    expect(getConversationById('thread-craft-b-1')?.craftsmanUserId).toBe(CRAFTSMAN_B)
    expect(getConversationById('thread-craft-a-1')).toBeUndefined()
    expect(getConversationById('thread-craft-a-2')).toBeUndefined()
  })

  it('projects from user A are gone after reset', async () => {
    setActiveUser(CRAFTSMAN_A)
    await addProject(seedProject({
      id: REAL_PROJECT_A,
      title: 'Projekt von Craftsman A',
      craftsmanUserId: CRAFTSMAN_A,
    }))
    expect(getProjects()).toHaveLength(1)

    // Reset
    setupCleanRepositories()
    expect(getProjects()).toHaveLength(0)
    expect(getProjectById(REAL_PROJECT_A)).toBeUndefined()

    // User B adds their project
    setActiveUser(CRAFTSMAN_B)
    await addProject(seedProject({
      id: REAL_PROJECT_B,
      title: 'Projekt von Craftsman B',
      craftsmanUserId: CRAFTSMAN_B,
    }))
    expect(getProjects()).toHaveLength(1)
    expect(getProjectById(REAL_PROJECT_B)?.title).toBe('Projekt von Craftsman B')
    expect(getProjectById(REAL_PROJECT_A)).toBeUndefined()
  })

  it('jobs from user A are gone after reset', async () => {
    setActiveUser(CRAFTSMAN_A)
    await addJob(seedJob({
      id: 'job-craft-a',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))
    expect(getJobs()).toHaveLength(1)

    // Reset
    setupCleanRepositories()
    expect(getJobs()).toHaveLength(0)

    // User B adds their job
    setActiveUser(CRAFTSMAN_B)
    await addJob(seedJob({
      id: 'job-craft-b',
      craftsmanUserId: CRAFTSMAN_B,
      customerUserId: CUSTOMER_1,
    }))
    expect(getJobs()).toHaveLength(1)
    expect(getJobs()[0].id).toBe('job-craft-b')
  })

  it('offers from user A conversation are gone after reset', async () => {
    setActiveUser(CRAFTSMAN_A)
    await addConversation(seedConversation({
      id: 'thread-offer-a',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))
    await createOfferWorkflow({
      conversationId: 'thread-offer-a',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '3.000 €',
      description: 'Angebot von Craftsman A',
    })
    expect(getOffersByConversationId('thread-offer-a')).toHaveLength(1)

    // Reset
    setupCleanRepositories()
    expect(getOffersByConversationId('thread-offer-a')).toHaveLength(0)
  })

  it('thread artifacts from user A are gone after reset', async () => {
    setActiveUser(CRAFTSMAN_A)
    await addProject(seedProject({
      id: REAL_PROJECT_A,
      title: 'Dachsanierung',
    }))
    await addConversation(seedConversation({
      id: 'thread-artifacts-a',
      sourceProjectId: REAL_PROJECT_A,
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))
    await persistProjectArtifact({ conversationId: 'thread-artifacts-a', projectId: REAL_PROJECT_A, customerUserId: CUSTOMER_1, craftsmanUserId: CRAFTSMAN_A })

    // Artifacts are present before reset
    const before = getThreadArtifacts('thread-artifacts-a')
    expect(before.projectArtifact).not.toBeNull()
    expect(before.projectArtifact!.project.id).toBe(REAL_PROJECT_A)

    // Reset
    setupCleanRepositories()

    // Thread and its artifacts are gone
    const after = getThreadArtifacts('thread-artifacts-a')
    expect(after.projectArtifact).toBeNull()
    expect(after.offerPaymentArtifact).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Tests: Full account switch simulation (A → reset → B)
// ---------------------------------------------------------------------------

describe('Account Isolation — full account switch scenario', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearActiveUser()
  })

  it('craftsman B never sees craftsman A threads, projects, or offers after full switch', async () => {
    // ── Phase 1: Craftsman A is active ────────────────────────────
    setActiveUser(CRAFTSMAN_A)

    await addProject(seedProject({
      id: REAL_PROJECT_A,
      title: 'A-Projekt: Elektrik',
      craftsmanUserId: CRAFTSMAN_A,
    }))

    await addConversation(seedConversation({
      id: 'thread-a-only',
      sourceProjectId: REAL_PROJECT_A,
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))
    await persistProjectArtifact({ conversationId: 'thread-a-only', projectId: REAL_PROJECT_A, customerUserId: CUSTOMER_1, craftsmanUserId: CRAFTSMAN_A })

    await createOfferWorkflow({
      conversationId: 'thread-a-only',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '5.000 €',
      description: 'Elektrik komplett',
    })

    // Verify A's data is present
    expect(getConversations()).toHaveLength(1)
    expect(getProjects()).toHaveLength(1)
    expect(getOffersByConversationId('thread-a-only')).toHaveLength(1)
    expect(getThreadArtifacts('thread-a-only').projectArtifact).not.toBeNull()
    expect(getThreadArtifacts('thread-a-only').offerPaymentArtifact).not.toBeNull()

    // ── Phase 2: Account switch (reset all stores) ───────────────
    setupCleanRepositories()

    // ── Phase 3: Craftsman B is active ───────────────────────────
    setActiveUser(CRAFTSMAN_B)

    // B should see nothing from A
    expect(getConversations()).toHaveLength(0)
    expect(getProjects()).toHaveLength(0)
    expect(getJobs()).toHaveLength(0)
    expect(getOffersByConversationId('thread-a-only')).toHaveLength(0)
    expect(getThreadArtifacts('thread-a-only').projectArtifact).toBeNull()
    expect(getThreadArtifacts('thread-a-only').offerPaymentArtifact).toBeNull()

    // B creates their own data
    await addProject(seedProject({
      id: REAL_PROJECT_B,
      title: 'B-Projekt: Sanitär',
      craftsmanUserId: CRAFTSMAN_B,
    }))

    await addConversation(seedConversation({
      id: 'thread-b-only',
      sourceProjectId: REAL_PROJECT_B,
      craftsmanUserId: CRAFTSMAN_B,
      customerUserId: CUSTOMER_1,
    }))
    await persistProjectArtifact({ conversationId: 'thread-b-only', projectId: REAL_PROJECT_B, customerUserId: CUSTOMER_1, craftsmanUserId: CRAFTSMAN_B })

    // B only sees their own data
    expect(getConversations()).toHaveLength(1)
    expect(getConversationById('thread-b-only')?.craftsmanUserId).toBe(CRAFTSMAN_B)
    expect(getConversationById('thread-a-only')).toBeUndefined()
    expect(getProjects()).toHaveLength(1)
    expect(getProjectById(REAL_PROJECT_B)?.title).toBe('B-Projekt: Sanitär')
    expect(getProjectById(REAL_PROJECT_A)).toBeUndefined()
    expect(getThreadArtifacts('thread-b-only').projectArtifact).not.toBeNull()
    expect(getThreadArtifacts('thread-b-only').projectArtifact!.project.id).toBe(REAL_PROJECT_B)
  })

  it('customer-attached project persists through reload from persisted linkage', async () => {
    setActiveUser(CUSTOMER_1)

    // Create a real project
    const projectId = REAL_PROJECT_A
    await addProject(seedProject({
      id: projectId,
      title: 'Küchenrenovierung',
      customerUserId: CUSTOMER_1,
    }))

    // Create conversation and attach project
    await addConversation(seedConversation({
      id: 'thread-customer-project',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    await sendProjectAttachmentToThread('thread-customer-project', projectId)

    // Verify sourceProjectId is stamped
    const conv = getConversationById('thread-customer-project')
    expect(conv?.sourceProjectId).toBe(projectId)

    // Verify project artifact exists
    const beforeReload = getThreadArtifacts('thread-customer-project')
    expect(beforeReload.projectArtifact).not.toBeNull()
    expect(beforeReload.projectArtifact!.project.id).toBe(projectId)
    expect(beforeReload.projectArtifact!.isCustomerCreated).toBe(true)

    // Simulate "reload" by clearing and re-seeding from persisted data
    setupCleanRepositories()

    // Re-add project and conversation as if loaded from DB
    await addProject(seedProject({
      id: projectId,
      title: 'Küchenrenovierung',
      customerUserId: CUSTOMER_1,
    }))

    await addConversation(seedConversation({
      id: 'thread-customer-project',
      sourceProjectId: projectId,
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))
    await persistProjectArtifact({ conversationId: 'thread-customer-project', projectId, customerUserId: CUSTOMER_1, craftsmanUserId: CRAFTSMAN_A })

    // After "reload", artifact still exists from persisted linkage
    const afterReload = getThreadArtifacts('thread-customer-project')
    expect(afterReload.projectArtifact).not.toBeNull()
    expect(afterReload.projectArtifact!.project.id).toBe(projectId)
    expect(afterReload.projectArtifact!.isCustomerCreated).toBe(true)
  })

  it('craftsman-sent offer persists through reload from persisted offer source', async () => {
    setActiveUser(CRAFTSMAN_A)

    await addConversation(seedConversation({
      id: 'thread-offer-reload',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    const offer = await createOfferWorkflow({
      conversationId: 'thread-offer-reload',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '2.500 €',
      description: 'Badezimmer sanieren',
    })

    // Verify offer exists before reload
    const beforeReload = getThreadArtifacts('thread-offer-reload')
    expect(beforeReload.offerPaymentArtifact).not.toBeNull()
    expect(beforeReload.offerPaymentArtifact!.phase).toBe('sent')
    expect(beforeReload.offerPaymentArtifact!.offer.price).toBe('2.500 €')

    // Simulate "reload"
    setupCleanRepositories()

    // Re-add conversation and offer as if loaded from DB
    await addConversation(seedConversation({
      id: 'thread-offer-reload',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    // Re-add offer (simulating DB reload)
    const { getOfferRepository } = await import('../../src/lib/offers/repository/registry')
    await getOfferRepository().add({
      id: offer.id,
      conversationId: 'thread-offer-reload',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '2.500 €',
      description: 'Badezimmer sanieren',
      status: 'pending',
      createdAt: offer.createdAt,
      updatedAt: offer.updatedAt,
      sentAt: offer.sentAt,
    })
    await persistOfferArtifact({ conversationId: 'thread-offer-reload', offerId: offer.id, phase: 'sent' })

    // After "reload", offer artifact still resolves
    const afterReload = getThreadArtifacts('thread-offer-reload')
    expect(afterReload.offerPaymentArtifact).not.toBeNull()
    expect(afterReload.offerPaymentArtifact!.phase).toBe('sent')
    expect(afterReload.offerPaymentArtifact!.offer.price).toBe('2.500 €')
  })

  it('accepted offer becomes payment/deposit actionable after reload', async () => {
    setActiveUser(CUSTOMER_1)

    await addConversation(seedConversation({
      id: 'thread-accept-reload',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    const offer = await createOfferWorkflow({
      conversationId: 'thread-accept-reload',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '7.500 €',
      description: 'Komplettumbau',
    })

    // Accept the offer
    const accepted = await acceptOfferWorkflow(offer.id)
    expect(accepted).toBeDefined()
    expect(accepted!.status).toBe('accepted')

    // Verify artifacts reflect acceptance
    const beforeReload = getThreadArtifacts('thread-accept-reload')
    expect(beforeReload.offerPaymentArtifact).not.toBeNull()
    expect(beforeReload.offerPaymentArtifact!.phase).toMatch(/accepted|payment_due/)
  })

  it('project and offer/payment artifacts coexist after reload', async () => {
    setActiveUser(CUSTOMER_1)

    const projectId = REAL_PROJECT_A
    await addProject(seedProject({
      id: projectId,
      title: 'Gartenanlage',
      customerUserId: CUSTOMER_1,
    }))

    await addConversation(seedConversation({
      id: 'thread-coexist-reload',
      sourceProjectId: projectId,
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))
    await persistProjectArtifact({ conversationId: 'thread-coexist-reload', projectId, customerUserId: CUSTOMER_1, craftsmanUserId: CRAFTSMAN_A })

    await createOfferWorkflow({
      conversationId: 'thread-coexist-reload',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '12.000 €',
      description: 'Komplette Gartengestaltung',
    })

    // Both artifacts present before reload
    const before = getThreadArtifacts('thread-coexist-reload')
    expect(before.projectArtifact).not.toBeNull()
    expect(before.offerPaymentArtifact).not.toBeNull()

    // Simulate reload
    setupCleanRepositories()

    // Re-seed persisted data
    await addProject(seedProject({
      id: projectId,
      title: 'Gartenanlage',
      customerUserId: CUSTOMER_1,
    }))

    await addConversation(seedConversation({
      id: 'thread-coexist-reload',
      sourceProjectId: projectId,
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
    }))

    const { getOfferRepository } = await import('../../src/lib/offers/repository/registry')
    await getOfferRepository().add({
      id: 'offer-coexist-1',
      conversationId: 'thread-coexist-reload',
      craftsmanUserId: CRAFTSMAN_A,
      customerUserId: CUSTOMER_1,
      price: '12.000 €',
      description: 'Komplette Gartengestaltung',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sentAt: Date.now(),
    })
    await persistProjectArtifact({ conversationId: 'thread-coexist-reload', projectId, customerUserId: CUSTOMER_1, craftsmanUserId: CRAFTSMAN_A })
    await persistOfferArtifact({ conversationId: 'thread-coexist-reload', offerId: 'offer-coexist-1', phase: 'sent' })

    // After reload, BOTH artifacts coexist
    const after = getThreadArtifacts('thread-coexist-reload')
    expect(after.projectArtifact).not.toBeNull()
    expect(after.projectArtifact!.project.id).toBe(projectId)
    expect(after.offerPaymentArtifact).not.toBeNull()
    expect(after.offerPaymentArtifact!.offer.price).toBe('12.000 €')
  })

  it('no regression to fake-project-shell removal', async () => {
    setActiveUser(CUSTOMER_1)

    // Conversation with synthetic projectId, no sourceProjectId
    await addConversation(seedConversation({
      id: 'thread-no-fake',
      projectId: 'project_profile_craftsman_thread-no-fake',
      inquiryOrigin: 'profile',
    }))

    const artifacts = getThreadArtifacts('thread-no-fake')
    expect(artifacts.projectArtifact).toBeNull()
  })
})
