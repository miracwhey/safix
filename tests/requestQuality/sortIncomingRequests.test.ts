import { describe, it, expect } from 'vitest'
import {
  sortIncomingRequests,
  type IncomingRequestItem,
} from '../../src/lib/messages/requestInboxSelectors'

function makeItem(overrides: Partial<IncomingRequestItem>): IncomingRequestItem {
  return {
    threadId: 't',
    customerName: 'C',
    customerAvatarUrl: '',
    projectTitle: 'P',
    projectSubtitle: '',
    inquiryOrigin: 'category',
    status: 'new_unread',
    unreadCount: 0,
    lastMessagePreview: '',
    hasProjectAttachment: false,
    qualityScore: 0,
    qualityTier: 'pruefen',
    lastActivityAt: 0,
    ...overrides,
  }
}

describe('sortIncomingRequests', () => {
  it('orders by descending quality score for "quality"', () => {
    const items = [
      makeItem({ threadId: 'a', qualityScore: 40 }),
      makeItem({ threadId: 'b', qualityScore: 90 }),
      makeItem({ threadId: 'c', qualityScore: 65 }),
    ]
    expect(sortIncomingRequests(items, 'quality').map((i) => i.threadId)).toEqual([
      'b',
      'c',
      'a',
    ])
  })

  it('breaks quality ties by most recent activity', () => {
    const items = [
      makeItem({ threadId: 'old', qualityScore: 70, lastActivityAt: 100 }),
      makeItem({ threadId: 'new', qualityScore: 70, lastActivityAt: 200 }),
    ]
    expect(sortIncomingRequests(items, 'quality').map((i) => i.threadId)).toEqual([
      'new',
      'old',
    ])
  })

  it('orders by most recent activity for "newest"', () => {
    const items = [
      makeItem({ threadId: 'a', lastActivityAt: 100 }),
      makeItem({ threadId: 'b', lastActivityAt: 300 }),
      makeItem({ threadId: 'c', lastActivityAt: 200 }),
    ]
    expect(sortIncomingRequests(items, 'newest').map((i) => i.threadId)).toEqual([
      'b',
      'c',
      'a',
    ])
  })

  it('does not mutate the input array', () => {
    const items = [
      makeItem({ threadId: 'a', qualityScore: 1 }),
      makeItem({ threadId: 'b', qualityScore: 2 }),
    ]
    const before = items.map((i) => i.threadId)
    sortIncomingRequests(items, 'quality')
    expect(items.map((i) => i.threadId)).toEqual(before)
  })

  it('never drops items — it flags quality, it does not hide', () => {
    const items = [
      makeItem({ threadId: 'low', qualityScore: 10, qualityTier: 'pruefen' }),
      makeItem({ threadId: 'high', qualityScore: 95, qualityTier: 'top' }),
    ]
    expect(sortIncomingRequests(items, 'quality')).toHaveLength(2)
    expect(sortIncomingRequests(items, 'newest')).toHaveLength(2)
  })
})
