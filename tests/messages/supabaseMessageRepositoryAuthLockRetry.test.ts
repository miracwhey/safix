/**
 * SupabaseMessageRepository — auth-lock-stolen retry (Sentry P0 FIXUP-WEB-B/9).
 *
 * Producer path: the conversations/messages PostgREST queries resolve their
 * access token through the auth client; under boot/resume lock contention
 * that internal read rejects with `AbortError: Lock was stolen by another
 * request`, which postgrest-js wraps into `result.error` → previously logged
 * as `repository.messages.initialize_conversations_failed` /
 * `initialize_messages_failed` and dropped the load into the stale-cache path.
 *
 * Expected behavior after the fix: loadForUser retries EXACTLY once on the
 * lock-stolen signature; other errors keep the Block-1 stale-while-revalidate
 * semantics unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type MockResult = { data: unknown; error: unknown }

  const state = {
    /** Result queues — one entry consumed per fetch attempt; last repeats. */
    conversationResults: [] as MockResult[],
    conversationCalls: 0,
    messageResults: [] as MockResult[],
    messageCalls: 0,
    session: { user: { id: 'user-1' } } as unknown,
    reset(): void {
      state.conversationResults = []
      state.conversationCalls = 0
      state.messageResults = []
      state.messageCalls = 0
      state.session = { user: { id: 'user-1' } }
    },
  }

  /** Thenable chainable builder resolving to `result` (postgrest shape:
   *  errors come back as `{ data: null, error }`, never as rejections). */
  function makeBuilder(result: MockResult) {
    const builder: Record<string, unknown> = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'or', 'eq', 'in', 'order', 'limit']) {
      builder[m] = () => builder
    }
    builder.single = async () => result
    builder.maybeSingle = async () => result
    builder.then = (
      onFulfilled?: ((value: MockResult) => unknown) | null,
      onRejected?: ((reason: unknown) => unknown) | null,
    ) => Promise.resolve(result).then(onFulfilled, onRejected)
    return builder
  }

  return { state, makeBuilder }
})

vi.mock('../../src/lib/supabase', () => {
  const channelObj: Record<string, unknown> = {}
  channelObj.on = () => channelObj
  channelObj.subscribe = () => channelObj

  return {
    supabase: {
      auth: {
        getSession: vi.fn(async () => ({ data: { session: h.state.session }, error: null })),
        onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      },
      from: vi.fn((table: string) => {
        if (table === 'conversations') {
          const idx = Math.min(h.state.conversationCalls, h.state.conversationResults.length - 1)
          h.state.conversationCalls++
          return h.makeBuilder(h.state.conversationResults[idx] ?? { data: [], error: null })
        }
        if (table === 'messages') {
          const idx = Math.min(h.state.messageCalls, h.state.messageResults.length - 1)
          h.state.messageCalls++
          return h.makeBuilder(h.state.messageResults[idx] ?? { data: [], error: null })
        }
        return h.makeBuilder({ data: [], error: null })
      }),
      channel: vi.fn(() => channelObj),
      removeChannel: vi.fn(),
    },
  }
})

vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

vi.mock('../../src/lib/persistence', () => ({
  recordPersistenceFailure: vi.fn(),
  enqueuePendingMutation: vi.fn(),
  getPendingMutations: vi.fn(() => []),
  isServerSideError: vi.fn(() => false),
}))

import { SupabaseMessageRepository } from '../../src/lib/messages/repository/SupabaseMessageRepository'
import { logError, logInfo } from '../../src/lib/observability'
import { invalidateAuthSessionSingleFlight } from '../../src/lib/auth/authSingleFlight'

/** Producer shape: postgrest-js wraps the navigator.locks rejection of its
 *  internal token read into a result error with `${name}: ${message}`. */
function lockStolenResult() {
  return {
    data: null,
    error: {
      message: 'AbortError: Lock was stolen by another request',
      details: 'AbortError: Lock was stolen by another request',
      hint: '',
      code: '',
    },
  }
}

/** Minimal conversations row matching the live schema mapping (rowToConversation). */
function conversationRow(id: string) {
  return {
    id,
    customer_name: 'Kunde A',
    customer_avatar_url: '',
    craftsman_name: 'Handwerker B',
    craftsman_handle: '@handwerkerb',
    craftsman_avatar_url: '',
    craftsman_user_id: 'user-1',
    customer_user_id: 'customer-1',
    project_title: 'Bad-Sanierung',
    project_subtitle: 'Komplett',
    project_location: null,
    project_cost_range: null,
    project_duration: null,
    project_status_label: null,
    time_label: null,
    unread_count: 0,
    inquiry_origin: null,
    source_project_id: null,
    reviewed_at: null,
    declined_at: null,
    created_at: 1_700_000_000_000,
  }
}

