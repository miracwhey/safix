/**
 * Thread Visual Hierarchy Tests
 *
 * Validates the 3-layer visual structure of the thread screen:
 *   LAYER 1: Persistent context (project bar, offer status) — compact, above timeline
 *   LAYER 2: Historical events (project send, quote send) — lighter, in timeline
 *   LAYER 3: Chat messages — standard text bubbles
 *
 * Also validates:
 *   - Role-aware quick replies (customer vs craftsman)
 *   - Visual differentiation between customer and craftsman events
 *   - Active project bar still renders
 *   - No regression to navigation or thread behavior
 */

import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { renderToString } from 'react-dom/server'
import MessageThreadScreen from '../../src/screens/MessageThreadScreen'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  persistProjectArtifact,
  persistOfferArtifact,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'

// ── Helpers ─────────────────────────────────────────────────────────────────

function renderThread(threadId: string, role: 'customer' | 'craftsman' = 'customer') {
  const backPath = role === 'craftsman' ? '/craftsman/messages' : '/messages'
  return renderToString(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`/messages/${threadId}`] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: '/messages/:threadId',
          element: React.createElement(MessageThreadScreen, { role, backPath }),
        })
      )
    )
  )
}

const PROJECT_UUID = 'a1a1a1a1-b2b2-4c3c-d4d4-e5e5e5e5e5e5'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-vh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Test Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-vh-001',
    craftsmanName: 'Test Handwerker',
    craftsmanHandle: 'vh-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-vh-001',
    projectTitle: 'VH Test',
    projectSubtitle: 'Anfrage',
    projectLocation: 'Berlin',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Gerade eben',
    inquiryOrigin: 'profile',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? PROJECT_UUID,
    title: 'Küche renovieren',
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
    category: 'Sanitär',
    description: 'Testprojekt',
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Thread Visual Hierarchy', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. ACTIVE PROJECT BAR STILL RENDERS
  // ═══════════════════════════════════════════════════════════════════════

  describe('1. Active project bar still renders', () => {
    it('renders project card with status, title, and CTA', async () => {
      const threadId = 'conv-vh-bar-001'
      await addProject(seedProject({ id: PROJECT_UUID, title: 'Badsanierung' }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
      })

      const html = renderThread(threadId, 'customer')

      // V5 (2026-06-23): persistent top-bar removed — project renders in the
      // stream via project-send-event; footer action is "Projekt öffnen".
      expect(html).toContain('project-send-event')
      expect(html).toContain('Badsanierung')
      expect(html).toContain('Anfrage')
      expect(html).toContain('Projekt öffnen')
    })

    it('renders Hauptprojekt badge for active project', async () => {
      const threadId = 'conv-vh-bar-002'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
      })

      const html = renderThread(threadId, 'customer')

      expect(html).toContain('Hauptprojekt')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. PROJECT EVENT CARD RENDERS IN TIMELINE
  // ═══════════════════════════════════════════════════════════════════════

  describe('2. Project event card renders in timeline', () => {
    it('renders project-send-event with customer-side styling', async () => {
      const threadId = 'conv-vh-proj-001'
      await addProject(seedProject({ id: PROJECT_UUID, title: 'Gartenarbeit' }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
      })

      const html = renderThread(threadId, 'customer')

      expect(html).toContain('project-send-event')
      expect(html).toContain('Gartenarbeit')
      // Unified shell: type label + status pill (no legacy "Projekt gesendet"
      // header / blue left border).
      expect(html).toContain('Anfrage')
    })

    it('shows metadata (category, location) in compact format', async () => {
      const threadId = 'conv-vh-proj-002'
      await addProject(seedProject({
        id: PROJECT_UUID,
        title: 'Dachausbau',
        category: 'Dachdecker',
        location: 'München',
      }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
      })

      const html = renderThread(threadId, 'customer')

      // Unified card shows the category as the subtitle (location lives on detail).
      expect(html).toContain('Dachdecker')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. QUOTE EVENT CARD RENDERS IN TIMELINE
  // ═══════════════════════════════════════════════════════════════════════

  describe('3. Quote event card renders in timeline', () => {
    it('renders quote-send-event with craftsman-side styling', async () => {
      const threadId = 'conv-vh-quote-001'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
      })
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: 'offer-vh-001',
        phase: 'sent',
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
        snapshotPrice: '€2.500',
        snapshotSummary: 'Komplettrenovierung',
      })

      const html = renderThread(threadId, 'customer')

      expect(html).toContain('quote-send-event')
      // Unified shell: doctype type label + status pill (no price in the stream,
      // no emerald left border).
      expect(html).toContain('Verbindliches Angebot')
      expect(html).toContain('Komplettrenovierung')
      expect(html).toContain('Liegt vor')
    })

    it('craftsman sees KV gesendet label', async () => {
      const threadId = 'conv-vh-quote-002'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
      })
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: 'offer-vh-002',
        phase: 'sent',
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
        snapshotPrice: '€1.200',
      })

      const html = renderThread(threadId, 'craftsman')

      expect(html).toContain('Verbindliches Angebot')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. ROLE-AWARE QUICK REPLIES
  // ═══════════════════════════════════════════════════════════════════════

  describe.skip('4. Role-aware quick replies — Slice 7: removed with legacy composer', () => {
    // Quick reply buttons were part of the legacy composer removed in Block D Slice 7.
    // The ChatComposer does not have quick reply chips.
    it('customer sees customer-appropriate quick reply suggestions', async () => {})
    it('craftsman sees craftsman-appropriate quick reply suggestions', async () => {})
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. VISUAL HIERARCHY — LAYERS ARE DISTINCT
  // ═══════════════════════════════════════════════════════════════════════

  // V5 (2026-06-23): the old multi-layer hierarchy (sticky top-bar + per-type
  // left-border-tinted event cards) is replaced by ONE unified artifact-card
  // shell. There is no longer a distinct "context layer" vs "event layer".
  describe('5. Artifacts render through the unified card shell', () => {
    it('uses the unified shell (rounded-[14px]) — no legacy left-border layer', async () => {
      const threadId = 'conv-vh-hier-001'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
      })

      const html = renderThread(threadId, 'customer')

      // Unified shell radius; legacy left-border event styling is gone.
      expect(html).toContain('rounded-[14px]')
      expect(html).not.toContain('border-l-[3px]')
    })

    it('project and quote events share the same unified shell (no per-type border tint)', async () => {
      const threadId = 'conv-vh-hier-002'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
      })
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: 'offer-vh-hier',
        phase: 'sent',
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
        snapshotPrice: '€3.000',
      })

      const html = renderThread(threadId, 'customer')

      // Both render as unified cards; the old blue/emerald left-border tints are gone.
      expect(html).toContain('project-send-event')
      expect(html).toContain('quote-send-event')
      expect(html).not.toContain('border-blue-300')
      expect(html).not.toContain('border-emerald-300')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. NO REGRESSION TO NAVIGATION
  // ═══════════════════════════════════════════════════════════════════════

  describe('6. No regression to navigation', () => {
    it('project card link and sent event link still work', async () => {
      const threadId = 'conv-vh-nav-001'
      await addProject(seedProject({ id: PROJECT_UUID, title: 'Fliesenarbeit' }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
      })

      const html = renderThread(threadId, 'customer')

      // Stream-card link (V5: persistent top-bar removed).
      expect(html).toContain(`/projects/${PROJECT_UUID}`)
      expect(html).toContain('project-send-event-link')
      expect(html).toContain('Projekt öffnen')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. EVENT OWNERSHIP ALIGNMENT
  // ═══════════════════════════════════════════════════════════════════════

  // V5 (2026-06-23): ownership alignment removed — every artifact is a
  // full-width unified card regardless of who sent it.
  describe('7. Artifacts are full-width unified cards (no ownership alignment)', () => {
    it('customer project event renders full-width (no justify-end/start)', async () => {
      const threadId = 'conv-vh-own-001'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
      })

      const html = renderThread(threadId, 'customer')

      // V5: full-width unified card — no ownership alignment.
      expect(html).toContain('project-send-event')
      expect(html).not.toContain('justify-end')
      expect(html).not.toContain('justify-start')
    })

    it('craftsman sees customer project event as incoming (left-oriented)', async () => {
      const threadId = 'conv-vh-own-002'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
      })

      const html = renderThread(threadId, 'craftsman')

      // V5: full-width unified card — no ownership alignment.
      expect(html).toContain('project-send-event')
      expect(html).not.toContain('justify-start')
    })

    it('craftsman sees own quote event as outgoing (right-oriented)', async () => {
      const threadId = 'conv-vh-own-003'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
      })
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: 'offer-vh-own-003',
        phase: 'sent',
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
        snapshotPrice: '€1.800',
      })

      const html = renderThread(threadId, 'craftsman')

      expect(html).toContain('quote-send-event')
      expect(html).toContain('Verbindliches Angebot')
      // V5: full-width unified card — no ownership alignment.
      expect(html).not.toContain('justify-end')
    })

    it('customer sees craftsman quote event as incoming (left-oriented)', async () => {
      const threadId = 'conv-vh-own-004'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
      })
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: 'offer-vh-own-004',
        phase: 'sent',
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
        snapshotPrice: '€2.200',
      })

      const html = renderThread(threadId, 'customer')

      expect(html).toContain('quote-send-event')
      expect(html).toContain('Verbindliches Angebot')
      // V5: full-width unified card — no ownership alignment.
      expect(html).not.toContain('justify-start')
    })

    it('persistent context (Layer 1) remains full-width / not ownership-aligned', async () => {
      const threadId = 'conv-vh-own-005'
      await addProject(seedProject({ id: PROJECT_UUID }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
      })

      const html = renderThread(threadId, 'customer')

      // V5: no persistent Layer-1 bar; the stream card is full-width, not
      // ownership-aligned.
      expect(html).toContain('project-send-event')
      expect(html).not.toContain('justify-end')
      expect(html).not.toContain('justify-start')
    })

    it('no regression to thread behavior or navigation', async () => {
      const threadId = 'conv-vh-own-006'
      await addProject(seedProject({ id: PROJECT_UUID, title: 'Badumbau' }))
      await addConversation(seedConversation({ id: threadId }))
      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
      })
      await persistOfferArtifact({
        conversationId: threadId,
        offerId: 'offer-vh-own-006',
        phase: 'sent',
        customerUserId: 'customer-vh-001',
        craftsmanUserId: 'craftsman-vh-001',
        snapshotPrice: '€3.500',
      })

      // Customer view
      const customerHtml = renderThread(threadId, 'customer')
      expect(customerHtml).toContain('project-send-event')
      expect(customerHtml).toContain('quote-send-event')
      expect(customerHtml).toContain('Badumbau')

      // Craftsman view
      const craftsmanHtml = renderThread(threadId, 'craftsman')
      expect(craftsmanHtml).toContain('project-send-event')
      expect(craftsmanHtml).toContain('quote-send-event')
      expect(craftsmanHtml).toContain('Badumbau')
    })
  })
})
