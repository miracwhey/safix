import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatAttachment } from '../../src/lib/chat/types'

// Per-table mock infrastructure (CHAT-1/2). The legacy global from-mock is a
// non-thenable chain (`then: undefined`) — it is kept as the default for
// tables no test registers. The repository's read paths await the query chain
// directly, so per-table tests need awaitable (thenable) builders.
const h = vi.hoisted(() => {
  type MockResult = { data: unknown; error: unknown }
  type Builder = {
    select: (...a: unknown[]) => Builder
    insert: (...a: unknown[]) => Builder
    update: (...a: unknown[]) => Builder
    upsert: (...a: unknown[]) => Builder
    eq: (...a: unknown[]) => Builder
    in: (...a: unknown[]) => Builder
    gt: (...a: unknown[]) => Builder
    gte: (...a: unknown[]) => Builder
    lte: (...a: unknown[]) => Builder
    is: (...a: unknown[]) => Builder
    order: (...a: unknown[]) => Builder
    limit: (...a: unknown[]) => Builder
    textSearch: (...a: unknown[]) => Builder
    abortSignal: (...a: unknown[]) => Builder
    single: () => Promise<MockResult>
    maybeSingle: () => Promise<MockResult>
    then: (
      onFulfilled?: ((value: MockResult) => unknown) | null,
      onRejected?: ((reason: unknown) => unknown) | null,
    ) => Promise<unknown>
  }

  /** Thenable chainable query builder resolving to `result`. */
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
    /** Per-table builder factories; unregistered tables get the legacy
     *  default (non-thenable) builder. */
    tables: new Map<string, () => Builder>(),
    /** postgres_changes listeners captured from channel.on(). */
    listeners: [] as Array<{
      filter: { event: string; table: string }
      cb: (payload: { new: unknown }) => void
    }>,
    session: null as unknown,
    /** Auth-state-change callbacks captured from onAuthStateChange(). */
    authCallbacks: [] as Array<(event: string, session: unknown) => Promise<void> | void>,
    reset(): void {
      state.tables.clear()
      state.listeners.length = 0
      state.session = null
      state.authCallbacks.length = 0
    },
  }

  return { makeBuilder, state }
})

// Mock supabase BEFORE importing the SUT, otherwise the module-level
// supabase import resolves to the real client.
vi.mock('../../src/lib/supabase', () => {
  type ChannelMock = {
    on: (
      type: string,
      filter: { event: string; table: string },
      cb: (payload: { new: unknown }) => void,
    ) => ChannelMock
    // The SUT assigns realtimeChannel = channel(...).on(...).subscribe(cb).
    // Return the channel object itself (like the real client) WITHOUT a
    // state === 'joined' marker so restartRealtimeIfDead() treats the mock
    // channel as dead and actually re-subscribes (stale-generation test).
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
    update: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    gt: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    textSearch: vi.fn().mockReturnThis(),
    abortSignal: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    then: undefined,
  })
  return {
    supabase: {
      auth: {
        getSession: vi.fn(async () => ({ data: { session: h.state.session } })),
        onAuthStateChange: vi.fn(
          (cb: (event: string, session: unknown) => Promise<void> | void) => {
            h.state.authCallbacks.push(cb)
            return { data: { subscription: { unsubscribe: vi.fn() } } }
          },
        ),
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

// localStorage shim — pendingMutationStore (chat send outbox) lazily
// reads/writes localStorage; the node test env has none.
const memoryStorage = (() => {
  let store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
    clear: () => {
      store = new Map()
    },
  }
})()
vi.stubGlobal('localStorage', memoryStorage)

const { SupabaseChatRepository } = await import(
  '../../src/lib/chat/repository/SupabaseChatRepository'
)
const { getPendingMutations, enqueuePendingMutation, clearPendingMutations } = await import(
  '../../src/lib/persistence/pendingMutationStore'
)

// ── Row factories (snake_case DB rows) ──────────────────────────────────────

function makeThreadRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't-new',
    channel_type: 'customer',
    customer_user_id: 'me-1',
    craftsman_user_id: 'other-1',
    provider_id: null,
    dispute_id: null,
    legacy_thread_id: null,
    legacy_source: null,
    title: null,
    last_message_id: null,
    last_message_at: null,
    last_message_body: null,
    created_at: 1000,
    updated_at: 1000,
    closed_at: null,
    ...overrides,
  }
}

function makeParticipantRow(
  threadId: string,
  userId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    thread_id: threadId,
    user_id: userId,
    role: 'customer',
    joined_at: 1000,
    left_at: null,
    last_read_message_id: null,
    last_read_at: null,
    muted_until: null,
    pinned: false,
    notification_preference: null,
    last_visible_message_id: null,
    last_visible_message_at: null,
    last_visible_message_body: null,
    last_visible_message_type: null,
    ...overrides,
  }
}

function makeMessageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm-1',
    thread_id: 't-1',
    sender_user_id: 'other-1',
    client_message_id: 'cm-1',
    body: null,
    message_type: 'text',
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

function makeAttachmentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'att-1',
    message_id: 'm-1',
    asset_type: 'image',
    mime_type: 'image/jpeg',
    size_bytes: 2048,
    storage_bucket: 'chat-customer',
    storage_path: 'threads/t-1/photo.jpg',
    width: 800,
    height: 600,
    duration_ms: null,
    poster_storage_path: null,
    transcript: null,
    transcript_language: null,
    uploaded_at: 1000,
    deleted_at: null,
    transcode_status: 'none',
    h264_url: null,
    poster_url: null,
    transcode_provider: null,
    transcode_error: null,
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
    assetType: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
    storageBucket: 'chat-customer',
    storagePath: '',
    width: null,
    height: null,
    durationMs: null,
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

describe('SupabaseChatRepository (unit, mocked supabase)', () => {
  let repo: InstanceType<typeof SupabaseChatRepository>

  beforeEach(() => {
    h.state.reset()
    repo = new SupabaseChatRepository()
  })

  it('initialize() with no session hydrates empty and does not crash', async () => {
    await repo.initialize()
    expect(repo.isHydrated()).toBe(true)
    expect(repo.getThreads()).toHaveLength(0)
    expect(repo.getLastError()).toBeNull()
  })

  it('sendMessage() without session throws', async () => {
    await repo.initialize()
    await expect(
      repo.sendMessage({ threadId: 't1', body: 'x', clientMessageId: 'cmid-1' }),
    ).rejects.toThrow(/no authenticated session/)
  })

  it('resetState() clears caches and de-hydrates', async () => {
    await repo.initialize()
    expect(repo.isHydrated()).toBe(true)
    repo.resetState()
    expect(repo.isHydrated()).toBe(false)
    expect(repo.getThreads()).toHaveLength(0)
  })

  it('prepareForResync() keeps isHydrated() true once hydrated (no gate flicker)', async () => {
    await repo.initialize()
    repo.prepareForResync()
    // Resume-resync must NOT de-hydrate: useChatHydrated-gated screens would
    // swap the live timeline for loading placeholders on the next notify.
    expect(repo.isHydrated()).toBe(true)
  })

  it('prepareForResync() before first hydration leaves isHydrated() false', () => {
    repo.prepareForResync()
    expect(repo.isHydrated()).toBe(false)
  })

  it('subscribe()/unsubscribe lifecycle', () => {
    let calls = 0
    const off = repo.subscribe(() => {
      calls++
    })
    repo.resetState() // notifies once
    off()
    repo.resetState() // already off, but resetState still fires synchronously to live listeners
    expect(calls).toBeGreaterThanOrEqual(1)
  })

  it('subscribeToThread / subscribeToThreadList return unsubscribers', () => {
    const offThread = repo.subscribeToThread('t1', () => {})
    const offList = repo.subscribeToThreadList(() => {})
    expect(typeof offThread).toBe('function')
    expect(typeof offList).toBe('function')
    offThread()
    offList()
  })

  it('restartRealtimeIfDead() is safe to call without session', () => {
    expect(() => repo.restartRealtimeIfDead()).not.toThrow()
  })

  it('getMigrationStatus falls back to not_migrated when row missing', async () => {
    const status = await repo.getMigrationStatus('legacy-x', 'conversations')
    expect(status).toBe('not_migrated')
  })

  it.skip('markThreadRead with synth-thread-id guard — Slice 7: synth-thread paths removed', async () => {
    // isSynthThreadId guard removed in Slice 7; legacy:conversations IDs no longer exist.
  })

  it.skip('getMessagesSince with synth-thread-id guard — Slice 7: synth-thread paths removed', async () => {
    // isSynthThreadId guard removed in Slice 7; legacy:conversations IDs no longer exist.
  })
})

// ── CHAT-1: ensureThreadInCache ─────────────────────────────────────────────

