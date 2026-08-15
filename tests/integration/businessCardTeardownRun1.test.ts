/**
 * Business Card Teardown — RUN 1 Verification Tests
 *
 * Verifies that the RUN 1 hard teardown was successful:
 *
 * 1. Old/current business-card selectors no longer use fallback paths
 * 2. Thread screen no longer depends on linkedProjectId / conversionState /
 *    jobContext / current artifact pending logic for business-card visibility
 * 3. Plain text messages still render (via selector)
 * 4. Participant scoping still holds
 * 5. Auth/bootstrap foundation not regressed
 * 6. thread_artifacts PRIMARY path is the only source of truth
 */

import path from 'path'
import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getConversationById,
  getThreadArtifacts,
  getThreadArtifactRecord,
  sendProjectAttachmentToThread,
  subscribeMessages,
  getMessageThreadById,
  getThreadHeader,
  persistProjectArtifact,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import { addJob } from '../../src/lib/jobs/service'
import type { Job } from '../../src/lib/jobs/types'
import { getSession } from '../../src/lib/session'
import { isConversationParticipant } from '../../src/lib/messages/participantScope'
import { sendDirectMessageWorkflow } from '../../src/lib/workflow/messageWorkflow'

// ── Helpers ─────────────────────────────────────────────────────────────────

