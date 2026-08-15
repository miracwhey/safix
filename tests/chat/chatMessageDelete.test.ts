import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryChatRepository } from '../../src/lib/chat/repository/InMemoryChatRepository'
import {
  setChatRepository,
  resetChatRepository,
} from '../../src/lib/chat/repository/registry'
import { deleteChatMessageWorkflow } from '../../src/lib/workflow/chatWorkflow'
import type { ChatMessageViewModel, ChatThreadViewModel } from '../../src/lib/chat/types'

const SELF = 'inmemory-user' // InMemoryChatRepository.defaultUserId
const PEER = 'peer-user'

function thread(): ChatThreadViewModel {
  const now = Date.now()
  return {
    id: 't1',
    channelType: 'customer',
    customerUserId: 'cust-1',
    craftsmanUserId: 'craft-1',
    providerId: 'prov-1',
    legacyThreadId: null,
    legacySource: null,
    title: null,
    lastMessageId: null,
    lastMessageAt: null,
    lastMessageBody: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    participants: [],
    unreadCount: 0,
    migrationStatus: 'migration_complete',
  }
}

function message(
  id: string,
  sender: string,
  overrides: Partial<ChatMessageViewModel> = {},
): ChatMessageViewModel {
  const now = Date.now()
  return {
    id,
    threadId: 't1',
    senderUserId: sender,
    clientMessageId: `c-${id}`,
    body: 'hi',
    messageType: 'text',
    artifactType: null,
    artifactId: null,
    replyToMessageId: null,
    createdAt: now,
    serverReceivedAt: now,
    deliveredAt: null,
    legacyMessageId: null,
    legacySource: null,
    deletedAt: null,
    redacted: false,
    redactedAt: null,
    redactedReason: null,
    attachments: [],
    status: 'sent',
    sender: { userId: sender, role: 'customer', displayName: null, avatarUrl: null },
    ...overrides,
  }
}

describe('chat message delete — InMemoryChatRepository', () => {
  let repo: InMemoryChatRepository
  beforeEach(async () => {
    repo = new InMemoryChatRepository()
    await repo.initialize()
    repo._seedThread(thread())
  })

  it('für mich: hides own message from reads', async () => {
    const m = await repo.sendMessage({ threadId: 't1', clientMessageId: 'c1', body: 'hi', messageType: 'text' })
    expect(repo.getMessages('t1')).toHaveLength(1)
    await repo.deleteMessage(m.id, 'self')
    expect(repo.getMessages('t1')).toHaveLength(0)
  })

  it('für mich: can hide a peer message (own-side only)', async () => {
    repo._seedMessage('t1', message('p1', PEER))
    expect(repo.getMessages('t1')).toHaveLength(1)
    await repo.deleteMessage('p1', 'self')
    expect(repo.getMessages('t1')).toHaveLength(0)
  })

  it('für alle: redacts own recent message in place (tombstone, body cleared)', async () => {
    const m = await repo.sendMessage({ threadId: 't1', clientMessageId: 'c1', body: 'oops', messageType: 'text' })
    await repo.deleteMessage(m.id, 'all')
    const msgs = repo.getMessages('t1')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].redacted).toBe(true)
    expect(msgs[0].body).toBeNull()
    expect(msgs[0].redactedReason).toBe('sender_unsend')
  })

  it('für alle: rejects a peer message (not sender)', async () => {
    repo._seedMessage('t1', message('p1', PEER))
    await expect(repo.deleteMessage('p1', 'all')).rejects.toThrow('not_sender')
  })

  it('für alle: rejects past the 15-min unsend window', async () => {
    repo._seedMessage(
      't1',
      message('o1', SELF, {
        createdAt: Date.now() - 16 * 60 * 1000,
        sender: { userId: SELF, role: 'craftsman', displayName: null, avatarUrl: null },
      }),
    )
    await expect(repo.deleteMessage('o1', 'all')).rejects.toThrow('unsend_window_expired')
  })
})

describe('deleteChatMessageWorkflow', () => {
  let repo: InMemoryChatRepository
  beforeEach(async () => {
    repo = new InMemoryChatRepository()
    await repo.initialize()
    repo._seedThread(thread())
    setChatRepository(repo)
  })
  afterEach(() => resetChatRepository())

  it('für mich → ok + message hidden', async () => {
    const m = await repo.sendMessage({ threadId: 't1', clientMessageId: 'c1', body: 'hi', messageType: 'text' })
    const res = await deleteChatMessageWorkflow(m, 'self')
    expect(res).toEqual({ ok: true })
    expect(repo.getMessages('t1')).toHaveLength(0)
  })

  it('für alle within window → ok + redacted', async () => {
    const m = await repo.sendMessage({ threadId: 't1', clientMessageId: 'c1', body: 'oops', messageType: 'text' })
    const res = await deleteChatMessageWorkflow(m, 'all')
    expect(res).toEqual({ ok: true })
    expect(repo.getMessages('t1')[0].redacted).toBe(true)
  })

  it('für alle past window → reason window_expired', async () => {
    const old = message('o1', SELF, {
      createdAt: Date.now() - 16 * 60 * 1000,
      sender: { userId: SELF, role: 'craftsman', displayName: null, avatarUrl: null },
    })
    repo._seedMessage('t1', old)
    const res = await deleteChatMessageWorkflow(old, 'all')
    expect(res).toEqual({ ok: false, reason: 'window_expired' })
  })

  it('für alle on a peer message → reason not_allowed', async () => {
    const p = message('p1', PEER)
    repo._seedMessage('t1', p)
    const res = await deleteChatMessageWorkflow(p, 'all')
    expect(res).toEqual({ ok: false, reason: 'not_allowed' })
  })
})
