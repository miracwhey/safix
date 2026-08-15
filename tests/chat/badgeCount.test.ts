import { describe, it, expect } from 'vitest'
import { computeBadgeUnreadCount } from '../../src/lib/chat/chatStore'
import type { ChatThreadViewModel, UserNotificationPreference, ChatChannelType } from '../../src/lib/chat/types'

function thread(id: string, channelType: ChatChannelType, unread: number): ChatThreadViewModel {
  const now = Date.now()
  return {
    id,
    channelType,
    customerUserId: null,
    craftsmanUserId: null,
    providerId: null,
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
    unreadCount: unread,
    migrationStatus: 'migration_complete',
  }
}

const defaultPref: UserNotificationPreference = {
  userId: 'u',
  quietHoursStart: null,
  quietHoursEnd: null,
  isAlwaysReachable: false,
  countCustomerChatUnread: true,
  countOfficeChatUnread: false,
  countTeamChatUnread: false,
  countAssignmentChatUnread: false,
  countDisputeChatUnread: true,
  createdAt: 0,
  updatedAt: 0,
}

describe('computeBadgeUnreadCount', () => {
  it('customer role only counts customer-channel and respects pref', () => {
    const threads = [
      thread('a', 'customer', 3),
      thread('b', 'customer', 2),
      thread('c', 'office', 5), // ignored
      thread('d', 'team', 4),    // ignored
    ]
    expect(computeBadgeUnreadCount(threads, defaultPref, 'customer')).toBe(5)

    const offPref = { ...defaultPref, countCustomerChatUnread: false }
    expect(computeBadgeUnreadCount(threads, offPref, 'customer')).toBe(0)
  })

  it('worker role excludes customer-channel always (architectural invariant)', () => {
    const threads = [
      thread('a', 'customer', 99), // forbidden, should be 0
      thread('b', 'assignment', 4),
      thread('c', 'team', 2),
    ]
    const allEnabledPref: UserNotificationPreference = {
      ...defaultPref,
      countCustomerChatUnread: true,
      countAssignmentChatUnread: true,
      countTeamChatUnread: true,
    }
    expect(computeBadgeUnreadCount(threads, allEnabledPref, 'worker')).toBe(6)
  })

  it('worker role counts assignment by default even without pref entry', () => {
    const threads = [thread('a', 'assignment', 7)]
    expect(computeBadgeUnreadCount(threads, undefined, 'worker')).toBe(7)
  })

  it('craftsman with default pref counts customer + dispute, ignores office/team/assignment', () => {
    const threads = [
      thread('a', 'customer', 1),
      thread('b', 'office', 5),    // off by default
      thread('c', 'team', 3),       // off by default
      thread('d', 'assignment', 2), // off by default for craftsman
      thread('e', 'dispute', 4),
    ]
    expect(computeBadgeUnreadCount(threads, defaultPref, 'craftsman')).toBe(5) // 1 + 4
  })

  it('craftsman with all-on pref counts every channel', () => {
    const threads = [
      thread('a', 'customer', 1),
      thread('b', 'office', 5),
      thread('c', 'team', 3),
      thread('d', 'assignment', 2),
      thread('e', 'dispute', 4),
    ]
    const onPref: UserNotificationPreference = {
      ...defaultPref,
      countOfficeChatUnread: true,
      countTeamChatUnread: true,
      countAssignmentChatUnread: true,
    }
    expect(computeBadgeUnreadCount(threads, onPref, 'craftsman')).toBe(15)
  })

  it('skips threads with unreadCount <= 0', () => {
    const threads = [
      thread('a', 'customer', 0),
      thread('b', 'customer', -1),
      thread('c', 'customer', 2),
    ]
    expect(computeBadgeUnreadCount(threads, defaultPref, 'customer')).toBe(2)
  })

  it('returns 0 for empty thread list', () => {
    expect(computeBadgeUnreadCount([], defaultPref, 'craftsman')).toBe(0)
  })
})
