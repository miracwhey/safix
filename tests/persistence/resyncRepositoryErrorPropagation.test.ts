/**
 * Resume-robustness Block 1 (chat-resume-crash, Fix B) —
 * resyncRepositories must surface message/chat reload failures.
 *
 * Root cause: SupabaseMessageRepository.initialize() and
 * SupabaseChatRepository.loadForUser() swallow fetch errors internally
 * (they always resolve and only record the failure via getLastError()).
 * The Promise.all inside resyncRepositories() therefore resolved even when
 * the reload genuinely failed → getOrStartResyncWave (session.ts) advanced
 * lastResyncAt → the next online/resume retry was debounced away for 30s
 * ("sticky" failed resync).
 *
 * Contract under test:
 *   1. resyncRepositories rejects when the message repository reports a
 *      reload error via getLastError().
 *   2. Same for the chat repository.
 *   3. A rejected resync does NOT clear recorded persistence failures —
 *      the divergence signal must remain visible (function doc contract).
 *   4. With clean repositories resyncRepositories resolves and clears
 *      persistence failures (existing behavior unchanged).
 *
 * The session.ts side needs no change: getOrStartResyncWave already
 * refuses to advance lastResyncAt in its .catch branch.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

// Defensive supabase mock — the resync path in this test runs entirely on
// InMemory repositories, but importing src/lib/bootstrap transitively loads
// every Supabase* repository module. No call may hit the network.
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
    from: vi.fn().mockImplementation(() => ({
      select: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      insert: vi.fn().mockResolvedValue({ error: null }),
    })),
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    }),
    removeChannel: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

import { resyncRepositories } from '../../src/lib/bootstrap'
import {
  setMessageRepository,
  InMemoryMessageRepository,
} from '../../src/lib/messages/repository'
import {
  setChatRepository,
  InMemoryChatRepository,
} from '../../src/lib/chat/repository'
import {
  recordPersistenceFailure,
  hasPersistenceFailures,
  clearPersistenceFailures,
} from '../../src/lib/persistence'

class FailingMessageRepository extends InMemoryMessageRepository {
  getLastError(): string | null {
    return 'Nachrichten konnten nicht geladen werden.'
  }
}

class FailingChatRepository extends InMemoryChatRepository {
  getLastError(): string | null {
    return 'Chat konnte nicht geladen werden.'
  }
}

afterEach(() => {
  // Restore clean in-memory repositories + failure store for sibling suites.
  setMessageRepository(new InMemoryMessageRepository())
  setChatRepository(new InMemoryChatRepository())
  clearPersistenceFailures()
})

describe('resyncRepositories — repository reload error propagation', () => {
  it('rejects when the message repository reports a reload error', async () => {
    setMessageRepository(new FailingMessageRepository())

    await expect(resyncRepositories()).rejects.toThrow(/messages/)
  })

  it('rejects when the chat repository reports a reload error', async () => {
    setChatRepository(new FailingChatRepository())

    await expect(resyncRepositories()).rejects.toThrow(/chat/)
  })

  it('names both domains when both repositories failed', async () => {
    setMessageRepository(new FailingMessageRepository())
    setChatRepository(new FailingChatRepository())

    await expect(resyncRepositories()).rejects.toThrow(/messages.*chat/)
  })

  it('does NOT clear persistence failures when the resync rejects', async () => {
    recordPersistenceFailure({
      domain: 'messages',
      entityId: 'msg-divergent-1',
      operation: 'add',
      error: new Error('insert failed'),
      occurredAt: Date.now(),
    })
    expect(hasPersistenceFailures()).toBe(true)

    setMessageRepository(new FailingMessageRepository())
    await expect(resyncRepositories()).rejects.toThrow()

    // Divergence signal must survive the failed resync.
    expect(hasPersistenceFailures()).toBe(true)
  })

  it('resolves and clears persistence failures when all repositories reload cleanly', async () => {
    recordPersistenceFailure({
      domain: 'messages',
      entityId: 'msg-divergent-2',
      operation: 'add',
      error: new Error('insert failed'),
      occurredAt: Date.now(),
    })
    expect(hasPersistenceFailures()).toBe(true)

    await expect(resyncRepositories()).resolves.toBeUndefined()
    expect(hasPersistenceFailures()).toBe(false)
  })
})
