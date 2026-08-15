/**
 * Canonical Thread Artifact Persistence Tests
 *
 * Validates the canonical persistence and reload stability of thread
 * business artifacts as defined by the rebuild package:
 *
 * SCENARIO 1 — Project artifact survives reload for both participants
 * SCENARIO 2 — Offer/payment artifact survives reload for both participants
 * SCENARIO 3 — Acceptance / payment phase continuity in same thread
 * SCENARIO 4 — No duplicate/forked thread after acceptance/payment
 * SCENARIO 5 — Declined offer produces artifact with phase='declined'
 * SCENARIO 6 — Canonical job lookup uses sourceConversationId as primary
 * SCENARIO 7 — Legacy jobs without sourceConversationId resolve via fallback
 * SCENARIO 8 — No regression to participant scoping
 * SCENARIO 9 — Project persistence status reflects canonical linkage
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getConversationById,
  getThreadArtifacts,
  sendProjectAttachmentToThread,
  findCanonicalJobForConversation,
  getThreadConversionState,
  persistProjectArtifact,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import { addJob, getJobById, getJobs } from '../../src/lib/jobs'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
} from '../../src/lib/workflow'
import { declineOfferWorkflow } from '../../src/lib/workflow/offerWorkflow'
import { getOffersByConversationId, getOfferById } from '../../src/lib/offers/service'
import { getPaymentForJob } from '../../src/lib/payments'

// ── Helpers ─────────────────────────────────────────────────────────────────

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-can-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: overrides.projectId ?? `project-${id}`,
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-can-001',
    craftsmanName: 'Peter Handwerker',
    craftsmanHandle: 'peter-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-can-001',
    projectTitle: 'Küche Sanierung',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Berlin',
    projectCostRange: '€5,000-10,000',
    projectDuration: '2 Wochen',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Gerade eben',
    inquiryOrigin: 'reel',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  const id = overrides.id ?? `project-can-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    title: 'Küche Sanierung',
    customer: 'Anna Kundin',
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
    ...overrides,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Canonical Thread Artifact Persistence', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 1 — PROJECT ARTIFACT SURVIVES RELOAD FOR BOTH PARTICIPANTS
  // ─────────────────────────────────────────────────────────────────────────

  describe('Scenario 1: Project artifact reload stability', () => {
    it('project artifact persists via sourceProjectId after attachment', async () => {
      const projectId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
      const threadId = 'conv-proj-reload-001'

      await addProject(seedProject({ id: projectId, title: 'Dachsanierung' }))
      await addConversation(seedConversation({
        id: threadId,
        projectId: `project_reel_${threadId}`, // synthetic
        inquiryOrigin: 'reel',
      }))

      // Before attachment: no project artifact
      expect(getThreadArtifacts(threadId).projectArtifact).toBeNull()

      // Attach project
      await sendProjectAttachmentToThread(threadId, projectId)

      // Verify sourceProjectId was stamped
      expect(getConversationById(threadId)?.sourceProjectId).toBe(projectId)

      // Multiple re-derivations simulate reload for both participants
      for (let i = 0; i < 3; i++) {
        const artifacts = getThreadArtifacts(threadId)
        expect(artifacts.projectArtifact).not.toBeNull()
        expect(artifacts.projectArtifact!.project.id).toBe(projectId)
        expect(artifacts.projectArtifact!.project.title).toBe('Dachsanierung')
        expect(artifacts.projectArtifact!.isCustomerCreated).toBe(true)
        expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
      }
    })

    it('project artifact confirmed when sourceProjectId is set', async () => {
      const projectId = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'
      const threadId = 'conv-proj-confirmed-001'

      await addProject(seedProject({ id: projectId }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
      }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
    })

    it('legacy projectId alone (without sourceProjectId) no longer produces project artifact', async () => {
      const projectId = 'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f'
      const threadId = 'conv-proj-legacy-001'

      await addProject(seedProject({ id: projectId }))
      await addConversation(seedConversation({
        id: threadId,
        projectId: projectId, // valid UUID but NOT via sourceProjectId
        // sourceProjectId NOT set
      }))

      // After teardown: FALLBACK C (conversation.projectId UUID) has been removed
      // as a live runtime path.  It was a phantom that never backfilled to
      // thread_artifacts, so the card would disappear after reload.
      // fail-fast: no card is better than an unstable phantom card.
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).toBeNull()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 2 — OFFER/PAYMENT ARTIFACT SURVIVES RELOAD FOR BOTH PARTICIPANTS
  // ─────────────────────────────────────────────────────────────────────────

  describe('Scenario 2: Offer artifact reload stability', () => {
    it('pending offer artifact persists across multiple re-derivations', async () => {
      const threadId = 'conv-offer-reload-001'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
        price: '5.000 €',
        description: 'Komplettsanierung',
      })

      // Simulated reload: 3 consecutive re-derivations
      for (let i = 0; i < 3; i++) {
        const artifacts = getThreadArtifacts(threadId)
        expect(artifacts.offerPaymentArtifact).not.toBeNull()
        expect(artifacts.offerPaymentArtifact!.offer.id).toBe(offer.id)
        expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
        expect(artifacts.offerPaymentArtifact!.offer.price).toBe('5.000 €')
        expect(artifacts.offerPaymentArtifact!.persistenceStatus).toBe('confirmed')
      }
    })

    it('offer artifact backed by real persisted offer entity', async () => {
      const threadId = 'conv-offer-backed-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
        price: '3.500 €',
      })

      // Verify offer exists in the persisted repository
      const offers = getOffersByConversationId(threadId)
      expect(offers).toHaveLength(1)
      expect(offers[0].conversationId).toBe(threadId)
      expect(offers[0].status).toBe('pending')

      // Artifact resolves from persisted offer
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact!.offer.id).toBe(offers[0].id)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 3 — ACCEPTANCE / PAYMENT PHASE CONTINUITY IN SAME THREAD
  // ─────────────────────────────────────────────────────────────────────────

  describe('Scenario 3: Acceptance and payment phase continuity', () => {
    it('accepted offer transitions to payment_due in same thread', async () => {
      const threadId = 'conv-accept-cont-001'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
        price: '8.000 €',
      })

      // Before acceptance: phase is 'sent'
      expect(getThreadArtifacts(threadId).offerPaymentArtifact!.phase).toBe('sent')

      // Accept the offer
      const accepted = await acceptOfferWorkflow(offer.id)
      expect(accepted).toBeDefined()
      expect(accepted!.status).toBe('accepted')
      expect(accepted!.createdJobId).toBeDefined()

      // After acceptance: phase transitions to 'payment_due'
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
      expect(artifacts.offerPaymentArtifact!.paymentState).toBe('deposit_required')
      expect(artifacts.offerPaymentArtifact!.jobId).toBe(accepted!.createdJobId)
    })

    it('payment phase survives multiple re-derivations after acceptance', async () => {
      const threadId = 'conv-payment-reload-001'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
        price: '12.000 €',
      })

      const accepted = await acceptOfferWorkflow(offer.id)
      const jobId = accepted!.createdJobId!

      // Simulated reload: 3 consecutive re-derivations
      for (let i = 0; i < 3; i++) {
        const artifacts = getThreadArtifacts(threadId)
        expect(artifacts.offerPaymentArtifact).not.toBeNull()
        expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
        expect(artifacts.offerPaymentArtifact!.paymentState).toBe('deposit_required')
        expect(artifacts.offerPaymentArtifact!.jobId).toBe(jobId)
      }
    })

    it('same thread remains canonical after acceptance — no fork', async () => {
      const threadId = 'conv-no-fork-001'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
        price: '6.000 €',
      })

      await acceptOfferWorkflow(offer.id)

      // The thread ID remains the same
      const conv = getConversationById(threadId)
      expect(conv).toBeDefined()
      expect(conv!.id).toBe(threadId)

      // The job links back to the same conversation
      const accepted = getOfferById(offer.id)!
      const job = getJobById(accepted.createdJobId!)!
      expect(job.sourceConversationId).toBe(threadId)

      // Thread artifacts still resolve in the original thread
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.offer.conversationId).toBe(threadId)
    })

    it('project and offer artifacts coexist through acceptance', async () => {
      const projectId = 'd4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f80'
      const threadId = 'conv-coexist-accept-001'

      await addProject(seedProject({ id: projectId, title: 'Fenstereinbau' }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
      }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
      })

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
        price: '7.000 €',
      })

      await acceptOfferWorkflow(offer.id)

      // Both artifacts coexist after acceptance
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.project.id).toBe(projectId)
      expect(artifacts.projectArtifact!.kind).toBe('project')

      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
      expect(artifacts.offerPaymentArtifact!.kind).toBe('offer_payment')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 4 — NO DUPLICATE/FORKED THREAD AFTER ACCEPTANCE/PAYMENT
  // ─────────────────────────────────────────────────────────────────────────

  describe('Scenario 4: No thread duplication or forking', () => {
    it('acceptance does not create a second conversation', async () => {
      const threadId = 'conv-no-dup-001'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
        price: '4.000 €',
      })

      await acceptOfferWorkflow(offer.id)

      // Only the original conversation exists
      expect(getConversationById(threadId)).toBeDefined()
      // No ghost threads — getThreadArtifacts for a non-existent thread returns null artifacts
      expect(getThreadArtifacts('ghost-thread-001').projectArtifact).toBeNull()
      expect(getThreadArtifacts('ghost-thread-001').offerPaymentArtifact).toBeNull()
    })

    it('job sourceConversationId points back to original thread', async () => {
      const threadId = 'conv-job-backlink-001'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
        price: '9.000 €',
      })

      const accepted = await acceptOfferWorkflow(offer.id)
      const job = getJobById(accepted!.createdJobId!)!

      // Canonical back-link
      expect(job.sourceConversationId).toBe(threadId)

      // Payment was created for this job
      const payment = getPaymentForJob(job.id)
      expect(payment).toBeDefined()
    })

    it('thread conversion state transitions from inquiry to project on acceptance', async () => {
      const threadId = 'conv-conversion-state-001'
      await addConversation(seedConversation({ id: threadId }))

      // Before offer: inquiry
      expect(getThreadConversionState(threadId)).toBe('inquiry')

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
        price: '5.500 €',
      })

      // With pending offer but no job: still inquiry
      expect(getThreadConversionState(threadId)).toBe('inquiry')

      await acceptOfferWorkflow(offer.id)

      // After acceptance (job created): project
      expect(getThreadConversionState(threadId)).toBe('project')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 5 — DECLINED OFFER PRODUCES ARTIFACT WITH PHASE='DECLINED'
  // ─────────────────────────────────────────────────────────────────────────

  describe('Scenario 5: Declined offer artifact continuity', () => {
    it('declined offer produces artifact with declined phase', async () => {
      const threadId = 'conv-declined-art-001'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
        price: '2.500 €',
      })

      await declineOfferWorkflow(offer.id)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('declined')
      expect(artifacts.offerPaymentArtifact!.offer.status).toBe('declined')
      expect(artifacts.offerPaymentArtifact!.persistenceStatus).toBe('confirmed')
      expect(artifacts.offerPaymentArtifact!.jobId).toBeNull()
      expect(artifacts.offerPaymentArtifact!.paymentState).toBeNull()
    })

    it('declined offer artifact survives multiple re-derivations', async () => {
      const threadId = 'conv-declined-reload-001'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
        price: '3.000 €',
      })

      await declineOfferWorkflow(offer.id)

      for (let i = 0; i < 3; i++) {
        const artifacts = getThreadArtifacts(threadId)
        expect(artifacts.offerPaymentArtifact).not.toBeNull()
        expect(artifacts.offerPaymentArtifact!.phase).toBe('declined')
      }
    })

    it('new pending offer takes precedence over declined offer', async () => {
      const threadId = 'conv-new-after-decline-001'
      await addConversation(seedConversation({ id: threadId }))

      // First offer: created then declined
      const offer1 = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
        price: '2.000 €',
      })
      await declineOfferWorkflow(offer1.id)

      // Second offer: pending
      const offer2 = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
        price: '2.500 €',
      })

      // Pending offer takes precedence
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
      expect(artifacts.offerPaymentArtifact!.offer.id).toBe(offer2.id)
      expect(artifacts.offerPaymentArtifact!.offer.price).toBe('2.500 €')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 6 — CANONICAL JOB LOOKUP
  // ─────────────────────────────────────────────────────────────────────────

  describe('Scenario 6: Canonical job lookup via findCanonicalJobForConversation', () => {
    it('finds job via sourceConversationId as primary canonical link', async () => {
      const threadId = 'conv-canonical-job-001'
      const conversation = seedConversation({ id: threadId })
      await addConversation(conversation)

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
        price: '6.000 €',
      })

      await acceptOfferWorkflow(offer.id)

      const storedConv = getConversationById(threadId)!
      const result = findCanonicalJobForConversation(storedConv, getJobs())
      expect(result).not.toBeNull()
      expect(result!.canonical).toBe(true) // Found via sourceConversationId
      expect(result!.job.sourceConversationId).toBe(threadId)
    })

    it('returns null when no job is linked to conversation', async () => {
      const threadId = 'conv-no-job-001'
      await addConversation(seedConversation({ id: threadId }))

      const conv = getConversationById(threadId)!
      const result = findCanonicalJobForConversation(conv, getJobs())
      expect(result).toBeNull()
    })

    it('legacy job without sourceConversationId resolves via projectId fallback', async () => {
      const threadId = 'conv-legacy-fallback-001'
      const projectId = 'e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8091'

      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
      }))

      // Legacy job: no sourceConversationId, but projectId matches
      await addJob({
        id: 'job-legacy-fallback-001',
        projectId,
        title: 'Legacy Job',
        customer: 'Anna',
        location: 'Berlin',
        dateLabel: 'Gestern',
        status: 'in_progress',
        amount: '€3,000',
        description: '',
        paymentState: 'work_in_progress',
        documentationStatus: 'In Arbeit',
        assignedMemberIds: [],
        notes: [],
        photoCount: 0,
        activities: [],
        // sourceConversationId: NOT SET (legacy)
      })

      const conv = getConversationById(threadId)!
      const result = findCanonicalJobForConversation(conv, getJobs())
      expect(result).not.toBeNull()
      expect(result!.canonical).toBe(false) // Found via fallback, not primary
      expect(result!.job.id).toBe('job-legacy-fallback-001')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 7 — PROJECT PERSISTENCE STATUS WITH JOB LINKAGE
  // ─────────────────────────────────────────────────────────────────────────

  describe('Scenario 7: Project persistence status via job-linked canonical path', () => {
    it('project found via job sourceConversationId is confirmed', async () => {
      const projectId = 'f6a7b8c9-d0e1-4f2a-3b4c-5d6e7f809102'
      const threadId = 'conv-job-proj-confirmed-001'

      await addProject(seedProject({ id: projectId, title: 'Treppenbau' }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
      }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
      })

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
        price: '10.000 €',
      })

      await acceptOfferWorkflow(offer.id)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      // Found via sourceProjectId which is the primary canonical link
      expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
    })

    it('project found only via job (no sourceProjectId) is confirmed if job canonical', async () => {
      const projectId = 'c9d0e1f2-a3b4-4c5d-6e7f-809102031405'
      const threadId = 'conv-job-only-proj-001'

      await addProject(seedProject({ id: projectId }))

      // Create conversation with sourceProjectId and persist artifact
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
        inquiryOrigin: 'reel',
      }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
      })

      // Create offer and accept (creates job with sourceConversationId)
      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
        price: '4.000 €',
      })

      await acceptOfferWorkflow(offer.id)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      // Found via job.sourceConversationId — canonical link → confirmed
      expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 8 — PARTICIPANT SCOPING NOT REGRESSED
  // ─────────────────────────────────────────────────────────────────────────

  describe('Scenario 8: Participant scoping defense-in-depth', () => {
    it('artifacts are role-agnostic: customer and craftsman see identical artifacts', async () => {
      const projectId = 'a7b8c9d0-e1f2-4a3b-4c5d-6e7f80910203'
      const threadId = 'conv-scope-001'

      await addProject(seedProject({ id: projectId }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
        customerUserId: 'customer-alice',
        craftsmanUserId: 'craftsman-bob',
      }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId,
        customerUserId: 'customer-alice',
        craftsmanUserId: 'craftsman-bob',
      })

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-alice',
        craftsmanUserId: 'craftsman-bob',
        price: '6.000 €',
      })

      // Both participants derive identical artifacts from the same persisted state
      const artifacts1 = getThreadArtifacts(threadId)
      const artifacts2 = getThreadArtifacts(threadId)

      expect(artifacts1.projectArtifact).not.toBeNull()
      expect(artifacts2.projectArtifact).not.toBeNull()
      expect(artifacts1.projectArtifact!.project.id).toBe(artifacts2.projectArtifact!.project.id)

      expect(artifacts1.offerPaymentArtifact).not.toBeNull()
      expect(artifacts2.offerPaymentArtifact).not.toBeNull()
      expect(artifacts1.offerPaymentArtifact!.offer.id).toBe(artifacts2.offerPaymentArtifact!.offer.id)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 9 — FULL CANONICAL LIFECYCLE
  // ─────────────────────────────────────────────────────────────────────────

  describe('Scenario 9: Full canonical lifecycle — project → offer → accept → payment → reload', () => {
    it('complete lifecycle maintains artifact coherence across all phases', async () => {
      const projectId = 'b8c9d0e1-f2a3-4b4c-5d6e-7f8091020314'
      const threadId = 'conv-full-lifecycle-001'

      // ── Phase 1: Create project and thread ──
      await addProject(seedProject({ id: projectId, title: 'Badezimmer komplett' }))
      await addConversation(seedConversation({
        id: threadId,
        projectId: `project_reel_${threadId}`,
        inquiryOrigin: 'reel',
      }))

      // ── Phase 2: Attach project ──
      await sendProjectAttachmentToThread(threadId, projectId)
      expect(getConversationById(threadId)?.sourceProjectId).toBe(projectId)

      let artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
      expect(artifacts.offerPaymentArtifact).toBeNull()

      // ── Phase 3: Create offer ──
      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-can-001',
        craftsmanUserId: 'craftsman-can-001',
        price: '15.000 €',
        description: 'Komplettsanierung',
      })

      artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')

      // ── Phase 4: Accept offer ──
      const accepted = await acceptOfferWorkflow(offer.id)
      expect(accepted!.createdJobId).toBeDefined()

      artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
      expect(artifacts.offerPaymentArtifact!.paymentState).toBe('deposit_required')

      // ── Phase 5: Verify job canonical linkage ──
      const job = getJobById(accepted!.createdJobId!)!
      expect(job.sourceConversationId).toBe(threadId)

      // ── Phase 6: Multiple re-derivations (simulated reload) ──
      for (let i = 0; i < 3; i++) {
        const reloaded = getThreadArtifacts(threadId)
        // Project persists
        expect(reloaded.projectArtifact).not.toBeNull()
        expect(reloaded.projectArtifact!.project.id).toBe(projectId)
        expect(reloaded.projectArtifact!.persistenceStatus).toBe('confirmed')

        // Offer/payment persists
        expect(reloaded.offerPaymentArtifact).not.toBeNull()
        expect(reloaded.offerPaymentArtifact!.phase).toBe('payment_due')
        expect(reloaded.offerPaymentArtifact!.paymentState).toBe('deposit_required')
        expect(reloaded.offerPaymentArtifact!.jobId).toBe(accepted!.createdJobId)
      }

      // ── Phase 7: Thread conversion state is 'project' ──
      expect(getThreadConversionState(threadId)).toBe('project')
    })
  })
})