describe('SupabaseChatRepository.ensureThreadInCache (CHAT-1)', () => {
  let repo: InstanceType<typeof SupabaseChatRepository>

  beforeEach(async () => {
    h.state.reset()
    h.state.session = { user: { id: 'me-1' } }
    repo = new SupabaseChatRepository()
    await repo.initialize()
  })

  it('fetches thread + participants + migration status and makes getThread() truthy', async () => {
    h.state.tables.set('chat_threads', () =>
      h.makeBuilder({ data: makeThreadRow({ id: 't-new' }), error: null }),
    )
    h.state.tables.set('chat_participants', () =>
      h.makeBuilder({
        data: [
          makeParticipantRow('t-new', 'me-1'),
          makeParticipantRow('t-new', 'other-1', { role: 'craftsman' }),
        ],
        error: null,
      }),
    )
    let migrationFetches = 0
    h.state.tables.set('chat_thread_migration_status', () => {
      migrationFetches += 1
      return h.makeBuilder({ data: null, error: null })
    })

    expect(repo.getThread('t-new')).toBeUndefined()
    const view = await repo.ensureThreadInCache('t-new')
    expect(view?.id).toBe('t-new')

    const cached = repo.getThread('t-new')
    expect(cached).toBeTruthy()
    expect(cached?.participants).toHaveLength(2)
    // No migration row → RPC-born thread defaults to migration_complete
    // (same default as loadForUser) so the send-guard never trips on it.
    expect(cached?.migrationStatus).toBe('migration_complete')
    expect(migrationFetches).toBe(1)
  })

  it('second call short-circuits on the cache and does not refetch', async () => {
    let threadFetches = 0
    h.state.tables.set('chat_threads', () => {
      threadFetches += 1
      return h.makeBuilder({ data: makeThreadRow({ id: 't-new' }), error: null })
    })
    h.state.tables.set('chat_participants', () =>
      h.makeBuilder({ data: [makeParticipantRow('t-new', 'me-1')], error: null }),
    )

    const first = await repo.ensureThreadInCache('t-new')
    expect(first?.id).toBe('t-new')
    expect(threadFetches).toBe(1)

    const second = await repo.ensureThreadInCache('t-new')
    expect(second?.id).toBe('t-new')
    expect(threadFetches).toBe(1)
  })

  it('fetch error → undefined, getThread stays undefined (never throws)', async () => {
    h.state.tables.set('chat_threads', () =>
      h.makeBuilder({ data: null, error: { message: 'rls denied' } }),
    )
    const view = await repo.ensureThreadInCache('t-err')
    expect(view).toBeUndefined()
    expect(repo.getThread('t-err')).toBeUndefined()
  })

  it('generation race — resetState during fetch does not seed a stale cache', async () => {
    const threadRow = makeThreadRow({ id: 't-race' })
    h.state.tables.set('chat_threads', () => {
      const b = h.makeBuilder({ data: threadRow, error: null })
      b.maybeSingle = async () => {
        // Logout / account-switch lands mid-fetch.
        repo.resetState()
        return { data: threadRow, error: null }
      }
      return b
    })
    const view = await repo.ensureThreadInCache('t-race')
    expect(view).toBeUndefined()
    expect(repo.getThread('t-race')).toBeUndefined()
  })
})

// ── CHAT-2: attachment hydration on the read paths ──────────────────────────

