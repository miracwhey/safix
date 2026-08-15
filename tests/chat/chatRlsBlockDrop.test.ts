import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the moderationService BEFORE importing the workflow so the
// getBlockedUserIdsSync reference inside chatWorkflow.ts resolves to our spy.
const blockedSet = new Set<string>()
vi.mock('../../src/lib/moderation/moderationService', () => ({
  getBlockedUserIdsSync: () => blockedSet,
  // isBlockedByCounterpart was removed from chatWorkflow imports in M3,
  // but other modules may still import it — keep export available.
  isBlockedByCounterpart: vi.fn(async () => false),
  getBlockedUserIds: vi.fn(async () => Array.from(blockedSet)),
  refreshBlockCache: vi.fn(async () => undefined),
}))

import { InMemoryChatRepository } from '../../src/lib/chat/repository/InMemoryChatRepository'
import { setChatRepository } from '../../src/lib/chat/repository/registry'
import { sendMessageWorkflow } from '../../src/lib/workflow/chatWorkflow'
import type { ChatThreadViewModel } from '../../src/lib/chat/types'

/**
 * M3 Silent Block Drop — workflow-layer invariants.
 *
 * Real RLS enforcement (chat_messages_select_participant + is_blocked_by_me
 * SECURITY DEFINER helper) can only be verified end-to-end against a live
 * Postgres instance — covered by real-device smoke checklist in
 * ~/.claude/plans/chat-architecture-block-d-slice-2-m3-silent-block-drop.md
 *
 * These tests guard the client-side contract:
 *   1. Inbound block (counterpart blocked me) does NOT throw at workflow.
 *      Pre-M3 it threw 'Nachricht kann nicht gesendet werden.' Post-M3 the
 *      INSERT goes through and RLS hides the row from the blocker on SELECT.
 *   2. Outbound block (I blocked counterpart) DOES throw — UX-intentional toast.
 */

function makeThread(): ChatThreadViewModel {
  const now = Date.now()
  return {
    id: 't-block-m3',
    channelType: 'customer',
    customerUserId: 'cust-A',
    craftsmanUserId: 'craft-B',
    providerId: 'prov-1',
    legacyThreadId: null,
    legacySource: null,
    title: null,
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

describe('M3 Silent Block Drop — workflow invariants', () => {
  let repo: InMemoryChatRepository

  beforeEach(async () => {
    blockedSet.clear()
    repo = new InMemoryChatRepository()
    await repo.initialize()
    setChatRepository(repo)
    repo._seedThread(makeThread())
  })

  it('inbound block: workflow does NOT throw — RLS is the single source of truth', async () => {
    // Setup: craft-B is the sender. cust-A has blocked craft-B (inbound from
    // craft-B's perspective). The sync block-cache here represents craft-B's
    // own blocks (empty — craft-B has not blocked anyone). Pre-M3, the workflow
    // would have made a Supabase round-trip to user_blocks and thrown. Post-M3,
    // that check is removed. The send must succeed at the workflow layer; the
    // server-side RLS silently filters the row from cust-A on SELECT.
    const msg = await sendMessageWorkflow({
      threadId: 't-block-m3',
      body: 'hello from inbound-blocked sender',
      clientMessageId: 'cmid-m3-inbound',
      callerRole: 'craftsman',
      currentUserId: 'craft-B',
    })

    expect(msg.body).toBe('hello from inbound-blocked sender')
    expect(repo.getMessages('t-block-m3')).toHaveLength(1)
  })

  it('outbound block: workflow still throws — UX toast preserved', async () => {
    // Setup: craft-B has blocked cust-A. craft-B tries to send to cust-A.
    // The sync block-cache for craft-B contains cust-A. The workflow must
    // throw so the UI can show "Nutzer ist blockiert" toast.
    blockedSet.add('cust-A')

    await expect(
      sendMessageWorkflow({
        threadId: 't-block-m3',
        body: 'should not reach the wire',
        clientMessageId: 'cmid-m3-outbound',
        callerRole: 'craftsman',
        currentUserId: 'craft-B',
      }),
    ).rejects.toThrow(/Nutzer ist blockiert/)

    // Ensure no row was inserted
    expect(repo.getMessages('t-block-m3')).toHaveLength(0)
  })

  it('no currentUserId provided in customer channel: workflow rejects (Stage 3b guard)', async () => {
    await expect(
      sendMessageWorkflow({
        threadId: 't-block-m3',
        body: 'cold start no session',
        clientMessageId: 'cmid-m3-nosession',
        callerRole: 'craftsman',
        currentUserId: null,
      }),
    ).rejects.toThrow(/Sitzung wird verbunden/)
  })
})
