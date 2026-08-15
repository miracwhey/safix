/**
 * Cache-idempotency invariant: at most ONE row per (sender, clientMessageId)
 * per thread — the client mirror of the server UNIQUE constraint.
 *
 * Regression suite for the "two audio bubbles, second one unplayable" bug:
 * insertOptimisticMessage appended blindly, and every reconciler
 * (handleRealtimeInsert dupIdx, replaceOptimistic, markOptimisticSent) only
 * ever replaces the FIRST match — so any path that materialized a second row
 * with the same clientMessageId (media retry, drain replay, gap-refetch merge
 * racing the echo) left an eternal unplayable ghost bubble.
 *
 * Fixed by: (1) insertOptimisticMessage upsert-in-place, (2) the
 * commitThreadMessages chokepoint enforcing the invariant on EVERY write.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatAttachment } from '../../src/lib/chat/types'

const h = vi.hoisted(() => {
  type MockResult = { data: unknown; error: unknown }
  type Builder = Record<string, unknown> & {
    then: (
      onFulfilled?: ((value: MockResult) => unknown) | null,
      onRejected?: ((reason: unknown) => unknown) | null,
    ) => Promise<unknown>
  }
  function makeBuilder(result: MockResult): Builder {
    const builder: Builder = {
      select: () => builder,
      insert: () => builder,
      update: () => builder,
      upsert: () => builder,
      eq: () => builder,
      in: () => builder,
      gt: () => builder,
      gte: () => builder,
      lte: () => builder,
      is: () => builder,
      order: () => builder,
      limit: () => builder,
      textSearch: () => builder,
      abortSignal: () => builder,
      single: async () => result,
      maybeSingle: async () => result,
      then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
    }
    return builder
  }
  const state = {
    tables: new Map<string, () => Builder>(),
    listeners: [] as Array<{
      filter: { event: string; table: string }
      cb: (payload: { new: unknown }) => void
    }>,
    session: null as unknown,
    reset(): void {
      state.tables.clear()
      state.listeners.length = 0
      state.session = null
    },
  }
  return { makeBuilder, state }
})

vi.mock('../../src/lib/supabase', () => {
  type ChannelMock = {
    on: (
      type: string,
      filter: { event: string; table: string },
      cb: (payload: { new: unknown }) => void,
    ) => ChannelMock
    subscribe: (cb?: (status: string) => void) => ChannelMock
  }
  const channelObj: ChannelMock = {
    on: (_type, filter, cb) => {
      h.state.listeners.push({ filter, cb })
      return channelObj
    },
    subscribe: () => channelObj,
  }
  const defaultBuilder = () => ({
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    then: undefined,
  })
  return {
    supabase: {
      auth: {
        getSession: vi.fn(async () => ({ data: { session: h.state.session } })),
        onAuthStateChange: vi.fn(() => ({
          data: { subscription: { unsubscribe: vi.fn() } },
        })),
      },
      from: vi.fn((table: string) => {
        const factory = h.state.tables.get(table)
        return factory ? factory() : defaultBuilder()
      }),
      channel: vi.fn().mockReturnValue(channelObj),
      removeChannel: vi.fn().mockResolvedValue(undefined),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  }
})

const memoryStorage = (() => {
  let store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => {
      store = new Map()
    },
  }
})()
vi.stubGlobal('localStorage', memoryStorage)

const { SupabaseChatRepository } = await import(
  '../../src/lib/chat/repository/SupabaseChatRepository'
)
const { InMemoryChatRepository } = await import(
  '../../src/lib/chat/repository/InMemoryChatRepository'
)

function makeMessageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm-1',
    thread_id: 't-1',
    sender_user_id: 'me-1',
    client_message_id: 'cm-1',
    body: null,
    message_type: 'voice',
    artifact_type: null,
    artifact_id: null,
    reply_to_message_id: null,
    created_at: 1000,
    server_received_at: 1000,
    delivered_at: null,
    legacy_message_id: null,
    legacy_source: null,
    deleted_at: null,
    redacted: false,
    redacted_at: null,
    redacted_reason: null,
    ...overrides,
  }
}

function makeTempAttachment(
  clientMessageId: string,
  overrides: Partial<ChatAttachment> = {},
): ChatAttachment {
  return {
    id: `temp_att_${clientMessageId}`,
    messageId: `temp_${clientMessageId}`,
    assetType: 'voice',
    mimeType: 'audio/mp4',
    sizeBytes: 1024,
    storageBucket: 'chat-internal',
    storagePath: '',
    width: null,
    height: null,
    durationMs: 2000,
    posterStoragePath: null,
    transcript: null,
    transcriptLanguage: null,
    uploadedAt: 1000,
    deletedAt: null,
    transcodeStatus: 'none',
    h264Url: null,
    posterUrl: null,
    transcodeProvider: null,
    transcodeError: null,
    ...overrides,
  }
}

describe('SupabaseChatRepository optimistic idempotency', () => {
  let repo: InstanceType<typeof SupabaseChatRepository>

  beforeEach(async () => {
    h.state.reset()
    h.state.session = { user: { id: 'me-1' } }
    repo = new SupabaseChatRepository()
    await repo.initialize()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function messageInsertListener() {
    const found = h.state.listeners.find(
      (l) => l.filter.table === 'chat_messages' && l.filter.event === 'INSERT',
    )
    if (!found) throw new Error('chat_messages INSERT listener not registered')
    return found
  }

  function insertVoiceOptimistic(threadId: string, clientMessageId: string) {
    return repo.insertOptimisticMessage({
      threadId,
      clientMessageId,
      messageType: 'voice',
      body: null,
      attachments: [makeTempAttachment(clientMessageId)],
    })
  }

  it('re-insert with the same clientMessageId replaces in place (single row, createdAt preserved)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(50_000)
    insertVoiceOptimistic('t-dup', 'cm-dup')
    vi.setSystemTime(55_000)
    const tempId = insertVoiceOptimistic('t-dup', 'cm-dup')

    const msgs = repo.getMessages('t-dup')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].id).toBe(tempId)
    expect(msgs[0].status).toBe('pending')
    // Timeline stability: retry must not move the bubble.
    expect(msgs[0].createdAt).toBe(50_000)
  })

  it('double-insert followed by the Realtime echo leaves exactly the server row', () => {
    insertVoiceOptimistic('t-dup2', 'cm-dup2')
    insertVoiceOptimistic('t-dup2', 'cm-dup2')
    messageInsertListener().cb({
      new: makeMessageRow({
        id: 'm-srv-dup2',
        thread_id: 't-dup2',
        sender_user_id: 'me-1',
        client_message_id: 'cm-dup2',
      }),
    })
    expect(repo.getMessages('t-dup2').map((m) => m.id)).toEqual(['m-srv-dup2'])
  })

  it('insert after the server row already landed is a no-op returning the server id', () => {
    insertVoiceOptimistic('t-landed', 'cm-landed')
    messageInsertListener().cb({
      new: makeMessageRow({
        id: 'm-srv-landed',
        thread_id: 't-landed',
        sender_user_id: 'me-1',
        client_message_id: 'cm-landed',
      }),
    })
    // Re-send after success whose cleanup was lost (drain replay).
    const returned = insertVoiceOptimistic('t-landed', 'cm-landed')
    expect(returned).toBe('m-srv-landed')
    const msgs = repo.getMessages('t-landed')
    expect(msgs.map((m) => m.id)).toEqual(['m-srv-landed'])
    expect(msgs[0].status).toBe('sent')
  })

  it('failed bubble retry resets in place instead of appending', () => {
    const tempId = insertVoiceOptimistic('t-retry', 'cm-retry')
    repo.failOptimisticMessage('t-retry', tempId)
    expect(repo.getMessages('t-retry')[0].status).toBe('failed')

    insertVoiceOptimistic('t-retry', 'cm-retry')
    const msgs = repo.getMessages('t-retry')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].status).toBe('pending')
  })

  it('gap-refetch merge (getMessagesSince) displaces a lingering temp row and carries its attachments', async () => {
    // Seed a cursor row via the full-fetch path.
    h.state.tables.set('chat_messages', () =>
      h.makeBuilder({
        data: [
          makeMessageRow({
            id: 'm-cursor',
            thread_id: 't-gap',
            client_message_id: 'cm-cursor',
            message_type: 'text',
            body: 'hi',
            created_at: 900,
          }),
        ],
        error: null,
      }),
    )
    h.state.tables.set('chat_attachments', () => h.makeBuilder({ data: [], error: null }))
    await repo.getMessagesSince('t-gap', 'cursor-not-cached')
    expect(repo.getMessages('t-gap')).toHaveLength(1)

    // Voice send in flight: optimistic temp row in the cache.
    insertVoiceOptimistic('t-gap', 'cm-voice')
    expect(repo.getMessages('t-gap')).toHaveLength(2)

    // Reconnect gap-refetch returns the landed server row for the same
    // clientMessageId — attachment fetch comes back empty (worst case).
    h.state.tables.set('chat_messages', () =>
      h.makeBuilder({
        data: [
          makeMessageRow({
            id: 'm-srv-voice',
            thread_id: 't-gap',
            sender_user_id: 'me-1',
            client_message_id: 'cm-voice',
            created_at: 2_000_000_000_000,
          }),
        ],
        error: null,
      }),
    )
    await repo.getMessagesSince('t-gap', 'm-cursor')

    const msgs = repo.getMessages('t-gap')
    expect(msgs.map((m) => m.id)).toEqual(['m-cursor', 'm-srv-voice'])
    // Attachment carry-over: the media bubble must not degrade to an empty
    // text row while the server attachment hydrates.
    expect(msgs[1].attachments?.[0]?.id).toBe('temp_att_cm-voice')
    // Late echo of the same server row stays a no-op.
    messageInsertListener().cb({
      new: makeMessageRow({
        id: 'm-srv-voice',
        thread_id: 't-gap',
        sender_user_id: 'me-1',
        client_message_id: 'cm-voice',
        created_at: 2_000_000_000_000,
      }),
    })
    expect(repo.getMessages('t-gap')).toHaveLength(2)
  })

  it('rows without clientMessageId are never deduped', async () => {
    h.state.tables.set('chat_messages', () =>
      h.makeBuilder({
        data: [
          makeMessageRow({
            id: 'm-legacy-1',
            thread_id: 't-legacy',
            client_message_id: null,
            message_type: 'text',
            body: 'a',
            created_at: 900,
          }),
          makeMessageRow({
            id: 'm-legacy-2',
            thread_id: 't-legacy',
            client_message_id: null,
            message_type: 'text',
            body: 'b',
            created_at: 901,
          }),
        ],
        error: null,
      }),
    )
    h.state.tables.set('chat_attachments', () => h.makeBuilder({ data: [], error: null }))
    await repo.getMessagesSince('t-legacy', 'cursor-not-cached')
    expect(repo.getMessages('t-legacy')).toHaveLength(2)
  })
})

describe('InMemoryChatRepository optimistic idempotency (adapter parity)', () => {
  it('re-insert with the same clientMessageId replaces in place', () => {
    const repo = new InMemoryChatRepository()
    const input = {
      threadId: 't-mem',
      clientMessageId: 'cm-mem',
      messageType: 'voice' as const,
      body: null,
      attachments: [makeTempAttachment('cm-mem')],
    }
    repo.insertOptimisticMessage(input)
    repo.insertOptimisticMessage(input)
    expect(repo.getMessages('t-mem')).toHaveLength(1)
    expect(repo.getMessages('t-mem')[0].status).toBe('pending')
  })
})
