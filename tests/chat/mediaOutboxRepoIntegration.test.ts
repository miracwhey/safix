/**
 * SupabaseChatRepository hardening — integration slices for Cluster 1 / B2:
 *   - offline text send ⇒ optimistic 'pending' bubble + pendingMutation enqueue
 *     (no throw, no red bubble)
 *   - media-outbox rehydration ⇒ queued survivor becomes a pending bubble,
 *     deduped against a server row already in the cache
 *   - realtime reconnect ⇒ UNBOUNDED capped backoff (never "exhausted")
 *
 * Compact self-contained supabase mock (thenable per-table builders + captured
 * realtime status callback), mirroring supabaseChatRepository.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { MediaOutboxRecord } from '../../src/lib/chat/mediaOutbox'

const h = vi.hoisted(() => {
  type MockResult = { data: unknown; error: unknown }
  function makeBuilder(result: MockResult) {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'in', 'gt', 'gte', 'lte', 'is', 'or', 'order', 'limit', 'textSearch', 'abortSignal']) {
      b[m] = () => b
    }
    b.single = async () => result
    b.maybeSingle = async () => result
    b.then = (onF: ((v: MockResult) => unknown) | null, onR?: ((e: unknown) => unknown) | null) =>
      Promise.resolve(result).then(onF, onR)
    return b
  }
  const state = {
    tables: new Map<string, () => unknown>(),
    subscribeCb: null as null | ((status: string) => void),
    channelRemoved: 0,
    session: null as unknown,
    authCallbacks: [] as Array<(e: string, s: unknown) => void | Promise<void>>,
    reset() {
      state.tables.clear()
      state.subscribeCb = null
      state.channelRemoved = 0
      state.session = null
      state.authCallbacks.length = 0
    },
  }
  return { makeBuilder, state }
})

vi.mock('../../src/lib/supabase', () => {
  const channelObj: Record<string, unknown> = {}
  channelObj.on = () => channelObj
  channelObj.subscribe = (cb?: (status: string) => void) => {
    if (cb) h.state.subscribeCb = cb
    return channelObj
  }
  // No `state` marker ⇒ restartRealtimeIfDead treats it as dead.
  return {
    supabase: {
      auth: {
        getSession: vi.fn(async () => ({ data: { session: h.state.session } })),
        onAuthStateChange: vi.fn((cb: (e: string, s: unknown) => void) => {
          h.state.authCallbacks.push(cb)
          return { data: { subscription: { unsubscribe: vi.fn() } } }
        }),
      },
      from: vi.fn((table: string) => {
        const f = h.state.tables.get(table)
        return f ? f() : h.makeBuilder({ data: null, error: null })
      }),
      channel: vi.fn(() => channelObj),
      removeChannel: vi.fn(async () => { h.state.channelRemoved++ }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    },
  }
})

vi.mock('../../src/lib/auth/authSingleFlight', () => ({
  getAuthSession: vi.fn(async () => ({ data: { session: h.state.session } })),
  isAuthLockStolenError: () => false,
}))

vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logWarning: vi.fn(),
  logInfo: vi.fn(),
}))

// In-memory media outbox controllable per test.
const ob = vi.hoisted(() => {
  const store = new Map<string, MediaOutboxRecord>()
  return {
    store,
    listAll: vi.fn(async () => [...store.values()]),
    get: vi.fn(async (id: string) => store.get(id) ?? null),
    requestOutboxDrain: vi.fn(),
    remove: vi.fn(async (id: string) => { store.delete(id) }),
    markAttempt: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
    requeue: vi.fn(async () => {}),
    enqueue: vi.fn(async () => {}),
    listForThread: vi.fn(async () => []),
    CHAT_OUTBOX_DRAIN_EVENT: 'fixup:chat-drain-outbox',
  }
})
vi.mock('../../src/lib/chat/mediaOutbox', () => ({
  listAll: ob.listAll,
  get: ob.get,
  remove: ob.remove,
  markAttempt: ob.markAttempt,
  markFailed: ob.markFailed,
  requeue: ob.requeue,
  enqueue: ob.enqueue,
  listForThread: ob.listForThread,
  requestOutboxDrain: ob.requestOutboxDrain,
  CHAT_OUTBOX_DRAIN_EVENT: ob.CHAT_OUTBOX_DRAIN_EVENT,
}))

const memoryStorage = (() => {
  let store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store = new Map() },
  }
})()
vi.stubGlobal('localStorage', memoryStorage)

const { SupabaseChatRepository } = await import('../../src/lib/chat/repository/SupabaseChatRepository')
const { getPendingMutations, clearPendingMutations } = await import('../../src/lib/persistence/pendingMutationStore')
const observability = await import('../../src/lib/observability')

// ── Row factories ─────────────────────────────────────────────────────────
function threadRow(over: Record<string, unknown> = {}) {
  return {
    id: 't-1', channel_type: 'customer', customer_user_id: 'me-1', craftsman_user_id: 'other-1',
    provider_id: null, dispute_id: null, legacy_thread_id: null, legacy_source: null, title: null,
    last_message_id: null, last_message_at: null, last_message_body: null,
    created_at: 1000, updated_at: 1000, closed_at: null, ...over,
  }
}
function participantRow(over: Record<string, unknown> = {}) {
  return {
    thread_id: 't-1', user_id: 'me-1', role: 'customer', joined_at: 1000, left_at: null,
    last_read_message_id: null, last_read_at: null, muted_until: null, pinned: false,
    notification_preference: null, last_visible_message_id: null, last_visible_message_at: 2000,
    last_visible_message_body: null, last_visible_message_type: null, ...over,
  }
}
function messageRow(over: Record<string, unknown> = {}) {
  return {
    id: 'm-1', thread_id: 't-1', sender_user_id: 'me-1', client_message_id: 'cm-server',
    body: 'hi', message_type: 'text', artifact_type: null, artifact_id: null,
    reply_to_message_id: null, created_at: 1500, server_received_at: 1500, delivered_at: null,
    legacy_message_id: null, legacy_source: null, deleted_at: null, redacted: false,
    redacted_at: null, redacted_reason: null, ...over,
  }
}

function outboxRecord(clientMessageId: string, over: Partial<MediaOutboxRecord> = {}): MediaOutboxRecord {
  return {
    clientMessageId, threadId: 't-1', channelType: 'customer', providerId: null, kind: 'voice',
    fileName: `voice-${clientMessageId}.m4a`, mimeType: 'audio/mp4', storagePath: '',
    metadata: { durationMs: 3200, fileExtension: 'm4a', caption: null },
    createdAt: 1400, attempts: 0, lastAttemptAt: null, state: 'queued', ...over,
  }
}

/** Register the standard loadForUser table responses. `messages` seeds the
 *  chat_messages preload (server rows). */
