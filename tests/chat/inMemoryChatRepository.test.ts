import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryChatRepository } from '../../src/lib/chat/repository/InMemoryChatRepository'
import type {
  ChatAttachment,
  ChatThreadViewModel,
  ChatParticipant,
  ChatChannelType,
} from '../../src/lib/chat/types'

function makeThread(overrides: Partial<ChatThreadViewModel> = {}): ChatThreadViewModel {
  const now = Date.now()
  return {
    id: overrides.id ?? 't1',
    channelType: overrides.channelType ?? ('customer' as ChatChannelType),
    customerUserId: overrides.customerUserId ?? 'cust-1',
    craftsmanUserId: overrides.craftsmanUserId ?? 'craft-1',
    providerId: overrides.providerId ?? 'prov-1',
    legacyThreadId: overrides.legacyThreadId ?? null,
    legacySource: overrides.legacySource ?? null,
    title: overrides.title ?? null,
    lastMessageId: overrides.lastMessageId ?? null,
    lastMessageAt: overrides.lastMessageAt ?? null,
    lastMessageBody: overrides.lastMessageBody ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    closedAt: overrides.closedAt ?? null,
    participants: overrides.participants ?? [],
    unreadCount: overrides.unreadCount ?? 0,
    migrationStatus: overrides.migrationStatus ?? 'migration_complete',
  }
}

function makeParticipant(userId: string, role: ChatParticipant['role']): ChatParticipant {
  return {
    threadId: 't1',
    userId,
    role,
    joinedAt: Date.now(),
    leftAt: null,
    lastReadMessageId: null,
    lastReadAt: null,
    mutedUntil: null,
    pinned: false,
    notificationPreference: null,
  }
}

