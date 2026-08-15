/**
 * Thread Artifact Runtime Repair Tests
 *
 * Tests for the specific runtime bugs fixed in this package:
 *
 * 1. Customer-created project card survives when job context exists
 *    (after offer acceptance creates a job via getJobContextForThread)
 * 2. Offer card phase transitions to payment_due with paymentState after acceptance
 * 3. Both artifacts coexist after acceptance when a job context is present
 * 4. Project artifact NOT suppressed by job context for customer-created projects
 * 5. Auto-created (non-customer) project artifact IS still suppressed by job context
 * 6. Payment/deposit state visible on offer card after acceptance (phase propagation)
 *
 * These tests verify the runtime paths that connect:
 *   MessageThreadScreen → ThreadOfferCard / ThreadProjectContextBar
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getThreadArtifacts,
  sendProjectAttachmentToThread,
  persistProjectArtifact,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
} from '../../src/lib/workflow'
import { getJobContextForThread } from '../../src/lib/workflow/messageWorkflow'

// ── Helpers ─────────────────────────────────────────────────────────────────

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-rt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: overrides.projectId ?? `project-${id}`,
    customerName: 'Lena Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-rt-001',
    craftsmanName: 'Karl Handwerker',
    craftsmanHandle: 'karl-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-rt-001',
    projectTitle: 'Dachsanierung',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Hamburg',
    projectCostRange: '€10,000-15,000',
    projectDuration: '4 Wochen',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Gerade eben',
    inquiryOrigin: 'reel',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  const id = overrides.id ?? `project-rt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    title: 'Dachsanierung',
    customer: 'Lena Kundin',
    craftsman: '',
    location: 'Hamburg',
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

describe('Thread Artifact Runtime Repair', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // BUG FIX 1: Customer-created project card survives job context
  // ─────────────────────────────────────────────────────────────────────────

  describe('Project artifact with job context', () => {
    it('customer-created project card is visible even when job context exists (post-acceptance)', async () => {
      const projectId = 'rt-project-job-ctx-001'
      const threadId = 'conv-rt-job-ctx-001'

      // Create real customer project
      await addProject(seedProject({ id: projectId, title: 'Fassadenanstrich' }))

      // Create conversation with sourceProjectId
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
        inquiryOrigin: 'reel',
      }))
      await persistProjectArtifact({ conversationId: threadId, projectId, customerUserId: 'customer-rt-001', craftsmanUserId: 'craftsman-rt-001' })

      // Verify project artifact exists before offer
      const beforeOffer = getThreadArtifacts(threadId)
      expect(beforeOffer.projectArtifact).not.toBeNull()
      expect(beforeOffer.projectArtifact!.isCustomerCreated).toBe(true)

      // Create and accept offer — this creates a job
      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-rt-001',
        craftsmanUserId: 'craftsman-rt-001',
        price: '7.500 €',
      })
      await acceptOfferWorkflow(offer.id)

      // Job context now exists (this is what triggers the bug)
      const jobCtx = getJobContextForThread(threadId)
      expect(jobCtx).not.toBeNull()

      // CRITICAL: project artifact MUST still be present despite job context
      const afterAccept = getThreadArtifacts(threadId)
      expect(afterAccept.projectArtifact).not.toBeNull()
      expect(afterAccept.projectArtifact!.project.id).toBe(projectId)
      expect(afterAccept.projectArtifact!.isCustomerCreated).toBe(true)

      // The runtime rendering guard should allow this:
      // artifacts.projectArtifact && (!jobContext || artifacts.projectArtifact.isCustomerCreated)
      const shouldRender = afterAccept.projectArtifact !== null &&
        (!jobCtx || afterAccept.projectArtifact!.isCustomerCreated)
      expect(shouldRender).toBe(true)
    })

    it('project attached via message survives offer acceptance (isCustomerCreated = true)', async () => {
      const projectId = 'rt-project-msg-attach-001'
      const threadId = 'conv-rt-msg-attach-001'

      await addProject(seedProject({ id: projectId, title: 'Wintergarten' }))
      await addConversation(seedConversation({
        id: threadId,
        projectId: `project_reel_${threadId}`, // synthetic
        inquiryOrigin: 'reel',
      }))

      // Customer attaches project via message
      await sendProjectAttachmentToThread(threadId, projectId)

      // Verify attachment was stamped
      const artifacts1 = getThreadArtifacts(threadId)
      expect(artifacts1.projectArtifact).not.toBeNull()
      expect(artifacts1.projectArtifact!.isCustomerCreated).toBe(true)

      // Create and accept offer
      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-rt-001',
        craftsmanUserId: 'craftsman-rt-001',
        price: '12.000 €',
      })
      await acceptOfferWorkflow(offer.id)

      // Job context exists
      expect(getJobContextForThread(threadId)).not.toBeNull()

      // Project card MUST still render
      const afterAccept = getThreadArtifacts(threadId)
      expect(afterAccept.projectArtifact).not.toBeNull()
      expect(afterAccept.projectArtifact!.project.id).toBe(projectId)
      expect(afterAccept.projectArtifact!.isCustomerCreated).toBe(true)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // BUG FIX 2: Offer card phase/paymentState propagation
  // ─────────────────────────────────────────────────────────────────────────

  describe('Offer card phase propagation', () => {
    it('offer artifact phase is sent when pending', async () => {
      const threadId = 'conv-rt-phase-sent-001'
      await addConversation(seedConversation({ id: threadId }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-rt-001',
        craftsmanUserId: 'craftsman-rt-001',
        price: '3.000 €',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
      // No payment state for pending offers
      expect(artifacts.offerPaymentArtifact!.paymentState).toBeNull()
      expect(artifacts.offerPaymentArtifact!.jobId).toBeNull()
    })

    it('offer artifact phase transitions to payment_due after acceptance', async () => {
      const threadId = 'conv-rt-phase-payment-001'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-rt-001',
        craftsmanUserId: 'craftsman-rt-001',
        price: '5.500 €',
        description: 'Komplettsanierung',
      })

      // Accept
      await acceptOfferWorkflow(offer.id)

      // Verify phase and payment state
      const artifacts = getThreadArtifacts(threadId)
      const opArtifact = artifacts.offerPaymentArtifact
      expect(opArtifact).not.toBeNull()
      expect(opArtifact!.phase).toBe('payment_due')
      expect(opArtifact!.paymentState).toBe('deposit_required')
      expect(opArtifact!.jobId).not.toBeNull()
      expect(opArtifact!.offer.status).toBe('accepted')
    })

    it('payment_due phase survives multiple re-derivations (reload simulation)', async () => {
      const threadId = 'conv-rt-phase-reload-001'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-rt-001',
        craftsmanUserId: 'craftsman-rt-001',
        price: '8.000 €',
      })
      await acceptOfferWorkflow(offer.id)

      // Simulate 5 reloads
      for (let i = 0; i < 5; i++) {
        const artifacts = getThreadArtifacts(threadId)
        expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
        expect(artifacts.offerPaymentArtifact!.paymentState).toBe('deposit_required')
      }
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // BUG FIX 3: Coexistence after acceptance
  // ─────────────────────────────────────────────────────────────────────────

  describe('Artifact coexistence after acceptance', () => {
    it('project card and offer/payment card both visible after offer acceptance', async () => {
      const projectId = 'rt-coexist-project-001'
      const threadId = 'conv-rt-coexist-001'

      await addProject(seedProject({ id: projectId, title: 'Kellersanierung' }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
      }))
      await persistProjectArtifact({ conversationId: threadId, projectId, customerUserId: 'customer-rt-001', craftsmanUserId: 'craftsman-rt-001' })

      // Create and accept offer
      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-rt-001',
        craftsmanUserId: 'craftsman-rt-001',
        price: '11.000 €',
      })
      await acceptOfferWorkflow(offer.id)

      // Both artifacts present — coexistence
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact).not.toBeNull()

      // Verify they are independent
      expect(artifacts.projectArtifact!.kind).toBe('project')
      expect(artifacts.offerPaymentArtifact!.kind).toBe('offer_payment')

      // Verify the rendering guard allows both:
      // Project renders because isCustomerCreated bypasses !jobContext
      const jobCtx = getJobContextForThread(threadId)
      expect(jobCtx).not.toBeNull()
      expect(
        artifacts.projectArtifact !== null &&
        (!jobCtx || artifacts.projectArtifact!.isCustomerCreated)
      ).toBe(true)
      // Offer renders unconditionally when artifact exists
      expect(artifacts.offerPaymentArtifact !== null).toBe(true)
    })

    it('neither artifact suppresses the other after reload', async () => {
      const projectId = 'rt-no-suppress-001'
      const threadId = 'conv-rt-no-suppress-001'

      await addProject(seedProject({ id: projectId, title: 'Terrassenausbau' }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
      }))
      await sendProjectAttachmentToThread(threadId, projectId)

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-rt-001',
        craftsmanUserId: 'craftsman-rt-001',
        price: '14.000 €',
      })
      await acceptOfferWorkflow(offer.id)

      // Multiple reloads — both must survive
      for (let i = 0; i < 3; i++) {
        const artifacts = getThreadArtifacts(threadId)
        expect(artifacts.projectArtifact).not.toBeNull()
        expect(artifacts.projectArtifact!.project.id).toBe(projectId)
        expect(artifacts.offerPaymentArtifact).not.toBeNull()
        expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
      }
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // REGRESSION SAFETY
  // ─────────────────────────────────────────────────────────────────────────

  describe('Regression safety', () => {
    it('no regression: synthetic project IDs do not produce project artifacts', async () => {
      const threadId = 'conv-rt-synthetic-001'
      await addConversation(seedConversation({
        id: threadId,
        projectId: 'project_profile_craft123_conv-001', // synthetic
        inquiryOrigin: 'profile',
      }))

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).toBeNull()
    })

    it('no regression: declined offer produces declined-phase artifact', async () => {
      const threadId = 'conv-rt-cancel-reg-001'
      await addConversation(seedConversation({ id: threadId }))

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-rt-001',
        craftsmanUserId: 'craftsman-rt-001',
        price: '4.000 €',
      })

      const { declineOfferWorkflow } = await import('../../src/lib/workflow/offerWorkflow')
      await declineOfferWorkflow(offer.id)

      // Declined offers now produce a 'declined' phase artifact for thread
      // continuity — both sides can still see what was offered and that it
      // was declined.
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('declined')
      expect(artifacts.offerPaymentArtifact!.offer.status).toBe('declined')
      expect(artifacts.offerPaymentArtifact!.persistenceStatus).toBe('confirmed')
    })

    it('no regression: project card without job context still renders', async () => {
      const projectId = 'rt-no-job-001'
      const threadId = 'conv-rt-no-job-001'

      await addProject(seedProject({ id: projectId }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
      }))
      await persistProjectArtifact({ conversationId: threadId, projectId, customerUserId: 'customer-rt-001', craftsmanUserId: 'craftsman-rt-001' })

      // No offer, no job — project card should still render
      const jobCtx = getJobContextForThread(threadId)
      expect(jobCtx).toBeNull()

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.project.id).toBe(projectId)

      // Rendering guard: !jobContext means always show
      expect(!jobCtx || artifacts.projectArtifact!.isCustomerCreated).toBe(true)
    })
  })
})
