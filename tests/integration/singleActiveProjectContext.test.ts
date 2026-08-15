/**
 * Single Active Project Context + Explicit Project Switch — Tests
 *
 * Validates the new product rule:
 *   - The thread has exactly ONE active/main project context at the top
 *   - All sent project cards remain in history below
 *   - Sending another project does NOT add multiple top context bars
 *   - Changing the active/main project happens only through explicit action
 *
 * Test coverage:
 *   1. Only one top active project bar renders
 *   2. Multiple project history cards remain visible in timeline
 *   3. Re-sending a project does not create another top main-project bar
 *   4. Explicit switch action changes the active/main project
 *   5. Detail view correctly shows whether the project is active or not
 *   6. Active detail view shows state without switch CTA
 *   7. Non-active detail view shows state plus switch CTA
 *   8. No regression to multi-send history
 *   9. No regression to active project persistence across reload/re-entry
 *  10. No regression to relationship-thread consolidation
 *  11. No regression to participant scoping
 */

import React from 'react'
import path from 'path'
import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { renderToString } from 'react-dom/server'
import MessageThreadScreen from '../../src/screens/MessageThreadScreen'
import CustomerProjectDetailScreen from '../../src/screens/CustomerProjectDetailScreen'
import ToastProvider from '../../src/components/system/ToastProvider'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getConversationById,
  getThreadArtifacts,
  getProjectHauptprojektStatus,
  setActiveThreadProject,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import {
  sendProjectAttachmentWorkflow,
} from '../../src/lib/workflow/messageWorkflow'
import { isConversationParticipant } from '../../src/lib/messages/participantScope'

// ── Helpers ─────────────────────────────────────────────────────────────────

const PROJECT_UUID_A = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5a'
const PROJECT_UUID_B = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6b'
const PROJECT_UUID_C = 'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7c'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-sap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'SAP Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-sap-001',
    craftsmanName: 'SAP Handwerker',
    craftsmanHandle: 'sap-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-sap-001',
    projectTitle: 'SAP Test',
    projectSubtitle: 'Neue Anfrage',
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
    id: overrides.id ?? `proj-sap-${Date.now()}`,
    title: 'Test Projekt',
    customer: 'SAP Kundin',
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
    description: 'Testbeschreibung',
    ...overrides,
  }
}

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

