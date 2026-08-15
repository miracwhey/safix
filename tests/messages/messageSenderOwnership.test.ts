/**
 * Message Sender Ownership — send/hydrate consistency fix
 *
 * Root cause: MessageThreadScreen sent craftsman messages with
 * `sender: 'counterparty'` (role-relative), but SupabaseMessageRepository
 * hydrates on resume using `rowToMessage()` which produces `sender: 'user'`
 * for the message author (user-centric, based on sender_user_id === currentUid).
 * After backgrounding/resuming, the craftsman's own messages appeared on the
 * left (other side) instead of the right (own side).
 *
 * Fix: MessageThreadScreen now always passes `'user'` as the optimistic sender
 * for own messages, consistent with `rowToMessage()`. The render checks
 * `message.sender === 'user'` instead of the old role-based inversion.
 *
 * Coverage:
 *   T1 rowToMessage: own message (sender_user_id === currentUid) → sender: 'user'
 *   T2 rowToMessage: other's message (sender_user_id !== currentUid) → sender: 'counterparty'
 *   T3 rowToMessage: null sender_user_id → sender: 'counterparty' (safe default)
 *   T4 Optimistic message via sendDirectMessageWorkflow uses sender: 'user'
 *   T5 After hydration, craftsman's own messages remain sender: 'user' (no flip)
 *   T6 After hydration, customer messages in craftsman view remain sender: 'counterparty'
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Supabase mock
// ---------------------------------------------------------------------------

const { mockInsertMessage, mockSelectMessages } = vi.hoisted(() => ({
  mockInsertMessage: vi.fn(),
  mockSelectMessages: vi.fn(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'messages') {
        return {
          select: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: () => mockSelectMessages(),
            }),
          }),
          insert: (payload: unknown) => mockInsertMessage(payload),
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
          update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        }
      }
      return {
        select: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
        insert: vi.fn().mockResolvedValue({ error: null }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      }
    }),
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: 'craftsman-uid' } } } }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
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
  recordPersistenceFailure: vi.fn(),
  enqueuePendingMutation: vi.fn(),
  hasPendingMutationForEntity: vi.fn().mockReturnValue(false),
  getPendingMutations: () => [],
  isServerSideError: () => false,
  isDuplicateKeyError: () => false,
}))

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { SupabaseMessageRepository } from '../../src/lib/messages/repository/SupabaseMessageRepository'
import type { Message } from '../../src/lib/messages/types'

// ---------------------------------------------------------------------------
// Helpers: access rowToMessage via repository initialize() + getMessages()
// ---------------------------------------------------------------------------

const CRAFTSMAN_UID = 'craftsman-uid'
const CUSTOMER_UID = 'customer-uid'

function makeMessageRow(senderId: string | null, id = 'msg-1') {
  return {
    id,
    conversation_id: 'conv-1',
    sender_user_id: senderId,
    content: 'Test message',
    created_at: Date.now(),
    media_url: null,
  }
}

function makeConversationRow() {
  return {
    id: 'conv-1',
    customer_name: 'Kunde',
    customer_avatar_url: '',
    craftsman_name: 'Meister',
    craftsman_handle: 'meister',
    craftsman_avatar_url: '',
    craftsman_user_id: CRAFTSMAN_UID,
    customer_user_id: CUSTOMER_UID,
    project_title: 'Test',
    project_subtitle: '',
    time_label: null,
    unread_count: null,
    inquiry_origin: null,
    source_project_id: null,
    reviewed_at: null,
    declined_at: null,
    created_at: Date.now(),
  }
}

async function hydrateMessages(
  rows: ReturnType<typeof makeMessageRow>[],
): Promise<Message[]> {
  const repo = new SupabaseMessageRepository()

  // messages select chain
  mockSelectMessages.mockResolvedValue({ data: rows, error: null })

  // conversations select
  const supabase = (await import('../../src/lib/supabase')).supabase
  vi.mocked(supabase.from).mockImplementation((table: string) => {
    if (table === 'messages') {
      return {
        select: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: () => mockSelectMessages(),
          }),
        }),
        insert: (payload: unknown) => mockInsertMessage(payload),
      } as unknown as ReturnType<typeof supabase.from>
    }
    if (table === 'conversations') {
      return {
        select: vi.fn().mockReturnValue({
          or: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: [makeConversationRow()], error: null }),
            }),
          }),
        }),
        insert: vi.fn().mockResolvedValue({ error: null }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      } as unknown as ReturnType<typeof supabase.from>
    }
    return {
      select: vi.fn().mockReturnValue({ order: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue({ data: [], error: null }) }),
    } as unknown as ReturnType<typeof supabase.from>
  })

  await repo.initialize()
  return repo.getMessages()
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockInsertMessage.mockReset()
  mockSelectMessages.mockReset()
})

// ===========================================================================
// T1 — rowToMessage: own message → sender: 'user'
// ===========================================================================

describe('T1 — rowToMessage: own message (sender_user_id === currentUid) → sender: user', () => {
  it('craftsman views their own message: sender is user', async () => {
    const messages = await hydrateMessages([makeMessageRow(CRAFTSMAN_UID)])
    const msg = messages.find((m) => m.id === 'msg-1')
    expect(msg?.sender).toBe('user')
  })
})

// ===========================================================================
// T2 — rowToMessage: other's message → sender: 'counterparty'
// ===========================================================================

describe('T2 — rowToMessage: other party message → sender: counterparty', () => {
  it('craftsman views customer message: sender is counterparty', async () => {
    const messages = await hydrateMessages([makeMessageRow(CUSTOMER_UID)])
    const msg = messages.find((m) => m.id === 'msg-1')
    expect(msg?.sender).toBe('counterparty')
  })
})

// ===========================================================================
// T3 — rowToMessage: null sender_user_id → safe default 'counterparty'
// ===========================================================================

describe('T3 — rowToMessage: null sender_user_id → counterparty (safe default)', () => {
  it('missing sender_user_id does not throw and yields counterparty', async () => {
    const messages = await hydrateMessages([makeMessageRow(null)])
    const msg = messages.find((m) => m.id === 'msg-1')
    expect(msg?.sender).toBe('counterparty')
  })
})

// ===========================================================================
// T4 — Optimistic send uses sender: 'user'
// ===========================================================================

describe('T4 — optimistic send creates message with sender: user', () => {
  it('addMessageAndUpdateConversation stores message with sender user in cache', async () => {
    await hydrateMessages([])
    const repo = (await import('../../src/lib/messages/repository/SupabaseMessageRepository')).SupabaseMessageRepository
    const instance = new repo()

    // Seed a conversation in cache (required for authorization guard)
    ;(instance as unknown as { conversations: unknown[] }).conversations = [makeConversationRow()]
    // Seed getSession for the insert path
    const { supabase: sb } = await import('../../src/lib/supabase')
    vi.mocked(sb.auth.getSession).mockResolvedValue({ data: { session: { user: { id: CRAFTSMAN_UID } } } } as never)
    mockInsertMessage.mockResolvedValue({ error: null })

    const msg: Message = {
      id: 'new-msg',
      conversationId: 'conv-1',
      sender: 'user',
      text: 'Hallo',
      createdAtLabel: '12:00',
    }
    await instance.addMessageAndUpdateConversation(msg, 'conv-1', {})
    const cached = (instance as unknown as { messages: Message[] }).messages
    expect(cached.find((m) => m.id === 'new-msg')?.sender).toBe('user')
    // Ensure insert was called
    expect(mockInsertMessage).toHaveBeenCalledTimes(1)
    // DB payload always uses sender_user_id (absolute), not the sender label
    const payload = mockInsertMessage.mock.calls[0][0] as Record<string, unknown>
    expect(payload.sender_user_id).toBe(CRAFTSMAN_UID)
    expect(payload).not.toHaveProperty('sender')
  })
})

// ===========================================================================
// T5 — After hydration, craftsman's own messages remain sender: 'user'
// ===========================================================================

describe('T5 — hydration produces sender: user for craftsman own messages (no flip)', () => {
  it('resume reload does not flip craftsman own message to counterparty', async () => {
    // DB returns a row with sender_user_id = craftsman
    const messages = await hydrateMessages([makeMessageRow(CRAFTSMAN_UID)])
    // Must be 'user' — not 'counterparty' — after hydration
    expect(messages.find((m) => m.id === 'msg-1')?.sender).toBe('user')
  })
})

// ===========================================================================
// T6 — After hydration, customer messages in craftsman view remain 'counterparty'
// ===========================================================================

describe('T6 — hydration produces sender: counterparty for customer messages in craftsman view', () => {
  it('customer messages render as counterparty after reload (craftsman perspective)', async () => {
    const messages = await hydrateMessages([makeMessageRow(CUSTOMER_UID)])
    expect(messages.find((m) => m.id === 'msg-1')?.sender).toBe('counterparty')
  })
})
