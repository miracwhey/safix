/**
 * Message Conversation Metadata Hardening — isServerSideError guard
 *
 * Root cause: SupabaseMessageRepository called recordPersistenceFailure
 * unconditionally on both non-critical conversation metadata update paths
 * (updateConversation and the post-send conversations UPDATE inside
 * addMessageAndUpdateConversation). A permanent server-side error (42501 RLS,
 * 42xxx schema, 23xxx constraint) on these fire-and-forget writes triggered
 * isPermanentKind → immediate SyncStatusBar escalation, even though the
 * message itself was already persisted.
 *
 * Fix: both paths now guard recordPersistenceFailure behind !isServerSideError.
 * The user-initiated messages INSERT path (Callsite C) is unchanged.
 * addConversation (Callsite A) is unchanged.
 *
 * Coverage:
 *   T1 post-send conv UPDATE 42501 → no persistence failure recorded
 *   T2 post-send conv UPDATE 42xxx (schema) → no persistence failure recorded
 *   T3 post-send conv UPDATE transient → persistence failure IS recorded
 *   T4 standalone updateConversation 42501 → no persistence failure recorded
 *   T5 standalone updateConversation transient → persistence failure IS recorded
 *   T6 messages INSERT permanent (user-initiated) → persistence failure IS recorded (unchanged)
 *   T7 messages INSERT transient (user-initiated) → failure recorded + enqueue (unchanged)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockRecordPersistenceFailure,
  mockEnqueue,
  mockMessagesInsert,
  mockConversationsUpdateEq,
} = vi.hoisted(() => ({
  mockRecordPersistenceFailure: vi.fn(),
  mockEnqueue: vi.fn(),
  mockMessagesInsert: vi.fn(),
  mockConversationsUpdateEq: vi.fn(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'messages') {
        return {
          select: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
          insert: (payload: unknown) => mockMessagesInsert(payload),
        }
      }
      if (table === 'conversations') {
        return {
          select: vi.fn().mockReturnValue({
            or: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          }),
          insert: vi.fn().mockResolvedValue({ error: null }),
          update: vi.fn().mockReturnValue({
            eq: (col: string, val: string) => mockConversationsUpdateEq(col, val),
          }),
        }
      }
      return {
        select: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      }
    }),
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'uid-owner' } } },
      }),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
    },
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

vi.mock('../../src/lib/persistence', () => ({
  recordPersistenceFailure: (input: unknown) => mockRecordPersistenceFailure(input),
  enqueuePendingMutation: (input: unknown) => mockEnqueue(input),
  getPendingMutations: () => [],
  hasPendingMutationForEntity: vi.fn().mockReturnValue(false),
  hasPersistenceFailureForEntity: vi.fn().mockReturnValue(false),
  isServerSideError: (error: unknown) => {
    if (typeof error !== 'object' || error === null) return false
    const e = error as Record<string, unknown>
    if (typeof e.code !== 'string') return false
    return e.code.startsWith('22') || e.code.startsWith('23') || e.code.startsWith('42')
  },
  isDuplicateKeyError: (error: unknown) => {
    if (typeof error !== 'object' || error === null) return false
    const e = error as Record<string, unknown>
    return e.code === '23505'
  },
}))

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { SupabaseMessageRepository } from '../../src/lib/messages/repository/SupabaseMessageRepository'
import type { Conversation, Message } from '../../src/lib/messages/types'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const RLS_VIOLATION = { code: '42501', message: 'new row violates row-level security policy' }
const SCHEMA_ERROR  = { code: '42703', message: 'column "x" does not exist' }
const TRANSIENT     = { code: 'PGRST000', message: 'network timeout' }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = Date.now()

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    projectId: '',
    customerName: 'Max Mustermann',
    customerAvatarUrl: '',
    craftsmanName: 'Hans Meister',
    craftsmanHandle: 'hans',
    craftsmanAvatarUrl: '',
    projectTitle: 'Bad',
    projectSubtitle: 'Renovierung',
    createdAt: now,
    ...overrides,
  }
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    sender: 'user',
    text: 'Hallo',
    createdAtLabel: '10:00',
    sentAt: now,
    ...overrides,
  }
}

function freshRepo(): SupabaseMessageRepository {
  const repo = new SupabaseMessageRepository()
  const r = repo as unknown as {
    _hydrated: boolean
    currentUid: string | null
    conversations: Conversation[]
    messages: Message[]
  }
  r._hydrated = true
  r.currentUid = 'uid-owner'
  r.conversations = [makeConversation()]
  r.messages = []
  return repo
}

/** Flush the microtask queue so fire-and-forget .then() callbacks run. */
async function flush() {
  await new Promise((r) => setTimeout(r, 0))
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockRecordPersistenceFailure.mockReset()
  mockEnqueue.mockReset()
  mockMessagesInsert.mockReset()
  mockConversationsUpdateEq.mockReset()
})

// ===========================================================================
// T1 — post-send conversations UPDATE 42501 → no persistence failure
// ===========================================================================

