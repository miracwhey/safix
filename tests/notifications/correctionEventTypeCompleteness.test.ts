import { describe, it, expect } from 'vitest'
import {
  getNotificationPriority,
  getNotificationRoleRelevance,
} from '../../src/lib/notifications/notificationConfig'
import { mapSignalToNotificationItem } from '../../src/lib/notifications/notificationSelectors'
import { REACTION_CATEGORY_MAP } from '../../src/lib/reactions/reactionCategoryMap'
import type { NotificationSignal } from '../../src/lib/notifications/types'

const NEW_TYPES = [
  'correction_created',
  'correction_resolved',
  'correction_rejected',
] as const

describe('Block 7.2.2 — correction notification event-type completeness', () => {
  it('notificationConfig contains priority + role relevance for all 3 types', () => {
    for (const type of NEW_TYPES) {
      expect(getNotificationPriority(type)).toBeDefined()
      expect(getNotificationRoleRelevance(type)).toEqual(['craftsman'])
    }
  })

  it('reactionCategoryMap contains all 3 types as job-category', () => {
    for (const type of NEW_TYPES) {
      expect(REACTION_CATEGORY_MAP[type]).toBe('job')
    }
  })

  it('notificationSelectors produce non-empty title/description/label for all 3 types', () => {
    for (const type of NEW_TYPES) {
      const signal: NotificationSignal = {
        id: `s-${type}`,
        jobId: 'job-1',
        type,
        priority: 'info',
        read: false,
        occurredAt: 0,
        recipientRole: 'craftsman',
      }
      const item = mapSignalToNotificationItem(signal)
      expect(item.title.length).toBeGreaterThan(0)
      expect(item.description.length).toBeGreaterThan(0)
      expect(item.label.length).toBeGreaterThan(0)
    }
  })
})