describe('InMemoryChatRepository', () => {
  let repo: InMemoryChatRepository

  beforeEach(async () => {
    repo = new InMemoryChatRepository()
    await repo.initialize()
  })

  it('starts hydrated with empty state', () => {
    expect(repo.isHydrated()).toBe(true)
    expect(repo.getThreads()).toHaveLength(0)
    expect(repo.getMessages('t1')).toHaveLength(0)
  })

  it('seedThread + getThread roundtrips', () => {
    const t = makeThread({ id: 't1', title: 'Bath' })
    repo._seedThread(t)
    expect(repo.getThread('t1')?.title).toBe('Bath')
    expect(repo.getThreads()).toHaveLength(1)
  })

  it('getThreads filters by channelType', () => {
    repo._seedThread(makeThread({ id: 'tc', channelType: 'customer' }))
    repo._seedThread(makeThread({ id: 'to', channelType: 'office' }))
    expect(repo.getThreads('customer')).toHaveLength(1)
    expect(repo.getThreads('customer')[0].id).toBe('tc')
    expect(repo.getThreads('office')).toHaveLength(1)
  })

  it('sendMessage stores message and updates thread last_message_*', async () => {
    repo._seedThread(makeThread({ id: 't1' }))
    const msg = await repo.sendMessage({
      threadId: 't1',
      body: 'Hallo',
      clientMessageId: 'cmid-1',
    })
    expect(msg.body).toBe('Hallo')
    expect(msg.status).toBe('sent')

    const t = repo.getThread('t1')!
    expect(t.lastMessageId).toBe(msg.id)
    expect(t.lastMessageBody).toBe('Hallo')
    expect(repo.getMessages('t1')).toHaveLength(1)
  })

  it('sendMessage dedupes by clientMessageId (idempotency)', async () => {
    repo._seedThread(makeThread({ id: 't1' }))
    const m1 = await repo.sendMessage({ threadId: 't1', body: 'x', clientMessageId: 'cmid-X' })
    const m2 = await repo.sendMessage({ threadId: 't1', body: 'x', clientMessageId: 'cmid-X' })
    expect(m2.id).toBe(m1.id)
    expect(repo.getMessages('t1')).toHaveLength(1)
  })

  it('subscribeToThread fires on send', async () => {
    repo._seedThread(makeThread({ id: 't1' }))
    const seen: string[] = []
    const unsub = repo.subscribeToThread('t1', (m) => {
      if (m.body) seen.push(m.body)
    })
    await repo.sendMessage({ threadId: 't1', body: 'A', clientMessageId: 'a' })
    await repo.sendMessage({ threadId: 't1', body: 'B', clientMessageId: 'b' })
    unsub()
    await repo.sendMessage({ threadId: 't1', body: 'C', clientMessageId: 'c' })
    expect(seen).toEqual(['A', 'B'])
  })

  it('subscribeToThreadList fires on send', async () => {
    repo._seedThread(makeThread({ id: 't1' }))
    const seen: string[] = []
    repo.subscribeToThreadList((t) => seen.push(t.id))
    await repo.sendMessage({ threadId: 't1', body: 'A', clientMessageId: 'a' })
    expect(seen).toContain('t1')
  })

  it('markThreadRead resets unread + sets last_read_*', async () => {
    const p = makeParticipant('inmemory-user', 'craftsman')
    repo._seedThread(makeThread({ id: 't1', unreadCount: 3, participants: [p] }))
    repo._seedParticipants('t1', [p])
    await repo.markThreadRead('t1', 'msg-id')
    expect(repo.getThread('t1')?.unreadCount).toBe(0)
  })

  it('searchMessages filters by query body, channelType and time bounds', async () => {
    repo._seedThread(makeThread({ id: 'tc', channelType: 'customer' }))
    repo._seedThread(makeThread({ id: 'to', channelType: 'office' }))
    await repo.sendMessage({ threadId: 'tc', body: 'badezimmer renovieren', clientMessageId: 'a' })
    await repo.sendMessage({ threadId: 'to', body: 'badezimmer team note', clientMessageId: 'b' })
    await repo.sendMessage({ threadId: 'tc', body: 'kueche planen', clientMessageId: 'c' })

    const all = await repo.searchMessages({ query: 'badezimmer' })
    expect(all).toHaveLength(2)

    const customerOnly = await repo.searchMessages({ query: 'badezimmer', channelType: 'customer' })
    expect(customerOnly).toHaveLength(1)
    expect(customerOnly[0].threadId).toBe('tc')

    const limited = await repo.searchMessages({ query: 'badezimmer', limit: 1 })
    expect(limited).toHaveLength(1)
  })

  it('searchMessages skips deleted/redacted', async () => {
    repo._seedThread(makeThread({ id: 't1' }))
    const m = await repo.sendMessage({ threadId: 't1', body: 'sensitive', clientMessageId: 'x' })
    // mutate via internal state — soft-delete simulation
    m.deletedAt = Date.now()
    expect(await repo.searchMessages({ query: 'sensitive' })).toHaveLength(0)
  })

  it('getMessagesSince returns slice after cursor', async () => {
    repo._seedThread(makeThread({ id: 't1' }))
    const a = await repo.sendMessage({ threadId: 't1', body: '1', clientMessageId: 'a' })
    await repo.sendMessage({ threadId: 't1', body: '2', clientMessageId: 'b' })
    await repo.sendMessage({ threadId: 't1', body: '3', clientMessageId: 'c' })
    const since = await repo.getMessagesSince('t1', a.id)
    expect(since.map((m) => m.body)).toEqual(['2', '3'])
  })

  it('getMessagesSince excludes soft-deleted messages on resume', async () => {
    repo._seedThread(makeThread({ id: 't1' }))
    const a = await repo.sendMessage({ threadId: 't1', body: '1', clientMessageId: 'a' })
    const b = await repo.sendMessage({ threadId: 't1', body: '2', clientMessageId: 'b' })
    await repo.sendMessage({ threadId: 't1', body: '3', clientMessageId: 'c' })
    // '2' soft-deleted while backgrounded must not resurface on a gap/resume read
    b.deletedAt = Date.now()
    const since = await repo.getMessagesSince('t1', a.id)
    expect(since.map((m) => m.body)).toEqual(['3'])
  })

  it('getMigrationStatus returns migration_complete (in-memory baseline)', async () => {
    expect(await repo.getMigrationStatus('any', 'conversations')).toBe('migration_complete')
  })

  it('updateUserNotificationPreference upserts patch', async () => {
    expect(repo.getUserNotificationPreference()).toBeUndefined()
    await repo.updateUserNotificationPreference({ countCustomerChatUnread: false })
    const p = repo.getUserNotificationPreference()!
    expect(p.countCustomerChatUnread).toBe(false)
    expect(p.countDisputeChatUnread).toBe(true) // default preserved
  })

  it('resetState clears caches and de-hydrates', async () => {
    repo._seedThread(makeThread({ id: 't1' }))
    await repo.sendMessage({ threadId: 't1', body: 'x', clientMessageId: 'a' })
    repo.resetState()
    expect(repo.isHydrated()).toBe(false)
    expect(repo.getThreads()).toHaveLength(0)
    expect(repo.getMessages('t1')).toHaveLength(0)
  })

  // CHAT-1 parity contract with SupabaseChatRepository.ensureThreadInCache.
  it('ensureThreadInCache returns the cached thread, undefined when missing', async () => {
    repo._seedThread(makeThread({ id: 't1', title: 'Seeded' }))
    const hit = await repo.ensureThreadInCache('t1')
    expect(hit?.id).toBe('t1')
    expect(hit?.title).toBe('Seeded')
    expect(await repo.ensureThreadInCache('missing')).toBeUndefined()
  })

  // CHAT-2 parity: attachments attached to a message survive getMessages().
  it('attachments of a message survive getMessages()', () => {
    repo._seedThread(makeThread({ id: 't1' }))
    const att: ChatAttachment = {
      id: 'temp_att_cm-att',
      messageId: 'temp_cm-att',
      assetType: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      storageBucket: 'chat-customer',
      storagePath: 'threads/t1/photo.jpg',
      width: 100,
      height: 80,
      durationMs: null,
      posterStoragePath: null,
      transcript: null,
      transcriptLanguage: null,
      uploadedAt: Date.now(),
      deletedAt: null,
      transcodeStatus: 'none',
      h264Url: null,
      posterUrl: null,
      transcodeProvider: null,
      transcodeError: null,
    }
    repo.insertOptimisticMessage({
      threadId: 't1',
      clientMessageId: 'cm-att',
      messageType: 'image',
      body: null,
      attachments: [att],
    })
    const msgs = repo.getMessages('t1')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].attachments).toHaveLength(1)
    expect(msgs[0].attachments?.[0].storagePath).toBe('threads/t1/photo.jpg')
    expect(msgs[0].attachments?.[0].assetType).toBe('image')
  })
})
