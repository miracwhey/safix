import { describe, it, expect } from 'vitest'
import {
  getChatThreadListRow,
  sortChatThreadsByUnread,
} from '../../src/lib/chat/selectors'
import type { ChatThreadViewModel } from '../../src/lib/chat/types'

function thread(over: Partial<ChatThreadViewModel>): ChatThreadViewModel {
  return {
    id: 'legacy:conversations:abc',
    channelType: 'customer',
    customerUserId: 'cust',
    craftsmanUserId: 'craft',
    providerId: null,
    legacyThreadId: 'abc',
    legacySource: 'conversations',
    title: null,
    lastMessageId: null,
    lastMessageAt: null,
    lastMessageBody: null,
    createdAt: 0,
    updatedAt: 0,
    closedAt: null,
    displayMetadata: null,
    participants: [],
    unreadCount: 0,
    migrationStatus: 'not_migrated',
    ...over,
  }
}

describe('getChatThreadListRow', () => {
  it('renders craftsman side from displayMetadata for customer role', () => {
    const t = thread({
      lastMessageBody: 'Hi there',
      displayMetadata: {
        craftsmanName: 'Müller GmbH',
        craftsmanAvatarUrl: 'https://x/c.png',
        projectTitle: 'Bad sanieren',
        projectSubtitle: 'Köln',
      },
    })
    const row = getChatThreadListRow(t, 'customer')
    expect(row.primaryName).toBe('Müller GmbH')
    expect(row.avatarUrl).toBe('https://x/c.png')
    expect(row.secondaryLine).toBe('Bad sanieren • Köln')
    expect(row.preview).toBe('Hi there')
  })

  it('renders customer side from displayMetadata for craftsman role', () => {
    const t = thread({
      displayMetadata: {
        customerName: 'Anna',
        customerAvatarUrl: 'https://x/a.png',
        projectTitle: 'Renovierung',
        projectSubtitle: 'Bonn',
      },
    })
    const row = getChatThreadListRow(t, 'craftsman')
    expect(row.primaryName).toBe('Anna')
    expect(row.avatarUrl).toBe('https://x/a.png')
    expect(row.secondaryLine).toBe('Renovierung • Bonn')
  })

  it('safe-fallbacks when displayMetadata is missing', () => {
    const t = thread({ displayMetadata: null })
    const row = getChatThreadListRow(t, 'customer')
    expect(row.primaryName).toBe('Handwerker')
    expect(row.avatarUrl).toBe('')
    expect(row.secondaryLine).toBe('Projekt • Details fehlen')
    expect(row.preview).toBe('')
  })

  it('formats today as HH:MM and earlier as DD.MM.', () => {
    const now = Date.now()
    const today = thread({ lastMessageAt: now })
    const yesterday = thread({ lastMessageAt: now - 24 * 60 * 60 * 1000 })
    expect(getChatThreadListRow(today, 'customer').timeLabel).toMatch(/^\d{2}:\d{2}$/)
    expect(getChatThreadListRow(yesterday, 'customer').timeLabel).toMatch(/^\d{2}\.\d{2}\.$/)
  })
})

describe('sortChatThreadsByUnread', () => {
  it('puts unread threads first, then most-recent within each group', () => {
    const a = thread({ id: 'a', unreadCount: 0, lastMessageAt: 100 })
    const b = thread({ id: 'b', unreadCount: 2, lastMessageAt: 50 })
    const c = thread({ id: 'c', unreadCount: 0, lastMessageAt: 200 })
    const d = thread({ id: 'd', unreadCount: 1, lastMessageAt: 75 })
    const sorted = sortChatThreadsByUnread([a, b, c, d]).map((t) => t.id)
    expect(sorted).toEqual(['d', 'b', 'c', 'a'])
  })

  it('falls back to updatedAt when lastMessageAt is null', () => {
    const a = thread({ id: 'a', unreadCount: 0, lastMessageAt: null, updatedAt: 100 })
    const b = thread({ id: 'b', unreadCount: 0, lastMessageAt: null, updatedAt: 200 })
    const sorted = sortChatThreadsByUnread([a, b]).map((t) => t.id)
    expect(sorted).toEqual(['b', 'a'])
  })

  it('does not mutate input', () => {
    const input = [thread({ id: 'a', unreadCount: 0 }), thread({ id: 'b', unreadCount: 1 })]
    const original = [...input]
    sortChatThreadsByUnread(input)
    expect(input).toEqual(original)
  })
})
