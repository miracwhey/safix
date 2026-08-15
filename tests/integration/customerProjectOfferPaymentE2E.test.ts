/**
 * Customer Project → Offer → Accept → Payment End-to-End Tests
 *
 * Validates the complete runtime chain fixed by this package:
 *
 * 1. Customer attaches real builder project to thread
 * 2. getThreadConversionState remains 'inquiry' (NOT 'project')
 *    so the craftsman offer form is visible
 * 3. Craftsman creates offer from thread
 * 4. Offer artifact appears alongside project artifact (coexistence)
 * 5. Customer accepts offer → payment_due phase
 * 6. Job context appears, project artifact persists (isCustomerCreated)
 * 7. getIncomingRequestForThread correctly excludes converted threads
 *
 * These tests exercise the real runtime selectors and workflows that
 * were fixed in this package.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getThreadArtifacts,
  getThreadConversionState,
  getIncomingRequestForThread,
  sendProjectAttachmentToThread,
  persistProjectArtifact,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addJob, getJobById } from '../../src/lib/jobs'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
} from '../../src/lib/workflow'
import { getJobContextForThread } from '../../src/lib/workflow/messageWorkflow'
import { getPaymentForJob } from '../../src/lib/payments'

// ── Helpers ─────────────────────────────────────────────────────────────────

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: overrides.projectId ?? `project-${id}`,
    customerName: 'Lisa Kunde',
    customerAvatarUrl: '',
    customerUserId: 'customer-e2e-001',
    craftsmanName: 'Markus Meister',
    craftsmanHandle: 'markus-meister',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-e2e-001',
    projectTitle: 'Dachsanierung',
    projectSubtitle: 'Anfrage',
    projectLocation: 'Berlin',
    projectCostRange: '€15,000-20,000',
    projectDuration: '4 Wochen',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Vor 3 Minuten',
    inquiryOrigin: 'reel',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  const id = overrides.id ?? `proj-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    title: 'Dachsanierung',
    customer: 'Lisa Kunde',
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

describe('Customer Project → Offer → Accept → Payment E2E', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // FIX 1: getThreadConversionState remains 'inquiry' after project attachment
  // ─────────────────────────────────────────────────────────────────────────

  describe('getThreadConversionState with customer-attached project', () => {
    it('returns inquiry when customer attaches a real project but no job exists', async () => {
      const projectId = 'proj-conv-state-001'
      const threadId = 'conv-conv-state-001'

      await addProject(seedProject({ id: projectId, title: 'Terrassenanbau' }))
      await addConversation(seedConversation({
        id: threadId,
        projectId: `project_reel_${threadId}`,
        inquiryOrigin: 'reel',
      }))

      // Customer attaches project — stamps sourceProjectId
      await sendProjectAttachmentToThread(threadId, projectId)

      // CRITICAL: conversion state must be 'inquiry', not 'project'
      // This is the fix — previously it returned 'project' because a
      // linked project was found, which hid the CraftsmanOfferForm
      const state = getThreadConversionState(threadId)
      expect(state).toBe('inquiry')
    })

    it('returns inquiry when sourceProjectId is set directly on conversation', async () => {
      const projectId = 'proj-conv-state-002'
      const threadId = 'conv-conv-state-002'

      await addProject(seedProject({ id: projectId }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
        inquiryOrigin: 'project',
      }))

      // No job exists — must still be 'inquiry'
      expect(getThreadConversionState(threadId)).toBe('inquiry')
    })

    it('returns project once a job is linked via sourceConversationId', async () => {
      const projectId = 'proj-conv-state-003'
      const threadId = 'conv-conv-state-003'

      await addProject(seedProject({ id: projectId }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
      }))

      // Before job: inquiry
      expect(getThreadConversionState(threadId)).toBe('inquiry')

      // Create offer and accept → creates a job
      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-e2e-001',
        craftsmanUserId: 'craftsman-e2e-001',
        price: '18.000 €',
      })
      await acceptOfferWorkflow(offer.id)

      // After job creation: project
      expect(getThreadConversionState(threadId)).toBe('project')
    })

    it('returns inquiry for thread with no project and no job', async () => {
      const threadId = 'conv-conv-state-004'
      await addConversation(seedConversation({
        id: threadId,
        inquiryOrigin: 'profile',
      }))

      expect(getThreadConversionState(threadId)).toBe('inquiry')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // COMPLETE E2E FLOW
  // ─────────────────────────────────────────────────────────────────────────

  describe('Complete flow: attach project → send offer → accept → payment', () => {
    it('full flow works end-to-end with coexisting artifacts', async () => {
      const projectId = 'proj-full-flow-001'
      const threadId = 'conv-full-flow-001'

      // ── Step 1: Customer creates a real project ──
      await addProject(seedProject({
        id: projectId,
        title: 'Komplette Badsanierung',
        source: 'builder',
      }))

      // ── Step 2: Customer starts a conversation and attaches project ──
      await addConversation(seedConversation({
        id: threadId,
        projectId: `project_reel_${threadId}`,
        inquiryOrigin: 'reel',
      }))
      await sendProjectAttachmentToThread(threadId, projectId)

      // ── Step 3: Verify project artifact is visible ──
      const afterAttach = getThreadArtifacts(threadId)
      expect(afterAttach.projectArtifact).not.toBeNull()
      expect(afterAttach.projectArtifact!.project.id).toBe(projectId)
      expect(afterAttach.projectArtifact!.isCustomerCreated).toBe(true)
      expect(afterAttach.offerPaymentArtifact).toBeNull()

      // ── Step 4: Verify craftsman can see offer form (conversion state = inquiry) ──
      expect(getThreadConversionState(threadId)).toBe('inquiry')

      // ── Step 5: Craftsman sends an offer ──
      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-e2e-001',
        craftsmanUserId: 'craftsman-e2e-001',
        price: '22.500 €',
        description: 'Komplette Badsanierung inkl. Fliesen',
        timingNote: 'Ab nächster Woche verfügbar',
      })
      expect(offer.status).toBe('pending')
      expect(offer.conversationId).toBe(threadId)

      // ── Step 6: Both artifacts coexist ──
      const afterOffer = getThreadArtifacts(threadId)
      expect(afterOffer.projectArtifact).not.toBeNull()
      expect(afterOffer.projectArtifact!.project.id).toBe(projectId)
      expect(afterOffer.offerPaymentArtifact).not.toBeNull()
      expect(afterOffer.offerPaymentArtifact!.phase).toBe('sent')
      expect(afterOffer.offerPaymentArtifact!.offer.price).toBe('22.500 €')

      // ── Step 7: Customer accepts the offer ──
      const accepted = await acceptOfferWorkflow(offer.id)
      expect(accepted).toBeDefined()
      expect(accepted!.status).toBe('accepted')
      expect(accepted!.createdJobId).toBeDefined()

      // ── Step 8: Offer becomes payment/deposit actionable ──
      const afterAccept = getThreadArtifacts(threadId)
      expect(afterAccept.offerPaymentArtifact).not.toBeNull()
      expect(afterAccept.offerPaymentArtifact!.phase).toBe('payment_due')
      expect(afterAccept.offerPaymentArtifact!.paymentState).toBe('deposit_required')
      expect(afterAccept.offerPaymentArtifact!.jobId).toBe(accepted!.createdJobId)

      // ── Step 9: Project artifact persists alongside job context ──
      expect(afterAccept.projectArtifact).not.toBeNull()
      expect(afterAccept.projectArtifact!.project.id).toBe(projectId)
      expect(afterAccept.projectArtifact!.isCustomerCreated).toBe(true)

      // ── Step 10: Job context is now available ──
      const jobCtx = getJobContextForThread(threadId)
      expect(jobCtx).not.toBeNull()
      expect(jobCtx!.status).toBe('booked')
      expect(jobCtx!.paymentState).toBe('deposit_required')

      // ── Step 11: Thread conversion state is now 'project' ──
      expect(getThreadConversionState(threadId)).toBe('project')

      // ── Step 12: Payment entity was created ──
      const payment = getPaymentForJob(accepted!.createdJobId!)
      expect(payment).toBeDefined()

      // ── Step 13: Job references the real project ──
      const job = getJobById(accepted!.createdJobId!)
      expect(job).toBeDefined()
      expect(job!.projectId).toBe(projectId)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // FIX 2: getIncomingRequestForThread with sourceProjectId
  // ─────────────────────────────────────────────────────────────────────────

  describe('Incoming request exclusion with sourceProjectId', () => {
    it('incoming request is available before offer acceptance', async () => {
      const projectId = 'proj-inbox-001'
      const threadId = 'conv-inbox-001'

      await addProject(seedProject({ id: projectId }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
        inquiryOrigin: 'reel',
      }))

      // No job → request should be visible
      const request = getIncomingRequestForThread(threadId)
      expect(request).not.toBeNull()
      expect(request!.threadId).toBe(threadId)
    })

    it('incoming request is excluded after offer acceptance creates job', async () => {
      const projectId = 'proj-inbox-002'
      const threadId = 'conv-inbox-002'

      await addProject(seedProject({ id: projectId }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
        inquiryOrigin: 'reel',
      }))

      // Create and accept offer → job created
      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-e2e-001',
        craftsmanUserId: 'craftsman-e2e-001',
        price: '5.000 €',
      })
      await acceptOfferWorkflow(offer.id)

      // Job exists → request should be excluded
      const request = getIncomingRequestForThread(threadId)
      expect(request).toBeNull()
    })

    it('incoming request excluded when job projectId matches sourceProjectId', async () => {
      const projectId = 'proj-inbox-003'
      const threadId = 'conv-inbox-003'

      await addProject(seedProject({ id: projectId }))
      await addConversation(seedConversation({
        id: threadId,
        projectId: `project_reel_${threadId}`, // synthetic
        sourceProjectId: projectId,
        inquiryOrigin: 'reel',
      }))

      // Add a job directly linked to the real project (not via sourceConversationId)
      await addJob({
        id: 'job-inbox-003',
        projectId, // matches sourceProjectId
        title: 'Auftrag',
        customer: 'Lisa Kunde',
        location: 'Berlin',
        dateLabel: 'Termin offen',
        status: 'new',
        amount: '5.000 €',
        description: '',
        paymentState: 'deposit_required',
        documentationStatus: '',
        assignedMemberIds: [],
        notes: [],
        photoCount: 0,
        activities: [],
      })

      // Job exists for sourceProjectId → request should be excluded
      const request = getIncomingRequestForThread(threadId)
      expect(request).toBeNull()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // ARTIFACT COEXISTENCE AFTER RELOAD
  // ─────────────────────────────────────────────────────────────────────────

  describe('Artifact coexistence and reload stability', () => {
    it('project and offer artifacts coexist and are stable across re-derivations', async () => {
      const projectId = 'proj-coexist-001'
      const threadId = 'conv-coexist-001'

      await addProject(seedProject({ id: projectId, title: 'Fassade streichen' }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
      }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId,
        customerUserId: 'customer-e2e-001',
        craftsmanUserId: 'craftsman-e2e-001',
      })

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-e2e-001',
        craftsmanUserId: 'craftsman-e2e-001',
        price: '8.500 €',
      })

      // Re-derive multiple times (simulates reload)
      for (let i = 0; i < 3; i++) {
        const artifacts = getThreadArtifacts(threadId)
        expect(artifacts.projectArtifact).not.toBeNull()
        expect(artifacts.projectArtifact!.project.id).toBe(projectId)
        expect(artifacts.offerPaymentArtifact).not.toBeNull()
        expect(artifacts.offerPaymentArtifact!.offer.id).toBe(offer.id)
        expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
      }
    })

    it('payment_due phase persists across re-derivations after acceptance', async () => {
      const projectId = 'proj-coexist-002'
      const threadId = 'conv-coexist-002'

      await addProject(seedProject({ id: projectId }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
      }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId,
        customerUserId: 'customer-e2e-001',
        craftsmanUserId: 'craftsman-e2e-001',
      })

      const offer = await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-e2e-001',
        craftsmanUserId: 'craftsman-e2e-001',
        price: '12.000 €',
      })
      await acceptOfferWorkflow(offer.id)

      // Re-derive multiple times
      for (let i = 0; i < 3; i++) {
        const artifacts = getThreadArtifacts(threadId)
        // Project card persists
        expect(artifacts.projectArtifact).not.toBeNull()
        expect(artifacts.projectArtifact!.isCustomerCreated).toBe(true)
        // Offer card in payment_due phase
        expect(artifacts.offerPaymentArtifact).not.toBeNull()
        expect(artifacts.offerPaymentArtifact!.phase).toBe('payment_due')
        expect(artifacts.offerPaymentArtifact!.paymentState).toBe('deposit_required')
      }
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // CRAFTSMAN OFFER FORM VISIBILITY
  // ─────────────────────────────────────────────────────────────────────────

  describe('Craftsman offer form visibility conditions', () => {
    it('offer form visible: project attached, no job, no offer (conversion = inquiry)', async () => {
      const projectId = 'proj-form-001'
      const threadId = 'conv-form-001'

      await addProject(seedProject({ id: projectId }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
        inquiryOrigin: 'reel',
      }))

      // The conditions for CraftsmanOfferForm visibility:
      const jobCtx = getJobContextForThread(threadId)
      const artifacts = getThreadArtifacts(threadId)
      const convState = getThreadConversionState(threadId)

      // All conditions met for showing the form
      expect(jobCtx).toBeNull()                              // !jobContext
      expect(artifacts.offerPaymentArtifact).toBeNull()     // !artifacts.offerPaymentArtifact
      expect(convState).toBe('inquiry')                      // conversionState === 'inquiry'
      // role === 'craftsman' is a prop, not tested here
    })

    it('offer form hidden after offer is created (offerPaymentArtifact exists)', async () => {
      const projectId = 'proj-form-002'
      const threadId = 'conv-form-002'

      await addProject(seedProject({ id: projectId }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
        inquiryOrigin: 'reel',
      }))

      await createOfferWorkflow({
        conversationId: threadId,
        customerUserId: 'customer-e2e-001',
        craftsmanUserId: 'craftsman-e2e-001',
        price: '6.000 €',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull() // offer exists → form hidden
    })

    it('offer form hidden after job context appears (post-acceptance)', async () => {
      const threadId = 'conv-form-003'

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
      await acceptOfferWorkflow(offer.id)

      const jobCtx = getJobContextForThread(threadId)
      expect(jobCtx).not.toBeNull() // job exists → form hidden
    })
  })
})