describe('SupabaseChatRepository attachment hydration (CHAT-2)', () => {
  let repo: InstanceType<typeof SupabaseChatRepository>

  beforeEach(() => {
    h.state.reset()
    repo = new SupabaseChatRepository()
  })

  it('fetchMessagesForThread hydrates attachments for media messages (camelCase mapping)', async () => {
    h.state.tables.set('chat_messages', () =>
      h.makeBuilder({
        data: [makeMessageRow({ id: 'm-img-1', thread_id: 't-img', message_type: 'image' })],
        error: null,
      }),
    )
    h.state.tables.set('chat_attachments', () =>
      h.makeBuilder({
        data: [
          makeAttachmentRow({
            id: 'att-img-1',
            message_id: 'm-img-1',
            storage_path: 'threads/t-img/photo.jpg',
            poster_url: 'https://cdn.example/poster.jpg',
            transcode_status: 'ready',
          }),
        ],
        error: null,
      }),
    )

    // Cursor not in cache → getMessagesSince falls through to the full
    // fetchMessagesForThread path.
    const msgs = await repo.getMessagesSince('t-img', 'cursor-not-cached')
    expect(msgs).toHaveLength(1)

    const cached = repo.getMessages('t-img')
    expect(cached[0].attachments).toHaveLength(1)
    const att = cached[0].attachments?.[0]
    expect(att?.id).toBe('att-img-1')
    expect(att?.storagePath).toBe('threads/t-img/photo.jpg')
    expect(att?.posterUrl).toBe('https://cdn.example/poster.jpg')
    expect(att?.transcodeStatus).toBe('ready')
  })

  it('text-only thread → no chat_attachments roundtrip (media filter)', async () => {
    h.state.tables.set('chat_messages', () =>
      h.makeBuilder({
        data: [makeMessageRow({ id: 'm-t1', thread_id: 't-txt', message_type: 'text' })],
        error: null,
      }),
    )
    let attachmentFetches = 0
    h.state.tables.set('chat_attachments', () => {
      attachmentFetches += 1
      return h.makeBuilder({ data: [], error: null })
    })

    const msgs = await repo.getMessagesSince('t-txt', 'cursor-not-cached')
    expect(msgs).toHaveLength(1)
    expect(attachmentFetches).toBe(0)
    expect(repo.getMessages('t-txt')[0].attachments).toEqual([])
  })

  it('chunks attachment fetch — 250 media ids → 3 .in() calls of ≤100', async () => {
    const rows = Array.from({ length: 250 }, (_, i) =>
      makeMessageRow({
        id: `m-${i}`,
        thread_id: 't-chunk',
        client_message_id: `cm-${i}`,
        message_type: 'image',
        created_at: 1000 + i,
      }),
    )
    h.state.tables.set('chat_messages', () => h.makeBuilder({ data: rows, error: null }))

    const inChunkSizes: number[] = []
    h.state.tables.set('chat_attachments', () => {
      const b = h.makeBuilder({ data: [], error: null })
      const origIn = b.in
      b.in = (...a: unknown[]) => {
        inChunkSizes.push((a[1] as string[]).length)
        return origIn(...a)
      }
      return b
    })

    await repo.getMessagesSince('t-chunk', 'cursor-not-cached')
    expect(inChunkSizes).toEqual([100, 100, 50])
  })

  it('attachment fetch error → messages still cached with empty attachments (graceful degradation)', async () => {
    h.state.tables.set('chat_messages', () =>
      h.makeBuilder({
        data: [makeMessageRow({ id: 'm-err-1', thread_id: 't-att-err', message_type: 'voice' })],
        error: null,
      }),
    )
    h.state.tables.set('chat_attachments', () =>
      h.makeBuilder({ data: null, error: { message: 'attachments boom' } }),
    )

    const msgs = await repo.getMessagesSince('t-att-err', 'cursor-not-cached')
    expect(msgs).toHaveLength(1)
    const cached = repo.getMessages('t-att-err')
    expect(cached).toHaveLength(1)
    expect(cached[0].attachments).toEqual([])
  })

  it('getMessagesSince merges fetched attachments into the cache', async () => {
    // Seed the cache with one text message via the full-fetch path.
    h.state.tables.set('chat_messages', () =>
      h.makeBuilder({
        data: [
          makeMessageRow({
            id: 'm-base',
            thread_id: 't-merge',
            message_type: 'text',
            created_at: 1000,
          }),
        ],
        error: null,
      }),
    )
    await repo.getMessagesSince('t-merge', 'cursor-not-cached')
    expect(repo.getMessages('t-merge')).toHaveLength(1)

    // Reconcile gap delivers one new image message with one attachment.
    h.state.tables.set('chat_messages', () =>
      h.makeBuilder({
        data: [
          makeMessageRow({
            id: 'm-new',
            thread_id: 't-merge',
            client_message_id: 'cm-new',
            message_type: 'image',
            created_at: 2000,
          }),
        ],
        error: null,
      }),
    )
    h.state.tables.set('chat_attachments', () =>
      h.makeBuilder({
        data: [makeAttachmentRow({ id: 'att-m-new', message_id: 'm-new' })],
        error: null,
      }),
    )

    const news = await repo.getMessagesSince('t-merge', 'm-base')
    expect(news).toHaveLength(1)
    const cached = repo.getMessages('t-merge')
    expect(cached).toHaveLength(2)
    expect(cached[1].id).toBe('m-new')
    expect(cached[1].attachments?.[0]?.id).toBe('att-m-new')
  })
})

// ── CHAT-2: chat_attachments realtime INSERT handling ───────────────────────

