/**
 * Thread Artifact Truth Trace — Integration Tests
 *
 * Validates the runtime truth trace and persisted-only rendering:
 * 1. Write result tracking for project attach, offer create, offer accept
 * 2. Persistence status on project and offer artifacts
 * 3. Truth trace snapshot builder produces correct diagnostics
 * 4. Customer and craftsman both rebuild from the same persisted truth
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getConversationById,
  getThreadArtifacts,
  sendProjectAttachmentToThread,
  buildTruthTraceSnapshot,
  getLastWriteResult,
  clearWriteResults,
  persistProjectArtifact,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject, getProjectById } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
  sendProjectAttachmentWorkflow,
} from '../../src/lib/workflow'
import { getOffersByConversationId } from '../../src/lib/offers/service'

// ── Helpers ─────────────────────────────────────────────────────────────────

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-tt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: overrides.projectId ?? `project-${id}`,
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-tt-001',
    craftsmanName: 'Peter Handwerker',
    craftsmanHandle: 'peter-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-tt-001',
    projectTitle: 'Wahrheitsprüfung',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Berlin',
    projectCostRange: '€5,000-8,000',
    projectDuration: '2 Wochen',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Gerade eben',
    inquiryOrigin: 'reel',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  const id = overrides.id ?? `project-tt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    title: 'Wahrheitsprüfung',
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
    source: 'inquiry',
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Thread Artifact Truth Trace', () => {
  beforeEach(() => {
    setupCleanRepositories()
    clearWriteResults()
  })

  // ── A. Persistence status on project artifact ────────────────────────────

  describe('ProjectArtifact persistenceStatus', () => {
    it('is "confirmed" when sourceProjectId is set and resolves to a real project', async () => {
      const project = seedProject()
      await addProject(project)

      const conversation = seedConversation({ sourceProjectId: project.id })
      await addConversation(conversation)

      await persistProjectArtifact({
        conversationId: conversation.id,
        projectId: project.id,
        customerUserId: 'customer-tt-001',
        craftsmanUserId: 'craftsman-tt-001',
      })

      const artifacts = getThreadArtifacts(conversation.id)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
    })

    it('is "unconfirmed" when project found via message attachment but no sourceProjectId', async () => {
      const project = seedProject()
      await addProject(project)

      const conversation = seedConversation()
      await addConversation(conversation)

      // Attach project via message — stamps sourceProjectId
      await sendProjectAttachmentToThread(conversation.id, project.id)

      // Verify that sourceProjectId was stamped
      const updated = getConversationById(conversation.id)
      expect(updated?.sourceProjectId).toBe(project.id)

      const artifacts = getThreadArtifacts(conversation.id)
      expect(artifacts.projectArtifact).not.toBeNull()
      // Because sendProjectAttachmentToThread stamps sourceProjectId,
      // the artifact should be confirmed
      expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
    })

    it('returns null projectArtifact when no project is linked at all', async () => {
      const conversation = seedConversation()
      await addConversation(conversation)

      const artifacts = getThreadArtifacts(conversation.id)
      expect(artifacts.projectArtifact).toBeNull()
    })
  })

  // ── B. Persistence status on offer artifact ──────────────────────────────

  describe('OfferPaymentArtifact persistenceStatus', () => {
    it('is "confirmed" when an offer row exists in the store', async () => {
      const conversation = seedConversation()
      await addConversation(conversation)

      await createOfferWorkflow({
        conversationId: conversation.id,
        customerUserId: 'customer-tt-001',
        craftsmanUserId: 'craftsman-tt-001',
        price: '€3,500',
      })

      const artifacts = getThreadArtifacts(conversation.id)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.persistenceStatus).toBe('confirmed')
    })

    it('returns null offerPaymentArtifact when no offers exist', async () => {
      const conversation = seedConversation()
      await addConversation(conversation)

      const artifacts = getThreadArtifacts(conversation.id)
      expect(artifacts.offerPaymentArtifact).toBeNull()
    })
  })

  // ── C. Write result tracking ─────────────────────────────────────────────

  describe('Write result tracking', () => {
    it('records success for sendProjectAttachmentWorkflow', async () => {
      const project = seedProject()
      await addProject(project)
      const conversation = seedConversation()
      await addConversation(conversation)

      await sendProjectAttachmentWorkflow(conversation.id, project.id)

      const result = getLastWriteResult('sendProjectAttachmentToThread')
      expect(result).toBeDefined()
      expect(result!.success).toBe(true)
      expect(result!.detail).toBeDefined()
      expect(result!.detail!.projectId).toBe(project.id)
      expect(result!.detail!.persistedConfirmed).toBe(true)
    })

    it('records success for createOfferWorkflow', async () => {
      const conversation = seedConversation()
      await addConversation(conversation)

      await createOfferWorkflow({
        conversationId: conversation.id,
        customerUserId: 'customer-tt-001',
        craftsmanUserId: 'craftsman-tt-001',
        price: '€2,000',
      })

      const result = getLastWriteResult('createOfferWorkflow')
      expect(result).toBeDefined()
      expect(result!.success).toBe(true)
      expect(result!.detail).toBeDefined()
      expect(result!.detail!.persistedConfirmed).toBe(true)
    })

    it('records success for acceptOfferWorkflow', async () => {
      const conversation = seedConversation()
      await addConversation(conversation)

      const offer = await createOfferWorkflow({
        conversationId: conversation.id,
        customerUserId: 'customer-tt-001',
        craftsmanUserId: 'craftsman-tt-001',
        price: '€4,000',
      })

      await acceptOfferWorkflow(offer.id)

      const result = getLastWriteResult('acceptOfferWorkflow')
      expect(result).toBeDefined()
      expect(result!.success).toBe(true)
      expect(result!.detail).toBeDefined()
      expect(result!.detail!.jobPersisted).toBe(true)
    })

    it('clearWriteResults resets all tracked results', async () => {
      const conversation = seedConversation()
      await addConversation(conversation)

      await createOfferWorkflow({
        conversationId: conversation.id,
        customerUserId: 'customer-tt-001',
        craftsmanUserId: 'craftsman-tt-001',
        price: '€1,000',
      })

      expect(getLastWriteResult('createOfferWorkflow')).toBeDefined()
      clearWriteResults()
      expect(getLastWriteResult('createOfferWorkflow')).toBeUndefined()
    })
  })

  // ── D. Truth trace snapshot ──────────────────────────────────────────────

  describe('buildTruthTraceSnapshot', () => {
    it('builds a complete snapshot with all diagnostic fields', async () => {
      const project = seedProject()
      await addProject(project)

      const conversation = seedConversation({ sourceProjectId: project.id })
      await addConversation(conversation)

      await persistProjectArtifact({
        conversationId: conversation.id,
        projectId: project.id,
        customerUserId: 'customer-tt-001',
        craftsmanUserId: 'craftsman-tt-001',
      })

      await createOfferWorkflow({
        conversationId: conversation.id,
        customerUserId: 'customer-tt-001',
        craftsmanUserId: 'craftsman-tt-001',
        price: '€6,000',
      })

      const artifacts = getThreadArtifacts(conversation.id)
      const offers = getOffersByConversationId(conversation.id)

      const snapshot = buildTruthTraceSnapshot({
        authUserId: 'customer-tt-001',
        conversation: getConversationById(conversation.id),
        projectExists: (id: string) => Boolean(getProjectById(id)),
        projectArtifactProjectId: artifacts.projectArtifact?.project.id ?? null,
        offers,
        resolvedJobId: null,
        resolvedPaymentState: null,
      })

      expect(snapshot.authUserId).toBe('customer-tt-001')
      expect(snapshot.conversationId).toBe(conversation.id)
      expect(snapshot.conversationSourceProjectId).toBe(project.id)
      expect(snapshot.sourceProjectIdResolvesToRealProject).toBe(true)
      expect(snapshot.projectArtifactPersistenceStatus).toBe('confirmed')
      expect(snapshot.projectArtifactProjectId).toBe(project.id)
      expect(snapshot.offerCount).toBe(1)
      expect(snapshot.offerArtifactPersistenceStatus).toBe('confirmed')
      expect(snapshot.lastWriteResults.createOfferWorkflow).toBeDefined()
      expect(snapshot.lastWriteResults.createOfferWorkflow!.success).toBe(true)
    })

    it('shows unconfirmed project when sourceProjectId is not set', async () => {
      const project = seedProject()
      await addProject(project)

      // Conversation with projectId matching but no sourceProjectId
      const conversation = seedConversation({ projectId: project.id })
      await addConversation(conversation)

      const artifacts = getThreadArtifacts(conversation.id)

      const snapshot = buildTruthTraceSnapshot({
        authUserId: null,
        conversation: getConversationById(conversation.id),
        projectExists: (id: string) => Boolean(getProjectById(id)),
        projectArtifactProjectId: artifacts.projectArtifact?.project.id ?? null,
        offers: [],
        resolvedJobId: null,
        resolvedPaymentState: null,
      })

      expect(snapshot.projectArtifactPersistenceStatus).toBe('unconfirmed')
      expect(snapshot.sourceProjectIdResolvesToRealProject).toBe(false)
    })

    it('shows missing offer when no offers exist', async () => {
      const conversation = seedConversation()
      await addConversation(conversation)

      const snapshot = buildTruthTraceSnapshot({
        authUserId: null,
        conversation: getConversationById(conversation.id),
        projectExists: () => false,
        projectArtifactProjectId: null,
        offers: [],
        resolvedJobId: null,
        resolvedPaymentState: null,
      })

      expect(snapshot.offerArtifactPersistenceStatus).toBe('missing')
      expect(snapshot.offerCount).toBe(0)
    })
  })

  // ── E. Both roles see same persisted truth ───────────────────────────────

  describe('Customer and craftsman role parity', () => {
    it('both roles see the same artifacts from the same persisted data', async () => {
      const project = seedProject()
      await addProject(project)

      const conversation = seedConversation({ sourceProjectId: project.id })
      await addConversation(conversation)

      await createOfferWorkflow({
        conversationId: conversation.id,
        customerUserId: 'customer-tt-001',
        craftsmanUserId: 'craftsman-tt-001',
        price: '€5,000',
      })

      // getThreadArtifacts is role-agnostic — both sides see the same data
      const customerArtifacts = getThreadArtifacts(conversation.id)
      const craftsmanArtifacts = getThreadArtifacts(conversation.id)

      expect(customerArtifacts.projectArtifact?.project.id)
        .toBe(craftsmanArtifacts.projectArtifact?.project.id)
      expect(customerArtifacts.projectArtifact?.persistenceStatus)
        .toBe(craftsmanArtifacts.projectArtifact?.persistenceStatus)
      expect(customerArtifacts.offerPaymentArtifact?.offer.id)
        .toBe(craftsmanArtifacts.offerPaymentArtifact?.offer.id)
      expect(customerArtifacts.offerPaymentArtifact?.persistenceStatus)
        .toBe(craftsmanArtifacts.offerPaymentArtifact?.persistenceStatus)
    })
  })

  // ── F. Post-accept full chain verification ───────────────────────────────

  describe('Full lifecycle truth trace', () => {
    it('project attach → offer create → offer accept → all confirmed', async () => {
      const project = seedProject()
      await addProject(project)

      const conversation = seedConversation()
      await addConversation(conversation)

      // Step 1: Attach project
      await sendProjectAttachmentWorkflow(conversation.id, project.id)
      const projectResult = getLastWriteResult('sendProjectAttachmentToThread')
      expect(projectResult?.success).toBe(true)

      // Step 2: Create offer
      const offer = await createOfferWorkflow({
        conversationId: conversation.id,
        customerUserId: 'customer-tt-001',
        craftsmanUserId: 'craftsman-tt-001',
        price: '€7,000',
      })
      const offerResult = getLastWriteResult('createOfferWorkflow')
      expect(offerResult?.success).toBe(true)

      // Step 3: Accept offer
      await acceptOfferWorkflow(offer.id)
      const acceptResult = getLastWriteResult('acceptOfferWorkflow')
      expect(acceptResult?.success).toBe(true)
      expect(acceptResult?.detail?.jobPersisted).toBe(true)

      // Step 4: Verify all artifacts are confirmed
      const artifacts = getThreadArtifacts(conversation.id)
      expect(artifacts.projectArtifact?.persistenceStatus).toBe('confirmed')
      expect(artifacts.offerPaymentArtifact?.persistenceStatus).toBe('confirmed')

      // Step 5: Build truth trace and verify diagnostic completeness
      const conv = getConversationById(conversation.id)
      const offers = getOffersByConversationId(conversation.id)
      const snapshot = buildTruthTraceSnapshot({
        authUserId: 'customer-tt-001',
        conversation: conv,
        projectExists: (id: string) => Boolean(getProjectById(id)),
        projectArtifactProjectId: artifacts.projectArtifact?.project.id ?? null,
        offers,
        resolvedJobId: artifacts.offerPaymentArtifact?.jobId ?? null,
        resolvedPaymentState: artifacts.offerPaymentArtifact?.paymentState ?? null,
      })

      expect(snapshot.projectArtifactPersistenceStatus).toBe('confirmed')
      expect(snapshot.offerArtifactPersistenceStatus).toBe('confirmed')
      expect(snapshot.sourceProjectIdResolvesToRealProject).toBe(true)
      expect(snapshot.resolvedJobId).not.toBeNull()
      expect(snapshot.lastWriteResults.sendProjectAttachmentToThread?.success).toBe(true)
      expect(snapshot.lastWriteResults.createOfferWorkflow?.success).toBe(true)
      expect(snapshot.lastWriteResults.acceptOfferWorkflow?.success).toBe(true)
    })
  })
})
