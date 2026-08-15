/**
 * SupabaseChatRepository — auth-lock-stolen retry (Sentry P0 FIXUP-WEB-56).
 *
 * Producer path: every PostgREST query resolves its access token through the
 * auth client; under boot/resume lock contention that internal read rejects
 * with `AbortError: Lock was stolen by another request`, which postgrest-js
 * wraps into `result.error` → `loadForUser` throws it → previously logged as
 * `chat.repository.initialize_failed` (hard init fail).
 *
 * Expected behavior after the fix: loadForUser retries EXACTLY once on the
 * lock-stolen signature; other errors keep the Block-1 stale-while-revalidate
 * semantics unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type MockResult = { data: unknown; error: unknown }

  const state = {
    /** Result queue for chat_threads — one entry consumed per fetch attempt;
     *  the last entry repeats. */
    threadResults: [] as MockResult[],
    threadCalls: 0,
    session: { user: { id: 'user-1' } } as unknown,
    reset(): void {
      state.threadResults = []
      state.threadCalls = 0
      state.session = { user: { id: 'user-1' } }
    },
  }

  /** Thenable chainable builder resolving to `result` (postgrest shape:
   *  errors come back as `{ data: null, error }`, never as rejections). */
  function makeBuilder(result: MockResult) {
    const builder: Record<string, unknown> = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'in', 'gt', 'gte', 'lte', 'is', 'order', 'limit', 'textSearch', 'abortSignal']) {
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
        if (table === 'chat_threads') {
          const idx = Math.min(h.state.threadCalls, h.state.threadResults.length - 1)
          h.state.threadCalls++
          return h.makeBuilder(h.state.threadResults[idx] ?? { data: [], error: null })
        }
        if (table === 'user_notification_preferences') {
          return h.makeBuilder({ data: null, error: null })
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

vi.mock('../../src/lib/persistence/pendingMutationStore', () => ({
  enqueuePendingMutation: vi.fn(),
  getPendingMutations: vi.fn(() => []),
  removePendingMutation: vi.fn(),
}))

vi.mock('../../src/lib/persistence/serverErrors', () => ({
  isServerSideError: vi.fn(() => false),
}))

import { SupabaseChatRepository } from '../../src/lib/chat/repository/SupabaseChatRepository'
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

beforeEach(() => {
  h.state.reset()
  vi.clearAllMocks()
  invalidateAuthSessionSingleFlight()
})

describe('SupabaseChatRepository auth-lock-stolen retry', () => {
  it('retries loadForUser exactly once and initializes cleanly when the retry succeeds', async () => {
    h.state.threadResults = [lockStolenResult(), { data: [], error: null }]

    const repo = new SupabaseChatRepository()
    await repo.initialize()

    expect(h.state.threadCalls).toBe(2)
    expect(repo.isHydrated()).toBe(true)
    expect(repo.getLastError()).toBeNull()
    // The P0 Sentry event must NOT fire when the retry recovers.
    expect(vi.mocked(logError)).not.toHaveBeenCalledWith(
      'chat.repository.initialize_failed',
      expect.anything(),
      expect.anything(),
    )
    expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
      'chat.repository.auth_lock_retry',
      { uid: 'user-1' },
    )
  })

  it('gives up after ONE retry — a second lock steal falls into the Block-1 error path', async () => {
    h.state.threadResults = [lockStolenResult(), lockStolenResult(), { data: [], error: null }]

    const repo = new SupabaseChatRepository()
    await repo.initialize()

    // Exactly two attempts — never a third.
    expect(h.state.threadCalls).toBe(2)
    // Block-1 semantics unchanged: hydrated stays true, error is surfaced
    // via getLastError() so the bootstrap resync escalates + retries later.
    expect(repo.isHydrated()).toBe(true)
    expect(repo.getLastError()).not.toBeNull()
    expect(vi.mocked(logError)).toHaveBeenCalledWith(
      'chat.repository.initialize_failed',
      expect.anything(),
      { uid: 'user-1' },
    )
  })

  it('does NOT retry on non-lock errors (single attempt, error surfaced)', async () => {
    h.state.threadResults = [
      { data: null, error: { message: 'permission denied for table chat_threads', details: '', hint: '', code: '42501' } },
    ]

    const repo = new SupabaseChatRepository()
    await repo.initialize()

    expect(h.state.threadCalls).toBe(1)
    expect(repo.isHydrated()).toBe(true)
    expect(repo.getLastError()).not.toBeNull()
    expect(vi.mocked(logInfo)).not.toHaveBeenCalledWith(
      'chat.repository.auth_lock_retry',
      expect.anything(),
    )
  })
})