describe('T1 — successful send + 42501 conversations UPDATE → no persistence failure', () => {
  it('recordPersistenceFailure is NOT called when conv metadata update hits RLS', async () => {
    const repo = freshRepo()
    mockMessagesInsert.mockResolvedValue({ error: null })
    mockConversationsUpdateEq.mockResolvedValue({ error: RLS_VIOLATION })

    await repo.addMessageAndUpdateConversation(makeMessage(), 'conv-1', {})
    await flush()

    expect(mockRecordPersistenceFailure).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// T2 — post-send conversations UPDATE 42xxx schema error → no persistence failure
// ===========================================================================

describe('T2 — successful send + 42xxx schema error conversations UPDATE → no persistence failure', () => {
  it('recordPersistenceFailure is NOT called for class-42 schema errors on conv update', async () => {
    const repo = freshRepo()
    mockMessagesInsert.mockResolvedValue({ error: null })
    mockConversationsUpdateEq.mockResolvedValue({ error: SCHEMA_ERROR })

    await repo.addMessageAndUpdateConversation(makeMessage(), 'conv-1', {})
    await flush()

    expect(mockRecordPersistenceFailure).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// T3 — post-send conversations UPDATE transient → persistence failure IS recorded
// ===========================================================================

describe('T3 — successful send + transient conversations UPDATE → persistence failure recorded', () => {
  it('recordPersistenceFailure IS called for non-server-side (transient) conv update errors', async () => {
    const repo = freshRepo()
    mockMessagesInsert.mockResolvedValue({ error: null })
    mockConversationsUpdateEq.mockResolvedValue({ error: TRANSIENT })

    await repo.addMessageAndUpdateConversation(makeMessage(), 'conv-1', {})
    await flush()

    expect(mockRecordPersistenceFailure).toHaveBeenCalledTimes(1)
    const call = mockRecordPersistenceFailure.mock.calls[0][0] as Record<string, unknown>
    expect(call.domain).toBe('messages')
    expect(call.operation).toBe('update')
    expect(call.entityId).toBe('conv-1')
  })
})

// ===========================================================================
// T4 — standalone updateConversation 42501 → no persistence failure
// ===========================================================================

describe('T4 — standalone updateConversation 42501 → no persistence failure', () => {
  it('recordPersistenceFailure is NOT called when standalone conv metadata update hits RLS', async () => {
    const repo = freshRepo()
    mockConversationsUpdateEq.mockResolvedValue({ error: RLS_VIOLATION })

    repo.updateConversation('conv-1', { projectTitle: 'Neu' })
    await flush()

    expect(mockRecordPersistenceFailure).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// T5 — standalone updateConversation transient → persistence failure IS recorded
// ===========================================================================

describe('T5 — standalone updateConversation transient → persistence failure recorded', () => {
  it('recordPersistenceFailure IS called for non-server-side (transient) standalone conv update', async () => {
    const repo = freshRepo()
    mockConversationsUpdateEq.mockResolvedValue({ error: TRANSIENT })

    repo.updateConversation('conv-1', { projectTitle: 'Neu' })
    await flush()

    expect(mockRecordPersistenceFailure).toHaveBeenCalledTimes(1)
    const call = mockRecordPersistenceFailure.mock.calls[0][0] as Record<string, unknown>
    expect(call.domain).toBe('messages')
    expect(call.operation).toBe('update')
    expect(call.entityId).toBe('conv-1')
  })
})

// ===========================================================================
// T6 — messages INSERT permanent (user-initiated) → failure IS recorded (unchanged)
// ===========================================================================

describe('T6 — messages INSERT permanent error → persistence failure recorded (user-initiated path unchanged)', () => {
  it('recordPersistenceFailure IS called when message INSERT fails with 42501', async () => {
    const repo = freshRepo()
    mockMessagesInsert.mockResolvedValue({ error: RLS_VIOLATION })
    mockConversationsUpdateEq.mockResolvedValue({ error: null })

    await repo.addMessageAndUpdateConversation(makeMessage(), 'conv-1', {}).catch(() => {})

    expect(mockRecordPersistenceFailure).toHaveBeenCalledTimes(1)
    const call = mockRecordPersistenceFailure.mock.calls[0][0] as Record<string, unknown>
    expect(call.domain).toBe('messages')
    expect(call.operation).toBe('add')
    expect(call.entityId).toBe('msg-1')
  })
})

// ===========================================================================
// T7 — messages INSERT transient → failure recorded + enqueue (unchanged)
// ===========================================================================

describe('T7 — messages INSERT transient → failure recorded + enqueue (user-initiated path unchanged)', () => {
  it('recordPersistenceFailure and enqueuePendingMutation both called for transient INSERT failure', async () => {
    const repo = freshRepo()
    mockMessagesInsert.mockResolvedValue({ error: TRANSIENT })
    mockConversationsUpdateEq.mockResolvedValue({ error: null })

    await repo.addMessageAndUpdateConversation(makeMessage(), 'conv-1', {}).catch(() => {})

    expect(mockRecordPersistenceFailure).toHaveBeenCalledTimes(1)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    const enqCall = mockEnqueue.mock.calls[0][0] as Record<string, unknown>
    expect(enqCall.domain).toBe('messages')
    expect(enqCall.operation).toBe('insert')
    expect(enqCall.entityId).toBe('msg-1')
  })
})