describe('SupabaseChatRepository chat_attachments realtime (CHAT-2)', () => {
  let repo: InstanceType<typeof SupabaseChatRepository>

  beforeEach(async () => {
    h.state.reset()
    h.state.session = { user: { id: 'me-1' } }
    repo = new SupabaseChatRepository()
    await repo.initialize()
  })

  function attachmentInsertListeners() {
    return h.state.listeners.filter(
      (l) => l.filter.table === 'chat_attachments' && l.filter.event === 'INSERT',
    )
  }

  function messageInsertListener() {
    const found = h.state.listeners.find(
      (l) => l.filter.table === 'chat_messages' && l.filter.event === 'INSERT',
    )
    if (!found) throw new Error('chat_messages INSERT listener not registered')
    return found
  }

  /** Seed one server message into the cache via the full-fetch path. */
  async function seedServerMessage(threadId: string, row: Record<string, unknown>) {
    h.state.tables.set('chat_messages', () => h.makeBuilder({ data: [row], error: null }))
    h.state.tables.set('chat_attachments', () => h.makeBuilder({ data: [], error: null }))
    await repo.getMessagesSince(threadId, 'cursor-not-cached')
    expect(repo.getMessages(threadId)).toHaveLength(1)
  }

  it('INSERT appends the attachment to the cached receiver message', async () => {
    await seedServerMessage(
      't-rt',
      makeMessageRow({ id: 'm-srv-1', thread_id: 't-rt', message_type: 'image' }),
    )
    const [listener] = attachmentInsertListeners()
    expect(listener).toBeTruthy()

    listener.cb({ new: makeAttachmentRow({ id: 'att-rt-1', message_id: 'm-srv-1' }) })

    const msg = repo.getMessages('t-rt')[0]
    expect(msg.attachments?.map((a) => a.id)).toEqual(['att-rt-1'])
  })

  it('INSERT dedups by attachment id (double echo → single row)', async () => {
    await seedServerMessage(
      't-rt',
      makeMessageRow({ id: 'm-srv-1', thread_id: 't-rt', message_type: 'image' }),
    )
    const [listener] = attachmentInsertListeners()
    const row = makeAttachmentRow({ id: 'att-rt-1', message_id: 'm-srv-1' })
    listener.cb({ new: row })
    listener.cb({ new: row })
    expect(repo.getMessages('t-rt')[0].attachments).toHaveLength(1)
  })

  it('INSERT with deleted_at is ignored (mirrors read-path filter)', async () => {
    await seedServerMessage(
      't-rt',
      makeMessageRow({ id: 'm-srv-1', thread_id: 't-rt', message_type: 'image' }),
    )
    const [listener] = attachmentInsertListeners()
    listener.cb({
      new: makeAttachmentRow({ id: 'att-del', message_id: 'm-srv-1', deleted_at: 1234 }),
    })
    expect(repo.getMessages('t-rt')[0].attachments).toEqual([])
  })

  it('sender echo replaces the optimistic temp_att_* by storagePath instead of appending', async () => {
    // Optimistic image send: the message row carries the temp attachment.
    repo.insertOptimisticMessage({
      threadId: 't-echo',
      clientMessageId: 'cm-echo',
      messageType: 'image',
      attachments: [
        makeTempAttachment('cm-echo', { assetType: 'image', storagePath: 'up/photo.jpg' }),
      ],
    })
    // chat_messages INSERT echo replaces the optimistic row, preserving the
    // optimistic attachments (handleRealtimeInsert behavior).
    messageInsertListener().cb({
      new: makeMessageRow({
        id: 'm-echo-1',
        thread_id: 't-echo',
        sender_user_id: 'me-1',
        client_message_id: 'cm-echo',
        message_type: 'image',
      }),
    })
    // chat_attachments INSERT echo with the same storagePath → REPLACE.
    const [attListener] = attachmentInsertListeners()
    attListener.cb({
      new: makeAttachmentRow({
        id: 'att-srv-9',
        message_id: 'm-echo-1',
        storage_path: 'up/photo.jpg',
      }),
    })

    const msg = repo.getMessages('t-echo')[0]
    expect(msg.id).toBe('m-echo-1')
    expect(msg.attachments).toHaveLength(1)
    expect(msg.attachments?.[0]?.id).toBe('att-srv-9')
  })

  it('voice sender echo replaces the path-less temp_att_* by assetType fallback', async () => {
    // Voice never patches storagePath onto the optimistic attachment — the
    // temp row stays path-less, so the storagePath match cannot hit.
    repo.insertOptimisticMessage({
      threadId: 't-voice',
      clientMessageId: 'cm-voice',
      messageType: 'voice',
      attachments: [
        makeTempAttachment('cm-voice', {
          assetType: 'voice',
          mimeType: 'audio/mp4',
          storagePath: '',
          localBlobUrl: 'blob:fake-voice',
        }),
      ],
    })
    messageInsertListener().cb({
      new: makeMessageRow({
        id: 'm-voice-1',
        thread_id: 't-voice',
        sender_user_id: 'me-1',
        client_message_id: 'cm-voice',
        message_type: 'voice',
      }),
    })
    const [attListener] = attachmentInsertListeners()
    attListener.cb({
      new: makeAttachmentRow({
        id: 'att-voice-9',
        message_id: 'm-voice-1',
        asset_type: 'voice',
        mime_type: 'audio/mp4',
        storage_path: 'voice/v.m4a',
      }),
    })

    const msg = repo.getMessages('t-voice')[0]
    expect(msg.attachments).toHaveLength(1)
    expect(msg.attachments?.[0]?.id).toBe('att-voice-9')
    expect(msg.attachments?.[0]?.storagePath).toBe('voice/v.m4a')
  })

  it('stale-generation listener is ignored after realtime restart', async () => {
    await seedServerMessage(
      't-stale',
      makeMessageRow({ id: 'm-stale-1', thread_id: 't-stale', message_type: 'image' }),
    )
    const [staleListener] = attachmentInsertListeners()
    // Re-subscribe (session resume path) → bumps realtimeGeneration; the
    // previously captured listener closure is now stale.
    repo.restartRealtimeIfDead()
    const listeners = attachmentInsertListeners()
    expect(listeners).toHaveLength(2)
    const freshListener = listeners[1]

    const row = makeAttachmentRow({ id: 'att-stale-1', message_id: 'm-stale-1' })
    staleListener.cb({ new: row })
    expect(repo.getMessages('t-stale')[0].attachments).toEqual([])

    freshListener.cb({ new: row })
    expect(repo.getMessages('t-stale')[0].attachments?.map((a) => a.id)).toEqual(['att-stale-1'])
  })
})

