import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryMessageRepository } from '../../src/lib/messages/repository/InMemoryMessageRepository'
import { formatMessageTimeLabel } from '../../src/lib/messages/service'
import type { Conversation, Message } from '../../src/lib/messages/types'

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: overrides.id ?? 'conv-1',
    projectId: overrides.projectId ?? 'proj-1',
    customerName: overrides.customerName ?? 'Test Customer',
    customerAvatarUrl: overrides.customerAvatarUrl ?? '',
    craftsmanName: overrides.craftsmanName ?? 'Test Craftsman',
    craftsmanHandle: overrides.craftsmanHandle ?? '@test',
    craftsmanAvatarUrl: overrides.craftsmanAvatarUrl ?? '',
    projectTitle: overrides.projectTitle ?? 'Test Project',
    projectSubtitle: overrides.projectSubtitle ?? '',
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

describe('InMemoryMessageRepository', () => {
  let repo: InMemoryMessageRepository

  beforeEach(() => {
    repo = new InMemoryMessageRepository([], [])
  })

  it('starts empty', () => {
    expect(repo.getConversations()).toHaveLength(0)
    expect(repo.getMessages()).toHaveLength(0)
  })

  it('addConversation stores the conversation', () => {
    const conv = makeConversation({ id: 'conv-1' })
    repo.addConversation(conv)
    expect(repo.getConversations()).toHaveLength(1)
    expect(repo.getConversationById('conv-1')).toEqual(conv)
  })

  it('getConversationByProjectId returns the correct conversation', () => {
    const conv = makeConversation({ id: 'conv-1', projectId: 'proj-42' })
    repo.addConversation(conv)
    expect(repo.getConversationByProjectId('proj-42')).toEqual(conv)
    expect(repo.getConversationByProjectId('proj-99')).toBeUndefined()
  })

  it('addMessageAndUpdateConversation persists the message', async () => {
    const conv = makeConversation({ id: 'conv-1' })
    repo.addConversation(conv)
    const msg = makeMessage({ id: 'msg-1', conversationId: 'conv-1', text: 'Hi' })
    await repo.addMessageAndUpdateConversation(msg, 'conv-1', { timeLabel: '12:00', unreadCount: 0 })

    const messages = repo.getMessagesByConversationId('conv-1')
    expect(messages).toHaveLength(1)
    expect(messages[0].text).toBe('Hi')
  })

  it('addMessageAndUpdateConversation patches the conversation', async () => {
    const conv = makeConversation({ id: 'conv-1', timeLabel: 'Gestern', unreadCount: 3 })
    repo.addConversation(conv)
    const msg = makeMessage({ id: 'msg-2', conversationId: 'conv-1' })
    await repo.addMessageAndUpdateConversation(msg, 'conv-1', { timeLabel: '14:30', unreadCount: 0 })

    const updated = repo.getConversationById('conv-1')
    expect(updated?.timeLabel).toBe('14:30')
    expect(updated?.unreadCount).toBe(0)
  })

  it('getMessages returns all messages across conversations', async () => {
    const conv1 = makeConversation({ id: 'conv-1' })
    const conv2 = makeConversation({ id: 'conv-2', projectId: 'proj-2' })
    repo.addConversation(conv1)
    repo.addConversation(conv2)

    await repo.addMessageAndUpdateConversation(
      makeMessage({ id: 'msg-a', conversationId: 'conv-1' }),
      'conv-1',
      {}
    )
    await repo.addMessageAndUpdateConversation(
      makeMessage({ id: 'msg-b', conversationId: 'conv-2' }),
      'conv-2',
      {}
    )

    expect(repo.getMessages()).toHaveLength(2)
  })

  it('getMessagesByConversationId scopes messages correctly', async () => {
    const conv1 = makeConversation({ id: 'conv-1' })
    const conv2 = makeConversation({ id: 'conv-2', projectId: 'proj-2' })
    repo.addConversation(conv1)
    repo.addConversation(conv2)

    await repo.addMessageAndUpdateConversation(
      makeMessage({ id: 'msg-x', conversationId: 'conv-1', text: 'to conv 1' }),
      'conv-1',
      {}
    )
    await repo.addMessageAndUpdateConversation(
      makeMessage({ id: 'msg-y', conversationId: 'conv-2', text: 'to conv 2' }),
      'conv-2',
      {}
    )

    const msgs1 = repo.getMessagesByConversationId('conv-1')
    expect(msgs1).toHaveLength(1)
    expect(msgs1[0].text).toBe('to conv 1')

    const msgs2 = repo.getMessagesByConversationId('conv-2')
    expect(msgs2).toHaveLength(1)
    expect(msgs2[0].text).toBe('to conv 2')
  })

  it('preserves insertion order (chronological) within a conversation', async () => {
    const conv = makeConversation({ id: 'conv-order' })
    repo.addConversation(conv)

    const base = Date.now()
    for (let i = 0; i < 5; i++) {
      await repo.addMessageAndUpdateConversation(
        makeMessage({ id: `msg-${i}`, conversationId: 'conv-order', sentAt: base + i * 1000, text: `msg ${i}` }),
        'conv-order',
        {}
      )
    }

    const messages = repo.getMessagesByConversationId('conv-order')
    expect(messages).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      expect(messages[i].text).toBe(`msg ${i}`)
    }
  })

  it('does not duplicate messages on repeated calls with distinct IDs', async () => {
    const conv = makeConversation({ id: 'conv-dedup' })
    repo.addConversation(conv)

    await repo.addMessageAndUpdateConversation(
      makeMessage({ id: 'dedup-1', conversationId: 'conv-dedup', text: 'first' }),
      'conv-dedup',
      {}
    )
    await repo.addMessageAndUpdateConversation(
      makeMessage({ id: 'dedup-2', conversationId: 'conv-dedup', text: 'second' }),
      'conv-dedup',
      {}
    )

    expect(repo.getMessagesByConversationId('conv-dedup')).toHaveLength(2)
  })

  it('deduplicates messages with the same ID', async () => {
    const conv = makeConversation({ id: 'conv-dedup-id' })
    repo.addConversation(conv)
    const msg = makeMessage({ id: 'same-id', conversationId: 'conv-dedup-id', text: 'hello' })

    await repo.addMessageAndUpdateConversation(msg, 'conv-dedup-id', {})
    // Second call with the same message ID must be silently ignored
    await repo.addMessageAndUpdateConversation(msg, 'conv-dedup-id', {})

    expect(repo.getMessagesByConversationId('conv-dedup-id')).toHaveLength(1)
  })

  it('notifies subscribers when a message is added', async () => {
    const conv = makeConversation({ id: 'conv-sub' })
    repo.addConversation(conv)
    let notified = 0
    repo.subscribe(() => { notified++ })

    await repo.addMessageAndUpdateConversation(
      makeMessage({ id: 'msg-sub-1', conversationId: 'conv-sub' }),
      'conv-sub',
      {}
    )
    expect(notified).toBe(1)
  })

  it('allows unsubscribing from notifications', async () => {
    const conv = makeConversation({ id: 'conv-unsub' })
    repo.addConversation(conv)
    let notified = 0
    const unsubscribe = repo.subscribe(() => { notified++ })
    unsubscribe()

    await repo.addMessageAndUpdateConversation(
      makeMessage({ id: 'msg-unsub-1', conversationId: 'conv-unsub' }),
      'conv-unsub',
      {}
    )
    expect(notified).toBe(0)
  })

  it('updateConversation patches only the specified fields', () => {
    const conv = makeConversation({ id: 'conv-patch', timeLabel: 'Mo', unreadCount: 2 })
    repo.addConversation(conv)

    repo.updateConversation('conv-patch', { unreadCount: 0 })

    const updated = repo.getConversationById('conv-patch')
    expect(updated?.unreadCount).toBe(0)
    expect(updated?.timeLabel).toBe('Mo')
  })

  // ---------------------------------------------------------------------------
  // Authorization: sending to a conversation the user is not part of
  // ---------------------------------------------------------------------------

  it('rejects send to an unknown conversation', async () => {
    const msg = makeMessage({ id: 'injected', conversationId: 'nonexistent-conv' })
    await expect(
      repo.addMessageAndUpdateConversation(msg, 'nonexistent-conv', {})
    ).rejects.toThrow('not accessible')
  })

  it('rejects send even when a different conversation exists', async () => {
    const conv = makeConversation({ id: 'conv-real' })
    repo.addConversation(conv)

    const msg = makeMessage({ id: 'injected-2', conversationId: 'other-conv' })
    await expect(
      repo.addMessageAndUpdateConversation(msg, 'other-conv', {})
    ).rejects.toThrow('not accessible')

    // The real conversation must be untouched
    expect(repo.getMessagesByConversationId('conv-real')).toHaveLength(0)
  })

  // ---------------------------------------------------------------------------
  // Reload persistence: messages pre-loaded at construction survive reads
  // ---------------------------------------------------------------------------

  it('messages loaded at construction are returned after reload', () => {
    const conv = makeConversation({ id: 'conv-reload' })
    const msg = makeMessage({ id: 'msg-reload', conversationId: 'conv-reload', text: 'persisted' })
    const preloaded = new InMemoryMessageRepository([conv], [msg])

    // Simulate "reload": read from the repo that was seeded at startup
    const messages = preloaded.getMessagesByConversationId('conv-reload')
    expect(messages).toHaveLength(1)
    expect(messages[0].text).toBe('persisted')
  })

  it('messages from multiple conversations are stable across getMessages calls', () => {
    const conv1 = makeConversation({ id: 'conv-stable-1' })
    const conv2 = makeConversation({ id: 'conv-stable-2', projectId: 'proj-s2' })
    const msgs = [
      makeMessage({ id: 'msg-s1', conversationId: 'conv-stable-1', sentAt: 1000 }),
      makeMessage({ id: 'msg-s2', conversationId: 'conv-stable-2', sentAt: 2000 }),
    ]
    const stableRepo = new InMemoryMessageRepository([conv1, conv2], msgs)

    expect(stableRepo.getMessages()).toHaveLength(2)
    expect(stableRepo.getMessagesByConversationId('conv-stable-1')).toHaveLength(1)
    expect(stableRepo.getMessagesByConversationId('conv-stable-2')).toHaveLength(1)
  })
})

