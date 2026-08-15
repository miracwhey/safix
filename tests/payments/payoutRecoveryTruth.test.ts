/**
 * Payout Recovery Truth
 *
 * Verifies that payout_failed and transfer_reversed signals are:
 * - Recognized by the notification config (alert priority, correct roles)
 * - Recognized by the timeline type system
 * - Not treated as success states anywhere
 */

import { describe, it, expect } from 'vitest'
import {
  NOTIFICATION_EVENT_CONFIG,
  NOTIFICATION_ROLE_RELEVANCE,
  isNotifiableEventType,
  getNotificationPriority,
  getNotificationRoleRelevance,
} from '../../src/lib/notifications/notificationConfig'
import type { ProjectTimelineEventType } from '../../src/lib/timeline/types'

describe('transfer_reversed — notification config', () => {
  it('is a notifiable event type', () => {
    expect(isNotifiableEventType('transfer_reversed')).toBe(true)
  })

  it('has alert priority', () => {
    expect(getNotificationPriority('transfer_reversed')).toBe('alert')
  })

  it('routes to craftsman and admin', () => {
    const roles = getNotificationRoleRelevance('transfer_reversed')
    expect(roles).toBeDefined()
    expect(roles).toContain('craftsman')
    expect(roles).toContain('admin')
    expect(roles).not.toContain('customer')
  })
})

describe('payout_failed — notification config', () => {
  it('is a notifiable event type', () => {
    expect(isNotifiableEventType('payout_failed')).toBe(true)
  })

  it('has alert priority', () => {
    expect(getNotificationPriority('payout_failed')).toBe('alert')
  })

  it('routes to craftsman and admin', () => {
    const roles = getNotificationRoleRelevance('payout_failed')
    expect(roles).toBeDefined()
    expect(roles).toContain('craftsman')
    expect(roles).toContain('admin')
  })
})

describe('error signals are never info-priority', () => {
  const errorSignals: ProjectTimelineEventType[] = ['payout_failed', 'transfer_reversed']

  for (const type of errorSignals) {
    it(`${type} priority is not 'info'`, () => {
      expect(getNotificationPriority(type)).not.toBe('info')
    })
  }
})

describe('transfer_reversed is a valid ProjectTimelineEventType', () => {
  it('NOTIFICATION_EVENT_CONFIG contains transfer_reversed key', () => {
    expect('transfer_reversed' in NOTIFICATION_EVENT_CONFIG).toBe(true)
  })

  it('NOTIFICATION_ROLE_RELEVANCE contains transfer_reversed key', () => {
    expect('transfer_reversed' in NOTIFICATION_ROLE_RELEVANCE).toBe(true)
  })
})
