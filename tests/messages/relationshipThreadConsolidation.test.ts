import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryMessageRepository } from '../../src/lib/messages/repository/InMemoryMessageRepository'
import {
  getMessageThreads,
  getMessageThreadById,
  resolveCanonicalThreadId,
  getIncomingProjectRequests,
  getThreadArtifacts,
  sendMessageToThread,
  sendProjectAttachmentToThread,
} from '../../src/lib/messages'
import {
  getPairKey,
  getRelationshipGroup,
} from '../../src/lib/messages/participantScope'
import { setMessageRepository } from '../../src/lib/messages/repository/registry'
import {
  setThreadArtifactRepository,
} from '../../src/lib/messages/repository/threadArtifactRegistry'
import { InMemoryThreadArtifactRepository } from '../../src/lib/messages/repository/InMemoryThreadArtifactRepository'
import { persistProjectArtifact } from '../../src/lib/messages/threadArtifactService'
import { addProject } from '../../src/lib/projects'
import type { Conversation, Message } from '../../src/lib/messages/types'
import type { Project } from '../../src/lib/projects/types'

// ── Helpers ────────────────────────────────────────────────────────────────

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: overrides.id ?? 'conv-1',
    projectId: overrides.projectId ?? 'proj-1',
    customerName: overrides.customerName ?? 'Test Customer',
    customerAvatarUrl: overrides.customerAvatarUrl ?? 'https://example.com/customer.jpg',
    craftsmanName: overrides.craftsmanName ?? 'Test Craftsman',
    craftsmanHandle: overrides.craftsmanHandle ?? '@testcraftsman',
    craftsmanAvatarUrl: overrides.craftsmanAvatarUrl ?? 'https://example.com/craftsman.jpg',
    projectTitle: overrides.projectTitle ?? 'Test Project',
    projectSubtitle: overrides.projectSubtitle ?? 'Project Subtitle',
    createdAt: overrides.createdAt ?? Date.now(),
    ...overrides,
  }
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: overrides.id ?? `m_${Date.now()}_test`,
    conversationId: overrides.conversationId ?? 'conv-1',
    sender: overrides.sender ?? 'user',
    text: overrides.text ?? 'Hello',
    createdAtLabel: overrides.createdAtLabel ?? '12:00',
    sentAt: overrides.sentAt ?? Date.now(),
    ...overrides,
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? 'proj-test-1',
    title: overrides.title ?? 'Test Project',
    status: overrides.status ?? 'request',
    createdAt: overrides.createdAt ?? Date.now(),
    ...overrides,
  } as Project
}

// ── Test Suite ─────────────────────────────────────────────────────────────