describe('formatMessageTimeLabel', () => {
  it('formats a timestamp from today as HH:MM', () => {
    const now = new Date()
    const ts = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 30).getTime()
    expect(formatMessageTimeLabel(ts)).toBe('14:30')
  })

  it('pads hours and minutes with leading zeros', () => {
    const now = new Date()
    const ts = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 5).getTime()
    expect(formatMessageTimeLabel(ts)).toBe('09:05')
  })

  it('formats a timestamp from yesterday as "Gestern"', () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const ts = new Date(
      yesterday.getFullYear(),
      yesterday.getMonth(),
      yesterday.getDate(),
      10,
      0,
    ).getTime()
    expect(formatMessageTimeLabel(ts)).toBe('Gestern')
  })

  it('formats a timestamp within the last 6 days as a weekday abbreviation', () => {
    const dayNames = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const
    const threeDaysAgo = new Date()
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3)
    const ts = new Date(
      threeDaysAgo.getFullYear(),
      threeDaysAgo.getMonth(),
      threeDaysAgo.getDate(),
      8,
      0,
    ).getTime()
    const expected = dayNames[threeDaysAgo.getDay()]
    expect(formatMessageTimeLabel(ts)).toBe(expected)
  })

  it('formats a timestamp older than 6 days as DD.MM.', () => {
    const old = new Date()
    old.setDate(old.getDate() - 10)
    const ts = new Date(old.getFullYear(), old.getMonth(), old.getDate(), 12, 0).getTime()
    const dd = String(old.getDate()).padStart(2, '0')
    const mo = String(old.getMonth() + 1).padStart(2, '0')
    expect(formatMessageTimeLabel(ts)).toBe(`${dd}.${mo}.`)
  })
})