function registerTables(messages: Array<Record<string, unknown>> = []) {
  h.state.tables.set('chat_threads', () => h.makeBuilder({ data: [threadRow()], error: null }))
  h.state.tables.set('chat_participants', () => h.makeBuilder({ data: [participantRow()], error: null }))
  h.state.tables.set('chat_thread_migration_status', () => h.makeBuilder({ data: [], error: null }))
  h.state.tables.set('user_notification_preferences', () => h.makeBuilder({ data: null, error: null }))
  h.state.tables.set('chat_messages', () => h.makeBuilder({ data: messages, error: null }))
  h.state.tables.set('chat_message_hidden', () => h.makeBuilder({ data: [], error: null }))
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  h.state.reset()
  ob.store.clear()
  ob.listAll.mockClear(); ob.get.mockClear()
  clearPendingMutations()
  vi.mocked(observability.logWarning).mockClear()
  vi.stubGlobal('navigator', { onLine: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('offline text send', () => {
  it('enqueues to the pending-mutation outbox and keeps the bubble pending (no throw)', async () => {
    h.state.session = { user: { id: 'me-1' } }
    registerTables()
    const repo = new SupabaseChatRepository()
    await repo.initialize()

    vi.stubGlobal('navigator', { onLine: false })
    const view = await repo.sendMessage({
      threadId: 't-1',
      clientMessageId: 'cm-offline',
      body: 'hallo offline',
      messageType: 'text',
    })

    expect(view.status).toBe('pending')
    const queued = getPendingMutations().filter((m) => m.table === 'chat_messages')
    expect(queued).toHaveLength(1)
    expect(queued[0].entityId).toBe('cm-offline')
    // The bubble is in the cache as pending, not failed.
    const msgs = repo.getMessages('t-1')
    expect(msgs.find((m) => m.clientMessageId === 'cm-offline')?.status).toBe('pending')
  })
})

describe('media-outbox rehydration', () => {
  it('rebuilds a queued survivor as a pending bubble and dedupes the one with a server row', async () => {
    h.state.session = { user: { id: 'me-1' } }
    // A server row for cm-server already exists in the preload.
    registerTables([messageRow({ client_message_id: 'cm-server' })])
    ob.store.set('cm-queued', outboxRecord('cm-queued'))
    ob.store.set('cm-server', outboxRecord('cm-server')) // already delivered

    const repo = new SupabaseChatRepository()
    await repo.initialize()
    await flush() // let the fire-and-forget hydrateFromMediaOutbox settle

    const msgs = repo.getMessages('t-1')
    const queued = msgs.find((m) => m.clientMessageId === 'cm-queued')
    expect(queued?.status).toBe('pending')
    expect(queued?.messageType).toBe('voice')
    expect(queued?.attachments?.[0]?.assetType).toBe('voice')

    // cm-server must NOT be re-added as an optimistic bubble (server row wins).
    const serverBubbles = msgs.filter((m) => m.clientMessageId === 'cm-server')
    expect(serverBubbles).toHaveLength(1)
    expect(serverBubbles[0].id).not.toMatch(/^temp_/)
  })

  it('rebuilds a failed record as a failed (red) bubble', async () => {
    h.state.session = { user: { id: 'me-1' } }
    registerTables([])
    ob.store.set('cm-failed', outboxRecord('cm-failed', { state: 'failed', kind: 'image', mimeType: 'image/jpeg' }))

    const repo = new SupabaseChatRepository()
    await repo.initialize()
    await flush()

    const msg = repo.getMessages('t-1').find((m) => m.clientMessageId === 'cm-failed')
    expect(msg?.status).toBe('failed')
    expect(msg?.messageType).toBe('image')
  })
})

describe('realtime reconnect backoff', () => {
  it('never capitulates — keeps scheduling capped-backoff reconnects past the old 5-attempt ceiling', async () => {
    vi.useFakeTimers()
    h.state.session = { user: { id: 'me-1' } }
    registerTables([])
    const repo = new SupabaseChatRepository()
    await repo.initialize()

    expect(h.state.subscribeCb).toBeTypeOf('function')

    // Drive many channel failures well past the retired 5-attempt cap. Each
    // failure schedules exactly one reconnect timer; advancing it re-subscribes
    // and captures the fresh status callback.
    for (let i = 0; i < 8; i++) {
      h.state.subscribeCb!('CHANNEL_ERROR')
      // A reconnect timer must be pending (capped at 60s).
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      await vi.advanceTimersByTimeAsync(60_000)
    }

    // The old ceiling logged 'realtime_reconnect_exhausted' after 5 — it must
    // never fire now.
    const warned = vi.mocked(observability.logWarning).mock.calls.map((c) => c[0])
    expect(warned).not.toContain('chat.repository.realtime_reconnect_exhausted')
  })
})
