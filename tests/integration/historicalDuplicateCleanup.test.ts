/**
 * Historical Duplicate Thread Cleanup Completion — Tests
 *
 * Validates that existing historical duplicate conversation rows for the same
 * customer ↔ craftsman pair no longer behave as separate active chats:
 *
 *  1. Inbox shows one thread per pair (historical duplicates collapsed)
 *  2. Inbox preview/timeLabel from consolidated relationship thread
 *  3. Unread/count semantics from consolidated thread
 *  4. Opening stale duplicate resolves to canonical master thread
 *  5. Project send appears in visible consolidated thread
 *  6. Active project state correct under historical duplicate data
 *  7. No regression to multi-send project history
 *  8. No regression to reload/re-entry stability
 *  9. markRequestReviewedWorkflow writes to canonical conversation
 * 10. declineRequestWorkflow writes to canonical conversation
 * 11. getConversationMessagesForJob consolidates across relationship group
 * 12. getProjectConversationMessageCount consolidates across relationship group
 * 13. getJobConversations deduplicates by pair
 * 14. sendJobConversationMessage targets canonical conversation
 * 15. getOutboundProjectRequests checks sourceProjectId across group
 * 16. getIncomingProjectRequests derives timeLabel from consolidated messages
 * 17. No regression to previous new-duplicate-prevention fix
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getConversationById,
  getMessageThreadById,
  getMessageThreads,
  getThreadArtifacts,
  resolveCanonicalThreadId,
  sendMessageToThread,
  sendProjectAttachmentToThread,
  subscribeMessages,
  getOutboundProjectRequests,
  getMessagesByConversationId,
} from '../../src/lib/messages'
import {
  getIncomingProjectRequests,
} from '../../src/lib/messages/requestInboxSelectors'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import { addJob } from '../../src/lib/jobs'
import type { Job } from '../../src/lib/jobs/types'
import {
  markRequestReviewedWorkflow,
  declineRequestWorkflow,
} from '../../src/lib/workflow/exploreInquiryWorkflow'
import {
  getConversationMessagesForJob,
  getProjectConversationMessageCount,
  getJobConversations,
  sendJobConversationMessage,
} from '../../src/lib/workflow/messageWorkflow'

// ── Helpers ─────────────────────────────────────────────────────────────────

const CUSTOMER_ID = 'customer-hdc-001'
const CRAFTSMAN_ID = 'craftsman-hdc-001'
const CRAFTSMAN_HANDLE = 'hans-hdc'

const PROJECT_A = 'aaaa3333-3333-4333-a333-333333333333'
const PROJECT_B = 'bbbb4444-4444-4444-b444-444444444444'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id =
    overrides.id ??
    `conv-hdc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Lisa Kundin',
    customerAvatarUrl: '',
    customerUserId: CUSTOMER_ID,
    craftsmanName: 'Hans Handwerker',
    craftsmanHandle: CRAFTSMAN_HANDLE,
    craftsmanAvatarUrl: '',
    craftsmanUserId: CRAFTSMAN_ID,
    projectTitle: 'Küche renovieren',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Berlin',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'profile',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? `proj-hdc-${Date.now()}`,
    title: 'Küchenumbau',
    category: 'Küche',
    description: 'Neue Küche einbauen',
    location: 'Berlin',
    status: 'request',
    source: 'builder',
    sourceJobId: '',
    customer: 'Kunde',
    craftsman: 'Handwerker',
    dateLabel: 'Offen',
    price: '',
    paymentState: 'none',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    requestedBudget: '5.000 – 10.000 €',
    requestedTiming: 'Innerhalb 8 Wochen',
    ...overrides,
  }
}

function seedJob(overrides: Partial<Job> = {}): Job {
  return {
    id: overrides.id ?? `job-hdc-${Date.now()}`,
    title: 'Küchenumbau',
    customer: 'Kunde',
    status: 'accepted',
    projectId: overrides.projectId ?? 'proj-hdc-1',
    dateLabel: 'Jetzt',
    amount: '5000',
    location: 'Berlin',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as Job
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Historical Duplicate Thread Cleanup Completion', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. INBOX: HISTORICAL DUPLICATES COLLAPSE INTO ONE THREAD
  // ═══════════════════════════════════════════════════════════════════════════

  describe('inbox collapses historical duplicates', () => {
    it('three historical duplicates show as one inbox thread', async () => {
      await addConversation(seedConversation({ id: 'conv-old1', createdAt: 1000 }))
      await addConversation(seedConversation({ id: 'conv-old2', createdAt: 2000 }))
      await addConversation(seedConversation({ id: 'conv-new', createdAt: 3000 }))

      const threads = getMessageThreads()
      const pairThreads = threads.filter((t) => t.craftsmanHandle === CRAFTSMAN_HANDLE)
      expect(pairThreads).toHaveLength(1)
      expect(pairThreads[0].id).toBe('conv-new')
    })

    it('preview derives from consolidated messages across duplicates', async () => {
      await addConversation(seedConversation({ id: 'conv-old', createdAt: 1000 }))
      await addConversation(seedConversation({ id: 'conv-new', createdAt: 2000 }))

      // Send message to old duplicate
      await sendMessageToThread('conv-old', 'Alte Nachricht')
      // Send message to new canonical
      await sendMessageToThread('conv-new', 'Neue Nachricht')

      const thread = getMessageThreadById('conv-new')!
      expect(thread.lastMessagePreview).toBe('Neue Nachricht')
      // Both messages should be visible in history
      expect(thread.messages).toHaveLength(2)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. UNREAD COUNT CONSOLIDATION
  // ═══════════════════════════════════════════════════════════════════════════

  describe('unread counts consolidate across historical duplicates', () => {
    it('unread counts from all duplicates are summed', async () => {
      await addConversation(seedConversation({ id: 'conv-old', createdAt: 1000, unreadCount: 2 }))
      await addConversation(seedConversation({ id: 'conv-new', createdAt: 2000, unreadCount: 3 }))

      const thread = getMessageThreadById('conv-new')!
      expect(thread.unreadCount).toBe(5)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. STALE DUPLICATE OPEN → RESOLVES TO CANONICAL
  // ═══════════════════════════════════════════════════════════════════════════

  describe('stale duplicate thread open resolves to canonical', () => {
    it('resolveCanonicalThreadId maps old duplicate to canonical', async () => {
      await addConversation(seedConversation({ id: 'conv-old', createdAt: 1000 }))
      await addConversation(seedConversation({ id: 'conv-new', createdAt: 2000 }))

      expect(resolveCanonicalThreadId('conv-old')).toBe('conv-new')
    })

    it('getMessageThreadById resolves old ID to canonical thread', async () => {
      await addConversation(seedConversation({ id: 'conv-old', createdAt: 1000 }))
      await addConversation(seedConversation({ id: 'conv-new', createdAt: 2000 }))

      const thread = getMessageThreadById('conv-old')
      expect(thread).toBeDefined()
      expect(thread!.id).toBe('conv-new')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. markRequestReviewedWorkflow — CANONICAL RESOLUTION
  // ═══════════════════════════════════════════════════════════════════════════

  describe('markRequestReviewedWorkflow resolves to canonical', () => {
    it('review mark written to canonical even when called with old ID', async () => {
      await addConversation(seedConversation({ id: 'conv-old', createdAt: 1000 }))
      await addConversation(seedConversation({ id: 'conv-new', createdAt: 2000, unreadCount: 3 }))

      // Call with old duplicate ID
      markRequestReviewedWorkflow('conv-old')

      // Review state should be on canonical conversation
      const canonical = getConversationById('conv-new')!
      expect(canonical.reviewedAt).toBeDefined()
      expect(canonical.unreadCount).toBe(0)
    })

    it('does not write to non-canonical duplicate', async () => {
      await addConversation(seedConversation({ id: 'conv-old', createdAt: 1000 }))
      await addConversation(seedConversation({ id: 'conv-new', createdAt: 2000, unreadCount: 3 }))

      markRequestReviewedWorkflow('conv-old')

      // Old duplicate should NOT have reviewedAt
      const old = getConversationById('conv-old')!
      expect(old.reviewedAt).toBeUndefined()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. declineRequestWorkflow — CANONICAL RESOLUTION
  // ═══════════════════════════════════════════════════════════════════════════

  describe('declineRequestWorkflow resolves to canonical', () => {
    it('decline state written to canonical even when called with old ID', async () => {
      await addConversation(seedConversation({ id: 'conv-old', createdAt: 1000 }))
      await addConversation(seedConversation({ id: 'conv-new', createdAt: 2000 }))

      declineRequestWorkflow('conv-old')

      // Decline state should be on canonical conversation
      const canonical = getConversationById('conv-new')!
      expect(canonical.declinedAt).toBeDefined()
      expect(canonical.projectStatusLabel).toBe('Abgelehnt')
    })

    it('decline message sent to canonical thread', async () => {
      await addConversation(seedConversation({ id: 'conv-old', createdAt: 1000 }))
      await addConversation(seedConversation({ id: 'conv-new', createdAt: 2000 }))

      declineRequestWorkflow('conv-old')

      // Message should be on canonical conversation
      const messages = getMessagesByConversationId('conv-new')
      expect(messages.length).toBeGreaterThan(0)
      expect(messages[0].sender).toBe('counterparty')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. getConversationMessagesForJob — CONSOLIDATION
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getConversationMessagesForJob consolidates across group', () => {
    it('messages from duplicate conversations appear in job context', async () => {
      await addConversation(seedConversation({ id: 'conv-old', createdAt: 1000 }))
      await addConversation(seedConversation({ id: 'conv-new', createdAt: 2000 }))
      await addJob(seedJob({
        id: 'job-1',
        sourceConversationId: 'conv-old',
        projectId: 'proj-1',
      }))

      // Send messages to both conversations
      await sendMessageToThread('conv-old', 'Hallo von alt')
      await sendMessageToThread('conv-new', 'Hallo von neu')

      const messages = getConversationMessagesForJob('job-1')
      expect(messages).toHaveLength(2)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. getProjectConversationMessageCount — CONSOLIDATION
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getProjectConversationMessageCount consolidates across group', () => {
    it('counts messages from all duplicate conversations', async () => {
      await addConversation(seedConversation({ id: 'conv-old', createdAt: 1000 }))
      await addConversation(seedConversation({ id: 'conv-new', createdAt: 2000 }))

      await sendMessageToThread('conv-old', 'Nachricht 1')
      await sendMessageToThread('conv-new', 'Nachricht 2')
      await sendMessageToThread('conv-new', 'Nachricht 3')

      // Using sourceConversationId path
      const count = getProjectConversationMessageCount('any-proj', 0, 'conv-old')
      expect(count).toBe(3) // All 3 messages across the group
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. getJobConversations — DEDUPLICATION
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getJobConversations deduplicates by pair', () => {
    it('duplicate conversations do not produce duplicate job entries', async () => {
      const projId = 'proj-job-dedup'
      await addConversation(seedConversation({
        id: 'conv-old',
        createdAt: 1000,
        projectId: projId,
      }))
      await addConversation(seedConversation({
        id: 'conv-new',
        createdAt: 2000,
        projectId: `project-conv-new`, // Different projectId
      }))
      await addJob(seedJob({
        id: 'job-dedup',
        projectId: projId,
        sourceConversationId: 'conv-old',
      }))

      const jobConvs = getJobConversations()
      const matching = jobConvs.filter((jc) => jc.jobId === 'job-dedup')
      expect(matching).toHaveLength(1)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. sendJobConversationMessage — CANONICAL ROUTING
  // ═══════════════════════════════════════════════════════════════════════════

  describe('sendJobConversationMessage targets canonical', () => {
    it('message sent via job path lands on canonical conversation', async () => {
      await addConversation(seedConversation({ id: 'conv-old', createdAt: 1000 }))
      await addConversation(seedConversation({ id: 'conv-new', createdAt: 2000 }))
      await addJob(seedJob({
        id: 'job-msg',
        sourceConversationId: 'conv-old',
        projectId: 'proj-1',
      }))

      await sendJobConversationMessage({
        jobId: 'job-msg',
        sender: 'craftsman',
        text: 'Hallo vom Handwerker',
      })

      // Message should be on canonical conversation
      const canonicalMessages = getMessagesByConversationId('conv-new')
      expect(canonicalMessages.length).toBeGreaterThan(0)
      expect(canonicalMessages.some((m) => m.text === 'Hallo vom Handwerker')).toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. getOutboundProjectRequests — GROUP-WIDE sourceProjectId CHECK
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getOutboundProjectRequests checks sourceProjectId across group', () => {
    it('finds outbound request when sourceProjectId is on non-canonical duplicate', async () => {
      await addConversation(seedConversation({
        id: 'conv-old',
        createdAt: 1000,
        sourceProjectId: PROJECT_A,
      }))
      await addConversation(seedConversation({
        id: 'conv-new',
        createdAt: 2000,
        // No sourceProjectId on canonical
      }))

      const requests = getOutboundProjectRequests(PROJECT_A)
      expect(requests).toHaveLength(1)
      expect(requests[0].threadId).toBe('conv-new') // Canonical thread
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 11. getIncomingProjectRequests — CONSOLIDATED timeLabel
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getIncomingProjectRequests derives timeLabel from consolidated messages', () => {
    it('timeLabel reflects most recent activity across group', async () => {
      await addConversation(seedConversation({
        id: 'conv-old',
        createdAt: 1000,
        timeLabel: 'Alt',
      }))
      await addConversation(seedConversation({
        id: 'conv-new',
        createdAt: 2000,
        timeLabel: 'Auch alt',
      }))

      // Send a message with a known timestamp
      await sendMessageToThread('conv-new', 'Aktualisiert')

      const requests = getIncomingProjectRequests()
      const pairReq = requests.find((r) => r.threadId === 'conv-new')
      expect(pairReq).toBeDefined()
      // timeLabel should NOT be the stale 'Auch alt' but derived from the message
      expect(pairReq!.timeLabel).not.toBe('Auch alt')
      expect(pairReq!.timeLabel).not.toBe('Alt')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 12. PROJECT SEND VISIBILITY UNDER HISTORICAL DUPLICATES
  // ═══════════════════════════════════════════════════════════════════════════

  describe('project send visible in consolidated thread', () => {
    it('project sent via old duplicate visible in canonical thread artifacts', async () => {
      await addConversation(seedConversation({ id: 'conv-old', createdAt: 1000 }))
      await addConversation(seedConversation({ id: 'conv-new', createdAt: 2000 }))
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))

      await sendProjectAttachmentToThread('conv-old', PROJECT_A)

      // Should be visible in canonical thread
      const artifacts = getThreadArtifacts('conv-new')
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.projectArtifacts[0].snapshot?.title).toBe('Küche')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 13. ACTIVE PROJECT STATE UNDER HISTORICAL DUPLICATES
  // ═══════════════════════════════════════════════════════════════════════════

  describe('active project state correct under duplicates', () => {
    it('sourceProjectId set on canonical via old duplicate write', async () => {
      await addConversation(seedConversation({ id: 'conv-old', createdAt: 1000 }))
      await addConversation(seedConversation({ id: 'conv-new', createdAt: 2000 }))
      await addProject(seedProject({ id: PROJECT_A }))

      // Send project via old ID — should write sourceProjectId to canonical
      await sendProjectAttachmentToThread('conv-old', PROJECT_A)

      const canonical = getConversationById('conv-new')!
      expect(canonical.sourceProjectId).toBe(PROJECT_A)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 14. NO REGRESSION — MULTI-SEND PROJECT HISTORY
  // ═══════════════════════════════════════════════════════════════════════════

  describe('no regression to multi-send project history', () => {
    it('multiple projects coexist in canonical thread', async () => {
      await addConversation(seedConversation({ id: 'conv-master', createdAt: 2000 }))
      await addProject(seedProject({ id: PROJECT_A, title: 'Küche' }))
      await addProject(seedProject({ id: PROJECT_B, title: 'Bad' }))

      await sendProjectAttachmentToThread('conv-master', PROJECT_A)
      await sendProjectAttachmentToThread('conv-master', PROJECT_B)

      const artifacts = getThreadArtifacts('conv-master')
      expect(artifacts.projectArtifacts).toHaveLength(2)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 15. NO REGRESSION — RELOAD/RE-ENTRY STABILITY
  // ═══════════════════════════════════════════════════════════════════════════

  describe('reload/re-entry stability', () => {
    it('thread artifacts stable across multiple reads', async () => {
      await addConversation(seedConversation({ id: 'conv-master', createdAt: 2000 }))
      await addProject(seedProject({ id: PROJECT_A }))
      await sendProjectAttachmentToThread('conv-master', PROJECT_A)

      const first = getThreadArtifacts('conv-master')
      const second = getThreadArtifacts('conv-master')

      expect(first.projectArtifacts).toHaveLength(1)
      expect(second.projectArtifacts).toHaveLength(1)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 16. NO REGRESSION — PARTICIPANT SCOPING
  // ═══════════════════════════════════════════════════════════════════════════

  describe('participant scoping', () => {
    it('different customers with same craftsman show separate threads', async () => {
      await addConversation(seedConversation({
        id: 'conv-cust-a',
        customerUserId: 'customer-a',
        customerName: 'Kunde A',
        createdAt: 1000,
      }))
      await addConversation(seedConversation({
        id: 'conv-cust-b',
        customerUserId: 'customer-b',
        customerName: 'Kunde B',
        createdAt: 2000,
      }))

      const threads = getMessageThreads()
      expect(threads).toHaveLength(2)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 17. SUBSCRIPTION REFRESH AFTER WRITES
  // ═══════════════════════════════════════════════════════════════════════════

  describe('subscription refresh correctness', () => {
    it('subscription fires after message send to historical duplicate', async () => {
      await addConversation(seedConversation({ id: 'conv-old', createdAt: 1000 }))
      await addConversation(seedConversation({ id: 'conv-new', createdAt: 2000 }))

      let notifyCount = 0
      const unsub = subscribeMessages(() => {
        notifyCount++
      })

      await sendMessageToThread('conv-old', 'Test')
      expect(notifyCount).toBeGreaterThan(0)

      unsub()
    })
  })
})