// ── Resume-Robustness Block 1: revalidation semantics + inflight guard ───────

/** Register the three hydration tables for loadForUser. */
function registerHydration(
  threads: Record<string, unknown>[],
  participants: Record<string, unknown>[],
  messages: Record<string, unknown>[],
): void {
  h.state.tables.set('chat_threads', () => h.makeBuilder({ data: threads, error: null }))
  h.state.tables.set('chat_participants', () => h.makeBuilder({ data: participants, error: null }))
  h.state.tables.set('chat_messages', () => h.makeBuilder({ data: messages, error: null }))
}

describe('SupabaseChatRepository resume revalidation (Block 1, Fix A/B)', () => {
  let repo: InstanceType<typeof SupabaseChatRepository>

  beforeEach(() => {
    h.state.reset()
    clearPendingMutations()
    repo = new SupabaseChatRepository()
  })

  it('realtime notify mid-resync still observes isHydrated() === true', async () => {
    h.state.session = { user: { id: 'me-1' } }
    registerHydration([makeThreadRow({ id: 't-1' })], [makeParticipantRow('t-1', 'me-1')], [])
    await repo.initialize()
    expect(repo.isHydrated()).toBe(true)

    repo.prepareForResync()
    const observed: boolean[] = []
    repo.subscribe(() => observed.push(repo.isHydrated()))

    // Partner schreibt während des Resyncs: Realtime-INSERT triggert notify.
    const listener = h.state.listeners.find(
      (l) => l.filter.table === 'chat_messages' && l.filter.event === 'INSERT',
    )
    expect(listener).toBeTruthy()
    listener!.cb({
      new: makeMessageRow({ id: 'm-rt-1', thread_id: 't-1', client_message_id: 'cm-rt-1' }),
    })

    expect(observed.length).toBeGreaterThan(0)
    expect(observed.every(Boolean)).toBe(true)

    await repo.initialize()
    expect(repo.isHydrated()).toBe(true)
  })

  it('concurrent initialize() calls share one load (inflight guard)', async () => {
    h.state.session = { user: { id: 'me-1' } }
    let threadFetches = 0
    h.state.tables.set('chat_threads', () => {
      threadFetches += 1
      return h.makeBuilder({ data: [], error: null })
    })
    await Promise.all([repo.initialize(), repo.initialize()])
    expect(threadFetches).toBe(1)
  })

  it('prepareForResync() invalidates the inflight init so the resync loads fresh', async () => {
    h.state.session = { user: { id: 'me-1' } }
    let threadFetches = 0
    h.state.tables.set('chat_threads', () => {
      threadFetches += 1
      return h.makeBuilder({ data: [], error: null })
    })
    await repo.initialize()
    expect(threadFetches).toBe(1)
    repo.prepareForResync()
    await repo.initialize()
    expect(threadFetches).toBe(2)
  })

  it('TOKEN_REFRESHED while hydrated does not start an extra load', async () => {
    h.state.session = { user: { id: 'me-1' } }
    let threadFetches = 0
    h.state.tables.set('chat_threads', () => {
      threadFetches += 1
      return h.makeBuilder({ data: [], error: null })
    })
    await repo.initialize()
    const authCb = h.state.authCallbacks[0]
    expect(authCb).toBeTruthy()
    await authCb('TOKEN_REFRESHED', { user: { id: 'me-1' } })
    expect(threadFetches).toBe(1)
  })

  it('TOKEN_REFRESHED mid-revalidation (not yet hydrated) does not double-load', async () => {
    h.state.session = { user: { id: 'me-1' } }
    registerHydration([], [], [])
    await repo.initialize()
    const authCb = h.state.authCallbacks[0]
    // Logout → un-hydrated state with a registered auth listener.
    await authCb('SIGNED_OUT', null)
    expect(repo.isHydrated()).toBe(false)

    // Gated chat_threads fetch: the resync load hangs until release().
    let release: ((v: { data: unknown; error: unknown }) => void) | undefined
    const gate = new Promise<{ data: unknown; error: unknown }>((res) => {
      release = res
    })
    let threadFetches = 0
    h.state.tables.set('chat_threads', () => {
      threadFetches += 1
      const b = h.makeBuilder({ data: [], error: null })
      b.then = (onF, onR) => gate.then(onF, onR)
      return b
    })

    repo.prepareForResync()
    const resync = repo.initialize()
    await vi.waitFor(() => expect(threadFetches).toBe(1))

    // TOKEN_REFRESHED arrives mid-resync: _hydrated=false, but _revalidating
    // must block the duplicate full reload.
    const authP = authCb('TOKEN_REFRESHED', { user: { id: 'me-1' } })
    release!({ data: [], error: null })
    await resync
    await authP
    expect(threadFetches).toBe(1)
    expect(repo.isHydrated()).toBe(true)
  })
})

