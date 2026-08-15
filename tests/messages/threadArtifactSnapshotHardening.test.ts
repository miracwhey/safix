/**
 * Thread Artifact Snapshot Hardening Tests
 *
 * Validates that thread business-card rendering is self-sufficient from
 * the thread_artifacts row and does not require secondary repository
 * hydration for basic visibility.
 *
 * SNAPSHOT HARDENING: artifact rows now carry minimal display snapshot
 * data (title, status, price, summary, phaseLabel) so the card renders
 * immediately without waiting for project/offer/job/payment repos.
 *
 * Coverage:
 *   1. Project card renders from artifact snapshot when project repo is NOT loaded
 *   2. Offer card renders from artifact snapshot when offer repo is NOT loaded
 *   3. Snapshot-based card survives re-entry/reload simulation
 *   4. Accept/decline/payment_due phase labels survive as snapshot data
 *   5. Full entity enriches card when loaded (snapshot + entity coexistence)
 *   6. No regression to participant scoping
 *   7. No regression to auth/bootstrap foundation
 *   8. Write paths persist snapshot data alongside entity references
 */

import path from 'path'
import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getThreadArtifacts,
  persistProjectArtifact,
  persistOfferArtifact,
  updateOfferArtifactPhase,
} from '../../src/lib/messages'
import { InMemoryThreadArtifactRepository } from '../../src/lib/messages/repository/InMemoryThreadArtifactRepository'
import { setThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import { getSession } from '../../src/lib/session'

// ── Helpers ─────────────────────────────────────────────────────────────

const PROJECT_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const OFFER_UUID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-snap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Snapshot Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-snap-001',
    craftsmanName: 'Snapshot Handwerker',
    craftsmanHandle: 'snap-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-snap-001',
    projectTitle: 'Snapshot Test',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Berlin',
    projectCostRange: '€3,000–5,000',
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
    id: overrides.id ?? `proj-snap-${Date.now()}`,
    title: overrides.title ?? 'Snapshot Projekt',
    category: 'Sanitär',
    description: 'Snapshot Testbeschreibung',
    location: 'Berlin',
    status: 'request',
    source: 'builder',
    createdAt: Date.now(),
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Thread Artifact Snapshot Hardening — self-sufficient rendering', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. PROJECT CARD FROM SNAPSHOT (NO PROJECT REPO)
  // ═══════════════════════════════════════════════════════════════════════

  describe('1. Project card renders from snapshot without project repo', () => {
    it('renders project artifact from snapshot when project entity is NOT loaded', async () => {
      const threadId = 'conv-snap-proj-001'

      await addConversation(seedConversation({ id: threadId }))

      // Persist project artifact with snapshot but do NOT add project to project repo
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        customerUserId: 'customer-snap-001',
        craftsmanUserId: 'craftsman-snap-001',
        snapshotTitle: 'Terrassenbau',
        snapshotStatus: 'request',
        snapshotSummary: 'Sanitär',
      })

      const artifacts = getThreadArtifacts(threadId)

      // Card renders from snapshot — no pending, no null
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.pendingProjectArtifact).toBe(false)

      // Snapshot data is available
      expect(artifacts.projectArtifact!.snapshot).not.toBeNull()
      expect(artifacts.projectArtifact!.snapshot!.title).toBe('Terrassenbau')
      expect(artifacts.projectArtifact!.snapshot!.status).toBe('request')
      expect(artifacts.projectArtifact!.snapshot!.summary).toBe('Sanitär')

      // Full entity is null (project repo not loaded)
      expect(artifacts.projectArtifact!.project).toBeNull()
    })

    it('snapshot card survives re-entry (re-read) without project repo', async () => {
      const threadId = 'conv-snap-proj-002'

      await addConversation(seedConversation({ id: threadId }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        snapshotTitle: 'Persistent Card',
        snapshotStatus: 'accepted',
      })

      // First read
      const first = getThreadArtifacts(threadId)
      expect(first.projectArtifact).not.toBeNull()
      expect(first.projectArtifact!.snapshot!.title).toBe('Persistent Card')

      // Second read (simulates re-entry)
      const second = getThreadArtifacts(threadId)
      expect(second.projectArtifact).not.toBeNull()
      expect(second.projectArtifact!.snapshot!.title).toBe('Persistent Card')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. OFFER CARD FROM SNAPSHOT (NO OFFER REPO)
  // ═══════════════════════════════════════════════════════════════════════

  describe('2. Offer card renders from snapshot without offer repo', () => {
    it('renders offer artifact from snapshot when offer entity is NOT loaded', async () => {
      const threadId = 'conv-snap-offer-001'

      await addConversation(seedConversation({ id: threadId }))

      // Persist offer artifact with snapshot but do NOT add offer to offer repo
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: OFFER_UUID,
        phase: 'sent',
        customerUserId: 'customer-snap-001',
        craftsmanUserId: 'craftsman-snap-001',
        snapshotPrice: '2.500 €',
        snapshotSummary: 'Komplettsanierung',
        snapshotPhaseLabel: 'Angebot liegt vor',
      })

      const artifacts = getThreadArtifacts(threadId)

      // Card renders from snapshot — no pending, no null
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.pendingOfferArtifact).toBe(false)

      // Snapshot data is available
      expect(artifacts.offerPaymentArtifact!.snapshot).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.snapshot!.price).toBe('2.500 €')
      expect(artifacts.offerPaymentArtifact!.snapshot!.summary).toBe('Komplettsanierung')
      expect(artifacts.offerPaymentArtifact!.snapshot!.phaseLabel).toBe('Angebot liegt vor')

      // Full entity is null (offer repo not loaded)
      expect(artifacts.offerPaymentArtifact!.offer).toBeNull()

      // Phase is derived from artifact record
      expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
    })

    it('snapshot offer card survives re-entry without offer repo', async () => {
      const threadId = 'conv-snap-offer-002'

      await addConversation(seedConversation({ id: threadId }))

      await persistOfferArtifact({
        conversationId: threadId,
        offerId: OFFER_UUID,
        phase: 'sent',
        snapshotPrice: '1.800 €',
        snapshotPhaseLabel: 'Angebot liegt vor',
      })

      // First read
      const first = getThreadArtifacts(threadId)
      expect(first.offerPaymentArtifact).not.toBeNull()
      expect(first.offerPaymentArtifact!.snapshot!.price).toBe('1.800 €')

      // Second read (simulates re-entry)
      const second = getThreadArtifacts(threadId)
      expect(second.offerPaymentArtifact).not.toBeNull()
      expect(second.offerPaymentArtifact!.snapshot!.price).toBe('1.800 €')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. PHASE TRANSITIONS PERSIST SNAPSHOT LABELS
  // ═══════════════════════════════════════════════════════════════════════

  describe('3. Phase transitions persist snapshot labels', () => {
    it('declined phase label persists as snapshot', async () => {
      const threadId = 'conv-snap-decline-001'

      await addConversation(seedConversation({ id: threadId }))

      await persistOfferArtifact({
        conversationId: threadId,
        offerId: OFFER_UUID,
        phase: 'sent',
        snapshotPrice: '3.200 €',
        snapshotPhaseLabel: 'Angebot liegt vor',
      })

      // Decline the offer
      await updateOfferArtifactPhase(threadId, 'declined', {
        snapshotPhaseLabel: 'Angebot abgelehnt',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('declined')
      expect(artifacts.offerPaymentArtifact!.snapshot!.phaseLabel).toBe('Angebot abgelehnt')
    })

    it('accepted phase label persists as snapshot', async () => {
      const threadId = 'conv-snap-accept-001'

      await addConversation(seedConversation({ id: threadId }))

      await persistOfferArtifact({
        conversationId: threadId,
        offerId: OFFER_UUID,
        phase: 'sent',
        snapshotPrice: '4.100 €',
        snapshotPhaseLabel: 'Angebot liegt vor',
      })

      // Accept the offer
      await updateOfferArtifactPhase(threadId, 'accepted', {
        snapshotPhaseLabel: 'Angebot angenommen',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
      expect(artifacts.offerPaymentArtifact!.snapshot!.phaseLabel).toBe('Angebot angenommen')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. ENTITY ENRICHMENT (SNAPSHOT + ENTITY COEXISTENCE)
  // ═══════════════════════════════════════════════════════════════════════

  describe('4. Full entity enriches card when loaded', () => {
    it('project card has both snapshot and entity when project repo is loaded', async () => {
      const threadId = 'conv-snap-enrich-001'

      await addProject(seedProject({ id: PROJECT_UUID, title: 'Enriched Projekt' }))
      await addConversation(seedConversation({ id: threadId }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        snapshotTitle: 'Enriched Projekt',
        snapshotStatus: 'request',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()

      // Both snapshot and entity are available
      expect(artifacts.projectArtifact!.snapshot).not.toBeNull()
      expect(artifacts.projectArtifact!.project).not.toBeNull()

      // Entity is the full object
      expect(artifacts.projectArtifact!.project!.title).toBe('Enriched Projekt')
      expect(artifacts.projectArtifact!.project!.id).toBe(PROJECT_UUID)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. PARTICIPANT SCOPING UNCHANGED
  // ═══════════════════════════════════════════════════════════════════════

  describe('5. No regression to participant scoping', () => {
    it('non-participant cannot see snapshot-based artifacts', async () => {
      const threadId = 'conv-snap-scope-001'

      await addConversation(seedConversation({
        id: threadId,
        customerUserId: 'customer-A',
        craftsmanUserId: 'craftsman-B',
      }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        customerUserId: 'customer-A',
        craftsmanUserId: 'craftsman-B',
        snapshotTitle: 'Scoped Project',
        snapshotStatus: 'request',
      })

      // Mock session as unrelated user
      const session = getSession()
      const originalUser = session.user
      session.user = { id: 'stranger-snap' } as typeof session.user

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).toBeNull()
      expect(artifacts.offerPaymentArtifact).toBeNull()

      session.user = originalUser
    })

    it('participant can see snapshot-based artifacts', async () => {
      const threadId = 'conv-snap-scope-002'

      await addConversation(seedConversation({
        id: threadId,
        customerUserId: 'customer-C',
        craftsmanUserId: 'craftsman-D',
      }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        customerUserId: 'customer-C',
        craftsmanUserId: 'craftsman-D',
        snapshotTitle: 'Visible Project',
        snapshotStatus: 'request',
      })

      const session = getSession()
      const originalUser = session.user
      session.user = { id: 'customer-C' } as typeof session.user

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.snapshot!.title).toBe('Visible Project')

      session.user = originalUser
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. PENDING STATE ONLY WHEN BOTH ENTITY AND SNAPSHOT MISSING
  // ═══════════════════════════════════════════════════════════════════════

  describe('6. Pending state is correct', () => {
    it('pendingProjectArtifact is false when snapshot exists but entity missing', async () => {
      const threadId = 'conv-snap-pending-001'

      await addConversation(seedConversation({ id: threadId }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        snapshotTitle: 'No Entity Needed',
        snapshotStatus: 'request',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.pendingProjectArtifact).toBe(false)
      expect(artifacts.projectArtifact).not.toBeNull()
    })

    it('pendingProjectArtifact is true when both snapshot and entity missing', async () => {
      const threadId = 'conv-snap-pending-002'

      const repo = new InMemoryThreadArtifactRepository()
      setThreadArtifactRepository(repo)

      await addConversation(seedConversation({ id: threadId }))

      // Persist artifact record WITHOUT snapshot data and WITHOUT entity
      await repo.upsert({
        id: `art-${threadId}-project`,
        conversationId: threadId,
        artifactType: 'project',
        projectId: PROJECT_UUID,
        // No snapshot fields
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.pendingProjectArtifact).toBe(true)
      expect(artifacts.projectArtifact).toBeNull()
    })

    it('pendingOfferArtifact is false when snapshot exists but entity missing', async () => {
      const threadId = 'conv-snap-pending-003'

      await addConversation(seedConversation({ id: threadId }))

      await persistOfferArtifact({
        conversationId: threadId,
        offerId: OFFER_UUID,
        phase: 'sent',
        snapshotPrice: '1.500 €',
        snapshotPhaseLabel: 'Angebot liegt vor',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.pendingOfferArtifact).toBe(false)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
    })

    it('pendingOfferArtifact is true when both snapshot and entity missing', async () => {
      const threadId = 'conv-snap-pending-004'

      const repo = new InMemoryThreadArtifactRepository()
      setThreadArtifactRepository(repo)

      await addConversation(seedConversation({ id: threadId }))

      // Persist artifact record WITHOUT snapshot data and WITHOUT entity
      await repo.upsert({
        id: `art-${threadId}-offer`,
        conversationId: threadId,
        artifactType: 'offer',
        offerId: OFFER_UUID,
        phase: 'sent',
        // No snapshot fields
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.pendingOfferArtifact).toBe(true)
      expect(artifacts.offerPaymentArtifact).toBeNull()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. WRITE PATHS PERSIST SNAPSHOT DATA
  // ═══════════════════════════════════════════════════════════════════════

  describe('7. Write paths persist snapshot data', () => {
    it('persistProjectArtifact stores snapshot fields in record', async () => {
      const threadId = 'conv-snap-write-001'

      await addConversation(seedConversation({ id: threadId }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        snapshotTitle: 'Written Title',
        snapshotStatus: 'scheduled',
        snapshotSummary: 'Written Summary',
      })

      // Verify snapshot fields are readable via getThreadArtifacts
      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.snapshot!.title).toBe('Written Title')
      expect(artifacts.projectArtifact!.snapshot!.status).toBe('scheduled')
      expect(artifacts.projectArtifact!.snapshot!.summary).toBe('Written Summary')
    })

    it('persistOfferArtifact stores snapshot fields in record', async () => {
      const threadId = 'conv-snap-write-002'

      await addConversation(seedConversation({ id: threadId }))

      await persistOfferArtifact({
        conversationId: threadId,
        offerId: OFFER_UUID,
        phase: 'sent',
        snapshotPrice: '5.000 €',
        snapshotSummary: 'Full kitchen renovation',
        snapshotPhaseLabel: 'Angebot liegt vor',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.snapshot!.price).toBe('5.000 €')
      expect(artifacts.offerPaymentArtifact!.snapshot!.summary).toBe('Full kitchen renovation')
      expect(artifacts.offerPaymentArtifact!.snapshot!.phaseLabel).toBe('Angebot liegt vor')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 8. NO LEGACY REGRESSION
  // ═══════════════════════════════════════════════════════════════════════

  describe('8. No legacy regression', () => {
    it('screen source still contains no legacy imports', async () => {
      const screenSource = await import('fs').then((fs) =>
        fs.readFileSync(
          path.resolve(__dirname, '../../src/screens/MessageThreadScreen.tsx'),
          'utf-8'
        )
      )

      // Old business-card selectors still forbidden
      expect(screenSource).not.toContain('getJobContextForThread')
      expect(screenSource).not.toContain('getThreadConversionState')
      expect(screenSource).not.toContain('buildTruthTraceSnapshot')

      // Old business-card components still forbidden
      expect(screenSource).not.toContain('ThreadProjectContextBar')
      expect(screenSource).not.toContain('ThreadOfferCard')
      expect(screenSource).not.toContain('ThreadJobContextBar')
      expect(screenSource).not.toContain('CraftsmanOfferForm')

      // ProjectPickerSheet is restored cleanly on the canonical write path
      expect(screenSource).toContain('ProjectPickerSheet')
      expect(screenSource).toContain('sendProjectAttachmentWorkflow')

      // Old business-card subscriptions still forbidden
      // NOTE: subscribeJobs is allowed — used for AWE gate reactivity, not business cards
      expect(screenSource).not.toContain('subscribePayments')
      expect(screenSource).not.toContain('subscribeOffers')

      // subscribeProjects is now used for the project attach entry
      expect(screenSource).toContain('subscribeProjects')

      // Clean canonical imports present
      expect(screenSource).toContain('getThreadArtifacts')
      expect(screenSource).toContain('subscribeThreadArtifacts')
      // Persistent top-cards removed (V5 2026-06-23): stream-only artifact cards.
      expect(screenSource).toContain('ChatArtifactCardCompact')
      expect(screenSource).not.toContain('ThreadArtifactCards')
    })
  })
})
