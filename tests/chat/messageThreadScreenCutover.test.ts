import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryChatRepository } from '../../src/lib/chat/repository/InMemoryChatRepository'
import {
  setChatRepository,
} from '../../src/lib/chat/repository/registry'
import {
  sendMessageWorkflow,
  markThreadReadWorkflow,
  sendAttachmentMessageWorkflow,
  ChatRBACError,
} from '../../src/lib/workflow/chatWorkflow'
import type {
  ChatChannelType,
  ChatThreadViewModel,
} from '../../src/lib/chat/types'

/**
 * Stage 3b — MessageThreadScreen cutover mitigation tests.
 *
 * Covers the five P0/P1 audit risks identified during Stage 3a and applied
 * to the customer↔craftsman compose-screen cutover:
 *   R1 — legacy-cache mis-routing (P0)        — URL pattern guarantees
 *                                                resolveCanonicalThreadId is
 *                                                identity-stable; no bypass
 *                                                required.  Covered by
 *                                                chatWorkflow.test.ts.
 *   R2 — non-cutover-aware retry (P0)         — handleChatThreadRetry tested
 *                                                via re-resolution path.
 *   R3 — markRead spam (P1)                   — dedupe-ref pattern.
 *   R4 — non-reactive currentUserId (P1)      — UI-only, covered visually.
 *   R5 — double-tap doppel-send (P1)          — sendingRef guard pattern.
 *
 * Plus Stage 3b-specific:
 *   - customer role + customer channel allowed
 *   - craftsman role + customer channel allowed
 *   - worker role + customer channel rejected (defense-in-depth)
 *   - attachment workflow customer-channel callerRole mapping
 */

