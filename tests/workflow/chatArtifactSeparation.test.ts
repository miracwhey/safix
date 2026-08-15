/**
 * Chat Artifact Separation Tests
 *
 * Verifies the formal separation of thread artifacts into two independent
 * families:
 *   A. ProjectArtifact  — real customer-created project card (reload-stable)
 *   B. OfferPaymentArtifact — craftsman offer/payment lifecycle card
 *
 * Test coverage:
 *   1. Real customer-created project attachment persists after reload
 *   2. Project card and offer card can coexist in the same thread
 *   3. Offer send is not blocked by unrelated project-completeness gating
 *   4. Sent offer appears as a separate thread artifact
 *   5. Accepted offer becomes payment/deposit actionable
 *   6. No regression to inquiry-only cases
 *   7. No regression to canonical owner / offer lifecycle semantics
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
  getThreadArtifacts,
  getThreadConversionState,
  getIncomingRequestForThread,
  persistProjectArtifact,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { getJobs, getJobById } from '../../src/lib/jobs'
import type { Job } from '../../src/lib/jobs/types'
import {
  addProject,
} from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
} from '../../src/lib/workflow'
import {
  deriveProposalReadiness,
} from '../../src/lib/jobs/proposalReadinessSelectors'
import { getJobContextForThread } from '../../src/lib/workflow/messageWorkflow'

// ── Helpers ─────────────────────────────────────────────────────────────────

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const conv: Conversation = {
    id,
    projectId: `project-${id}`,
    customerName: 'Max Mustermann',
    customerAvatarUrl: '',
    customerUserId: 'customer-123',
    craftsmanName: 'Hans Handwerker',
    craftsmanHandle: 'hans-handwerker',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-456',
    projectTitle: 'Badezimmer Renovation',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Munich',
    projectCostRange: '€5,000-10,000',
    projectDuration: '2 Wochen',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Vor 5 Minuten',
    inquiryOrigin: 'reel',
    createdAt: Date.now(),
    ...overrides,
  }
  return conv
}

function seedJob(overrides: Partial<Job> = {}): Job {
  const id = overrides.id ?? `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: overrides.projectId ?? `project-${id}`,
    title: 'Auftrag aus Anfrage',
    customer: 'Max Mustermann',
    location: 'Munich',
    dateLabel: 'Termin offen',
    status: 'new',
    amount: '',
    description: '',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  const id = overrides.id ?? `project-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    title: 'Badezimmer Renovation',
    customer: 'Max Mustermann',
    craftsman: 'Hans Handwerker',
    location: 'Munich',
    dateLabel: 'Termin offen',
    price: '',
    status: 'request',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: 'inquiry',
    ...overrides,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Chat Artifact Separation', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ───────────────────────────────────────────────────────────────────────
  // 1. Real customer-created project attachment persists after reload
  // ───────────────────────────────────────────────────────────────────────
  describe('Project artifact reload stability', () => {
    it('real customer-created project card persists after re-deriving artifacts', async () => {
      const projectId = 'project-real-uuid-001'
      const threadId = 'conv-builder-001'

      // Seed a real project
      const project = seedProject({
        id: projectId,
        title: 'Küchen-Umbau',
        status: 'request',
        source: 'builder',
      })
      await addProject(project)

      // Seed conversation linked to the real project
      const conv = seedConversation({
        id: threadId,
        sourceProjectId: projectId,
        projectTitle: 'Küchen-Umbau',
        inquiryOrigin: 'project',
      })
      await addConversation(conv)
      await persistProjectArtifact({ conversationId: threadId, projectId, customerUserId: 'customer-123', craftsmanUserId: 'craftsman-456' })

      // First derivation
      const artifacts1 = getThreadArtifacts(threadId)
      expect(artifacts1.projectArtifact).not.toBeNull()
      expect(artifacts1.projectArtifact!.project.id).toBe(projectId)
      expect(artifacts1.projectArtifact!.project.title).toBe('Küchen-Umbau')
      expect(artifacts1.projectArtifact!.isCustomerCreated).toBe(true)

      // Simulate "reload" — re-derive from the same store state
      const artifacts2 = getThreadArtifacts(threadId)
      expect(artifacts2.projectArtifact).not.toBeNull()
      expect(artifacts2.projectArtifact!.project.id).toBe(projectId)
      expect(artifacts2.projectArtifact!.project.title).toBe('Küchen-Umbau')
      expect(artifacts2.projectArtifact!.isCustomerCreated).toBe(true)
    })

    it('project artifact remains stable even after offer acceptance creates a job', async () => {
      const projectId = 'project-real-uuid-002'
      const threadId = 'conv-builder-002'

      // Seed a real project
      await addProject(seedProject({
        id: projectId,
        title: 'Fassadenarbeit',
        status: 'request',
        source: 'builder',
      }))

      // Seed conversation
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
        projectTitle: 'Fassadenarbeit',
        inquiryOrigin: 'project',
      }))
      await persistProjectArtifact({ conversationId: threadId, projectId, customerUserId: 'customer-123', craftsmanUserId: 'craftsman-456' })

      // Check project artifact before offer
      const before = getThreadArtifacts(threadId)
      expect(before.projectArtifact).not.toBeNull()
      expect(before.projectArtifact!.project.id).toBe(projectId)

      // Create and accept offer
      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
        price: '3.500 €',
        description: 'Fassade erneuern',
      })
      await acceptOfferWorkflow(offer.id)

      // Project artifact should still exist after acceptance
      const after = getThreadArtifacts(threadId)
      expect(after.projectArtifact).not.toBeNull()
      expect(after.projectArtifact!.project.id).toBe(projectId)
    })
  })

  // ───────────────────────────────────────────────────────────────────────
  // 2. Project card and offer card can coexist in the same thread
  // ───────────────────────────────────────────────────────────────────────
  describe('Artifact coexistence', () => {
    it('project artifact and offer artifact coexist in the same thread', async () => {
      const projectId = 'project-coexist-001'
      const threadId = 'conv-coexist-001'

      // Seed real project
      await addProject(seedProject({
        id: projectId,
        title: 'Dachsanierung',
        status: 'request',
      }))

      // Seed conversation with project link
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
        projectTitle: 'Dachsanierung',
      }))
      await persistProjectArtifact({ conversationId: threadId, projectId, customerUserId: 'customer-123', craftsmanUserId: 'craftsman-456' })

      // Create an offer
      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
        price: '8.000 €',
        description: 'Dach komplett erneuern',
      })

      // Both artifacts should be present
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.project.id).toBe(projectId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.offer.price).toBe('8.000 €')
      expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
    })

    it('project and offer artifacts are independent — removing one does not affect the other', async () => {
      const projectId = 'project-indep-001'
      const threadId = 'conv-indep-001'

      // Only project, no offer
      await addProject(seedProject({ id: projectId, title: 'Elektroinstallation' }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
        projectTitle: 'Elektroinstallation',
      }))
      await persistProjectArtifact({ conversationId: threadId, projectId, customerUserId: 'customer-123', craftsmanUserId: 'craftsman-456' })

      const withProjectOnly = getThreadArtifacts(threadId)
      expect(withProjectOnly.projectArtifact).not.toBeNull()
      expect(withProjectOnly.offerPaymentArtifact).toBeNull()

      // Add offer
      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
        price: '2.000 €',
      })

      const withBoth = getThreadArtifacts(threadId)
      expect(withBoth.projectArtifact).not.toBeNull()
      expect(withBoth.offerPaymentArtifact).not.toBeNull()
    })
  })

  // ───────────────────────────────────────────────────────────────────────
  // 3. Offer send is not blocked by unrelated project-completeness gating
  // ───────────────────────────────────────────────────────────────────────
  describe('Offer gating bypass', () => {
    it('profile-origin job skips intake prerequisite', () => {
      const job = seedJob({
        amount: '5.000 €',
        description: 'Badezimmer komplett sanieren',
        intakeContext: {
          origin: 'inquiry_profile',
          originLabel: 'Profil-Anfrage',
        },
      })

      const readiness = deriveProposalReadiness(job)
      expect(readiness.readiness).toBe('ready_for_proposal')
      // Intake should be satisfied for profile origin
      const intakePrereq = readiness.prerequisites.find(p => p.id === 'intake')
      expect(intakePrereq?.satisfied).toBe(true)
    })

    it('reel-origin job with valid offer fields skips intake gating', () => {
      const job = seedJob({
        amount: '3.500 €',
        description: 'Fassade erneuern und streichen',
        sourceConversationId: 'conv-chat-001',
        intakeContext: {
          origin: 'inquiry_reel',
          originLabel: 'Explore-Reel',
          // No requestDescription, requestLocation etc. → intake would be incomplete
        },
      })

      const readiness = deriveProposalReadiness(job)
      // Should be ready because chat-origin + valid offer fields bypass intake
      expect(readiness.readiness).toBe('ready_for_proposal')
      const intakePrereq = readiness.prerequisites.find(p => p.id === 'intake')
      expect(intakePrereq?.satisfied).toBe(true)
    })

    it('reel-origin job without valid offer fields still requires intake', () => {
      const job = seedJob({
        amount: '',
        description: '',
        sourceConversationId: 'conv-chat-002',
        intakeContext: {
          origin: 'inquiry_reel',
          originLabel: 'Explore-Reel',
        },
      })

      const readiness = deriveProposalReadiness(job)
      expect(readiness.readiness).toBe('needs_clarification')
    })

    it('offer workflow does not gate on project completeness', async () => {
      const threadId = 'conv-no-gate-001'
      await addConversation(seedConversation({
        id: threadId,
        inquiryOrigin: 'profile',
      }))

      // Should succeed without any project or intake checks
      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
        price: '1.200 €',
      })

      expect(offer).toBeDefined()
      expect(offer.status).toBe('pending')
      expect(offer.price).toBe('1.200 €')
    })
  })

  // ───────────────────────────────────────────────────────────────────────
  // 4. Sent offer appears as a separate thread artifact
  // ───────────────────────────────────────────────────────────────────────
  describe('Offer as separate artifact', () => {
    it('sent offer appears as its own OfferPaymentArtifact, not as project', async () => {
      const threadId = 'conv-separate-001'
      await addConversation(seedConversation({
        id: threadId,
        inquiryOrigin: 'profile',
      }))

      // No project artifact should exist (profile inquiry with no real project)
      const beforeOffer = getThreadArtifacts(threadId)
      expect(beforeOffer.projectArtifact).toBeNull()
      expect(beforeOffer.offerPaymentArtifact).toBeNull()

      // Send offer
      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
        price: '2.500 €',
        description: 'Malerarbeiten Wohnzimmer',
      })

      const afterOffer = getThreadArtifacts(threadId)
      // Offer artifact appears, project artifact stays null
      expect(afterOffer.projectArtifact).toBeNull()
      expect(afterOffer.offerPaymentArtifact).not.toBeNull()
      expect(afterOffer.offerPaymentArtifact!.kind).toBe('offer_payment')
      expect(afterOffer.offerPaymentArtifact!.phase).toBe('sent')
      expect(afterOffer.offerPaymentArtifact!.offer.price).toBe('2.500 €')
    })

    it('offer artifact and project artifact have different kinds', async () => {
      const projectId = 'project-kinds-001'
      const threadId = 'conv-kinds-001'

      await addProject(seedProject({ id: projectId }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
      }))
      await persistProjectArtifact({ conversationId: threadId, projectId, customerUserId: 'customer-123', craftsmanUserId: 'craftsman-456' })
      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
        price: '4.000 €',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact!.kind).toBe('project')
      expect(artifacts.offerPaymentArtifact!.kind).toBe('offer_payment')
      // They are genuinely different artifact types
      expect(artifacts.projectArtifact!.kind).not.toBe(artifacts.offerPaymentArtifact!.kind)
    })
  })

  // ───────────────────────────────────────────────────────────────────────
  // 5. Accepted offer becomes payment/deposit actionable
  // ───────────────────────────────────────────────────────────────────────
  describe('Offer to payment transition', () => {
    it('accepted offer transitions to payment_due phase', async () => {
      const threadId = 'conv-payment-001'
      await addConversation(seedConversation({
        id: threadId,
        inquiryOrigin: 'profile',
      }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
        price: '5.000 €',
        description: 'Komplette Badsanierung',
      })

      // Before acceptance: phase is 'sent'
      const beforeAccept = getThreadArtifacts(threadId)
      expect(beforeAccept.offerPaymentArtifact!.phase).toBe('sent')
      expect(beforeAccept.offerPaymentArtifact!.jobId).toBeNull()

      // Accept the offer
      await acceptOfferWorkflow(offer.id)

      // After acceptance: phase should be 'payment_due'
      const afterAccept = getThreadArtifacts(threadId)
      expect(afterAccept.offerPaymentArtifact).not.toBeNull()
      expect(afterAccept.offerPaymentArtifact!.phase).toBe('payment_due')
      expect(afterAccept.offerPaymentArtifact!.jobId).not.toBeNull()
      expect(afterAccept.offerPaymentArtifact!.paymentState).toBe('deposit_required')
    })

    it('accepted offer has correct payment state in artifact', async () => {
      const threadId = 'conv-payment-002'
      await addConversation(seedConversation({
        id: threadId,
        inquiryOrigin: 'reel',
      }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
        price: '3.000 €',
      })

      await acceptOfferWorkflow(offer.id)

      const artifacts = getThreadArtifacts(threadId)
      const opArtifact = artifacts.offerPaymentArtifact!
      expect(opArtifact.paymentState).toBe('deposit_required')

      // Verify the underlying job has correct state
      const job = getJobById(opArtifact.jobId!)
      expect(job).toBeDefined()
      expect(job!.paymentState).toBe('deposit_required')
      expect(job!.proposalAcceptedAt).toBeDefined()
    })

    it('project created on acceptance does not override offer artifact', async () => {
      const threadId = 'conv-payment-003'
      await addConversation(seedConversation({
        id: threadId,
        inquiryOrigin: 'profile',
      }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
        price: '6.000 €',
        description: 'Dacharbeiten',
      })

      await acceptOfferWorkflow(offer.id)

      const artifacts = getThreadArtifacts(threadId)
      // Offer artifact is still the offer/payment type, NOT a project type
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.kind).toBe('offer_payment')
      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')

      // A project may also have been created (by ensureProjectForAcceptedOffer)
      // but it lives in the projectArtifact lane, not conflated with the offer
      if (artifacts.projectArtifact) {
        expect(artifacts.projectArtifact.kind).toBe('project')
        expect(artifacts.projectArtifact.kind).not.toBe(artifacts.offerPaymentArtifact!.kind)
      }
    })
  })

  // ───────────────────────────────────────────────────────────────────────
  // 6. No regression to inquiry-only cases
  // ───────────────────────────────────────────────────────────────────────
  describe('Inquiry regression safety', () => {
    it('inquiry thread without offer or project has null artifacts', async () => {
      const threadId = 'conv-inquiry-only-001'
      await addConversation(seedConversation({
        id: threadId,
        inquiryOrigin: 'reel',
      }))

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).toBeNull()
      expect(artifacts.offerPaymentArtifact).toBeNull()
    })

    it('profile inquiry does not produce fake project artifact', async () => {
      const threadId = 'conv-profile-only-001'
      await addConversation(seedConversation({
        id: threadId,
        projectId: `project_profile_craft123_${threadId}`, // synthetic ID
        inquiryOrigin: 'profile',
      }))

      const artifacts = getThreadArtifacts(threadId)
      // Synthetic project IDs (project_profile_...) are NOT valid UUIDs
      // and should not produce a project artifact
      expect(artifacts.projectArtifact).toBeNull()
      expect(artifacts.offerPaymentArtifact).toBeNull()
    })

    it('conversion state correctly reflects inquiry vs project', async () => {
      const threadId = 'conv-conversion-001'
      await addConversation(seedConversation({
        id: threadId,
        inquiryOrigin: 'reel',
      }))

      expect(getThreadConversionState(threadId)).toBe('inquiry')

      // Create and accept offer → should now be 'project'
      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
        price: '1.000 €',
      })
      await acceptOfferWorkflow(offer.id)

      expect(getThreadConversionState(threadId)).toBe('project')
    })
  })

  // ───────────────────────────────────────────────────────────────────────
  // 7. Canonical owner / offer lifecycle semantics
  // ───────────────────────────────────────────────────────────────────────
  describe('Canonical owner and lifecycle', () => {
    it('job is the canonical owner after offer acceptance', async () => {
      const threadId = 'conv-canonical-001'
      await addConversation(seedConversation({
        id: threadId,
        inquiryOrigin: 'profile',
      }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
        price: '4.500 €',
      })

      await acceptOfferWorkflow(offer.id)

      // Job exists and is linked to the conversation
      const jobs = getJobs()
      const linkedJob = jobs.find(j => j.sourceConversationId === threadId)
      expect(linkedJob).toBeDefined()
      expect(linkedJob!.proposalSentAt).toBeDefined()
      expect(linkedJob!.proposalAcceptedAt).toBeDefined()

      // Job context available for thread
      const jobCtx = getJobContextForThread(threadId)
      expect(jobCtx).not.toBeNull()
      expect(jobCtx!.jobId).toBe(linkedJob!.id)
    })

    it('offer lifecycle follows correct phases: sent → accepted → payment_due', async () => {
      const threadId = 'conv-lifecycle-001'
      await addConversation(seedConversation({
        id: threadId,
        inquiryOrigin: 'reel',
      }))

      // Phase 1: Sent
      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
        price: '7.000 €',
        description: 'Gesamtumbau',
      })

      let artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')

      // Phase 2: Accepted
      await acceptOfferWorkflow(offer.id)

      artifacts = getThreadArtifacts(threadId)
      // After acceptance with deposit_required, should be payment_due
      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
      expect(artifacts.offerPaymentArtifact!.offer.status).toBe('accepted')
    })

    it('declined offer appears as declined artifact (not hidden)', async () => {
      const threadId = 'conv-decline-001'
      await addConversation(seedConversation({
        id: threadId,
        inquiryOrigin: 'profile',
      }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
        price: '2.000 €',
      })

      const { declineOfferWorkflow } = await import('../../src/lib/workflow/offerWorkflow')
      await declineOfferWorkflow(offer.id)

      const artifacts = getThreadArtifacts(threadId)
      // Declined offers are shown as 'declined' phase artifacts for thread continuity
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('declined')
      expect(artifacts.offerPaymentArtifact!.offer.status).toBe('declined')
      expect(artifacts.offerPaymentArtifact!.persistenceStatus).toBe('confirmed')
    })

    it('incoming request disappears after offer acceptance creates a job', async () => {
      const threadId = 'conv-request-001'
      await addConversation(seedConversation({
        id: threadId,
        inquiryOrigin: 'reel',
        unreadCount: 1,
      }))

      // Before: should be an incoming request
      expect(getIncomingRequestForThread(threadId)).not.toBeNull()

      // Accept offer
      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
        price: '3.000 €',
      })
      await acceptOfferWorkflow(offer.id)

      // After: no longer an incoming request (job exists)
      expect(getIncomingRequestForThread(threadId)).toBeNull()
    })
  })

  // ───────────────────────────────────────────────────────────────────────
  // 8. Project artifact persistence hardening
  // ───────────────────────────────────────────────────────────────────────
  describe('Project artifact persistence hardening', () => {
    it('project attached via message persists after re-deriving artifacts', async () => {
      const projectId = 'project-msg-attach-001'
      const threadId = 'conv-msg-attach-001'

      // Seed a real project
      await addProject(seedProject({
        id: projectId,
        title: 'Balkonanbau',
        status: 'request',
        source: 'builder',
      }))

      // Seed conversation WITHOUT sourceProjectId — simulates a thread where
      // the project is attached via message, not builder-origin
      await addConversation(seedConversation({
        id: threadId,
        projectId: `project_profile_craft_${threadId}`, // synthetic ID
        inquiryOrigin: 'profile',
        // sourceProjectId intentionally NOT set
      }))

      // Attach project via message (this should stamp sourceProjectId)
      const { sendProjectAttachmentToThread } = await import('../../src/lib/messages/service')
      await sendProjectAttachmentToThread(threadId, projectId)

      // First derivation — should find the project from the now-stamped sourceProjectId
      const artifacts1 = getThreadArtifacts(threadId)
      expect(artifacts1.projectArtifact).not.toBeNull()
      expect(artifacts1.projectArtifact!.project.id).toBe(projectId)
      expect(artifacts1.projectArtifact!.project.title).toBe('Balkonanbau')
      expect(artifacts1.projectArtifact!.isCustomerCreated).toBe(true)

      // Simulate "reload" — re-derive from persisted state
      const artifacts2 = getThreadArtifacts(threadId)
      expect(artifacts2.projectArtifact).not.toBeNull()
      expect(artifacts2.projectArtifact!.project.id).toBe(projectId)
      expect(artifacts2.projectArtifact!.project.title).toBe('Balkonanbau')
    })

    it('getThreadArtifacts restores real project from persisted sourceProjectId linkage', async () => {
      const projectId = 'project-linkage-001'
      const threadId = 'conv-linkage-001'

      await addProject(seedProject({
        id: projectId,
        title: 'Heizungsanlage',
        status: 'request',
      }))

      // Conversation with canonical sourceProjectId linkage
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
        projectTitle: 'Heizungsanlage',
      }))
      await persistProjectArtifact({ conversationId: threadId, projectId, customerUserId: 'customer-123', craftsmanUserId: 'craftsman-456' })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      // The project must come from persisted data, not placeholder metadata
      expect(artifacts.projectArtifact!.project.id).toBe(projectId)
      expect(artifacts.projectArtifact!.project.title).toBe('Heizungsanlage')
      expect(artifacts.projectArtifact!.kind).toBe('project')
    })

    it('clicking restored project artifact resolves the same real project id', async () => {
      const projectId = 'project-click-001'
      const threadId = 'conv-click-001'

      await addProject(seedProject({
        id: projectId,
        title: 'Treppensanierung',
      }))

      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
      }))
      await persistProjectArtifact({ conversationId: threadId, projectId, customerUserId: 'customer-123', craftsmanUserId: 'craftsman-456' })

      // First read
      const artifacts1 = getThreadArtifacts(threadId)
      const id1 = artifacts1.projectArtifact!.project.id

      // "Reload" — second read
      const artifacts2 = getThreadArtifacts(threadId)
      const id2 = artifacts2.projectArtifact!.project.id

      // Both must resolve to the same real project ID
      expect(id1).toBe(projectId)
      expect(id2).toBe(projectId)
      expect(id1).toBe(id2)
    })

    it('message-attached project is marked as customer-created', async () => {
      const projectId = 'project-cust-created-001'
      const threadId = 'conv-cust-created-001'

      await addProject(seedProject({
        id: projectId,
        title: 'Gartengestaltung',
      }))

      await addConversation(seedConversation({
        id: threadId,
        projectId: `project_reel_${threadId}`, // synthetic
        inquiryOrigin: 'reel',
      }))

      // Attach via message
      const { sendProjectAttachmentToThread } = await import('../../src/lib/messages/service')
      await sendProjectAttachmentToThread(threadId, projectId)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.isCustomerCreated).toBe(true)
    })

    it('synthetic project ID does not produce a project artifact', async () => {
      const threadId = 'conv-synthetic-001'

      await addConversation(seedConversation({
        id: threadId,
        projectId: 'project_category_plumbing_123', // synthetic, not a UUID
        inquiryOrigin: 'category',
      }))

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).toBeNull()
    })

    it('sendProjectAttachmentToThread stamps sourceProjectId on conversation', async () => {
      const projectId = 'project-stamp-001'
      const threadId = 'conv-stamp-001'

      await addProject(seedProject({ id: projectId, title: 'Fenstereinbau' }))

      await addConversation(seedConversation({
        id: threadId,
        projectId: `project_profile_${threadId}`,
        inquiryOrigin: 'profile',
        // sourceProjectId NOT set initially
      }))

      // Before attachment, no sourceProjectId
      const { getConversationById } = await import('../../src/lib/messages')
      const convBefore = getConversationById(threadId)
      expect(convBefore?.sourceProjectId).toBeUndefined()

      // Attach project
      const { sendProjectAttachmentToThread } = await import('../../src/lib/messages/service')
      await sendProjectAttachmentToThread(threadId, projectId)

      // After attachment, sourceProjectId should be stamped
      const convAfter = getConversationById(threadId)
      expect(convAfter?.sourceProjectId).toBe(projectId)
    })
  })

  // ───────────────────────────────────────────────────────────────────────
  // 9. Narrow offer gating
  // ───────────────────────────────────────────────────────────────────────
  describe('Narrow offer gating', () => {
    it('reel-origin job with valid offer fields bypasses intake', () => {
      const job = seedJob({
        amount: '2.000 €',
        description: 'Malerarbeiten Flur',
        sourceConversationId: 'conv-reel-001',
        intakeContext: {
          origin: 'inquiry_reel',
          originLabel: 'Explore-Reel',
        },
      })

      const readiness = deriveProposalReadiness(job)
      expect(readiness.readiness).toBe('ready_for_proposal')
      const intakePrereq = readiness.prerequisites.find(p => p.id === 'intake')
      expect(intakePrereq?.satisfied).toBe(true)
    })

    it('category-origin job with valid offer fields does NOT bypass intake', () => {
      const job = seedJob({
        amount: '4.000 €',
        description: 'Sanitärarbeit komplett',
        sourceConversationId: 'conv-category-001',
        intakeContext: {
          origin: 'inquiry_category',
          originLabel: 'Kategorie-Suche',
          // No requestDescription, requestLocation etc. → intake incomplete
        },
      })

      const readiness = deriveProposalReadiness(job)
      // Category-origin has structured intake → must satisfy normal intake readiness
      expect(readiness.readiness).toBe('needs_clarification')
      const intakePrereq = readiness.prerequisites.find(p => p.id === 'intake')
      expect(intakePrereq?.satisfied).toBe(false)
    })

    it('project-origin job with valid offer fields does NOT bypass intake', () => {
      const job = seedJob({
        amount: '6.000 €',
        description: 'Dachdeckerarbeiten',
        sourceConversationId: 'conv-project-001',
        intakeContext: {
          origin: 'inquiry_project',
          originLabel: 'Projekt-Anfrage',
        },
      })

      const readiness = deriveProposalReadiness(job)
      expect(readiness.readiness).toBe('needs_clarification')
      const intakePrereq = readiness.prerequisites.find(p => p.id === 'intake')
      expect(intakePrereq?.satisfied).toBe(false)
    })

    it('direct-origin job does NOT bypass intake', () => {
      const job = seedJob({
        amount: '1.500 €',
        description: 'Elektroarbeit',
        sourceConversationId: 'conv-direct-001',
        intakeContext: {
          origin: 'direct',
          originLabel: 'Direkt',
        },
      })

      const readiness = deriveProposalReadiness(job)
      expect(readiness.readiness).toBe('needs_clarification')
      const intakePrereq = readiness.prerequisites.find(p => p.id === 'intake')
      expect(intakePrereq?.satisfied).toBe(false)
    })

    it('reel-origin job without valid offer fields does NOT bypass intake', () => {
      const job = seedJob({
        amount: '',
        description: '',
        sourceConversationId: 'conv-reel-empty-001',
        intakeContext: {
          origin: 'inquiry_reel',
          originLabel: 'Explore-Reel',
        },
      })

      const readiness = deriveProposalReadiness(job)
      expect(readiness.readiness).toBe('needs_clarification')
    })

    it('profile-origin always bypasses intake (even without offer fields)', () => {
      const job = seedJob({
        amount: '',
        description: '',
        intakeContext: {
          origin: 'inquiry_profile',
          originLabel: 'Profil-Anfrage',
        },
      })

      const readiness = deriveProposalReadiness(job)
      // Profile-origin is a blanket bypass for intake
      const intakePrereq = readiness.prerequisites.find(p => p.id === 'intake')
      expect(intakePrereq?.satisfied).toBe(true)
      // But overall readiness is still needs_clarification because amount/description are empty
      expect(readiness.readiness).toBe('needs_clarification')
    })

    it('accepted/payment-ready artifact not affected by narrowed gating', async () => {
      const threadId = 'conv-narrow-accept-001'
      await addConversation(seedConversation({
        id: threadId,
        inquiryOrigin: 'reel',
      }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
        price: '5.500 €',
        description: 'Gartenarbeit komplett',
      })

      await acceptOfferWorkflow(offer.id)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
      expect(artifacts.offerPaymentArtifact!.paymentState).toBe('deposit_required')
    })
  })
})
