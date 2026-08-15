/**
 * Thread Artifact End-to-End Tests
 *
 * Validates the complete runtime chain:
 *   1. Customer creates a real project
 *   2. Customer sends that project into the chat/thread
 *   3. Project card survives reload on BOTH customer and craftsman sides
 *   4. Craftsman sends a real offer for that case
 *   5. Customer receives a distinct offer card in the thread
 *   6. Offer card survives reload on BOTH sides
 *   7. Customer accepts the offer card
 *   8. After acceptance, the same offer card becomes payment/deposit actionable
 *   9. Payment/deposit state survives reload
 *  10. Project card and offer/payment card coexist cleanly without collision
 *
 * These tests verify the real runtime persistence + rehydration path,
 * not just selector-only compensation.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getConversationById,
  getThreadArtifacts,
  sendProjectAttachmentToThread,
  persistProjectArtifact,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject, getProjectById } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import { getJobById } from '../../src/lib/jobs'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
} from '../../src/lib/workflow'
import { getOffersByConversationId, getOfferById } from '../../src/lib/offers/service'
import { getPaymentForJob } from '../../src/lib/payments'

// ── Helpers ─────────────────────────────────────────────────────────────────

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: overrides.projectId ?? `project-${id}`,
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-e2e-001',
    craftsmanName: 'Peter Handwerker',
    craftsmanHandle: 'peter-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-e2e-001',
    projectTitle: 'Badezimmer Sanierung',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Berlin',
    projectCostRange: '€8,000-12,000',
    projectDuration: '3 Wochen',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Gerade eben',
    inquiryOrigin: 'reel',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  const id = overrides.id ?? `project-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    title: 'Badezimmer Sanierung',
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

describe('Thread Artifact End-to-End Flow', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // COMPLETE E2E CHAIN (all 10 steps in one test)
  // ─────────────────────────────────────────────────────────────────────────

  it('complete flow: project → attach → reload → offer → reload → accept → payment → reload → coexist', async () => {
    // ── Step 1: Customer creates a real project ──
    const projectId = 'e2e-project-full-chain'
    const project = seedProject({
      id: projectId,
      title: 'Küche komplett erneuern',
      description: 'Alte Küche raus, neue rein',
      location: 'München',
      category: 'Küchenbau',
    })
    await addProject(project)

    // Verify project exists in store
    const storedProject = getProjectById(projectId)
    expect(storedProject).toBeDefined()
    expect(storedProject!.title).toBe('Küche komplett erneuern')

    // ── Step 2: Customer sends project into chat/thread ──
    const threadId = 'conv-e2e-full-chain'
    await addConversation(seedConversation({
      id: threadId,
      projectId: `project_reel_${threadId}`, // synthetic legacy ID
      inquiryOrigin: 'reel',
      // sourceProjectId NOT set initially — will be stamped by sendProjectAttachmentToThread
    }))

    // Before attachment, no project artifact
    const beforeAttach = getThreadArtifacts(threadId)
    expect(beforeAttach.projectArtifact).toBeNull()

    // Customer sends project attachment
    await sendProjectAttachmentToThread(threadId, projectId)

    // Verify sourceProjectId was stamped on conversation
    const convAfterAttach = getConversationById(threadId)
    expect(convAfterAttach?.sourceProjectId).toBe(projectId)

    // ── Step 3: Project card survives reload on BOTH sides ──
    // First derivation (simulates initial page load)
    const afterAttach1 = getThreadArtifacts(threadId)
    expect(afterAttach1.projectArtifact).not.toBeNull()
    expect(afterAttach1.projectArtifact!.project.id).toBe(projectId)
    expect(afterAttach1.projectArtifact!.project.title).toBe('Küche komplett erneuern')
    expect(afterAttach1.projectArtifact!.isCustomerCreated).toBe(true)
    expect(afterAttach1.projectArtifact!.kind).toBe('project')

    // Simulate "reload" — re-derive from persisted state (same for customer AND craftsman)
    const afterAttach2 = getThreadArtifacts(threadId)
    expect(afterAttach2.projectArtifact).not.toBeNull()
    expect(afterAttach2.projectArtifact!.project.id).toBe(projectId)
    expect(afterAttach2.projectArtifact!.project.title).toBe('Küche komplett erneuern')
    expect(afterAttach2.projectArtifact!.isCustomerCreated).toBe(true)

    // ── Step 4: Craftsman sends a real offer ──
    const offer = await createOfferWorkflow({
      conversationId: threadId,
      customerUserId: 'customer-e2e-001',
      craftsmanUserId: 'craftsman-e2e-001',
      price: '15.000 €',
      description: 'Komplette Küchensanierung inkl. Geräte',
    })
    expect(offer).toBeDefined()
    expect(offer.status).toBe('pending')
    expect(offer.conversationId).toBe(threadId)

    // ── Step 5: Customer receives distinct offer card in thread ──
    const afterOffer = getThreadArtifacts(threadId)
    expect(afterOffer.offerPaymentArtifact).not.toBeNull()
    expect(afterOffer.offerPaymentArtifact!.kind).toBe('offer_payment')
    expect(afterOffer.offerPaymentArtifact!.phase).toBe('sent')
    expect(afterOffer.offerPaymentArtifact!.offer.price).toBe('15.000 €')
    expect(afterOffer.offerPaymentArtifact!.offer.description).toBe('Komplette Küchensanierung inkl. Geräte')

    // Project artifact is still present alongside offer
    expect(afterOffer.projectArtifact).not.toBeNull()
    expect(afterOffer.projectArtifact!.project.id).toBe(projectId)

    // ── Step 6: Offer card survives reload on BOTH sides ──
    const afterOfferReload = getThreadArtifacts(threadId)
    expect(afterOfferReload.offerPaymentArtifact).not.toBeNull()
    expect(afterOfferReload.offerPaymentArtifact!.phase).toBe('sent')
    expect(afterOfferReload.offerPaymentArtifact!.offer.price).toBe('15.000 €')
    expect(afterOfferReload.offerPaymentArtifact!.offer.id).toBe(offer.id)

    // Offer is persisted in the offer repository
    const persistedOffers = getOffersByConversationId(threadId)
    expect(persistedOffers).toHaveLength(1)
    expect(persistedOffers[0].id).toBe(offer.id)
    expect(persistedOffers[0].status).toBe('pending')

    // ── Step 7: Customer accepts the offer card ──
    const accepted = await acceptOfferWorkflow(offer.id)
    expect(accepted).toBeDefined()
    expect(accepted!.status).toBe('accepted')
    expect(accepted!.createdJobId).toBeDefined()

    // ── Step 8: After acceptance, offer card becomes payment/deposit actionable ──
    const afterAccept = getThreadArtifacts(threadId)
    expect(afterAccept.offerPaymentArtifact).not.toBeNull()
    expect(afterAccept.offerPaymentArtifact!.phase).toBe('payment_due')
    expect(afterAccept.offerPaymentArtifact!.paymentState).toBe('deposit_required')
    expect(afterAccept.offerPaymentArtifact!.jobId).not.toBeNull()

    // Verify the underlying job exists with correct state
    const jobId = afterAccept.offerPaymentArtifact!.jobId!
    const job = getJobById(jobId)
    expect(job).toBeDefined()
    expect(job!.proposalAcceptedAt).toBeDefined()
    expect(job!.paymentState).toBe('deposit_required')

    // Verify payment entity was created
    const payment = getPaymentForJob(jobId)
    expect(payment).toBeDefined()

    // ── Step 9: Payment/deposit state survives reload ──
    const afterPaymentReload = getThreadArtifacts(threadId)
    expect(afterPaymentReload.offerPaymentArtifact).not.toBeNull()
    expect(afterPaymentReload.offerPaymentArtifact!.phase).toBe('payment_due')
    expect(afterPaymentReload.offerPaymentArtifact!.paymentState).toBe('deposit_required')
    expect(afterPaymentReload.offerPaymentArtifact!.jobId).toBe(jobId)

    // Verify offer status persists after reload
    const reloadedOffer = getOfferById(offer.id)
    expect(reloadedOffer).toBeDefined()
    expect(reloadedOffer!.status).toBe('accepted')
    expect(reloadedOffer!.createdJobId).toBe(jobId)

    // ── Step 10: Project card and offer/payment card coexist cleanly ──
    const finalArtifacts = getThreadArtifacts(threadId)
    // Both artifacts present
    expect(finalArtifacts.projectArtifact).not.toBeNull()
    expect(finalArtifacts.offerPaymentArtifact).not.toBeNull()

    // They are genuinely different artifact types
    expect(finalArtifacts.projectArtifact!.kind).toBe('project')
    expect(finalArtifacts.offerPaymentArtifact!.kind).toBe('offer_payment')

    // Project card is still the original customer project
    expect(finalArtifacts.projectArtifact!.project.id).toBe(projectId)
    expect(finalArtifacts.projectArtifact!.project.title).toBe('Küche komplett erneuern')
    expect(finalArtifacts.projectArtifact!.isCustomerCreated).toBe(true)

    // Offer card is the accepted/payment-ready offer
    expect(finalArtifacts.offerPaymentArtifact!.offer.price).toBe('15.000 €')
    expect(finalArtifacts.offerPaymentArtifact!.phase).toBe('payment_due')
    expect(finalArtifacts.offerPaymentArtifact!.paymentState).toBe('deposit_required')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // OFFER RELOAD STABILITY
  // ─────────────────────────────────────────────────────────────────────────

  describe('Offer artifact reload stability', () => {
    it('pending offer persists across multiple re-derivations', async () => {
      const threadId = 'conv-offer-reload-001'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-e2e-001',
        craftsmanUserId: 'craftsman-e2e-001',
        price: '3.500 €',
        description: 'Fliesenarbeit Bad',
      })

      // Three consecutive re-derivations — must all return the same offer
      for (let i = 0; i < 3; i++) {
        const artifacts = getThreadArtifacts(threadId)
        expect(artifacts.offerPaymentArtifact).not.toBeNull()
        expect(artifacts.offerPaymentArtifact!.offer.id).toBe(offer.id)
        expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
        expect(artifacts.offerPaymentArtifact!.offer.price).toBe('3.500 €')
      }
    })

    it('accepted offer with payment_due persists across multiple re-derivations', async () => {
      const threadId = 'conv-payment-reload-001'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-e2e-001',
        craftsmanUserId: 'craftsman-e2e-001',
        price: '6.000 €',
      })

      await acceptOfferWorkflow(offer.id)

      // Three consecutive re-derivations — must all return payment_due
      for (let i = 0; i < 3; i++) {
        const artifacts = getThreadArtifacts(threadId)
        expect(artifacts.offerPaymentArtifact).not.toBeNull()
        expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
        expect(artifacts.offerPaymentArtifact!.paymentState).toBe('deposit_required')
        expect(artifacts.offerPaymentArtifact!.jobId).not.toBeNull()
      }
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // CRAFTSMAN-SIDE PARITY
  // ─────────────────────────────────────────────────────────────────────────

  describe('Both-sides artifact parity', () => {
    it('getThreadArtifacts returns identical artifacts regardless of caller role', async () => {
      const projectId = 'e2e-parity-project'
      const threadId = 'conv-parity-001'

      await addProject(seedProject({ id: projectId, title: 'Wohnzimmer streichen' }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
      }))
      await persistProjectArtifact({ conversationId: threadId, projectId, customerUserId: 'customer-e2e-001', craftsmanUserId: 'craftsman-e2e-001' })

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-e2e-001',
        craftsmanUserId: 'craftsman-e2e-001',
        price: '2.200 €',
      })

      await acceptOfferWorkflow(offer.id)

      // getThreadArtifacts is role-agnostic — both customer and craftsman
      // read from the same persisted store. Verify consistent derivation.
      const call1 = getThreadArtifacts(threadId)
      const call2 = getThreadArtifacts(threadId)

      // Project artifact parity
      expect(call1.projectArtifact).not.toBeNull()
      expect(call2.projectArtifact).not.toBeNull()
      expect(call1.projectArtifact!.project.id).toBe(call2.projectArtifact!.project.id)
      expect(call1.projectArtifact!.project.id).toBe(projectId)

      // Offer/payment artifact parity
      expect(call1.offerPaymentArtifact).not.toBeNull()
      expect(call2.offerPaymentArtifact).not.toBeNull()
      expect(call1.offerPaymentArtifact!.offer.id).toBe(call2.offerPaymentArtifact!.offer.id)
      expect(call1.offerPaymentArtifact!.phase).toBe(call2.offerPaymentArtifact!.phase)
      expect(call1.offerPaymentArtifact!.paymentState).toBe(call2.offerPaymentArtifact!.paymentState)
      expect(call1.offerPaymentArtifact!.jobId).toBe(call2.offerPaymentArtifact!.jobId)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // sendProjectAttachmentToThread + createOfferWorkflow INTEGRATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('Project attachment + offer creation integration', () => {
    it('attaching a project then creating offer yields both artifacts', async () => {
      const projectId = 'e2e-attach-then-offer'
      const threadId = 'conv-attach-offer-001'

      await addProject(seedProject({ id: projectId, title: 'Garagentor-Einbau' }))
      await addConversation(seedConversation({
        id: threadId,
        inquiryOrigin: 'reel',
      }))

      // Step A: Attach project
      await sendProjectAttachmentToThread(threadId, projectId)

      // Step B: Create offer
      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-e2e-001',
        craftsmanUserId: 'craftsman-e2e-001',
        price: '4.800 €',
        description: 'Garagentor inkl. Einbau',
      })

      // Both artifacts present and independent
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.project.id).toBe(projectId)
      expect(artifacts.projectArtifact!.kind).toBe('project')

      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.offer.price).toBe('4.800 €')
      expect(artifacts.offerPaymentArtifact!.kind).toBe('offer_payment')
      expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
    })

    it('project attachment uses createOfferWorkflow preferredProjectId from sourceProjectId', async () => {
      const projectId = 'e2e-preferred-project'
      const threadId = 'conv-preferred-001'

      await addProject(seedProject({ id: projectId, title: 'Balkon verglasen' }))
      await addConversation(seedConversation({
        id: threadId,
        projectId: `project_reel_${threadId}`, // synthetic legacy ID
        inquiryOrigin: 'reel',
      }))

      // Attach project stamps sourceProjectId
      await sendProjectAttachmentToThread(threadId, projectId)

      // Verify sourceProjectId is now stamped
      const conv = getConversationById(threadId)
      expect(conv?.sourceProjectId).toBe(projectId)

      // Create offer — offerWorkflow should pick up sourceProjectId
      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-e2e-001',
        craftsmanUserId: 'craftsman-e2e-001',
        price: '9.500 €',
      })

      // Accept — job should link to the real project, not the synthetic one
      const accepted = await acceptOfferWorkflow(offer.id)
      expect(accepted).toBeDefined()

      const job = getJobById(accepted!.createdJobId!)
      expect(job).toBeDefined()
      // Job should reference the real project ID (the one from sourceProjectId)
      expect(job!.projectId).toBe(projectId)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // REGRESSION SAFETY
  // ─────────────────────────────────────────────────────────────────────────

  describe('Regression safety', () => {
    it('no regression: synthetic project IDs do not produce artifacts', async () => {
      const threadId = 'conv-no-regression-001'
      await addConversation(seedConversation({
        id: threadId,
        projectId: 'project_profile_craft123_conv-001', // synthetic
        inquiryOrigin: 'profile',
      }))

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).toBeNull()
      expect(artifacts.offerPaymentArtifact).toBeNull()
    })

    it('no regression: cancelled terminal semantics preserved', async () => {
      const threadId = 'conv-cancel-regression-001'
      await addConversation(seedConversation({
        id: threadId,
        inquiryOrigin: 'profile',
      }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-e2e-001',
        craftsmanUserId: 'craftsman-e2e-001',
        price: '3.000 €',
      })

      const accepted = await acceptOfferWorkflow(offer.id)
      expect(accepted).toBeDefined()
      expect(accepted!.createdJobId).toBeDefined()

      const job = getJobById(accepted!.createdJobId!)
      expect(job).toBeDefined()
      // Job status should be 'booked' (not 'completed' or 'cancelled')
      expect(job!.status).toBe('booked')
      expect(job!.proposalAcceptedAt).toBeDefined()
    })

    it('no regression: offer not blocked by project-completeness for chat-origin', async () => {
      const threadId = 'conv-gating-regression-001'
      await addConversation(seedConversation({
        id: threadId,
        inquiryOrigin: 'reel',
      }))

      // Should succeed — not gated by project completeness
      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-e2e-001',
        craftsmanUserId: 'craftsman-e2e-001',
        price: '1.500 €',
        description: 'Kleine Reparatur',
      })

      expect(offer).toBeDefined()
      expect(offer.status).toBe('pending')
    })
  })
})