function makeThread(channelType: ChatChannelType, id = 't-customer'): ChatThreadViewModel {
  const now = Date.now()
  return {
    id,
    channelType,
    customerUserId: 'cust-1',
    craftsmanUserId: 'craft-1',
    providerId: 'prov-1',
    legacyThreadId: 'legacy-conv-1',
    legacySource: 'conversations',
    title: 'Test',
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

describe('Stage 3b — MessageThreadScreen cutover (workflow-level)', () => {
  let repo: InMemoryChatRepository

  beforeEach(async () => {
    repo = new InMemoryChatRepository()
    await repo.initialize()
    setChatRepository(repo)
  })

  it('customer role can send text in customer channel (callerRole mapping)', async () => {
    repo._seedThread(makeThread('customer'))
    await sendMessageWorkflow({
      threadId: 't-customer',
      body: 'Hallo, kannst du das anschauen?',
      clientMessageId: 'cmid-customer-1',
      callerRole: 'customer',
      currentUserId: 'cust-1',
    })
    const messages = repo.getMessages('t-customer')
    expect(messages).toHaveLength(1)
    expect(messages[0].body).toBe('Hallo, kannst du das anschauen?')
  })

  it('craftsman role can send text in customer channel (callerRole mapping)', async () => {
    repo._seedThread(makeThread('customer'))
    await sendMessageWorkflow({
      threadId: 't-customer',
      body: 'Klar, ich melde mich morgen früh.',
      clientMessageId: 'cmid-craftsman-1',
      callerRole: 'craftsman',
      currentUserId: 'craft-1',
    })
    const messages = repo.getMessages('t-customer')
    expect(messages).toHaveLength(1)
    expect(messages[0].body).toBe('Klar, ich melde mich morgen früh.')
  })

  it('worker role rejected in customer channel (defense-in-depth, P0)', async () => {
    repo._seedThread(makeThread('customer'))
    await expect(
      sendMessageWorkflow({
        threadId: 't-customer',
        body: 'should not arrive',
        clientMessageId: 'cmid-worker-deny',
        callerRole: 'worker',
      }),
    ).rejects.toBeInstanceOf(ChatRBACError)
    expect(repo.getMessages('t-customer')).toHaveLength(0)
  })

  it('attachment workflow rejects customer role in office channel (callerRole mapping)', async () => {
    repo._seedThread(makeThread('office', 't-office'))
    const fakeFile = new File(['x'], 'a.png', { type: 'image/png' })
    await expect(
      sendAttachmentMessageWorkflow({
        threadId: 't-office',
        clientMessageId: 'cmid-att-1',
        callerRole: 'customer',
        files: [fakeFile],
      }),
    ).rejects.toBeInstanceOf(ChatRBACError)
  })
})

describe('Stage 3b — moderation parity (block + content)', () => {
  let repo: InMemoryChatRepository

  beforeEach(async () => {
    repo = new InMemoryChatRepository()
    await repo.initialize()
    setChatRepository(repo)
  })

  it('content-filter rejects banned terms in customer channel', async () => {
    repo._seedThread(makeThread('customer'))
    await expect(
      sendMessageWorkflow({
        threadId: 't-customer',
        body: 'du bist ein arschloch',
        clientMessageId: 'cmid-ban-1',
        callerRole: 'customer',
        currentUserId: 'cust-1',
      }),
    ).rejects.toThrow()
    expect(repo.getMessages('t-customer')).toHaveLength(0)
  })

  it('content-filter does NOT run in internal channels (office)', async () => {
    repo._seedThread(makeThread('office', 't-office'))
    // The same body would be blocked in customer channel; office channel
    // is intra-organisation and skips moderation entirely.
    await sendMessageWorkflow({
      threadId: 't-office',
      body: 'wichser-team-banter',
      clientMessageId: 'cmid-office-1',
      callerRole: 'craftsman',
      // currentUserId intentionally absent — internal channels skip the
      // entire moderation phase, so the cold-start guard never fires.
    })
    expect(repo.getMessages('t-office')).toHaveLength(1)
  })

  it('customer channel REJECTS send when currentUserId is null (cold-start defense)', async () => {
    // Without a resolved session the block-check cannot run; a blocked
    // user could otherwise send during the cold-start race between
    // mount and the supabase auth-state-change callback. Workflow
    // throws — screen catches via ChatComposer and keeps the draft.
    repo._seedThread(makeThread('customer'))
    await expect(
      sendMessageWorkflow({
        threadId: 't-customer',
        body: 'plain neutral message',
        clientMessageId: 'cmid-no-uid',
        callerRole: 'customer',
        currentUserId: null,
      }),
    ).rejects.toThrow(/Sitzung wird verbunden/)
    expect(repo.getMessages('t-customer')).toHaveLength(0)
  })
})

describe('Stage 3b — sendingRef guard pattern (R5: double-tap)', () => {
  let repo: InMemoryChatRepository

  beforeEach(async () => {
    repo = new InMemoryChatRepository()
    await repo.initialize()
    setChatRepository(repo)
    repo._seedThread(makeThread('customer'))
  })

  it('two concurrent fires with same sendingRef produce a single message', async () => {
    // Mirrors the screen's handleChatSend(): synchronous ref-set BEFORE
    // any await. Two concurrent calls in the same tick: the second sees
    // sendingRef.current === true and returns early.
    const ref = { current: false }
    let invocations = 0

    async function handleSend(body: string) {
      if (ref.current) return
      ref.current = true
      try {
        invocations += 1
        await sendMessageWorkflow({
          threadId: 't-customer',
          body,
          clientMessageId: `cmid-${invocations}`,
          callerRole: 'customer',
          currentUserId: 'cust-1',
        })
      } finally {
        ref.current = false
      }
    }

    // Simulate two synchronous touch events landing in the same tick.
    const p1 = handleSend('first')
    const p2 = handleSend('second')
    await Promise.all([p1, p2])

    expect(invocations).toBe(1)
    expect(repo.getMessages('t-customer')).toHaveLength(1)
  })

  it('after first send completes, ref releases and a second send goes through', async () => {
    const ref = { current: false }

    async function handleSend(body: string, cmid: string) {
      if (ref.current) return
      ref.current = true
      try {
        await sendMessageWorkflow({
          threadId: 't-customer',
          body,
          clientMessageId: cmid,
          callerRole: 'customer',
          currentUserId: 'cust-1',
        })
      } finally {
        ref.current = false
      }
    }

    await handleSend('first', 'cmid-1')
    await handleSend('second', 'cmid-2')
    expect(repo.getMessages('t-customer')).toHaveLength(2)
  })
})

describe('CHAT-1 — handleChatSend bubble-aware failure handling (workflow-level)', () => {
  // Mirrors MessageThreadScreen.handleChatSend: pre-insert failures
  // (thread_not_found, moderation, cold-start session) throw BEFORE
  // repo.sendMessage, so no optimistic bubble exists as a retry surface —
  // the handler RE-THROWS so ChatComposer keeps the text. Post-insert
  // failures leave a bubble → swallow + register failedTextSends.
  let repo: InMemoryChatRepository

  beforeEach(async () => {
    repo = new InMemoryChatRepository()
    await repo.initialize()
    setChatRepository(repo)
  })

  function makeHandleChatSend(threadId: string) {
    const failedTextSends: Record<string, { body: string; retryCount: number }> = {}
    async function handleChatSend(body: string, clientMessageId: string) {
      try {
        await sendMessageWorkflow({
          threadId,
          body,
          clientMessageId,
          callerRole: 'customer',
          currentUserId: 'cust-1',
        })
      } catch (err) {
        const bubbleExists = repo
          .getMessages(threadId)
          .some((m) => m.clientMessageId === clientMessageId)
        if (!bubbleExists) throw err
        failedTextSends[clientMessageId] = { body, retryCount: 0 }
      }
    }
    return { handleChatSend, failedTextSends }
  }

  it('re-throws when no optimistic bubble exists (thread_not_found keeps composer text)', async () => {
    const { handleChatSend, failedTextSends } = makeHandleChatSend('t-not-cached')
    await expect(handleChatSend('hallo', 'cmid-rethrow')).rejects.toMatchObject({
      code: 'thread_not_found',
    })
    // No orphaned failedTextSends entry without a bubble to anchor it.
    expect(Object.keys(failedTextSends)).toHaveLength(0)
  })

  it('re-throws on moderation rejection (pre-insert, no bubble)', async () => {
    repo._seedThread(makeThread('customer'))
    const { handleChatSend, failedTextSends } = makeHandleChatSend('t-customer')
    await expect(handleChatSend('du bist ein arschloch', 'cmid-mod')).rejects.toThrow()
    expect(Object.keys(failedTextSends)).toHaveLength(0)
    expect(repo.getMessages('t-customer')).toHaveLength(0)
  })

  it('swallows + registers failedTextSends when the optimistic bubble exists', async () => {
    repo._seedThread(makeThread('customer'))
    // Post-insert failure: the repo places the bubble, then the send fails
    // (network/insert error after the optimistic row landed).
    const originalSend = repo.sendMessage.bind(repo)
    repo.sendMessage = (async (input: Parameters<InMemoryChatRepository['sendMessage']>[0]) => {
      await originalSend(input)
      throw new Error('netzwerk: senden fehlgeschlagen')
    }) as InMemoryChatRepository['sendMessage']

    const { handleChatSend, failedTextSends } = makeHandleChatSend('t-customer')
    // Resolves — error swallowed, bubble is the retry surface.
    await handleChatSend('hallo welt', 'cmid-swallow')
    expect(failedTextSends['cmid-swallow']).toEqual({ body: 'hallo welt', retryCount: 0 })
    expect(repo.getMessages('t-customer')).toHaveLength(1)
  })
})

describe('Stage 3b — markRead dedupe pattern (R3: realtime spam)', () => {
  let repo: InMemoryChatRepository
  let markReadInvocations: number
  let originalMark: InMemoryChatRepository['markThreadRead']

  beforeEach(async () => {
    repo = new InMemoryChatRepository()
    await repo.initialize()
    setChatRepository(repo)
    repo._seedThread(makeThread('customer'))

    // Spy on markThreadRead to count repository hits.
    markReadInvocations = 0
    originalMark = repo.markThreadRead.bind(repo)
    repo.markThreadRead = (async (threadId: string, lastMessageId: string) => {
      markReadInvocations += 1
      return originalMark(threadId, lastMessageId)
    }) as InMemoryChatRepository['markThreadRead']
  })

  it('same last-message-id twice = one RPC (dedupe via lastMarkedReadIdRef)', async () => {
    // Mirrors the screen's markRead useEffect: a ref captures the last
    // observed id; if unchanged, no workflow call.
    const ref: { current: string | null } = { current: null }

    function maybeMarkRead(threadId: string, lastId: string) {
      if (ref.current === lastId) return
      ref.current = lastId
      void markThreadReadWorkflow(threadId, lastId)
    }

    maybeMarkRead('t-customer', 'msg-99')
    // Realtime echo with same last id → no second RPC.
    maybeMarkRead('t-customer', 'msg-99')
    // Allow microtasks to settle.
    await Promise.resolve()
    expect(markReadInvocations).toBe(1)
  })

  it('different last-message-id = two RPCs', async () => {
    const ref: { current: string | null } = { current: null }

    function maybeMarkRead(threadId: string, lastId: string) {
      if (ref.current === lastId) return
      ref.current = lastId
      void markThreadReadWorkflow(threadId, lastId)
    }

    maybeMarkRead('t-customer', 'msg-99')
    maybeMarkRead('t-customer', 'msg-100')
    await Promise.resolve()
    expect(markReadInvocations).toBe(2)
  })

  it('thread change resets dedupe key — same last-id in new thread fires RPC', async () => {
    // Set up a second customer thread.
    repo._seedThread(makeThread('customer', 't-customer-2'))
    const ref: { current: string | null } = { current: null }

    function maybeMarkRead(threadId: string, lastId: string) {
      if (ref.current === lastId) return
      ref.current = lastId
      void markThreadReadWorkflow(threadId, lastId)
    }

    maybeMarkRead('t-customer', 'shared-msg-id')
    // Screen useEffect resets ref when chatThreadId changes.
    ref.current = null
    maybeMarkRead('t-customer-2', 'shared-msg-id')
    await Promise.resolve()
    expect(markReadInvocations).toBe(2)
  })
})