// ── Resume-Robustness Block 1: resync preserves optimistic rows (Fix C) ─────

describe('SupabaseChatRepository resync cache preservation (Block 1, Fix C)', () => {
  let repo: InstanceType<typeof SupabaseChatRepository>

  beforeEach(async () => {
    h.state.reset()
    clearPendingMutations()
    repo = new SupabaseChatRepository()
    h.state.session = { user: { id: 'me-1' } }
    registerHydration(
      [makeThreadRow({ id: 't-1' })],
      [makeParticipantRow('t-1', 'me-1')],
      [],
    )
    await repo.initialize()
  })

  async function failSend(clientMessageId: string, body: string): Promise<void> {
    h.state.tables.set('chat_messages', () =>
      h.makeBuilder({ data: null, error: { message: 'TypeError: Load failed', code: '' } }),
    )
    await expect(
      repo.sendMessage({ threadId: 't-1', body, clientMessageId }),
    ).rejects.toBeTruthy()
  }

  it('failed optimistic row survives a resync (retry bubble keeps the text)', async () => {
    await failSend('cm-f1', 'hallo welt')
    expect(repo.getMessages('t-1').map((m) => [m.id, m.status])).toEqual([
      ['temp_cm-f1', 'failed'],
    ])

    // Resume-resync: server still has no row for this send.
    repo.prepareForResync()
    h.state.tables.set('chat_messages', () => h.makeBuilder({ data: [], error: null }))
    await repo.initialize()

    const after = repo.getMessages('t-1')
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe('temp_cm-f1')
    expect(after[0].status).toBe('failed')
    expect(after[0].body).toBe('hallo welt')
  })

  it('optimistic row dedups against a landed server row (timeout-after-commit)', async () => {
    await failSend('cm-f2', 'hallo welt')

    repo.prepareForResync()
    h.state.tables.set('chat_messages', () =>
      h.makeBuilder({
        data: [
          makeMessageRow({
            id: 'srv-1',
            thread_id: 't-1',
            sender_user_id: 'me-1',
            client_message_id: 'cm-f2',
            body: 'hallo welt',
          }),
        ],
        error: null,
      }),
    )
    await repo.initialize()

    const after = repo.getMessages('t-1')
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe('srv-1')
    expect(after[0].status).toBe('sent')
  })

  it('message-preload failure keeps the previous cache instead of a wiped-empty map', async () => {
    // Seed one server message via a resync round.
    repo.prepareForResync()
    h.state.tables.set('chat_messages', () =>
      h.makeBuilder({
        data: [makeMessageRow({ id: 'm-1', thread_id: 't-1' })],
        error: null,
      }),
    )
    await repo.initialize()
    expect(repo.getMessages('t-1').map((m) => m.id)).toEqual(['m-1'])

    // Next resync: thread fetch ok, message preload fails (Funkloch).
    repo.prepareForResync()
    h.state.tables.set('chat_messages', () =>
      h.makeBuilder({ data: null, error: { message: 'fetch failed' } }),
    )
    await repo.initialize()

    expect(repo.isHydrated()).toBe(true)
    expect(repo.getMessages('t-1').map((m) => m.id)).toEqual(['m-1'])
  })
})

// ── Resume-Robustness Block 1: send hardening + outbox adapter (Fix D) ──────

