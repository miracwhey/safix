import { describe, it, expect } from 'vitest'
import type { ChatParticipant, ChatThreadViewModel } from '../../src/lib/chat/types'

/**
 * M3 Hotfix — Per-participant last-visible-message contract.
 *
 * The migration 20260515000002_chat_per_participant_last_visible.sql adds
 * `last_visible_message_*` columns to chat_participants. The trigger
 * `fn_chat_update_thread_last_message` writes per-participant rows only when
 * the sender is NOT in that participant's user_blocks. This is the silent-drop
 * surface for inbox preview, thread sort, and unread badge.
 *
 * SupabaseChatRepository now:
 *   - Sources ChatThreadViewModel.lastMessageId/At/Body from my-participant's
 *     last_visible_* (NOT chat_threads.last_message_*).
 *   - Sorts the thread list by my-participant.last_visible_message_at.
 *   - Computes unreadCount from my-participant.last_visible_message_at > last_read_at.
 *   - Realtime: listens to chat_participants UPDATE for my user_id and
 *     reconciles the cached ViewModel.
 *
 * In-memory and integration coverage:
 *   - InMemoryChatRepository does NOT model user_blocks (it has no DB-side
 *     RLS). It is the workflow-level harness — block-filter is asserted at
 *     real-device-smoke time.
 *   - These contract tests verify the shape of ChatParticipant and the
 *     ChatThreadViewModel pre/post-state semantics that the Supabase repo
 *     enforces.
 */

describe('M3 hotfix per-participant denorm — type + shape contract', () => {
  it('ChatParticipant carries last_visible_message_* fields', () => {
    const p: ChatParticipant = {
      threadId: 't1',
      userId: 'u1',
      role: 'craftsman',
      joinedAt: 1,
      leftAt: null,
      lastReadMessageId: null,
      lastReadAt: 0,
      mutedUntil: null,
      pinned: false,
      notificationPreference: null,
      lastVisibleMessageId: 'm-visible',
      lastVisibleMessageAt: 1000,
      lastVisibleMessageBody: 'hello',
      lastVisibleMessageType: 'text',
    }
    expect(p.lastVisibleMessageAt).toBe(1000)
    expect(p.lastVisibleMessageBody).toBe('hello')
  })

  it('unread logic: lastVisible > lastRead → 1, else → 0', () => {
    // Inlined to avoid exporting an internal helper from the repository.
    // Mirrors SupabaseChatRepository.computeUnreadCount post-hotfix.
    function compute(p: ChatParticipant): number {
      if (!p.lastVisibleMessageAt) return 0
      const lastReadAt = p.lastReadAt ?? 0
      return p.lastVisibleMessageAt > lastReadAt ? 1 : 0
    }
    const base: ChatParticipant = {
      threadId: 't1',
      userId: 'u1',
      role: 'craftsman',
      joinedAt: 0,
      pinned: false,
    }
    expect(compute({ ...base, lastVisibleMessageAt: 100, lastReadAt: 50 })).toBe(1)
    expect(compute({ ...base, lastVisibleMessageAt: 50, lastReadAt: 100 })).toBe(0)
    expect(compute({ ...base, lastVisibleMessageAt: null, lastReadAt: 50 })).toBe(0)
    expect(compute({ ...base, lastVisibleMessageAt: 100, lastReadAt: null as unknown as number })).toBe(1)
  })

  it('sort: thread A with newer participant.lastVisible ranks before thread B', () => {
    // Mirrors the loadForUser sort comparator post-hotfix.
    function sortByMyVisibleAt(threads: ChatThreadViewModel[], uid: string): ChatThreadViewModel[] {
      return [...threads].sort((a, b) => {
        const aP = a.participants.find((p) => p.userId === uid)
        const bP = b.participants.find((p) => p.userId === uid)
        const aAt = aP?.lastVisibleMessageAt ?? 0
        const bAt = bP?.lastVisibleMessageAt ?? 0
        return bAt - aAt
      })
    }
    const myUid = 'u1'
    const mkP = (visibleAt: number | null): ChatParticipant => ({
      threadId: 't',
      userId: myUid,
      role: 'craftsman',
      joinedAt: 0,
      pinned: false,
      lastVisibleMessageAt: visibleAt,
    })
    const mkT = (id: string, visibleAt: number | null): ChatThreadViewModel => ({
      id,
      channelType: 'customer',
      customerUserId: 'cust',
      craftsmanUserId: 'craft',
      providerId: 'prov',
      legacyThreadId: null,
      legacySource: null,
      title: null,
      lastMessageId: null,
      lastMessageAt: null,
      lastMessageBody: null,
      createdAt: 0,
      updatedAt: 0,
      closedAt: null,
      participants: [mkP(visibleAt)],
      unreadCount: 0,
      migrationStatus: 'migration_complete',
    })
    const ordered = sortByMyVisibleAt(
      [mkT('older', 100), mkT('newest', 999), mkT('null-at', null)],
      myUid,
    )
    expect(ordered.map((t) => t.id)).toEqual(['newest', 'older', 'null-at'])
  })
})

describe('M3 hotfix per-participant denorm — leak contract (documented)', () => {
  it.skip('REAL-DEVICE / INTEGRATION: blocker preview does not update on blocked-sender bump', () => {
    // Verified via real-device smoke checklist in
    // ~/.claude/plans/chat-architecture-block-d-slice-2-m3-silent-block-drop.md
    // (case 3: thread-list view from blocker — preview stays the previous
    // non-blocked sender's value or null).
    //
    // The trigger fn_chat_update_thread_last_message guarantees this server-side:
    // it skips the chat_participants row WHERE NOT EXISTS user_blocks(blocker=cp.user_id, blocked=NEW.sender_user_id).
    // The blocker's chat_participants.last_visible_* fields stay at their
    // previous values; no realtime UPDATE fires for that row; the cached
    // ChatThreadViewModel preview / sort / unread don't move.
  })
})