describe('Relationship Thread Consolidation', () => {
  let repo: InMemoryMessageRepository
  let artifactRepo: InMemoryThreadArtifactRepository

  beforeEach(() => {
    repo = new InMemoryMessageRepository([], [])
    setMessageRepository(repo)
    artifactRepo = new InMemoryThreadArtifactRepository()
    setThreadArtifactRepository(artifactRepo)
  })

  // ── FIX 1: Relationship Grouping ──────────────────────────────────────

  describe('FIX 1: Relationship thread grouping model', () => {
    it('getPairKey returns null without customerUserId', () => {
      const conv = makeConversation({ customerUserId: undefined })
      expect(getPairKey(conv)).toBeNull()
    })

    it('getPairKey returns consistent key for same pair', () => {
      const conv1 = makeConversation({ customerUserId: 'cust-1', craftsmanHandle: '@hans' })
      const conv2 = makeConversation({ customerUserId: 'cust-1', craftsmanHandle: '@hans', id: 'conv-2' })
      expect(getPairKey(conv1)).toBe(getPairKey(conv2))
    })

    it('getPairKey returns different keys for different pairs', () => {
      const conv1 = makeConversation({ customerUserId: 'cust-1', craftsmanHandle: '@hans' })
      const conv2 = makeConversation({ customerUserId: 'cust-2', craftsmanHandle: '@hans' })
      expect(getPairKey(conv1)).not.toBe(getPairKey(conv2))
    })

    it('getRelationshipGroup returns all IDs for same pair', () => {
      const conv1 = makeConversation({ id: 'conv-old', customerUserId: 'cust-1', craftsmanHandle: '@hans', createdAt: 1000 })
      const conv2 = makeConversation({ id: 'conv-new', customerUserId: 'cust-1', craftsmanHandle: '@hans', createdAt: 2000 })
      const conv3 = makeConversation({ id: 'conv-other', customerUserId: 'cust-2', craftsmanHandle: '@hans', createdAt: 1500 })

      const group = getRelationshipGroup(conv1, [conv1, conv2, conv3])
      expect(group).toContain('conv-old')
      expect(group).toContain('conv-new')
      expect(group).not.toContain('conv-other')
      expect(group).toHaveLength(2)
    })

    it('getRelationshipGroup returns [id] for ungroupable conversation', () => {
      const conv = makeConversation({ id: 'conv-no-cust', customerUserId: undefined })
      const group = getRelationshipGroup(conv, [conv])
      expect(group).toEqual(['conv-no-cust'])
    })
  })

  // ── FIX 2: One Visible Inbox Entry Per Relationship ───────────────────

  describe('FIX 2: One visible inbox entry per relationship', () => {
    it('multiple raw conversation rows for same pair produce one inbox entry', () => {
      const conv1 = makeConversation({
        id: 'conv-dup-1',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 1000,
      })
      const conv2 = makeConversation({
        id: 'conv-dup-2',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 2000,
      })
      repo.addConversation(conv1)
      repo.addConversation(conv2)

      const threads = getMessageThreads()
      expect(threads).toHaveLength(1)
      expect(threads[0].id).toBe('conv-dup-2') // canonical = most recent
    })

    it('different pairs still produce separate inbox entries', () => {
      const conv1 = makeConversation({
        id: 'conv-pair1',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 1000,
      })
      const conv2 = makeConversation({
        id: 'conv-pair2',
        customerUserId: 'cust-2',
        craftsmanHandle: '@hans',
        createdAt: 2000,
      })
      repo.addConversation(conv1)
      repo.addConversation(conv2)

      const threads = getMessageThreads()
      expect(threads).toHaveLength(2)
    })
  })

  // ── FIX 3: Consolidated Thread History ────────────────────────────────

  describe('FIX 3: Consolidated thread history', () => {
    it('thread history includes messages from duplicate conversations', () => {
      const conv1 = makeConversation({
        id: 'conv-old',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 1000,
      })
      const conv2 = makeConversation({
        id: 'conv-new',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 2000,
      })
      const msg1 = makeMessage({ id: 'msg-old-1', conversationId: 'conv-old', text: 'Old message', sentAt: 1000 })
      const msg2 = makeMessage({ id: 'msg-new-1', conversationId: 'conv-new', text: 'New message', sentAt: 2000 })

      repo = new InMemoryMessageRepository([conv1, conv2], [msg1, msg2])
      setMessageRepository(repo)

      // Build thread from canonical conversation
      const thread = getMessageThreadById('conv-new')
      expect(thread).toBeDefined()
      expect(thread!.messages).toHaveLength(2)
      expect(thread!.messages[0].text).toBe('Old message')
      expect(thread!.messages[1].text).toBe('New message')
    })

    it('messages are sorted chronologically across duplicate conversations', () => {
      const conv1 = makeConversation({
        id: 'conv-a',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 1000,
      })
      const conv2 = makeConversation({
        id: 'conv-b',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 2000,
      })
      const msg1 = makeMessage({ id: 'msg-1', conversationId: 'conv-a', text: 'First', sentAt: 100 })
      const msg2 = makeMessage({ id: 'msg-2', conversationId: 'conv-b', text: 'Second', sentAt: 200 })
      const msg3 = makeMessage({ id: 'msg-3', conversationId: 'conv-a', text: 'Third', sentAt: 300 })

      repo = new InMemoryMessageRepository([conv1, conv2], [msg1, msg2, msg3])
      setMessageRepository(repo)

      const thread = getMessageThreadById('conv-b')
      expect(thread!.messages).toHaveLength(3)
      expect(thread!.messages[0].text).toBe('First')
      expect(thread!.messages[1].text).toBe('Second')
      expect(thread!.messages[2].text).toBe('Third')
    })

    it('consolidated preview reflects latest message across all duplicates', () => {
      const conv1 = makeConversation({
        id: 'conv-1',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 1000,
        timeLabel: '10:00',
      })
      const conv2 = makeConversation({
        id: 'conv-2',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 2000,
        timeLabel: '11:00',
      })
      // Newest message is on the OLD conversation
      const msg1 = makeMessage({ id: 'msg-latest', conversationId: 'conv-1', text: 'I am the latest', sentAt: 5000 })
      const msg2 = makeMessage({ id: 'msg-old', conversationId: 'conv-2', text: 'I am old', sentAt: 1000 })

      repo = new InMemoryMessageRepository([conv1, conv2], [msg1, msg2])
      setMessageRepository(repo)

      const thread = getMessageThreadById('conv-2')
      expect(thread!.lastMessagePreview).toBe('I am the latest')
    })

    it('consolidated unread count sums across all duplicates', () => {
      const conv1 = makeConversation({
        id: 'conv-dup-a',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 1000,
        unreadCount: 3,
      })
      const conv2 = makeConversation({
        id: 'conv-dup-b',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 2000,
        unreadCount: 2,
      })

      repo = new InMemoryMessageRepository([conv1, conv2], [])
      setMessageRepository(repo)

      const thread = getMessageThreadById('conv-dup-b')
      expect(thread!.unreadCount).toBe(5)
    })
  })

  // ── FIX 4: Canonical Master Write Target ──────────────────────────────

  describe('FIX 4: Canonical master write target', () => {
    it('new direct message goes to canonical master', async () => {
      const conv1 = makeConversation({
        id: 'conv-old-wr',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 1000,
      })
      const conv2 = makeConversation({
        id: 'conv-new-wr',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 2000,
      })
      repo = new InMemoryMessageRepository([conv1, conv2], [])
      setMessageRepository(repo)

      // Send message targeting the OLD (non-canonical) conversation
      await sendMessageToThread('conv-old-wr', 'Hello from old')

      // Message should have landed on the canonical conversation
      const messagesOnCanonical = repo.getMessagesByConversationId('conv-new-wr')
      expect(messagesOnCanonical).toHaveLength(1)
      expect(messagesOnCanonical[0].text).toBe('Hello from old')

      // Nothing on the old conversation
      const messagesOnOld = repo.getMessagesByConversationId('conv-old-wr')
      expect(messagesOnOld).toHaveLength(0)
    })

    it('new direct message appears in visible consolidated thread', async () => {
      const conv1 = makeConversation({
        id: 'conv-vis-old',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 1000,
      })
      const conv2 = makeConversation({
        id: 'conv-vis-new',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 2000,
      })
      const oldMsg = makeMessage({ id: 'msg-vis-old', conversationId: 'conv-vis-old', text: 'Old history', sentAt: 500 })
      repo = new InMemoryMessageRepository([conv1, conv2], [oldMsg])
      setMessageRepository(repo)

      await sendMessageToThread('conv-vis-new', 'New message')

      const thread = getMessageThreadById('conv-vis-new')
      expect(thread!.messages).toHaveLength(2)
      expect(thread!.messages[0].text).toBe('Old history')
      expect(thread!.messages[1].text).toBe('New message')
    })

    it('new project send goes to canonical master', async () => {
      const conv1 = makeConversation({
        id: 'conv-proj-old',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 1000,
      })
      const conv2 = makeConversation({
        id: 'conv-proj-new',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 2000,
      })
      repo = new InMemoryMessageRepository([conv1, conv2], [])
      setMessageRepository(repo)

      const project = makeProject({ id: 'proj-send-1', title: 'My Project' })
      await addProject(project)

      // Send project targeting old conversation
      await sendProjectAttachmentToThread('conv-proj-old', 'proj-send-1')

      // Project message should be on canonical
      const messagesOnCanonical = repo.getMessagesByConversationId('conv-proj-new')
      expect(messagesOnCanonical).toHaveLength(1)
      expect(messagesOnCanonical[0].attachmentType).toBe('project')
    })
  })

  // ── FIX 5: Old Duplicate Entry Redirect / Resolution ──────────────────

  describe('FIX 5: Old duplicate thread resolves to canonical', () => {
    it('opening old duplicate thread via getMessageThreadById returns canonical thread', () => {
      const conv1 = makeConversation({
        id: 'conv-resolve-old',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 1000,
      })
      const conv2 = makeConversation({
        id: 'conv-resolve-new',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 2000,
      })
      const msg1 = makeMessage({ id: 'msg-r-1', conversationId: 'conv-resolve-old', text: 'Old msg', sentAt: 500 })
      const msg2 = makeMessage({ id: 'msg-r-2', conversationId: 'conv-resolve-new', text: 'New msg', sentAt: 1500 })

      repo = new InMemoryMessageRepository([conv1, conv2], [msg1, msg2])
      setMessageRepository(repo)

      // Open old duplicate thread
      const thread = getMessageThreadById('conv-resolve-old')
      expect(thread).toBeDefined()
      expect(thread!.id).toBe('conv-resolve-new') // resolved to canonical
      expect(thread!.messages).toHaveLength(2) // consolidated history
    })

    it('resolveCanonicalThreadId resolves non-canonical to canonical', () => {
      const conv1 = makeConversation({
        id: 'conv-ctl-old',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 1000,
      })
      const conv2 = makeConversation({
        id: 'conv-ctl-new',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 2000,
      })
      repo = new InMemoryMessageRepository([conv1, conv2], [])
      setMessageRepository(repo)

      expect(resolveCanonicalThreadId('conv-ctl-old')).toBe('conv-ctl-new')
      expect(resolveCanonicalThreadId('conv-ctl-new')).toBe('conv-ctl-new')
    })
  })

  // ── FIX 6: No Regression to Project History / Active Project ──────────

  describe('FIX 6: No regression to project history / active project', () => {
    it('multi-send project history visible in consolidated thread', async () => {
      const conv = makeConversation({
        id: 'conv-multi-proj',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 2000,
      })
      repo = new InMemoryMessageRepository([conv], [])
      setMessageRepository(repo)

      const proj1 = makeProject({ id: 'proj-ms-1', title: 'Project Alpha' })
      const proj2 = makeProject({ id: 'proj-ms-2', title: 'Project Beta' })
      await addProject(proj1)
      await addProject(proj2)

      await sendProjectAttachmentToThread('conv-multi-proj', 'proj-ms-1')
      await sendProjectAttachmentToThread('conv-multi-proj', 'proj-ms-2')

      const artifacts = getThreadArtifacts('conv-multi-proj')
      expect(artifacts.projectArtifacts).toHaveLength(2)
    })

    it('active project logic preserved after consolidation', async () => {
      const conv = makeConversation({
        id: 'conv-active-proj',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 2000,
      })
      repo = new InMemoryMessageRepository([conv], [])
      setMessageRepository(repo)

      const proj = makeProject({ id: 'proj-active-1', title: 'Active Project' })
      await addProject(proj)

      await sendProjectAttachmentToThread('conv-active-proj', 'proj-active-1')

      const artifacts = getThreadArtifacts('conv-active-proj')
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.isActiveProject).toBe(true)
    })

    it('project artifacts from duplicate conversations visible in consolidated thread', async () => {
      const conv1 = makeConversation({
        id: 'conv-art-old',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 1000,
      })
      const conv2 = makeConversation({
        id: 'conv-art-new',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        createdAt: 2000,
      })
      repo = new InMemoryMessageRepository([conv1, conv2], [])
      setMessageRepository(repo)

      const proj = makeProject({ id: 'proj-dup-art', title: 'Dup Art Project' })
      await addProject(proj)

      // Persist artifact on the OLD (non-canonical) conversation
      await persistProjectArtifact({
        conversationId: 'conv-art-old',
        projectId: 'proj-dup-art',
        snapshotTitle: 'Dup Art Project',
        snapshotStatus: 'request',
      })

      // Ask for artifacts from the canonical conversation
      const artifacts = getThreadArtifacts('conv-art-new')
      expect(artifacts.projectArtifacts).toHaveLength(1)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.snapshot!.title).toBe('Dup Art Project')
    })
  })

  // ── Reload / re-entry stability ───────────────────────────────────────

  describe('Reload / re-entry stability', () => {
    it('thread context remains valid after simulated reload with duplicates', () => {
      const conv1 = makeConversation({
        id: 'conv-reload-1',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        customerName: 'Maria Müller',
        craftsmanName: 'Klaus Schmidt',
        projectTitle: 'Küche Modernisierung',
        createdAt: 1000,
      })
      const conv2 = makeConversation({
        id: 'conv-reload-2',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        customerName: 'Maria Müller',
        craftsmanName: 'Klaus Schmidt',
        projectTitle: 'Küche Modernisierung',
        createdAt: 2000,
      })
      const msg = makeMessage({
        id: 'msg-reload',
        conversationId: 'conv-reload-1',
        text: 'Hallo, ich habe eine Frage',
        sentAt: 500,
      })

      const reloadedRepo = new InMemoryMessageRepository([conv1, conv2], [msg])
      setMessageRepository(reloadedRepo)

      const thread = getMessageThreadById('conv-reload-2')
      expect(thread).toBeDefined()
      expect(thread!.customerName).toBe('Maria Müller')
      expect(thread!.messages).toHaveLength(1)
      expect(thread!.messages[0].text).toBe('Hallo, ich habe eine Frage')
    })
  })

  // ── Participant scoping ───────────────────────────────────────────────

  describe('Participant scoping preserved', () => {
    it('conversations without customerUserId are not grouped', () => {
      const conv1 = makeConversation({
        id: 'conv-no-cust-1',
        craftsmanHandle: '@hans',
        // no customerUserId
        createdAt: 1000,
      })
      const conv2 = makeConversation({
        id: 'conv-no-cust-2',
        craftsmanHandle: '@hans',
        // no customerUserId
        createdAt: 2000,
      })
      const msg1 = makeMessage({ id: 'msg-nc-1', conversationId: 'conv-no-cust-1', text: 'A', sentAt: 100 })
      const msg2 = makeMessage({ id: 'msg-nc-2', conversationId: 'conv-no-cust-2', text: 'B', sentAt: 200 })

      repo = new InMemoryMessageRepository([conv1, conv2], [msg1, msg2])
      setMessageRepository(repo)

      // Without customerUserId, dedup does not merge them
      const threads = getMessageThreads()
      expect(threads).toHaveLength(2)

      // Each thread only sees its own messages (no grouping)
      const thread1 = getMessageThreadById('conv-no-cust-1')
      expect(thread1!.messages).toHaveLength(1)
      expect(thread1!.messages[0].text).toBe('A')
    })
  })

  // ── Incoming request consolidation ────────────────────────────────────

  describe('Incoming request inbox consolidation', () => {
    it('consolidated request inbox shows one entry per relationship', () => {
      const conv1 = makeConversation({
        id: 'conv-req-1',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        craftsmanUserId: 'craft-1',
        inquiryOrigin: 'reel',
        createdAt: 1000,
        unreadCount: 1,
      })
      const conv2 = makeConversation({
        id: 'conv-req-2',
        customerUserId: 'cust-1',
        craftsmanHandle: '@hans',
        craftsmanUserId: 'craft-1',
        inquiryOrigin: 'reel',
        createdAt: 2000,
        unreadCount: 2,
      })
      const msg = makeMessage({
        id: 'msg-req-1',
        conversationId: 'conv-req-1',
        sender: 'user',
        text: 'Old inquiry message',
        sentAt: 500,
      })

      repo = new InMemoryMessageRepository([conv1, conv2], [msg])
      setMessageRepository(repo)

      const requests = getIncomingProjectRequests()
      expect(requests).toHaveLength(1)
      // Consolidated unread count
      expect(requests[0].unreadCount).toBe(3)
      // Preview from consolidated messages
      expect(requests[0].lastMessagePreview).toBe('Old inquiry message')
    })
  })
})