describe('SupabaseChatRepository send hardening + outbox (Block 1, Fix D)', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  let repo: InstanceType<typeof SupabaseChatRepository>

  beforeEach(async () => {
    h.state.reset()
    clearPendingMutations()
    repo = new SupabaseChatRepository()
    h.state.session = { user: { id: 'me-1' } }
    registerHydration(
      [makeThreadRow({ id: 't-1' })],
      [makeParticipantRow('t-1', 'me-1')],
      [],
    )
    await repo.initialize()
  })

  function registerFailingInsert(
    error: Record<string, unknown>,
    insertPayloads?: Record<string, unknown>[],
  ): void {
    h.state.tables.set('chat_messages', () => {
      const b = h.makeBuilder({ data: null, error })
      if (insertPayloads) {
        const orig = b.insert
        b.insert = (...a: unknown[]) => {
          insertPayloads.push(a[0] as Record<string, unknown>)
          return orig(...a)
        }
      }
      return b
    })
  }

  it('transient failure enqueues a replay payload with a stable client-generated id', async () => {
    const insertPayloads: Record<string, unknown>[] = []
    registerFailingInsert({ message: 'AbortError: signal timed out', code: '' }, insertPayloads)

    await expect(
      repo.sendMessage({ threadId: 't-1', body: 'x', clientMessageId: 'cm-t1' }),
    ).rejects.toBeTruthy()

    const queued = getPendingMutations()
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      table: 'chat_messages',
      operation: 'insert',
      domain: 'chat',
      entityId: 'cm-t1',
    })
    expect(String(queued[0].payload.id)).toMatch(UUID_RE)
    expect(queued[0].payload.id).toBe(insertPayloads[0].id)
    // Bubble deterministisch failed, nie ewig pending.
    expect(repo.getMessages('t-1')[0].status).toBe('failed')

    // Retry inserts with the SAME planned id (upsert onConflict:'id' replay
    // must hit the id conflict target, not the composite UNIQUE).
    await expect(
      repo.sendMessage({ threadId: 't-1', body: 'x', clientMessageId: 'cm-t1' }),
    ).rejects.toBeTruthy()
    expect(insertPayloads).toHaveLength(2)
    expect(insertPayloads[1].id).toBe(insertPayloads[0].id)
    expect(getPendingMutations()).toHaveLength(1)
  })

  it('server-side rejection (42501) is NOT enqueued for replay', async () => {
    registerFailingInsert({ message: 'rls denied', code: '42501' })
    await expect(
      repo.sendMessage({ threadId: 't-1', body: 'x', clientMessageId: 'cm-rls' }),
    ).rejects.toBeTruthy()
    expect(getPendingMutations()).toHaveLength(0)
    expect(repo.getMessages('t-1')[0].status).toBe('failed')
  })

  it('a thrown insert (no postgrest error object) still lands in failed + queue', async () => {
    h.state.tables.set('chat_messages', () => {
      const b = h.makeBuilder({ data: null, error: null })
      b.single = async () => {
        throw new Error('network down')
      }
      return b
    })
    await expect(
      repo.sendMessage({ threadId: 't-1', body: 'x', clientMessageId: 'cm-throw' }),
    ).rejects.toThrow(/network down/)
    expect(repo.getMessages('t-1')[0].status).toBe('failed')
    expect(getPendingMutations()).toHaveLength(1)
  })

  it('successful send clears the queued replay entry', async () => {
    registerFailingInsert({ message: 'AbortError: signal timed out', code: '' })
    await expect(
      repo.sendMessage({ threadId: 't-1', body: 'x', clientMessageId: 'cm-s1' }),
    ).rejects.toBeTruthy()
    expect(getPendingMutations()).toHaveLength(1)

    h.state.tables.set('chat_messages', () =>
      h.makeBuilder({
        data: makeMessageRow({
          id: 'srv-9',
          thread_id: 't-1',
          sender_user_id: 'me-1',
          client_message_id: 'cm-s1',
          body: 'x',
        }),
        error: null,
      }),
    )
    const view = await repo.sendMessage({ threadId: 't-1', body: 'x', clientMessageId: 'cm-s1' })
    expect(view.id).toBe('srv-9')
    expect(getPendingMutations()).toHaveLength(0)
    const msgs = repo.getMessages('t-1')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].id).toBe('srv-9')
    expect(msgs[0].status).toBe('sent')
  })

  it('discardOptimisticMessage cancels the queued background replay', async () => {
    registerFailingInsert({ message: 'AbortError: signal timed out', code: '' })
    await expect(
      repo.sendMessage({ threadId: 't-1', body: 'geheim', clientMessageId: 'cm-d1' }),
    ).rejects.toBeTruthy()
    expect(getPendingMutations()).toHaveLength(1)

    repo.discardOptimisticMessage('t-1', 'cm-d1')
    expect(repo.getMessages('t-1')).toHaveLength(0)
    expect(getPendingMutations()).toHaveLength(0)
  })

  it('hydrateFromQueue reconstructs a pending bubble after a cold reload', async () => {
    enqueuePendingMutation({
      operation: 'insert',
      table: 'chat_messages',
      domain: 'chat',
      entityId: 'cm-q1',
      payload: {
        id: '11111111-2222-4333-8444-555555555555',
        thread_id: 't-1',
        sender_user_id: 'me-1',
        client_message_id: 'cm-q1',
        body: 'offline getippt',
        message_type: 'text',
        artifact_type: null,
        artifact_id: null,
        reply_to_message_id: null,
      },
    })

    // Cold reload: fresh repo instance, same queue.
    const fresh = new SupabaseChatRepository()
    await fresh.initialize()

    const msgs = fresh.getMessages('t-1')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({
      id: 'temp_cm-q1',
      status: 'pending',
      body: 'offline getippt',
      senderUserId: 'me-1',
      clientMessageId: 'cm-q1',
    })
  })
})
