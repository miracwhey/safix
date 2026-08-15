/**
 * Offer Acceptance Runtime Repair — Tests
 *
 * Validates the fixes applied to make offer acceptance work end-to-end:
 *
 *   1. Customer can accept active offer in visible relationship thread
 *   2. Accepted state persists after reload/re-entry
 *   3. Acceptance targets correct offer and correct canonical thread
 *   4. Real runtime failure is normalized into readable error
 *   5. No regression to quote-send flow
 *   6. No regression to project history and participant scoping
 *
 * ROOT CAUSE ADDRESSED:
 *   acceptOfferWorkflow threw "Offer cannot be accepted before it was sent"
 *   when the linked job lacked proposalSentAt — even though the offer itself
 *   had sentAt.  The overly strict guard has been replaced by a sync step
 *   that copies offer.sentAt → job.proposalSentAt when missing.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getThreadArtifacts,
  getThreadArtifactRecord,
} from '../../src/lib/messages'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
  declineOfferWorkflow,
} from '../../src/lib/workflow/offerWorkflow'
import { getOfferRepository, getOfferById } from '../../src/lib/offers'
import { getJobRepository, getJobById } from '../../src/lib/jobs'
import { addProject } from '../../src/lib/projects'
import { normalizeErrorMessage } from '../../src/lib/diagnostics'
import type { Conversation } from '../../src/lib/messages/types'
import type { Project } from '../../src/lib/projects'

// ── Helpers ──────────────────────────────────────────────────────────────

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-oar-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Testkundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-oar-001',
    craftsmanName: 'Testhandwerker',
    craftsmanHandle: 'oar-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-oar-001',
    projectTitle: 'Offerannahme Test',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Berlin',
    projectCostRange: '€2,000-5,000',
    projectDuration: '1 Woche',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Gerade eben',
    inquiryOrigin: 'reel',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? `proj-oar-${Date.now()}`,
    title: 'OAR Projekt',
    customer: 'Testkundin',
    craftsman: '',
    location: 'Berlin',
    dateLabel: 'Termin offen',
    price: '',
    status: 'request',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: 'builder',
    category: 'Sanitär',
    description: 'OAR-Test-Projekt',
    ...overrides,
  }
}

const CUSTOMER_UID = 'customer-oar-001'
const CRAFTSMAN_UID = 'craftsman-oar-001'

// ═══════════════════════════════════════════════════════════════════════════
// 1. CUSTOMER CAN ACCEPT ACTIVE OFFER IN VISIBLE RELATIONSHIP THREAD
// ═══════════════════════════════════════════════════════════════════════════

describe('Customer can accept active offer', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('acceptance succeeds and returns accepted offer with job', async () => {
    const threadId = 'conv-oar-accept-1'
    await addConversation(seedConversation({ id: threadId }))

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: CUSTOMER_UID,
      craftsmanUserId: CRAFTSMAN_UID,
      price: '3.500 €',
      description: 'Badezimmer renovieren',
    })

    const accepted = await acceptOfferWorkflow(offer.id)
    expect(accepted).toBeDefined()
    expect(accepted!.status).toBe('accepted')
    expect(accepted!.acceptedAt).toBeDefined()
    expect(accepted!.createdJobId).toBeDefined()
  })

  it('offer status updates correctly after acceptance', async () => {
    const threadId = 'conv-oar-status-1'
    await addConversation(seedConversation({ id: threadId }))

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: CUSTOMER_UID,
      craftsmanUserId: CRAFTSMAN_UID,
      price: '2.000 €',
    })

    await acceptOfferWorkflow(offer.id)

    const fromRepo = getOfferById(offer.id)
    expect(fromRepo!.status).toBe('accepted')
    expect(fromRepo!.acceptedAt).toBeDefined()
    expect(fromRepo!.createdJobId).toBeDefined()
  })

  it('thread artifact phase updates to payment_due after acceptance', async () => {
    const threadId = 'conv-oar-artifact-1'
    await addConversation(seedConversation({ id: threadId }))

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: CUSTOMER_UID,
      craftsmanUserId: CRAFTSMAN_UID,
      price: '4.000 €',
    })

    await acceptOfferWorkflow(offer.id)

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.offerPaymentArtifact).not.toBeNull()
    expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
    expect(artifacts.offerPaymentArtifact!.paymentState).toBe('deposit_required')
  })

  it('acceptance syncs proposalSentAt when job lacks it', async () => {
    const threadId = 'conv-oar-sync-sent'
    await addConversation(seedConversation({ id: threadId }))

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: CUSTOMER_UID,
      craftsmanUserId: CRAFTSMAN_UID,
      price: '1.500 €',
    })

    // Create a job without proposalSentAt (simulates inquiry-conversion job)
    const jobId = 'job-oar-nosent'
    getJobRepository().add({
      id: jobId,
      projectId: 'project-oar-nosent',
      title: 'Pre-existing Job',
      customer: 'Testkundin',
      location: 'Berlin',
      dateLabel: 'Termin offen',
      status: 'new',
      amount: '1.500 €',
      description: '',
      paymentState: 'deposit_required',
      documentationStatus: 'Noch keine Dokumentation',
      assignedMemberIds: [],
      notes: [],
      photoCount: 0,
      activities: [],
      craftsmanUserId: CRAFTSMAN_UID,
      customerUserId: CUSTOMER_UID,
      sourceConversationId: threadId,
      proposalSentAt: undefined,
      proposalAcceptedAt: undefined,
    })

    // Acceptance should NOT throw — it should sync proposalSentAt from offer
    const accepted = await acceptOfferWorkflow(offer.id)
    expect(accepted).toBeDefined()
    expect(accepted!.status).toBe('accepted')

    // Verify proposalSentAt was synced
    const job = getJobById(jobId)
    expect(job!.proposalSentAt).toBe(offer.sentAt)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. ACCEPTED STATE PERSISTS AFTER RELOAD / RE-ENTRY
// ═══════════════════════════════════════════════════════════════════════════

describe('Accepted state persists after reload/re-entry', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('accepted offer is retrievable from repository after acceptance', async () => {
    const threadId = 'conv-oar-persist-1'
    await addConversation(seedConversation({ id: threadId }))

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: CUSTOMER_UID,
      craftsmanUserId: CRAFTSMAN_UID,
      price: '5.000 €',
    })

    await acceptOfferWorkflow(offer.id)

    // Simulate reload: read from repository
    const fromRepo = getOfferRepository().getById(offer.id)
    expect(fromRepo).toBeDefined()
    expect(fromRepo!.status).toBe('accepted')
    expect(fromRepo!.acceptedAt).toBeDefined()
    expect(fromRepo!.createdJobId).toBeDefined()
  })

  it('thread artifacts resolve correctly after acceptance on re-entry', async () => {
    const threadId = 'conv-oar-reentry-1'
    await addConversation(seedConversation({ id: threadId }))

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: CUSTOMER_UID,
      craftsmanUserId: CRAFTSMAN_UID,
      price: '3.000 €',
    })

    await acceptOfferWorkflow(offer.id)

    // Simulate re-entry: fresh getThreadArtifacts call
    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.offerPaymentArtifact).not.toBeNull()
    // After acceptance with payment, phase should be payment_due
    expect(['accepted', 'payment_due']).toContain(artifacts.offerPaymentArtifact!.phase)
    // Offer entity should be loaded and show accepted
    expect(artifacts.offerPaymentArtifact!.offer).not.toBeNull()
    expect(artifacts.offerPaymentArtifact!.offer!.status).toBe('accepted')
  })

  it('offer artifact record persists with accepted phase', async () => {
    const threadId = 'conv-oar-record-1'
    await addConversation(seedConversation({ id: threadId }))

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: CUSTOMER_UID,
      craftsmanUserId: CRAFTSMAN_UID,
      price: '2.500 €',
    })

    await acceptOfferWorkflow(offer.id)

    const record = getThreadArtifactRecord(threadId, 'offer')
    expect(record).toBeDefined()
    expect(record!.phase).toBe('accepted')
    expect(record!.snapshotPhaseLabel).toBe('Angebot angenommen')
  })

  it('payment phase artifact persists after acceptance', async () => {
    const threadId = 'conv-oar-payment-1'
    await addConversation(seedConversation({ id: threadId }))

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: CUSTOMER_UID,
      craftsmanUserId: CRAFTSMAN_UID,
      price: '1.800 €',
    })

    await acceptOfferWorkflow(offer.id)

    const record = getThreadArtifactRecord(threadId, 'payment_phase')
    expect(record).toBeDefined()
    expect(record!.phase).toBe('payment_due')
    expect(record!.snapshotPhaseLabel).toBe('Zahlung fällig')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. ACCEPTANCE TARGETS CORRECT OFFER AND CORRECT CANONICAL THREAD
// ═══════════════════════════════════════════════════════════════════════════

describe('Acceptance targets correct canonical thread', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('offer created on canonical thread is accepted on same thread', async () => {
    const threadId = 'conv-oar-canonical-1'
    await addConversation(seedConversation({ id: threadId }))

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: CUSTOMER_UID,
      craftsmanUserId: CRAFTSMAN_UID,
      price: '6.000 €',
    })

    // The offer should be scoped to the canonical thread
    expect(offer.conversationId).toBe(threadId)

    const accepted = await acceptOfferWorkflow(offer.id)
    expect(accepted!.conversationId).toBe(threadId)

    // Artifacts should be on the canonical thread
    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.offerPaymentArtifact).not.toBeNull()
  })

  it('idempotent re-acceptance returns same result without side effects', async () => {
    const threadId = 'conv-oar-idempotent-1'
    await addConversation(seedConversation({ id: threadId }))

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: CUSTOMER_UID,
      craftsmanUserId: CRAFTSMAN_UID,
      price: '1.200 €',
    })

    const first = await acceptOfferWorkflow(offer.id)
    const second = await acceptOfferWorkflow(offer.id)

    expect(second!.id).toBe(first!.id)
    expect(second!.createdJobId).toBe(first!.createdJobId)
    expect(second!.status).toBe('accepted')

    // Only one job created
    const allJobs = getJobRepository().getAll()
    expect(allJobs).toHaveLength(1)
  })

  it('idempotent re-acceptance syncs proposalSentAt on existing job if missing', async () => {
    const threadId = 'conv-oar-idempotent-sync'
    await addConversation(seedConversation({ id: threadId }))

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: CUSTOMER_UID,
      craftsmanUserId: CRAFTSMAN_UID,
      price: '900 €',
    })

    // Accept first time
    const accepted = await acceptOfferWorkflow(offer.id)
    const jobId = accepted!.createdJobId!

    // Clear proposalSentAt on the job to simulate stale state
    getJobRepository().update(jobId, (j) => ({
      ...j,
      proposalSentAt: undefined,
    }))

    // Re-accept should sync proposalSentAt from offer, not throw
    const reAccepted = await acceptOfferWorkflow(offer.id)
    expect(reAccepted!.status).toBe('accepted')

    const job = getJobById(jobId)
    expect(job!.proposalSentAt).toBe(offer.sentAt)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. REAL RUNTIME ERROR IS NORMALIZED INTO READABLE ERROR
// ═══════════════════════════════════════════════════════════════════════════

describe('Real runtime error surfacing', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('normalizeErrorMessage extracts message from Error objects', () => {
    const msg = normalizeErrorMessage(new Error('DB connection failed'))
    expect(msg).toBe('DB connection failed')
  })

  it('normalizeErrorMessage handles string errors', () => {
    const msg = normalizeErrorMessage('RLS policy violation')
    expect(msg).toBe('RLS policy violation')
  })

  it('normalizeErrorMessage handles object errors with message field', () => {
    const msg = normalizeErrorMessage({ message: 'constraint violation', code: '23505' })
    expect(msg).toBe('constraint violation')
  })

  it('offer not found returns undefined without throwing', async () => {
    const result = await acceptOfferWorkflow('non-existent-offer-id')
    expect(result).toBeUndefined()
  })

  it('offer without sentAt throws readable error', async () => {
    const threadId = 'conv-oar-nosent'
    await addConversation(seedConversation({ id: threadId }))

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: CUSTOMER_UID,
      craftsmanUserId: CRAFTSMAN_UID,
      price: '500 €',
    })

    // Force-clear sentAt to simulate edge case
    getOfferRepository().update(offer.id, (o) => ({
      ...o,
      sentAt: 0,
    }))

    await expect(acceptOfferWorkflow(offer.id)).rejects.toThrow(
      /before it was sent/
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. NO REGRESSION TO QUOTE-SEND FLOW
// ═══════════════════════════════════════════════════════════════════════════

describe('No regression to quote-send flow', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('creating an offer still works correctly', async () => {
    const threadId = 'conv-oar-quote-1'
    await addConversation(seedConversation({ id: threadId }))

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: CUSTOMER_UID,
      craftsmanUserId: CRAFTSMAN_UID,
      price: '2.200 €',
      description: 'Fenster einbauen',
      timingNote: 'Nächste Woche',
    })

    expect(offer.status).toBe('pending')
    expect(offer.price).toBe('2.200 €')
    expect(offer.sentAt).toBeDefined()
    expect(offer.conversationId).toBe(threadId)
  })

  it('offer artifact is created on send', async () => {
    const threadId = 'conv-oar-quote-artifact'
    await addConversation(seedConversation({ id: threadId }))

    await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: CUSTOMER_UID,
      craftsmanUserId: CRAFTSMAN_UID,
      price: '1.000 €',
    })

    const record = getThreadArtifactRecord(threadId, 'offer')
    expect(record).toBeDefined()
    expect(record!.phase).toBe('sent')
  })

  it('duplicate active offers are still blocked', async () => {
    const threadId = 'conv-oar-dup-block'
    await addConversation(seedConversation({ id: threadId }))

    await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: CUSTOMER_UID,
      craftsmanUserId: CRAFTSMAN_UID,
      price: '500 €',
    })

    await expect(
      createOfferWorkflow({
        conversationId: threadId,
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
        price: '600 €',
      })
    ).rejects.toThrow(/Active offer already exists/)
  })

  it('decline still works and allows new offer', async () => {
    const threadId = 'conv-oar-decline-new'
    await addConversation(seedConversation({ id: threadId }))

    const first = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: CUSTOMER_UID,
      craftsmanUserId: CRAFTSMAN_UID,
      price: '1.000 €',
    })

    const declined = await declineOfferWorkflow(first.id)
    expect(declined!.status).toBe('declined')

    const second = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: CUSTOMER_UID,
      craftsmanUserId: CRAFTSMAN_UID,
      price: '900 €',
    })

    expect(second.status).toBe('pending')
    expect(second.price).toBe('900 €')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. NO REGRESSION TO PROJECT HISTORY AND PARTICIPANT SCOPING
// ═══════════════════════════════════════════════════════════════════════════

describe('No regression to project history', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('offer acceptance creates project linked to job', async () => {
    const threadId = 'conv-oar-project-1'
    await addConversation(seedConversation({ id: threadId }))

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: CUSTOMER_UID,
      craftsmanUserId: CRAFTSMAN_UID,
      price: '7.000 €',
    })

    const accepted = await acceptOfferWorkflow(offer.id)
    const job = getJobById(accepted!.createdJobId!)

    expect(job).toBeDefined()
    expect(job!.sourceConversationId).toBe(threadId)
    expect(job!.craftsmanUserId).toBe(CRAFTSMAN_UID)
    expect(job!.customerUserId).toBe(CUSTOMER_UID)
  })

  it('offer acceptance preserves existing project artifact', async () => {
    const threadId = 'conv-oar-preserve-proj'
    const projectId = 'proj-oar-preserve'
    await addConversation(seedConversation({ id: threadId }))
    await addProject(seedProject({ id: projectId }))

    // Create offer
    const offer = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: CUSTOMER_UID,
      craftsmanUserId: CRAFTSMAN_UID,
      price: '4.500 €',
    })

    // Accept
    await acceptOfferWorkflow(offer.id)

    // Offer artifact should be updated, not destroyed
    const offerRecord = getThreadArtifactRecord(threadId, 'offer')
    expect(offerRecord).toBeDefined()
    expect(offerRecord!.phase).toBe('accepted')
  })

  it('accepted offer job has correct participant user IDs', async () => {
    const threadId = 'conv-oar-participants'
    await addConversation(seedConversation({ id: threadId }))

    const offer = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: CUSTOMER_UID,
      craftsmanUserId: CRAFTSMAN_UID,
      price: '3.200 €',
    })

    const accepted = await acceptOfferWorkflow(offer.id)
    const job = getJobById(accepted!.createdJobId!)

    expect(job!.customerUserId).toBe(CUSTOMER_UID)
    expect(job!.craftsmanUserId).toBe(CRAFTSMAN_UID)
  })
})