const VALID_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-run1-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Test Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-run1-001',
    craftsmanName: 'Test Handwerker',
    craftsmanHandle: 'test-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-run1-001',
    projectTitle: 'RUN 1 Teardown Test',
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
  return {
    id: overrides.id ?? `proj-run1-${Date.now()}`,
    title: 'Test Projekt',
    customer: 'Test Kundin',
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

function seedJob(overrides: Partial<Job> = {}): Job {
  return {
    id: overrides.id ?? `job-run1-${Date.now()}`,
    title: 'Test Job',
    projectId: overrides.projectId ?? VALID_UUID,
    sourceConversationId: overrides.sourceConversationId,
    customer: 'Test Kundin',
    customerUserId: 'customer-run1-001',
    craftsmanUserId: 'craftsman-run1-001',
    status: 'accepted',
    amount: '5.000 €',
    location: 'Berlin',
    dateLabel: 'Termin offen',
    description: 'Test Beschreibung',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Business Card Teardown — RUN 1 Verification', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. FALLBACK PATHS REMOVED — selectors no longer use legacy resolution
  // ═══════════════════════════════════════════════════════════════════════

  describe('1. Fallback paths removed from selectors', () => {
    it('sourceProjectId alone does NOT produce a project artifact (FALLBACK A removed)', async () => {
      await addProject(seedProject({ id: VALID_UUID }))
      await addConversation(
        seedConversation({
          id: 'conv-run1-fallback-a',
          sourceProjectId: VALID_UUID,
        })
      )

      const artifacts = getThreadArtifacts('conv-run1-fallback-a')
      expect(artifacts.projectArtifact).toBeNull()
    })

    it('job.projectId match alone does NOT produce a project artifact (FALLBACK B removed)', async () => {
      await addProject(seedProject({ id: VALID_UUID }))
      await addConversation(
        seedConversation({
          id: 'conv-run1-fallback-b',
          sourceProjectId: VALID_UUID,
        })
      )
      await addJob(
        seedJob({
          id: 'job-run1-fallback-b',
          projectId: VALID_UUID,
          sourceConversationId: 'conv-run1-fallback-b',
        })
      )

      const artifacts = getThreadArtifacts('conv-run1-fallback-b')
      // No thread_artifacts record → no card, even with job match
      expect(artifacts.projectArtifact).toBeNull()
    })

    it('pending artifact detection is disabled (always false)', async () => {
      await addConversation(seedConversation({ id: 'conv-run1-pending' }))

      const artifacts = getThreadArtifacts('conv-run1-pending')
      expect(artifacts.pendingProjectArtifact).toBe(false)
      expect(artifacts.pendingOfferArtifact).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. SCREEN DECOUPLED — no more linkedProjectId/conversionState/jobContext
  // ═══════════════════════════════════════════════════════════════════════

  describe('2. Screen no longer couples to OLD business-card state', () => {
    it('MessageThreadScreen imports do not include OLD business-card selectors', async () => {
      const screenSource = await import('fs').then((fs) =>
        fs.readFileSync(
          path.resolve(__dirname, '../../src/screens/MessageThreadScreen.tsx'),
          'utf-8'
        )
      )

      // RUN 2 canonical clean sources ARE expected now
      expect(screenSource).toContain('getThreadArtifacts')
      expect(screenSource).toContain('subscribeThreadArtifacts')
      // Persistent top-cards removed (V5 2026-06-23): artifacts render in the
      // stream via ChatArtifactCardCompact + the *SendEventCard renderers.
      expect(screenSource).toContain('ChatArtifactCardCompact')
      expect(screenSource).not.toContain('ThreadArtifactCards')

      // Old business-card selectors/state still forbidden
      expect(screenSource).not.toContain('getJobContextForThread')
      expect(screenSource).not.toContain('getThreadConversionState')
      expect(screenSource).not.toContain('buildTruthTraceSnapshot')

      // Old business-card components still forbidden
      expect(screenSource).not.toContain('ThreadProjectContextBar')
      expect(screenSource).not.toContain('ThreadOfferCard')
      expect(screenSource).not.toContain('ThreadJobContextBar')
      expect(screenSource).not.toContain('ThreadTruthTracePanel')
      expect(screenSource).not.toContain('CraftsmanOfferForm')
      expect(screenSource).not.toContain('CraftsmanRequestActionCard')
      expect(screenSource).not.toContain('CustomerInquiryPendingBar')

      // ProjectPickerSheet is now restored cleanly on the canonical
      // artifact write path (sendProjectAttachmentWorkflow).  It is
      // intentionally imported again — this is NOT the old legacy
      // attachment-inference system.
      expect(screenSource).toContain('ProjectPickerSheet')
      expect(screenSource).toContain('sendProjectAttachmentWorkflow')

      // Old business-card subscriptions still forbidden
      // NOTE: subscribeJobs is allowed — used for AWE gate reactivity, not business cards
      expect(screenSource).not.toContain('subscribePayments')
      expect(screenSource).not.toContain('subscribeDisputes')
      expect(screenSource).not.toContain('subscribeOperations')
      expect(screenSource).not.toContain('subscribeOffers')

      // subscribeProjects is now used for the project attach entry
      // (customer project list), not for old business-card state.
      expect(screenSource).toContain('subscribeProjects')

      // Old business-card state still forbidden
      expect(screenSource).not.toContain('linkedProjectId')
      expect(screenSource).not.toContain('canAttachProject')
      expect(screenSource).not.toContain('conversionState')
    })

    it('MessageThreadScreen still imports core messaging functions', async () => {
      const screenSource = await import('fs').then((fs) =>
        fs.readFileSync(
          path.resolve(__dirname, '../../src/screens/MessageThreadScreen.tsx'),
          'utf-8'
        )
      )

      expect(screenSource).toContain('getMessageThreadById')
      expect(screenSource).toContain('getThreadHeader')
      expect(screenSource).toContain('subscribeMessages')
      // sendDirectMessageWorkflow removed in Slice 7 — legacy composer gone
      expect(screenSource).toContain('markRequestReviewedWorkflow')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. PLAIN TEXT MESSAGES STILL WORK
  // ═══════════════════════════════════════════════════════════════════════

  describe('3. Plain text messages still render', () => {
    it('messages can be sent and retrieved in a thread', async () => {
      const threadId = 'conv-run1-msg-001'
      await addConversation(seedConversation({ id: threadId }))

      await sendDirectMessageWorkflow(threadId, 'Hallo, wie geht es?')
      await sendDirectMessageWorkflow(threadId, 'Gut, danke!', 'counterparty')

      const thread = getMessageThreadById(threadId)
      expect(thread).toBeDefined()
      expect(thread!.messages).toHaveLength(2)
      expect(thread!.messages[0].text).toBe('Hallo, wie geht es?')
      expect(thread!.messages[1].text).toBe('Gut, danke!')
    })

    it('thread header derives correctly for both roles', async () => {
      const threadId = 'conv-run1-header-001'
      await addConversation(
        seedConversation({
          id: threadId,
          customerName: 'Anna Kundin',
          craftsmanName: 'Peter Handwerker',
        })
      )

      const thread = getMessageThreadById(threadId)!
      const customerHeader = getThreadHeader(thread, 'customer')
      const craftsmanHeader = getThreadHeader(thread, 'craftsman')

      expect(customerHeader.primaryName).toBe('Peter Handwerker')
      expect(craftsmanHeader.primaryName).toBe('Anna Kundin')
    })

    it('message subscription fires on new messages', async () => {
      const threadId = 'conv-run1-sub-001'
      await addConversation(seedConversation({ id: threadId }))

      let notified = false
      const unsub = subscribeMessages(() => { notified = true })

      await sendDirectMessageWorkflow(threadId, 'Test message')
      expect(notified).toBe(true)

      unsub()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. PARTICIPANT SCOPING STILL WORKS
  // ═══════════════════════════════════════════════════════════════════════

  describe('4. Participant scoping still holds', () => {
    it('isConversationParticipant correctly identifies participants', async () => {
      const conv = seedConversation({
        id: 'conv-run1-scope-001',
        customerUserId: 'customer-A',
        craftsmanUserId: 'craftsman-B',
      })
      await addConversation(conv)

      expect(isConversationParticipant(conv, 'customer-A')).toBe(true)
      expect(isConversationParticipant(conv, 'craftsman-B')).toBe(true)
      expect(isConversationParticipant(conv, 'stranger')).toBe(false)
    })

    it('non-participant cannot see thread artifacts', async () => {
      const threadId = 'conv-run1-scope-002'
      await addProject(seedProject({ id: VALID_UUID }))
      await addConversation(
        seedConversation({
          id: threadId,
          customerUserId: 'customer-X',
          craftsmanUserId: 'craftsman-Y',
        })
      )

      await persistProjectArtifact({
        conversationId: threadId,
        projectId: VALID_UUID,
      })

      // Set session to non-participant
      const session = getSession()
      const original = session.user
      session.user = { id: 'stranger' } as typeof session.user

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).toBeNull()

      session.user = original
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. AUTH/BOOTSTRAP NOT REGRESSED
  // ═══════════════════════════════════════════════════════════════════════

  describe('5. Auth/bootstrap foundation not regressed', () => {
    it('getThreadArtifacts does not throw on empty stores', () => {
      expect(() => getThreadArtifacts('nonexistent')).not.toThrow()
      const artifacts = getThreadArtifacts('nonexistent')
      expect(artifacts.projectArtifact).toBeNull()
      expect(artifacts.offerPaymentArtifact).toBeNull()
    })

    it('conversation can be created and retrieved', async () => {
      const threadId = 'conv-run1-bootstrap-001'
      await addConversation(seedConversation({ id: threadId }))

      const conv = getConversationById(threadId)
      expect(conv).toBeDefined()
      expect(conv!.id).toBe(threadId)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. thread_artifacts PRIMARY PATH IS THE ONLY SOURCE
  // ═══════════════════════════════════════════════════════════════════════

  describe('6. thread_artifacts is the only source of business cards', () => {
    it('project artifact resolves from thread_artifacts record', async () => {
      const threadId = 'conv-run1-primary-001'
      await addProject(seedProject({ id: VALID_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId: VALID_UUID,
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.project.id).toBe(VALID_UUID)
      expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
    })

    it('sendProjectAttachmentToThread creates artifact record (canonical write path)', async () => {
      const threadId = 'conv-run1-write-001'
      await addProject(seedProject({ id: VALID_UUID }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentToThread(threadId, VALID_UUID)

      const record = getThreadArtifactRecord(threadId, 'project')
      expect(record).toBeDefined()
      expect(record!.projectId).toBe(VALID_UUID)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
    })

    it('no artifact without explicit persistence', async () => {
      const threadId = 'conv-run1-no-persist-001'
      await addProject(seedProject({ id: VALID_UUID }))
      await addConversation(
        seedConversation({
          id: threadId,
          sourceProjectId: VALID_UUID,
        })
      )

      // sourceProjectId is set but no thread_artifacts record
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).toBeNull()
    })
  })
})
