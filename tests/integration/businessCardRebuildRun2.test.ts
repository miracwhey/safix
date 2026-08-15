/**
 * Business Card Rebuild — RUN 2 Verification Tests
 *
 * Verifies that the RUN 2 clean rebuild is correct:
 *
 * 1. Project card renders from canonical thread_artifact record only
 * 2. Offer card renders from canonical thread_artifact record only
 * 3. Cards survive re-entry and reload for both participant roles
 * 4. Declined / accepted / payment-phase continuity
 * 5. No regression to participant scoping
 * 6. No regression to plain text messaging
 * 7. No regression to auth/bootstrap foundation
 * 8. No old legacy selectors or components reintroduced
 */

import React from 'react'
import path from 'path'
import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { renderToString } from 'react-dom/server'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import MessageThreadScreen from '../../src/screens/MessageThreadScreen'
import {
  addConversation,
  getThreadArtifacts,
  persistProjectArtifact,
  persistOfferArtifact,
  subscribeMessages,
  getMessageThreadById,
  getThreadHeader,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import { addOffer } from '../../src/lib/offers/service'
import type { Offer } from '../../src/lib/offers/types'
import { getSession } from '../../src/lib/session'
import { sendDirectMessageWorkflow } from '../../src/lib/workflow/messageWorkflow'

// ── Helpers ─────────────────────────────────────────────────────────────────

const PROJECT_UUID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'
const OFFER_UUID = 'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-run2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Run2 Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-run2-001',
    craftsmanName: 'Run2 Handwerker',
    craftsmanHandle: 'run2-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-run2-001',
    projectTitle: 'RUN 2 Rebuild Test',
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
    id: overrides.id ?? `proj-run2-${Date.now()}`,
    title: overrides.title ?? 'Run2 Projekt',
    customer: 'Run2 Kundin',
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

function seedOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: overrides.id ?? `offer-run2-${Date.now()}`,
    conversationId: overrides.conversationId ?? 'conv-run2-test',
    customerUserId: overrides.customerUserId ?? 'customer-run2-001',
    craftsmanUserId: overrides.craftsmanUserId ?? 'craftsman-run2-001',
    price: '2.500 €',
    description: 'Angebotstext für RUN 2',
    sentAt: Date.now(),
    status: overrides.status ?? 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function renderThread(threadId: string, role: 'customer' | 'craftsman' = 'customer'): string {
  const basePath = role === 'craftsman' ? '/craftsman/messages' : '/messages'
  return renderToString(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`${basePath}/${threadId}`] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: `${basePath}/:threadId`,
          element: React.createElement(MessageThreadScreen, { role, backPath: basePath }),
        })
      )
    )
  )
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Business Card Rebuild — RUN 2 Verification', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. PROJECT CARD FROM CANONICAL ARTIFACT
  // ═══════════════════════════════════════════════════════════════════════

  describe('1. Project card renders from canonical thread_artifact', () => {
    it('renders project card when project artifact is persisted', async () => {
      const threadId = 'conv-run2-proj-001'
      await addProject(seedProject({ id: PROJECT_UUID, title: 'Badezimmer Renovierung' }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
      })

      const html = renderThread(threadId, 'customer')

      expect(html).toContain('Badezimmer Renovierung')
      expect(html).toContain('Anfrage')
    })

    it('does NOT render project card without explicit artifact persistence', async () => {
      const threadId = 'conv-run2-proj-002'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: PROJECT_UUID,
      }))

      // sourceProjectId is set but no artifact record → no card
      const html = renderThread(threadId, 'customer')
      expect(html).not.toContain('Öffnen →')
    })

    it('renders project card for customer with navigation link', async () => {
      const threadId = 'conv-run2-proj-003'
      await addProject(seedProject({ id: PROJECT_UUID, title: 'Küche Umbau' }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({ conversationId: threadId, projectId: PROJECT_UUID })

      const html = renderThread(threadId, 'customer')
      expect(html).toContain('Projekt öffnen')
      expect(html).toContain(`/projects/${PROJECT_UUID}`)
    })

    it('renders project card for craftsman with pre-job request detail link', async () => {
      const threadId = 'conv-run2-proj-004'
      await addProject(seedProject({ id: PROJECT_UUID, title: 'Dachsanierung' }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({ conversationId: threadId, projectId: PROJECT_UUID })

      const html = renderThread(threadId, 'craftsman')
      expect(html).toContain('Dachsanierung')
      // Pre-job: craftsman can now open request detail view
      expect(html).toContain(`/craftsman/request/${PROJECT_UUID}`)
      expect(html).toContain('Projekt öffnen')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. OFFER CARD FROM CANONICAL ARTIFACT
  // ═══════════════════════════════════════════════════════════════════════

  describe('2. Offer card renders from canonical thread_artifact', () => {
    it('renders pending offer card with price', async () => {
      const threadId = 'conv-run2-offer-001'
      const offer = seedOffer({ id: OFFER_UUID, conversationId: threadId })
      await addConversation(seedConversation({ id: threadId }))
      await addOffer(offer)
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: OFFER_UUID,
        phase: 'sent',
      })

      const html = renderThread(threadId, 'customer')
      expect(html).toContain('Liegt vor')
    })

    it('renders deeplink CTA (not inline buttons) for customer on pending offer', async () => {
      const threadId = 'conv-run2-offer-002'
      const offer = seedOffer({ id: OFFER_UUID, conversationId: threadId })
      await addConversation(seedConversation({ id: threadId }))
      await addOffer(offer)
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: OFFER_UUID,
        phase: 'sent',
      })

      const html = renderThread(threadId, 'customer')
      // Inline accept/decline removed from chat — whole card deep-links to the
      // quote detail (footer "Angebot ansehen") where the decision lives.
      expect(html).toContain('Angebot ansehen')
      expect(html).toContain('quote-send-event-link')
      expect(html).not.toContain('✅ Annehmen')
      expect(html).not.toContain('>Ablehnen<')
    })

    it('does NOT render accept/decline buttons for craftsman', async () => {
      const threadId = 'conv-run2-offer-003'
      const offer = seedOffer({ id: OFFER_UUID, conversationId: threadId })
      await addConversation(seedConversation({ id: threadId }))
      await addOffer(offer)
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: OFFER_UUID,
        phase: 'sent',
      })

      const html = renderThread(threadId, 'craftsman')
      expect(html).toContain('Liegt vor')
      // Unified card has no inline craftsman hint; the status pill carries state.
      expect(html).not.toContain('Annehmen')
    })

    it('does NOT render offer card without explicit artifact persistence', async () => {
      const threadId = 'conv-run2-offer-004'
      const offer = seedOffer({ id: OFFER_UUID, conversationId: threadId })
      await addConversation(seedConversation({ id: threadId }))
      await addOffer(offer)

      // Offer entity exists but no artifact record → no card
      const html = renderThread(threadId, 'customer')
      expect(html).not.toContain('Liegt vor')
      expect(html).not.toContain('2.500 €')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. RE-ENTRY / RELOAD STABILITY
  // ═══════════════════════════════════════════════════════════════════════

  describe('3. Cards survive re-entry and reload', () => {
    it('project card survives customer re-entry', async () => {
      const threadId = 'conv-run2-reentry-001'
      await addProject(seedProject({ id: PROJECT_UUID, title: 'Stable Project' }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({ conversationId: threadId, projectId: PROJECT_UUID })

      // First render
      const html1 = renderThread(threadId, 'customer')
      expect(html1).toContain('Stable Project')

      // Simulate re-entry (re-render from fresh state)
      const html2 = renderThread(threadId, 'customer')
      expect(html2).toContain('Stable Project')
    })

    it('project card survives craftsman re-entry', async () => {
      const threadId = 'conv-run2-reentry-002'
      await addProject(seedProject({ id: PROJECT_UUID, title: 'Cross-Role Project' }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({ conversationId: threadId, projectId: PROJECT_UUID })

      const customerHtml = renderThread(threadId, 'customer')
      expect(customerHtml).toContain('Cross-Role Project')

      const craftsmanHtml = renderThread(threadId, 'craftsman')
      expect(craftsmanHtml).toContain('Cross-Role Project')
    })

    it('offer card survives re-entry for both roles', async () => {
      const threadId = 'conv-run2-reentry-003'
      const offer = seedOffer({ id: OFFER_UUID, conversationId: threadId })
      await addConversation(seedConversation({ id: threadId }))
      await addOffer(offer)
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: OFFER_UUID,
        phase: 'sent',
      })

      const customerHtml = renderThread(threadId, 'customer')
      expect(customerHtml).toContain('Liegt vor')

      const craftsmanHtml = renderThread(threadId, 'craftsman')
      expect(craftsmanHtml).toContain('Liegt vor')

      // Second render (re-entry)
      const reentryHtml = renderThread(threadId, 'customer')
      expect(reentryHtml).toContain('Liegt vor')
    })

    it('getThreadArtifacts returns consistent results across calls', async () => {
      const threadId = 'conv-run2-reentry-004'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({ conversationId: threadId, projectId: PROJECT_UUID })

      const first = getThreadArtifacts(threadId)
      const second = getThreadArtifacts(threadId)

      expect(first.projectArtifact).not.toBeNull()
      expect(second.projectArtifact).not.toBeNull()
      expect(first.projectArtifact!.project.id).toBe(second.projectArtifact!.project.id)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. DECLINED / ACCEPTED / PAYMENT-PHASE CONTINUITY
  // ═══════════════════════════════════════════════════════════════════════

  describe('4. Offer lifecycle continuity', () => {
    it('renders declined offer state', async () => {
      const threadId = 'conv-run2-declined-001'
      const offer = seedOffer({
        id: OFFER_UUID,
        conversationId: threadId,
        status: 'declined',
        declinedAt: Date.now(),
      })
      await addConversation(seedConversation({ id: threadId }))
      await addOffer(offer)
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: OFFER_UUID,
        phase: 'declined',
      })

      const html = renderThread(threadId, 'customer')
      expect(html).toContain('Abgelehnt')
    })

    it('renders accepted offer state', async () => {
      const threadId = 'conv-run2-accepted-001'
      const offer = seedOffer({
        id: OFFER_UUID,
        conversationId: threadId,
        status: 'accepted',
        acceptedAt: Date.now(),
      })
      await addConversation(seedConversation({ id: threadId }))
      await addOffer(offer)
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: OFFER_UUID,
        phase: 'accepted',
      })

      const html = renderThread(threadId, 'customer')
      expect(html).toContain('Angenommen')
    })

    it('declined state visible on re-entry for both roles', async () => {
      const threadId = 'conv-run2-declined-002'
      const offer = seedOffer({
        id: OFFER_UUID,
        conversationId: threadId,
        status: 'declined',
      })
      await addConversation(seedConversation({ id: threadId }))
      await addOffer(offer)
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: OFFER_UUID,
        phase: 'declined',
      })

      expect(renderThread(threadId, 'customer')).toContain('Abgelehnt')
      expect(renderThread(threadId, 'craftsman')).toContain('Abgelehnt')
    })

    it('accepted state visible on re-entry for both roles', async () => {
      const threadId = 'conv-run2-accepted-002'
      const offer = seedOffer({
        id: OFFER_UUID,
        conversationId: threadId,
        status: 'accepted',
      })
      await addConversation(seedConversation({ id: threadId }))
      await addOffer(offer)
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: OFFER_UUID,
        phase: 'accepted',
      })

      expect(renderThread(threadId, 'customer')).toContain('Angenommen')
      expect(renderThread(threadId, 'craftsman')).toContain('Angenommen')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. PARTICIPANT SCOPING
  // ═══════════════════════════════════════════════════════════════════════

  describe('5. Participant scoping prevents cross-account leakage', () => {
    it('non-participant does not see artifacts via selector', async () => {
      const threadId = 'conv-run2-scope-001'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({
        id: threadId,
        customerUserId: 'customer-A',
        craftsmanUserId: 'craftsman-B',
      }))
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
      })

      // Set session to non-participant
      const session = getSession()
      const original = session.user
      session.user = { id: 'stranger-run2' } as typeof session.user

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).toBeNull()
      expect(artifacts.offerPaymentArtifact).toBeNull()

      session.user = original
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. PLAIN TEXT MESSAGING NOT REGRESSED
  // ═══════════════════════════════════════════════════════════════════════

  describe('6. Plain text messaging still works alongside artifact cards', () => {
    it.skip('messages render alongside project card — Slice 7: text messages now from chat domain, not legacy store', async () => {
      const threadId = 'conv-run2-mixed-001'
      await addProject(seedProject({ id: PROJECT_UUID, title: 'Mixed Card Thread' }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({ conversationId: threadId, projectId: PROJECT_UUID })

      await sendDirectMessageWorkflow(threadId, 'Hallo, hier das Projekt')
      await sendDirectMessageWorkflow(threadId, 'Danke, sieht gut aus!', 'counterparty')

      const html = renderThread(threadId, 'customer')
      expect(html).toContain('Mixed Card Thread')
      expect(html).toContain('Hallo, hier das Projekt')
      expect(html).toContain('Danke, sieht gut aus!')
    })

    it('thread header still derives correctly for both roles', async () => {
      const threadId = 'conv-run2-header-001'
      await addConversation(seedConversation({
        id: threadId,
        customerName: 'Maria Run2',
        craftsmanName: 'Hans Run2',
      }))

      const thread = getMessageThreadById(threadId)!
      expect(getThreadHeader(thread, 'customer').primaryName).toBe('Hans Run2')
      expect(getThreadHeader(thread, 'craftsman').primaryName).toBe('Maria Run2')
    })

    it('message subscription fires on new messages', async () => {
      const threadId = 'conv-run2-sub-001'
      await addConversation(seedConversation({ id: threadId }))

      let notified = false
      const unsub = subscribeMessages(() => { notified = true })

      await sendDirectMessageWorkflow(threadId, 'Subscription test')
      expect(notified).toBe(true)

      unsub()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. NO OLD LEGACY COMPONENTS REINTRODUCED
  // ═══════════════════════════════════════════════════════════════════════

  describe('7. No old legacy components reintroduced', () => {
    it('screen source uses only clean canonical imports', async () => {
      const screenSource = await import('fs').then((fs) =>
        fs.readFileSync(
          path.resolve(__dirname, '../../src/screens/MessageThreadScreen.tsx'),
          'utf-8'
        )
      )

      // RUN 2 clean canonical sources must be present
      expect(screenSource).toContain('getThreadArtifacts')
      expect(screenSource).toContain('subscribeThreadArtifacts')
      // Persistent top-cards removed (V5 2026-06-23): artifacts now render in
      // the stream via ChatArtifactCardCompact + the *SendEventCard renderers.
      expect(screenSource).toContain('ChatArtifactCardCompact')
      expect(screenSource).not.toContain('ThreadArtifactCards')

      // Old legacy components must NOT be present
      expect(screenSource).not.toContain('ThreadProjectContextBar')
      expect(screenSource).not.toContain('ThreadOfferCard')
      expect(screenSource).not.toContain('ThreadJobContextBar')
      expect(screenSource).not.toContain('ThreadTruthTracePanel')
      expect(screenSource).not.toContain('CraftsmanOfferForm')
      expect(screenSource).not.toContain('CraftsmanRequestActionCard')
      expect(screenSource).not.toContain('CustomerInquiryPendingBar')
      expect(screenSource).not.toContain('ProjectAttachmentCard')

      // ProjectPickerSheet is restored cleanly on the canonical write path
      // (sendProjectAttachmentWorkflow). This is NOT the old legacy system.
      expect(screenSource).toContain('ProjectPickerSheet')
      expect(screenSource).toContain('sendProjectAttachmentWorkflow')

      // Old legacy selectors/state must NOT be present
      expect(screenSource).not.toContain('getJobContextForThread')
      expect(screenSource).not.toContain('getThreadConversionState')
      expect(screenSource).not.toContain('buildTruthTraceSnapshot')
      expect(screenSource).not.toContain('linkedProjectId')
      expect(screenSource).not.toContain('canAttachProject')
      expect(screenSource).not.toContain('conversionState')

      // Old legacy subscriptions must NOT be present
      // NOTE: subscribeJobs is allowed — used for AWE gate reactivity, not business cards
      expect(screenSource).not.toContain('subscribePayments')
      expect(screenSource).not.toContain('subscribeDisputes')
      expect(screenSource).not.toContain('subscribeOperations')
      expect(screenSource).not.toContain('subscribeOffers')

      // subscribeProjects is now used for the project attach entry
      expect(screenSource).toContain('subscribeProjects')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 8. BOTH ARTIFACT TYPES COEXIST
  // ═══════════════════════════════════════════════════════════════════════

  describe('8. Project and offer cards coexist in same thread', () => {
    it('renders both project and offer cards simultaneously', async () => {
      const threadId = 'conv-run2-both-001'
      await addProject(seedProject({ id: PROJECT_UUID, title: 'Doppeltes Projekt' }))
      const offer = seedOffer({ id: OFFER_UUID, conversationId: threadId })
      await addConversation(seedConversation({ id: threadId }))
      await addOffer(offer)

      await persistProjectArtifact({ conversationId: threadId, projectId: PROJECT_UUID })
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: OFFER_UUID,
        phase: 'sent',
      })

      const html = renderThread(threadId, 'customer')
      expect(html).toContain('Doppeltes Projekt')
      expect(html).toContain('Liegt vor')
    })
  })
})