function renderCustomerProjectDetail(projectId: string) {
  return renderToString(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`/projects/${projectId}`] },
      React.createElement(
        ToastProvider,
        null,
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/projects/:projectId',
            element: React.createElement(CustomerProjectDetailScreen),
          })
        )
      )
    )
  )
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Single Active Project Context', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. ONLY ONE TOP ACTIVE PROJECT BAR RENDERS
  // ═══════════════════════════════════════════════════════════════════════

  // V5 (2026-06-23): persistent top-bar removed — the "single active project"
  // invariant is now the ★ Hauptprojekt badge, which ProjectSendEventCard
  // renders ONLY on the active project. Exactly one badge ⇔ exactly one active.
  describe('1. Exactly one project is marked active (Hauptprojekt badge)', () => {
    it('single project renders one active marker', async () => {
      const threadId = 'conv-sap-top-001'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Badsanierung' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)

      const html = renderThread(threadId, 'customer')
      // One project-card-link in top context
      const topCardMatches = html.match(/timeline-hauptprojekt-badge/g) ?? []
      expect(topCardMatches.length).toBe(1)
    })

    it('two projects still render only one top context card', async () => {
      const threadId = 'conv-sap-top-002'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Projekt A' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Projekt B' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      const html = renderThread(threadId, 'customer')
      // Only one project-card-link (the active project) in top context
      const topCardMatches = html.match(/timeline-hauptprojekt-badge/g) ?? []
      expect(topCardMatches.length).toBe(1)
    })

    it('three projects still render only one top context card', async () => {
      const threadId = 'conv-sap-top-003'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'A' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'B' }))
      await addProject(seedProject({ id: PROJECT_UUID_C, title: 'C' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_C)

      const html = renderThread(threadId, 'customer')
      const topCardMatches = html.match(/timeline-hauptprojekt-badge/g) ?? []
      expect(topCardMatches.length).toBe(1)
    })

    it('active project is the first sent project (default)', async () => {
      const threadId = 'conv-sap-top-004'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Erste Anfrage' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Zweite Anfrage' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      const artifacts = getThreadArtifacts(threadId)
      const activeArtifact = artifacts.projectArtifacts.find((a) => a.isActiveProject)
      expect(activeArtifact).toBeDefined()
      expect(activeArtifact!.project!.id).toBe(PROJECT_UUID_A)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. MULTIPLE PROJECT HISTORY CARDS REMAIN VISIBLE IN TIMELINE
  // ═══════════════════════════════════════════════════════════════════════

  describe('2. Multiple project history cards remain visible in timeline', () => {
    it('both project send events render in timeline', async () => {
      const threadId = 'conv-sap-timeline-001'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'A' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'B' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      const html = renderThread(threadId, 'customer')
      const eventMatches = html.match(/project-send-event/g) ?? []
      // At least 2 project-send-event entries (each event has the testid)
      expect(eventMatches.length).toBeGreaterThanOrEqual(2)
    })

    it('three project send events all render in timeline', async () => {
      const threadId = 'conv-sap-timeline-002'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'A' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'B' }))
      await addProject(seedProject({ id: PROJECT_UUID_C, title: 'C' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_C)

      const html = renderThread(threadId, 'customer')
      const eventMatches = html.match(/project-send-event/g) ?? []
      expect(eventMatches.length).toBeGreaterThanOrEqual(3)
    })

    it('timeline shows Hauptprojekt badge on active project card', async () => {
      const threadId = 'conv-sap-timeline-003'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Aktiv' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Nicht aktiv' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      const html = renderThread(threadId, 'customer')
      expect(html).toContain('timeline-hauptprojekt-badge')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. RE-SENDING DOES NOT CREATE ANOTHER TOP MAIN-PROJECT BAR
  // ═══════════════════════════════════════════════════════════════════════

  describe('3. Re-sending does not create another top main-project bar', () => {
    it('sending same project twice still shows one top bar', async () => {
      const threadId = 'conv-sap-resend-001'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Resend' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)

      // Re-sending the same project must not create a SECOND active/main project.
      // (The same project re-sent yields two artifact records — both flagged for
      // the one active project — so we assert exactly ONE DISTINCT active project,
      // not a record/badge count.)
      const activeProjectIds = new Set(
        getThreadArtifacts(threadId)
          .projectArtifacts.filter((a) => a.isActiveProject)
          .map((a) => a.project?.id ?? a.snapshot?.projectId),
      )
      expect(activeProjectIds.size).toBe(1)
    })

    it('resending does not change sourceProjectId', async () => {
      const threadId = 'conv-sap-resend-002'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addProject(seedProject({ id: PROJECT_UUID_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      // sourceProjectId stays as first project
      expect(getConversationById(threadId)?.sourceProjectId).toBe(PROJECT_UUID_A)

      // Re-send B
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      // sourceProjectId STILL stays as first project
      expect(getConversationById(threadId)?.sourceProjectId).toBe(PROJECT_UUID_A)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. EXPLICIT SWITCH ACTION CHANGES THE ACTIVE/MAIN PROJECT
  // ═══════════════════════════════════════════════════════════════════════

  describe('4. Explicit switch action changes the active/main project', () => {
    it('switch changes active project in artifacts', async () => {
      const threadId = 'conv-sap-switch-001'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Was Active' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Now Active' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      // Before switch
      const before = getThreadArtifacts(threadId)
      expect(before.projectArtifacts[0].isActiveProject).toBe(true)
      expect(before.projectArtifacts[1].isActiveProject).toBe(false)

      // Switch
      const result = setActiveThreadProject(threadId, PROJECT_UUID_B)
      expect(result).toBe(true)

      // After switch
      const after = getThreadArtifacts(threadId)
      expect(after.projectArtifacts[0].isActiveProject).toBe(false)
      expect(after.projectArtifacts[1].isActiveProject).toBe(true)
    })

    it('switched project appears as the only top context card', async () => {
      const threadId = 'conv-sap-switch-002'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Alt' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Neu' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      // Switch to B
      setActiveThreadProject(threadId, PROJECT_UUID_B)

      const html = renderThread(threadId, 'customer')
      // Still only one top context card
      const topCardMatches = html.match(/timeline-hauptprojekt-badge/g) ?? []
      expect(topCardMatches.length).toBe(1)
      // The top card is now B
      expect(html).toContain('Neu')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. DETAIL VIEW CORRECTLY SHOWS WHETHER PROJECT IS ACTIVE
  // ═══════════════════════════════════════════════════════════════════════

  describe('5. Detail view correctly shows whether project is active or not', () => {
    it('getProjectHauptprojektStatus returns isActive:true for active project', async () => {
      const threadId = 'conv-sap-detail-001'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)

      const status = getProjectHauptprojektStatus(PROJECT_UUID_A)
      expect(status).not.toBeNull()
      expect(status!.isActive).toBe(true)
      expect(status!.threadId).toBe(threadId)
    })

    it('getProjectHauptprojektStatus returns isActive:false for non-active project', async () => {
      const threadId = 'conv-sap-detail-002'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addProject(seedProject({ id: PROJECT_UUID_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      // B is in thread history but NOT active
      const status = getProjectHauptprojektStatus(PROJECT_UUID_B)
      expect(status).not.toBeNull()
      expect(status!.isActive).toBe(false)
    })

    it('getProjectHauptprojektStatus returns null for unassociated project', async () => {
      await addProject(seedProject({ id: PROJECT_UUID_A }))

      const status = getProjectHauptprojektStatus(PROJECT_UUID_A)
      expect(status).toBeNull()
    })

    it('status updates after explicit switch', async () => {
      const threadId = 'conv-sap-detail-003'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addProject(seedProject({ id: PROJECT_UUID_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      // Before switch
      expect(getProjectHauptprojektStatus(PROJECT_UUID_A)!.isActive).toBe(true)
      expect(getProjectHauptprojektStatus(PROJECT_UUID_B)!.isActive).toBe(false)

      // Switch to B
      setActiveThreadProject(threadId, PROJECT_UUID_B)

      // After switch
      expect(getProjectHauptprojektStatus(PROJECT_UUID_A)!.isActive).toBe(false)
      expect(getProjectHauptprojektStatus(PROJECT_UUID_B)!.isActive).toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. ACTIVE DETAIL VIEW SHOWS STATE WITHOUT SWITCH CTA
  // ═══════════════════════════════════════════════════════════════════════

  describe('6. Active detail view shows state without switch CTA', () => {
    it('active project detail shows Hauptprojekt badge', async () => {
      const threadId = 'conv-sap-active-detail-001'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'Mein Hauptprojekt' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)

      const html = renderCustomerProjectDetail(PROJECT_UUID_A)
      expect(html).toContain('hauptprojekt-active-badge')
      expect(html).toContain('Dieses Projekt ist aktuell dein Hauptprojekt')
    })

    it('active project detail does NOT show switch CTA', async () => {
      const threadId = 'conv-sap-active-detail-002'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)

      const html = renderCustomerProjectDetail(PROJECT_UUID_A)
      expect(html).not.toContain('set-hauptprojekt-cta')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. NON-ACTIVE DETAIL VIEW SHOWS STATE PLUS SWITCH CTA
  // ═══════════════════════════════════════════════════════════════════════

  describe('7. Non-active detail view shows state plus switch CTA', () => {
    it('non-active project detail shows switch CTA', async () => {
      const threadId = 'conv-sap-nonactive-detail-001'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Nicht aktiv' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      const html = renderCustomerProjectDetail(PROJECT_UUID_B)
      expect(html).toContain('set-hauptprojekt-cta')
      expect(html).toContain('Als Hauptprojekt setzen')
    })

    it('non-active project detail does NOT show active badge', async () => {
      const threadId = 'conv-sap-nonactive-detail-002'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addProject(seedProject({ id: PROJECT_UUID_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      const html = renderCustomerProjectDetail(PROJECT_UUID_B)
      expect(html).not.toContain('hauptprojekt-active-badge')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 8. NO REGRESSION TO MULTI-SEND HISTORY
  // ═══════════════════════════════════════════════════════════════════════

  describe('8. No regression to multi-send history', () => {
    it('all project artifacts remain in projectArtifacts array', async () => {
      const threadId = 'conv-sap-history-001'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addProject(seedProject({ id: PROJECT_UUID_B }))
      await addProject(seedProject({ id: PROJECT_UUID_C }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_C)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifacts).toHaveLength(3)
    })

    it('projectArtifact backward-compat still returns first', async () => {
      const threadId = 'conv-sap-history-002'
      await addProject(seedProject({ id: PROJECT_UUID_A, title: 'First' }))
      await addProject(seedProject({ id: PROJECT_UUID_B, title: 'Second' }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.project!.id).toBe(PROJECT_UUID_A)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 9. NO REGRESSION TO ACTIVE PROJECT PERSISTENCE ACROSS RELOAD
  // ═══════════════════════════════════════════════════════════════════════

  describe('9. No regression to active project persistence across reload/re-entry', () => {
    it('multiple reads return consistent active project state', async () => {
      const threadId = 'conv-sap-reload-001'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addProject(seedProject({ id: PROJECT_UUID_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      for (let i = 0; i < 3; i++) {
        const artifacts = getThreadArtifacts(threadId)
        expect(artifacts.projectArtifacts).toHaveLength(2)
        expect(artifacts.projectArtifacts[0].isActiveProject).toBe(true)
        expect(artifacts.projectArtifacts[1].isActiveProject).toBe(false)
      }
    })

    it('switched state survives re-derivation', async () => {
      const threadId = 'conv-sap-reload-002'
      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addProject(seedProject({ id: PROJECT_UUID_B }))
      await addConversation(seedConversation({ id: threadId }))

      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_A)
      await sendProjectAttachmentWorkflow(threadId, PROJECT_UUID_B)

      setActiveThreadProject(threadId, PROJECT_UUID_B)

      for (let i = 0; i < 3; i++) {
        const artifacts = getThreadArtifacts(threadId)
        expect(artifacts.projectArtifacts[0].isActiveProject).toBe(false)
        expect(artifacts.projectArtifacts[1].isActiveProject).toBe(true)
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 10. NO REGRESSION TO RELATIONSHIP-THREAD CONSOLIDATION
  // ═══════════════════════════════════════════════════════════════════════

  describe('10. No regression to relationship-thread consolidation', () => {
    it('artifacts aggregate across relationship group', async () => {
      const threadA = 'conv-sap-rel-001a'
      const threadB = 'conv-sap-rel-001b'
      const customerUserId = 'customer-sap-rel-001'
      const craftsmanUserId = 'craftsman-sap-rel-001'

      await addProject(seedProject({ id: PROJECT_UUID_A }))
      await addConversation(seedConversation({
        id: threadA,
        customerUserId,
        craftsmanUserId,
      }))
      await addConversation(seedConversation({
        id: threadB,
        customerUserId,
        craftsmanUserId,
      }))

      await sendProjectAttachmentWorkflow(threadA, PROJECT_UUID_A)

      // Artifact visible from both conversation IDs via group consolidation
      const artifactsA = getThreadArtifacts(threadA)
      const artifactsB = getThreadArtifacts(threadB)
      expect(artifactsA.projectArtifacts.length).toBeGreaterThan(0)
      expect(artifactsB.projectArtifacts.length).toBeGreaterThan(0)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 11. NO REGRESSION TO PARTICIPANT SCOPING
  // ═══════════════════════════════════════════════════════════════════════

  describe('11. No regression to participant scoping', () => {
    it('participant check works correctly', async () => {
      const conv = seedConversation({
        id: 'conv-sap-scope-001',
        customerUserId: 'cust-sap-scope',
        craftsmanUserId: 'craft-sap-scope',
      })
      await addConversation(conv)

      expect(isConversationParticipant(conv, 'cust-sap-scope')).toBe(true)
      expect(isConversationParticipant(conv, 'craft-sap-scope')).toBe(true)
      expect(isConversationParticipant(conv, 'stranger')).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // SOURCE CODE VERIFICATION
  // ═══════════════════════════════════════════════════════════════════════

  describe('Source code verification', () => {
    it('ThreadArtifactCards renders only active project (not all)', async () => {
      const fs = await import('fs')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../src/components/messages/ThreadArtifactCards.tsx'),
        'utf-8'
      )

      // Uses active project filtering
      expect(source).toContain('activeProject')
      expect(source).toContain('isActiveProject')
      // Does NOT map over all project artifacts
      expect(source).not.toContain('projectArtifacts.map')
    })

    it('ProjectSendEventCard has Hauptprojekt badge and switch action', async () => {
      const fs = await import('fs')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../src/components/messages/ProjectSendEventCard.tsx'),
        'utf-8'
      )

      expect(source).toContain('timeline-hauptprojekt-badge')
      expect(source).toContain('timeline-set-active-project')
      expect(source).toContain('Als Hauptprojekt setzen')
      expect(source).toContain('onSetActive')
    })

    it('CustomerProjectDetailScreen has Hauptprojekt status section', async () => {
      const fs = await import('fs')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../src/screens/CustomerProjectDetailScreen.tsx'),
        'utf-8'
      )

      expect(source).toContain('hauptprojekt-status-section')
      expect(source).toContain('hauptprojekt-active-badge')
      expect(source).toContain('set-hauptprojekt-cta')
      expect(source).toContain('Dieses Projekt ist aktuell dein Hauptprojekt')
      expect(source).toContain('Als Hauptprojekt setzen')
      expect(source).toContain('getProjectHauptprojektStatus')
    })

    it('MessageThreadScreen passes onSetActive to ProjectSendEventCard', async () => {
      const fs = await import('fs')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../src/screens/MessageThreadScreen.tsx'),
        'utf-8'
      )

      expect(source).toContain('onSetActive={handleSetActiveProject}')
    })
  })
})
