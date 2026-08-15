/**
 * Hydration Gate — NotificationRepository & NotificationBridge
 *
 * Verifies that addNotificationSignal() is fail-closed when the notification
 * repository is not yet hydrated. Also verifies that startNotificationBridge()
 * handles an unhydrated timeline gracefully — skipping the initial sync and
 * logging a warning instead of silently processing empty state as truth.
 *
 * Covers:
 *   A. addNotificationSignal() skips write and logs warning when unhydrated
 *   B. addNotificationSignal() writes correctly when hydrated
 *   C. startNotificationBridge() logs warning when timeline is unhydrated
 *   D. startNotificationBridge() processes initial sync when timeline is hydrated
 *   E. No regression: in-memory repository (isHydrated = true) is unaffected
 */

// ── Mocks must come before imports ──────────────────────────────────────────

const mockLogWarning = vi.fn()

vi.mock('../../src/lib/observability', () => ({
  logWarning: (...args: unknown[]) => mockLogWarning(...args),
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { addNotificationSignal } from '../../src/lib/notifications/notificationService'
import { startNotificationBridge, stopNotificationBridge } from '../../src/lib/notifications/notificationBridge'
import { setNotificationRepository } from '../../src/lib/notifications/repository'
import { setTimelineRepository } from '../../src/lib/timeline/repository'
import { InMemoryNotificationRepository } from '../../src/lib/notifications/repository/InMemoryNotificationRepository'
import { InMemoryTimelineRepository } from '../../src/lib/timeline/repository/InMemoryTimelineRepository'
import type { NotificationRepository } from '../../src/lib/notifications/repository/NotificationRepository'
import type { TimelineRepository } from '../../src/lib/timeline/repository/TimelineRepository'
import type { NotificationSignal } from '../../src/lib/notifications/types'
import type { ProjectTimelineEventType, ProjectTimelineSignal } from '../../src/lib/timeline/types'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeNotificationSignal(id = 'notif-1', jobId = 'job-1'): NotificationSignal {
  return {
    id,
    jobId,
    type: 'payment_released',
    priority: 'high',
    read: false,
    occurredAt: Date.now(),
  }
}

class ControllableNotificationRepository implements NotificationRepository {
  private _hydrated: boolean
  readonly addCalls: NotificationSignal[] = []
  private readonly listeners = new Set<() => void>()

  constructor(hydrated: boolean) {
    this._hydrated = hydrated
  }

  setHydrated(value: boolean): void {
    this._hydrated = value
  }

  async initialize(): Promise<void> {}
  isHydrated(): boolean { return this._hydrated }
  notify(): void { this.listeners.forEach((l) => l()) }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getAll(): NotificationSignal[] { return [] }
  getForJob(_jobId: string): NotificationSignal[] { return [] }
  getUnread(): NotificationSignal[] { return [] }
  hasSignal(_id: string): boolean { return false }
  add(signal: NotificationSignal): void { this.addCalls.push(signal) }
  markRead(_id: string): void {}
  markAllRead(): void {}
}

class ControllableTimelineRepository implements TimelineRepository {
  private _hydrated: boolean
  private signals: ProjectTimelineSignal[] = []
  private readonly listeners = new Set<() => void>()

  constructor(hydrated: boolean, signals: ProjectTimelineSignal[] = []) {
    this._hydrated = hydrated
    this.signals = signals
  }

  setHydrated(value: boolean): void { this._hydrated = value }

  async initialize(): Promise<void> {}
  isHydrated(): boolean { return this._hydrated }
  notify(): void { this.listeners.forEach((l) => l()) }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getAll(): ProjectTimelineSignal[] { return [...this.signals] }
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Notification hydration gate', () => {
  let notifRepo: ControllableNotificationRepository

  beforeEach(() => {
    vi.clearAllMocks()
    stopNotificationBridge()
    notifRepo = new ControllableNotificationRepository(false)
    setNotificationRepository(notifRepo)
    // Default timeline: hydrated, empty
    setTimelineRepository(new ControllableTimelineRepository(true))
  })

  afterEach(() => {
    stopNotificationBridge()
    setNotificationRepository(new InMemoryNotificationRepository())
    setTimelineRepository(new InMemoryTimelineRepository())
  })

  // ── A. addNotificationSignal — unhydrated ────────────────────────────────────

  describe('A. addNotificationSignal() when repository is unhydrated', () => {
    it('does not call add() on the repository', () => {
      addNotificationSignal(makeNotificationSignal())
      expect(notifRepo.addCalls).toHaveLength(0)
    })

    it('logs notification.add.skipped_unhydrated warning', () => {
      addNotificationSignal(makeNotificationSignal('notif-x', 'job-x'))
      expect(mockLogWarning).toHaveBeenCalledWith(
        'notification.add.skipped_unhydrated',
        expect.objectContaining({ signalId: 'notif-x', jobId: 'job-x' })
      )
    })

    it('does not throw', () => {
      expect(() => addNotificationSignal(makeNotificationSignal())).not.toThrow()
    })
  })

  // ── B. addNotificationSignal — hydrated ──────────────────────────────────────

  describe('B. addNotificationSignal() when repository is hydrated', () => {
    beforeEach(() => {
      notifRepo.setHydrated(true)
    })

    it('calls add() on the repository', () => {
      const signal = makeNotificationSignal('notif-2', 'job-2')
      addNotificationSignal(signal)
      expect(notifRepo.addCalls).toHaveLength(1)
      expect(notifRepo.addCalls[0].id).toBe('notif-2')
    })

    it('does not log a warning', () => {
      addNotificationSignal(makeNotificationSignal())
      expect(mockLogWarning).not.toHaveBeenCalled()
    })
  })

  // ── C. startNotificationBridge — unhydrated timeline ────────────────────────

  describe('C. startNotificationBridge() with unhydrated timeline', () => {
    beforeEach(() => {
      notifRepo.setHydrated(true)
      setTimelineRepository(new ControllableTimelineRepository(false))
    })

    it('logs notification.bridge.initial_sync_skipped_unhydrated', () => {
      startNotificationBridge()
      expect(mockLogWarning).toHaveBeenCalledWith(
        'notification.bridge.initial_sync_skipped_unhydrated'
      )
    })

    it('does not crash', () => {
      expect(() => startNotificationBridge()).not.toThrow()
    })

    it('is idempotent — second call is a no-op', () => {
      startNotificationBridge()
      startNotificationBridge()
      const calls = mockLogWarning.mock.calls.filter(
        ([key]) => key === 'notification.bridge.initial_sync_skipped_unhydrated'
      )
      expect(calls).toHaveLength(1)
    })
  })

  // ── D. startNotificationBridge — hydrated timeline ──────────────────────────

  describe('D. startNotificationBridge() with hydrated timeline', () => {
    beforeEach(() => {
      notifRepo.setHydrated(true)
      // Hydrated timeline with one notifiable signal
      const timelineSignal: ProjectTimelineSignal = {
        id: 'timeline-job-7-payment_released',
        jobId: 'job-7',
        type: 'payment_released',
        occurredAt: Date.now(),
      }
      setTimelineRepository(new ControllableTimelineRepository(true, [timelineSignal]))
    })

    it('does not log initial_sync_skipped_unhydrated', () => {
      startNotificationBridge()
      const skipCalls = mockLogWarning.mock.calls.filter(
        ([key]) => key === 'notification.bridge.initial_sync_skipped_unhydrated'
      )
      expect(skipCalls).toHaveLength(0)
    })

    it('processes notifiable initial signals and writes to notification repo', () => {
      startNotificationBridge()
      // payment_released is a notifiable type — bridge should derive a notification
      expect(notifRepo.addCalls).toHaveLength(1)
      expect(notifRepo.addCalls[0]).toMatchObject({ jobId: 'job-7', type: 'payment_released' })
    })
  })

  // ── E. No regression: InMemoryNotificationRepository is always hydrated ──────

  describe('E. InMemoryNotificationRepository (always hydrated) is unaffected', () => {
    beforeEach(() => {
      setNotificationRepository(new InMemoryNotificationRepository())
    })

    it('addNotificationSignal writes without warning', () => {
      addNotificationSignal(makeNotificationSignal())
      expect(mockLogWarning).not.toHaveBeenCalled()
    })
  })
})
