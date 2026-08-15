/**
 * Block 7.1B5 — Invoice notification config coverage.
 *
 * Closes the half-state where notificationSelectors knew titles/descriptions/labels
 * for invoice_* events but NOTIFICATION_EVENT_CONFIG did not list them, causing
 * notificationBridge to silently drop the timeline → notification handoff.
 *
 * Verifies:
 *   1. invoice_created / invoice_issued / invoice_sent / invoice_cancelled /
 *      invoice_credit_note_issued are notifiable per config
 *   2. role relevance is configured for each
 *   3. notificationBridge actually emits notification signals when these
 *      timeline events arrive (no longer dropped at isNotifiableEventType gate)
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  isNotifiableEventType,
  getNotificationPriority,
  getNotificationRoleRelevance,
} from '../../src/lib/notifications/notificationConfig'
import {
  startNotificationBridge,
  stopNotificationBridge,
} from '../../src/lib/notifications/notificationBridge'
import { setNotificationRepository } from '../../src/lib/notifications/repository'
import { setTimelineRepository } from '../../src/lib/timeline/repository'
import { InMemoryNotificationRepository } from '../../src/lib/notifications/repository/InMemoryNotificationRepository'
import { InMemoryTimelineRepository } from '../../src/lib/timeline/repository/InMemoryTimelineRepository'
import type { NotificationRepository } from '../../src/lib/notifications/repository/NotificationRepository'
import type { TimelineRepository } from '../../src/lib/timeline/repository/TimelineRepository'
import type { NotificationSignal } from '../../src/lib/notifications/types'
import type {
  ProjectTimelineEventType,
  ProjectTimelineSignal,
} from '../../src/lib/timeline/types'

const INVOICE_EVENTS: ProjectTimelineEventType[] = [
  'invoice_created',
  'invoice_issued',
  'invoice_sent',
  'invoice_cancelled',
  'invoice_credit_note_issued',
]

class CapturingNotificationRepository implements NotificationRepository {
  readonly addCalls: NotificationSignal[] = []
  private readonly listeners = new Set<() => void>()
  async initialize(): Promise<void> {}
  isHydrated(): boolean {
    return true
  }
  notify(): void {
    this.listeners.forEach((l) => l())
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getAll(): NotificationSignal[] {
    return [...this.addCalls]
  }
  getForJob(jobId: string): NotificationSignal[] {
    return this.addCalls.filter((s) => s.jobId === jobId)
  }
  getUnread(): NotificationSignal[] {
    return this.addCalls.filter((s) => !s.read)
  }
  hasSignal(id: string): boolean {
    return this.addCalls.some((s) => s.id === id)
  }
  add(signal: NotificationSignal): void {
    this.addCalls.push(signal)
  }
  markRead(_id: string): void {}
  markAllRead(): void {}
}

class HydratedTimelineRepository implements TimelineRepository {
  private signals: ProjectTimelineSignal[] = []
  private readonly listeners = new Set<() => void>()
  async initialize(): Promise<void> {}
  isHydrated(): boolean {
    return true
  }
  notify(): void {
    this.listeners.forEach((l) => l())
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getAll(): ProjectTimelineSignal[] {
    return [...this.signals]
  }
  getForJob(jobId: string): ProjectTimelineSignal[] {
    return this.signals.filter((s) => s.jobId === jobId)
  }
  hasEventOfType(jobId: string, type: ProjectTimelineEventType): boolean {
    return this.signals.some((s) => s.jobId === jobId && s.type === type)
  }
  add(signal: ProjectTimelineSignal): void {
    this.signals = [...this.signals, signal]
    this.notify()
  }
}

describe('Block 7.1B5 — invoice events in notification config', () => {
  describe('NOTIFICATION_EVENT_CONFIG coverage', () => {
    it.each(INVOICE_EVENTS)('%s is notifiable', (type) => {
      expect(isNotifiableEventType(type)).toBe(true)
    })

    it.each(INVOICE_EVENTS)('%s has a notification priority', (type) => {
      const priority = getNotificationPriority(type)
      expect(priority).toBeDefined()
      expect(['info', 'action', 'alert']).toContain(priority)
    })

    it('invoice_cancelled is alert-level (steuerrelevant)', () => {
      expect(getNotificationPriority('invoice_cancelled')).toBe('alert')
    })

    it.each(INVOICE_EVENTS)('%s has explicit role relevance', (type) => {
      const roles = getNotificationRoleRelevance(type)
      expect(roles).toBeDefined()
      expect(roles!.length).toBeGreaterThan(0)
    })

    it('invoice_created is craftsman-only (intern, vor sent)', () => {
      expect(getNotificationRoleRelevance('invoice_created')).toEqual(['craftsman'])
    })
  })

  describe('notificationBridge delivers invoice events', () => {
    let notifRepo: CapturingNotificationRepository
    let timelineRepo: HydratedTimelineRepository

    beforeEach(() => {
      vi.clearAllMocks()
      stopNotificationBridge()
      notifRepo = new CapturingNotificationRepository()
      timelineRepo = new HydratedTimelineRepository()
      setNotificationRepository(notifRepo)
      setTimelineRepository(timelineRepo)
    })

    afterEach(() => {
      stopNotificationBridge()
      setNotificationRepository(new InMemoryNotificationRepository())
      setTimelineRepository(new InMemoryTimelineRepository())
    })

    it.each(INVOICE_EVENTS)('emits notification signal(s) when %s arrives', (type) => {
      startNotificationBridge()
      timelineRepo.add({
        id: `tl-${type}-job-1`,
        jobId: 'job-1',
        type,
        occurredAt: Date.now(),
      })
      const matched = notifRepo.addCalls.filter((s) => s.type === type)
      // At least one role-targeted signal — exact count depends on role config.
      expect(matched.length).toBeGreaterThanOrEqual(1)
      expect(matched.every((s) => s.jobId === 'job-1')).toBe(true)
    })
  })
})
