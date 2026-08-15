import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryMessageRepository } from '../../src/lib/messages/repository/InMemoryMessageRepository'
import { getMessageThreadById, getThreadHeader, getThreadListRow } from '../../src/lib/messages/selectors'
import { setMessageRepository } from '../../src/lib/messages/repository/registry'
import type { Conversation, Message } from '../../src/lib/messages/types'

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

describe('Message Identity and Metadata - Fallback Handling', () => {
  let repo: InMemoryMessageRepository

  beforeEach(() => {
    repo = new InMemoryMessageRepository([], [])
    setMessageRepository(repo)
  })

  describe('Thread Header Fallbacks', () => {
    it('provides safe fallback when craftsman name is missing (customer view)', () => {
      const conv = makeConversation({
        id: 'conv-no-craftsman',
        craftsmanName: '',
        projectTitle: 'My Project',
      })
      repo.addConversation(conv)

      const thread = getMessageThreadById('conv-no-craftsman')
      expect(thread).toBeDefined()

      const header = getThreadHeader(thread!, 'customer')
      expect(header.primaryName).toBe('Handwerker') // fallback
      expect(header.secondaryLine).toBe('My Project')
    })

    it('provides safe fallback when customer name is missing (craftsman view)', () => {
      const conv = makeConversation({
        id: 'conv-no-customer',
        customerName: '',
        projectTitle: 'Customer Project',
      })
      repo.addConversation(conv)

      const thread = getMessageThreadById('conv-no-customer')
      expect(thread).toBeDefined()

      const header = getThreadHeader(thread!, 'craftsman')
      expect(header.primaryName).toBe('Kunde') // fallback
      expect(header.secondaryLine).toBe('Customer Project')
    })

    it('provides safe fallback when project title is missing', () => {
      const conv = makeConversation({
        id: 'conv-no-title',
        projectTitle: '',
        craftsmanName: 'Hans Meier',
      })
      repo.addConversation(conv)

      const thread = getMessageThreadById('conv-no-title')
      expect(thread).toBeDefined()

      const header = getThreadHeader(thread!, 'customer')
      expect(header.primaryName).toBe('Hans Meier')
      expect(header.secondaryLine).toBe('Projekt') // fallback
    })

    it('includes craftsmanUserId in customer view when available', () => {
      const conv = makeConversation({
        id: 'conv-with-uid',
        craftsmanName: 'Max Mustermann',
        craftsmanUserId: 'craftsman-uid-123',
      })
      repo.addConversation(conv)

      const thread = getMessageThreadById('conv-with-uid')
      const header = getThreadHeader(thread!, 'customer')

      expect(header.craftsmanUserId).toBe('craftsman-uid-123')
      expect(header.customerUserId).toBeUndefined()
    })

    it('includes customerUserId in craftsman view when available', () => {
      const conv = makeConversation({
        id: 'conv-with-customer-uid',
        customerName: 'Anna Schmidt',
        customerUserId: 'customer-uid-456',
      })
      repo.addConversation(conv)

      const thread = getMessageThreadById('conv-with-customer-uid')
      const header = getThreadHeader(thread!, 'craftsman')

      expect(header.customerUserId).toBe('customer-uid-456')
      expect(header.craftsmanUserId).toBeUndefined()
    })
  })

  describe('Thread List Row Fallbacks', () => {
    it('prevents "undefined • undefined" by using fallbacks for project context', () => {
      const conv = makeConversation({
        id: 'conv-no-project-meta',
        projectTitle: '',
        projectSubtitle: '',
      })
      repo.addConversation(conv)

      const thread = getMessageThreadById('conv-no-project-meta')
      expect(thread).toBeDefined()

      const row = getThreadListRow(thread!, 'customer')
      expect(row.secondaryLine).toBe('Projekt • Details fehlen')
      expect(row.secondaryLine).not.toContain('undefined')
    })

    it('uses safe fallback when only project title is missing', () => {
      const conv = makeConversation({
        id: 'conv-no-title-only',
        projectTitle: '',
        projectSubtitle: 'Badezimmer Renovierung',
      })
      repo.addConversation(conv)

      const thread = getMessageThreadById('conv-no-title-only')
      const row = getThreadListRow(thread!, 'customer')

      expect(row.secondaryLine).toBe('Projekt • Badezimmer Renovierung')
    })

    it('uses safe fallback when only project subtitle is missing', () => {
      const conv = makeConversation({
        id: 'conv-no-subtitle',
        projectTitle: 'Elektrik',
        projectSubtitle: '',
      })
      repo.addConversation(conv)

      const thread = getMessageThreadById('conv-no-subtitle')
      const row = getThreadListRow(thread!, 'customer')

      expect(row.secondaryLine).toBe('Elektrik • Details fehlen')
    })

    it('uses craftsman name fallback when missing (customer view)', () => {
      const conv = makeConversation({
        id: 'conv-craftsman-missing',
        craftsmanName: '',
      })
      repo.addConversation(conv)

      const thread = getMessageThreadById('conv-craftsman-missing')
      const row = getThreadListRow(thread!, 'customer')

      expect(row.primaryName).toBe('Handwerker')
    })

    it('uses customer name fallback when missing (craftsman view)', () => {
      const conv = makeConversation({
        id: 'conv-customer-missing',
        customerName: '',
      })
      repo.addConversation(conv)

      const thread = getMessageThreadById('conv-customer-missing')
      const row = getThreadListRow(thread!, 'craftsman')

      expect(row.primaryName).toBe('Kunde')
    })
  })

  describe('Reload Persistence - Context Survival', () => {
    it('thread context remains valid after simulated reload', () => {
      const conv = makeConversation({
        id: 'conv-reload',
        customerName: 'Maria Müller',
        craftsmanName: 'Klaus Schmidt',
        projectTitle: 'Küche Modernisierung',
        projectSubtitle: 'Neue Arbeitsplatten',
        projectLocation: 'Berlin',
      })
      const msg = makeMessage({
        id: 'msg-reload',
        conversationId: 'conv-reload',
        text: 'Hallo, ich habe eine Frage',
      })

      // Simulate reload: create new repo with persisted data
      const reloadedRepo = new InMemoryMessageRepository([conv], [msg])
      setMessageRepository(reloadedRepo)

      const thread = getMessageThreadById('conv-reload')
      expect(thread).toBeDefined()
      expect(thread!.customerName).toBe('Maria Müller')
      expect(thread!.craftsmanName).toBe('Klaus Schmidt')
      expect(thread!.project.title).toBe('Küche Modernisierung')
      expect(thread!.project.subtitle).toBe('Neue Arbeitsplatten')
      expect(thread!.project.location).toBe('Berlin')
      expect(thread!.messages).toHaveLength(1)
      expect(thread!.messages[0].text).toBe('Hallo, ich habe eine Frage')
    })

    it('messages persist while context identity remains intact after reload', () => {
      const conv = makeConversation({
        id: 'conv-persist',
        craftsmanName: 'Thomas Bauer',
        craftsmanUserId: 'craftsman-123',
        customerUserId: 'customer-456',
      })
      const messages = [
        makeMessage({ id: 'm1', conversationId: 'conv-persist', text: 'Message 1', sentAt: 1000 }),
        makeMessage({ id: 'm2', conversationId: 'conv-persist', text: 'Message 2', sentAt: 2000 }),
        makeMessage({ id: 'm3', conversationId: 'conv-persist', text: 'Message 3', sentAt: 3000 }),
      ]

      const reloadedRepo = new InMemoryMessageRepository([conv], messages)
      setMessageRepository(reloadedRepo)

      const thread = getMessageThreadById('conv-persist')
      expect(thread).toBeDefined()
      expect(thread!.messages).toHaveLength(3)
      expect(thread!.craftsmanName).toBe('Thomas Bauer')
      expect(thread!.craftsmanUserId).toBe('craftsman-123')
      expect(thread!.customerUserId).toBe('customer-456')

      // Verify header can be constructed correctly
      const header = getThreadHeader(thread!, 'customer')
      expect(header.primaryName).toBe('Thomas Bauer')
      expect(header.craftsmanUserId).toBe('craftsman-123')
    })

    it('empty metadata survives reload with safe fallbacks', () => {
      // Simulate worst case: DB returned empty strings (schema DEFAULT '')
      const conv = makeConversation({
        id: 'conv-empty',
        customerName: '',
        craftsmanName: '',
        projectTitle: '',
        projectSubtitle: '',
      })
      const msg = makeMessage({ id: 'm1', conversationId: 'conv-empty' })

      const reloadedRepo = new InMemoryMessageRepository([conv], [msg])
      setMessageRepository(reloadedRepo)

      const thread = getMessageThreadById('conv-empty')
      expect(thread).toBeDefined()
      expect(thread!.messages).toHaveLength(1)

      const header = getThreadHeader(thread!, 'customer')
      expect(header.primaryName).toBe('Handwerker') // fallback
      expect(header.secondaryLine).toBe('Projekt') // fallback

      const row = getThreadListRow(thread!, 'customer')
      expect(row.secondaryLine).toBe('Projekt • Details fehlen')
      expect(row.secondaryLine).not.toContain('undefined')
    })
  })

  describe('User ID Propagation', () => {
    it('includes craftsmanUserId and customerUserId in thread when available', () => {
      const conv = makeConversation({
        id: 'conv-ids',
        craftsmanUserId: 'craftsman-uid-789',
        customerUserId: 'customer-uid-101',
      })
      repo.addConversation(conv)

      const thread = getMessageThreadById('conv-ids')
      expect(thread).toBeDefined()
      expect(thread!.craftsmanUserId).toBe('craftsman-uid-789')
      expect(thread!.customerUserId).toBe('customer-uid-101')
    })

    it('thread can be built without user IDs (optional fields)', () => {
      const conv = makeConversation({
        id: 'conv-no-ids',
        // craftsmanUserId and customerUserId are omitted
      })
      repo.addConversation(conv)

      const thread = getMessageThreadById('conv-no-ids')
      expect(thread).toBeDefined()
      expect(thread!.craftsmanUserId).toBeUndefined()
      expect(thread!.customerUserId).toBeUndefined()
    })
  })
})