beforeEach(() => {
  h.state.reset()
  vi.clearAllMocks()
  invalidateAuthSessionSingleFlight()
})

describe('SupabaseMessageRepository auth-lock-stolen retry', () => {
  it('retries loadForUser exactly once and hydrates cleanly when the retry succeeds', async () => {
    h.state.conversationResults = [
      lockStolenResult(),
      { data: [conversationRow('conv-1')], error: null },
    ]
    h.state.messageResults = [{ data: [], error: null }]

    const repo = new SupabaseMessageRepository()
    await repo.initialize()

    expect(h.state.conversationCalls).toBe(2)
    expect(repo.isHydrated()).toBe(true)
    expect(repo.getLastError()).toBeNull()
    expect(repo.getConversations().map((c) => c.id)).toEqual(['conv-1'])
    // The P0 Sentry events must NOT fire when the retry recovers.
    expect(vi.mocked(logError)).not.toHaveBeenCalled()
    expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
      'repository.messages.auth_lock_retry',
      { userId: 'user-1' },
    )
  })

  it('also retries when only the messages fetch hit the stolen lock', async () => {
    h.state.conversationResults = [{ data: [conversationRow('conv-1')], error: null }]
    h.state.messageResults = [lockStolenResult(), { data: [], error: null }]

    const repo = new SupabaseMessageRepository()
    await repo.initialize()

    expect(h.state.messageCalls).toBe(2)
    expect(repo.isHydrated()).toBe(true)
    expect(repo.getLastError()).toBeNull()
  })

  it('gives up after ONE retry — a second lock steal falls into the Block-1 stale-cache path', async () => {
    h.state.conversationResults = [lockStolenResult(), lockStolenResult(), { data: [], error: null }]
    h.state.messageResults = [{ data: [], error: null }]

    const repo = new SupabaseMessageRepository()
    await repo.initialize()

    // Exactly two attempts — never a third.
    expect(h.state.conversationCalls).toBe(2)
    // Block-1 semantics unchanged: hydrated stays true (stale-while-
    // revalidate), error surfaced via getLastError() so the bootstrap
    // resync escalates + retries later instead of debouncing away.
    expect(repo.isHydrated()).toBe(true)
    expect(repo.getLastError()).toBe('Nachrichten konnten nicht geladen werden.')
    expect(vi.mocked(logError)).toHaveBeenCalledWith(
      'repository.messages.initialize_conversations_failed',
      expect.anything(),
      { userId: 'user-1' },
    )
  })

  it('keeps the same-user cache when the retried load still fails (stale-while-revalidate)', async () => {
    // First init: clean load with one conversation.
    h.state.conversationResults = [{ data: [conversationRow('conv-1')], error: null }]
    h.state.messageResults = [{ data: [], error: null }]

    const repo = new SupabaseMessageRepository()
    await repo.initialize()
    expect(repo.getConversations().map((c) => c.id)).toEqual(['conv-1'])

    // Resume-resync: both attempts hit the stolen lock.
    h.state.conversationResults = [lockStolenResult(), lockStolenResult()]
    h.state.conversationCalls = 0
    repo.prepareForResync()
    await repo.initialize()

    expect(h.state.conversationCalls).toBe(2)
    // Same-user stale cache retained — the inbox must not blank out.
    expect(repo.getConversations().map((c) => c.id)).toEqual(['conv-1'])
    expect(repo.getLastError()).toBe('Nachrichten konnten nicht geladen werden.')
  })

  it('does NOT retry on non-lock errors (single attempt, error surfaced)', async () => {
    h.state.conversationResults = [
      { data: null, error: { message: 'permission denied for table conversations', details: '', hint: '', code: '42501' } },
    ]
    h.state.messageResults = [{ data: [], error: null }]

    const repo = new SupabaseMessageRepository()
    await repo.initialize()

    expect(h.state.conversationCalls).toBe(1)
    expect(repo.getLastError()).not.toBeNull()
    expect(vi.mocked(logInfo)).not.toHaveBeenCalledWith(
      'repository.messages.auth_lock_retry',
      expect.anything(),
    )
  })
})
