/**
 * Block H-5a + H-5b — Offline/Reload/Resume Hardening: R1–R8 Repros
 *
 * Covers the two root-cause invariants across all queued domains (except
 * Invoice, which has its own H-4c suite):
 *
 * H-5a — Server-side INSERT conflicts (Postgres 23xxx / 42xxx) MUST NOT be
 *         enqueued. The flush path replays via upsert; queuing would silently
 *         overwrite DB-authoritative state.  23505 additionally reloads the
 *         DB-authoritative version into cache.
 *
 * H-5b — hydrateFromQueue: queued draft inserts are materialised into the
 *         local cache during loadForUser so offline-created entities remain
 *         visible after app restart even when the DB row is not yet flushed.
 *
 * R1  duplicate-key (23505) not queued            [H-5a, async repos]
 * R2  other server error (23503) not queued        [H-5a, fire-and-forget repos]
 * R3  transient/network error still queued         [H-5a, any repo]
 * R4  restart rehydrates pending inserts           [H-5b]
 * R5  no duplicate in cache when DB already has row [H-5b]
 * R6  cross-user filter: other uid not hydrated    [H-5b]
 * R7  malformed payload in queue does not crash    [H-5b]
 * R8  InMemory repos are unaffected                [invariant]
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ── Supabase mock ─────────────────────────────────────────────────────────────

const {
  mockCalendarInsert,
  mockCalendarSelectSingle,
  mockCalendarSelectAll,
  mockScheduleInsert,
  mockScheduleSelectAll,
  mockTimelineInsert,
  mockTimelineSelectAll,
  mockNotifInsert,
  mockNotifSelectAll,
  mockRatingInsert,
  mockRatingSelectAll,
} = vi.hoisted(() => ({
  mockCalendarInsert: vi.fn(),
  mockCalendarSelectSingle: vi.fn(),
  mockCalendarSelectAll: vi.fn(),
  mockScheduleInsert: vi.fn(),
  mockScheduleSelectAll: vi.fn(),
  mockTimelineInsert: vi.fn(),
  mockTimelineSelectAll: vi.fn(),
  mockNotifInsert: vi.fn(),
  mockNotifSelectAll: vi.fn(),
  mockRatingInsert: vi.fn(),
  mockRatingSelectAll: vi.fn(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'calendar_entries') {
        return {
          select: vi.fn().mockImplementation(() => ({
            eq: vi.fn().mockImplementation((col: string) => {
              if (col === 'provider_id') {
                return {
                  order: vi.fn().mockReturnThis(),
                  limit: vi.fn().mockImplementation(() => mockCalendarSelectAll()),
                }
              }
              return { single: vi.fn().mockImplementation(() => mockCalendarSelectSingle()) }
            }),
          })),
          insert: mockCalendarInsert,
          update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        }
      }
      if (table === 'schedules') {
        return {
          select: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockImplementation(() => mockScheduleSelectAll()),
          }),
          insert: mockScheduleInsert,
        }
      }
      if (table === 'timeline_signals') {
        return {
          select: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockImplementation(() => mockTimelineSelectAll()),
          }),
          insert: mockTimelineInsert,
        }
      }
      if (table === 'notification_signals') {
        return {
          select: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockImplementation(() => mockNotifSelectAll()),
          }),
          insert: mockNotifInsert,
        }
      }
      if (table === 'ratings') {
        return {
          select: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockImplementation(() => mockRatingSelectAll()),
          }),
          insert: mockRatingInsert,
        }
      }
      if (table === 'providers') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'prov-1' } }) }),
          }),
        }
      }
      return {
        select: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) }),
        }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      }
    }),
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: 'uid-1' } } } }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
    channel: vi.fn().mockImplementation(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    })),
    removeChannel: vi.fn().mockResolvedValue(undefined),
  },
}))

// ── Persistence mock ──────────────────────────────────────────────────────────

const mockEnqueue = vi.fn()
const mockRecordFailure = vi.fn()
let pendingByEntity: Map<string, boolean>
let pendingMutations: unknown[]

vi.mock('../../src/lib/persistence', () => ({
  recordPersistenceFailure: (...args: unknown[]) => mockRecordFailure(...args),
  enqueuePendingMutation: (...args: unknown[]) => mockEnqueue(...args),
  hasPendingMutationForEntity: (_table: string, entityId: string) =>
    pendingByEntity.get(entityId) ?? false,
  getPendingMutations: () => pendingMutations,
  isServerSideError: (error: unknown) => {
    if (typeof error !== 'object' || error === null) return false
    const e = error as Record<string, unknown>
    if (typeof e.code !== 'string') return false
    return e.code.startsWith('23') || e.code.startsWith('42')
  },
  isDuplicateKeyError: (error: unknown) => {
    if (typeof error !== 'object' || error === null) return false
    const e = error as Record<string, unknown>
    return e.code === '23505'
  },
}))

vi.mock('../../src/lib/observability', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarning: vi.fn() }))

// ── Imports ───────────────────────────────────────────────────────────────────

import { SupabaseCalendarRepository } from '../../src/lib/calendar/repository/SupabaseCalendarRepository'
import { SupabaseScheduleRepository } from '../../src/lib/operations/repository/SupabaseScheduleRepository'
import { SupabaseTimelineRepository } from '../../src/lib/timeline/repository/SupabaseTimelineRepository'
import { SupabaseNotificationRepository } from '../../src/lib/notifications/repository/SupabaseNotificationRepository'
import { SupabaseRatingRepository } from '../../src/lib/ratings/repository/SupabaseRatingRepository'
import { InMemoryTimelineRepository } from '../../src/lib/timeline/repository/InMemoryTimelineRepository'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'
import type { JobSchedule } from '../../src/lib/operations/types'
import type { ProjectTimelineSignal } from '../../src/lib/timeline/types'
import type { NotificationSignal } from '../../src/lib/notifications/types'
import type { Rating } from '../../src/lib/ratings/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const now = Date.now()

function makeEntry(id = 'cal-1'): CalendarEntry {
  return {
    id,
    kind: 'custom',
    title: 'Test',
    customerName: 'Kunde',
    location: 'Berlin',
    dateLabel: '2026-04-23',
    dateKey: '20260423',
    startsAtLabel: '09:00',
    endsAtLabel: '10:00',
    assignedMemberIds: [],
    status: 'scheduled' as CalendarEntry['status'],
    createdAt: now,
    updatedAt: now,
  }
}

function entryToRow(e: CalendarEntry) {
  return {
    id: e.id,
    job_id: e.jobId ?? null,
    provider_id: e.providerId ?? null,
    title: e.title,
    customer_name: e.customerName,
    location: e.location,
    date_label: e.dateLabel,
    date_key: e.dateKey,
    starts_at_label: e.startsAtLabel,
    ends_at_label: e.endsAtLabel,
    assigned_member_ids: e.assignedMemberIds,
    status: e.status,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
  }
}

function makeSchedule(id = 'sched-1'): JobSchedule {
  return {
    id,
    jobId: 'job-1',
    scheduledStart: now,
    scheduledEnd: now + 3600_000,
    executionWindow: 3600,
    schedulingStatus: 'planned' as JobSchedule['schedulingStatus'],
    createdAt: now,
    updatedAt: now,
  }
}

function scheduleToRow(s: JobSchedule) {
  return {
    id: s.id,
    job_id: s.jobId,
    scheduled_start: s.scheduledStart,
    scheduled_end: s.scheduledEnd,
    execution_window: s.executionWindow,
    scheduling_status: s.schedulingStatus,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  }
}

function makeSignal(id = 'sig-1'): ProjectTimelineSignal {
  return { id, jobId: 'job-1', type: 'job_created' as ProjectTimelineSignal['type'], occurredAt: now }
}

function signalToRow(s: ProjectTimelineSignal) {
  return { id: s.id, job_id: s.jobId, type: s.type, occurred_at: s.occurredAt }
}

function makeNotif(id = 'notif-1'): NotificationSignal {
  return { id, jobId: 'job-1', type: 'job_created' as NotificationSignal['type'], priority: 'low' as NotificationSignal['priority'], read: false, occurredAt: now, recipientRole: 'craftsman' }
}

function notifToRow(n: NotificationSignal) {
  return { id: n.id, job_id: n.jobId, type: n.type, priority: n.priority, read: n.read, occurred_at: n.occurredAt, recipient_role: n.recipientRole }
}

function makeRating(id = 'rating-1'): Rating {
  return { id, jobId: 'job-1', providerUserId: 'prov-uid', customerUserId: 'cust-uid', ratingScore: 5 as Rating['ratingScore'], createdAt: now }
}

function ratingToRow(r: Rating) {
  return { id: r.id, job_id: r.jobId, provider_user_id: r.providerUserId, customer_user_id: r.customerUserId, rating_score: r.ratingScore, rating_comment: null, created_at: new Date(r.createdAt).toISOString() }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('H-5a + H-5b — Offline Hardening Repros', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pendingByEntity = new Map()
    pendingMutations = []
    mockCalendarSelectAll.mockResolvedValue({ data: [], error: null })
    mockCalendarSelectSingle.mockResolvedValue({ data: null, error: null })
    mockScheduleSelectAll.mockResolvedValue({ data: [], error: null })
    mockTimelineSelectAll.mockResolvedValue({ data: [], error: null })
    mockNotifSelectAll.mockResolvedValue({ data: [], error: null })
    mockRatingSelectAll.mockResolvedValue({ data: [], error: null })
  })

  // ── R1: 23505 not queued (async repo — Calendar) ──────────────────────────

  describe('R1 — 23505 duplicate key not queued (async Calendar repo)', () => {
    it('add() with 23505 does not call enqueuePendingMutation', async () => {
      const repo = new SupabaseCalendarRepository()
      await repo.initialize()
      mockCalendarInsert.mockResolvedValueOnce({ error: { code: '23505', message: 'dup key' } })

      await repo.add(makeEntry())

      expect(mockEnqueue).not.toHaveBeenCalled()
    })

    it('23505: reloads DB-authoritative version into cache', async () => {
      const entry = makeEntry()
      const dbVersion: CalendarEntry = { ...entry, title: 'DB-Version' }
      const repo = new SupabaseCalendarRepository()
      await repo.initialize()
      mockCalendarInsert.mockResolvedValueOnce({ error: { code: '23505', message: 'dup key' } })
      mockCalendarSelectSingle.mockResolvedValueOnce({ data: entryToRow(dbVersion), error: null })

      await repo.add(entry)
      await tick()

      const cached = repo.getAll().find((e) => e.id === entry.id)
      expect(cached?.title).toBe('DB-Version')
    })

    it('23505: optimistic entry is rolled back before reload', async () => {
      const entry = makeEntry()
      const repo = new SupabaseCalendarRepository()
      await repo.initialize()
      mockCalendarInsert.mockResolvedValueOnce({ error: { code: '23505', message: 'dup key' } })
      mockCalendarSelectSingle.mockResolvedValueOnce({ data: null, error: null })

      const snapshots: string[][] = []
      repo.subscribe(() => snapshots.push(repo.getAll().map((e) => e.id)))

      await repo.add(entry)

      const wasRolledBack = snapshots.some((snap) => !snap.includes(entry.id))
      expect(wasRolledBack).toBe(true)
    })
  })

  // ── R2: other server error not queued (fire-and-forget — Schedule) ─────────

  describe('R2 — server error (23503 FK) not queued (fire-and-forget Schedule)', () => {
    it('add() with 23503 does not enqueue', async () => {
      const repo = new SupabaseScheduleRepository()
      await repo.initialize()
      mockScheduleInsert.mockResolvedValueOnce({ error: { code: '23503', message: 'FK violation' } })

      repo.add(makeSchedule())
      await tick()

      expect(mockEnqueue).not.toHaveBeenCalled()
    })

    it('add() with 42703 schema error does not enqueue', async () => {
      const repo = new SupabaseScheduleRepository()
      await repo.initialize()
      mockScheduleInsert.mockResolvedValueOnce({ error: { code: '42703', message: 'column not found' } })

      repo.add(makeSchedule())
      await tick()

      expect(mockEnqueue).not.toHaveBeenCalled()
    })

    it('23503: schedule is rolled back from cache', async () => {
      const schedule = makeSchedule()
      const repo = new SupabaseScheduleRepository()
      await repo.initialize()
      mockScheduleInsert.mockResolvedValueOnce({ error: { code: '23503', message: 'FK violation' } })

      repo.add(schedule)
      await tick()

      expect(repo.getAll().some((s) => s.id === schedule.id)).toBe(false)
    })
  })

  // ── R3: transient error still enqueued ────────────────────────────────────

  describe('R3 — transient/network error enqueued', () => {
    it('Calendar async add: transient error → enqueued', async () => {
      const repo = new SupabaseCalendarRepository()
      await repo.initialize()
      mockCalendarInsert.mockResolvedValueOnce({ error: { message: 'network timeout' } })

      await expect(repo.add(makeEntry())).rejects.toBeDefined()

      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'calendar', table: 'calendar_entries', operation: 'insert' }),
      )
    })

    it('Timeline fire-and-forget add: transient error → enqueued', async () => {
      const repo = new SupabaseTimelineRepository()
      await repo.initialize()
      mockTimelineInsert.mockResolvedValueOnce({ error: { message: 'network timeout' } })

      repo.add(makeSignal())
      await tick()

      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'timeline', table: 'timeline_signals', operation: 'insert' }),
      )
    })

    it('Notifications fire-and-forget add: transient error → enqueued', async () => {
      const repo = new SupabaseNotificationRepository()
      await repo.initialize()
      mockNotifInsert.mockResolvedValueOnce({ error: { message: 'network timeout' } })

      repo.add(makeNotif())
      await tick()

      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'notifications', table: 'notification_signals', operation: 'insert' }),
      )
    })
  })

  // ── R4: restart rehydrates pending inserts ────────────────────────────────

  describe('R4 — app restart rehydrates queued inserts', () => {
    it('Calendar: pending insert materialises into cache after initialize()', async () => {
      const entry = makeEntry()
      pendingMutations = [{
        table: 'calendar_entries',
        operation: 'insert',
        entityId: entry.id,
        userId: 'uid-1',
        payload: entryToRow(entry),
      }]
      mockCalendarSelectAll.mockResolvedValueOnce({ data: [], error: null })

      const repo = new SupabaseCalendarRepository()
      await repo.initialize()

      expect(repo.getAll().some((e) => e.id === entry.id)).toBe(true)
    })

    it('Schedule: pending insert materialises into cache after initialize()', async () => {
      const sched = makeSchedule()
      pendingMutations = [{
        table: 'schedules',
        operation: 'insert',
        entityId: sched.id,
        userId: 'uid-1',
        payload: scheduleToRow(sched),
      }]
      mockScheduleSelectAll.mockResolvedValueOnce({ data: [], error: null })

      const repo = new SupabaseScheduleRepository()
      await repo.initialize()

      expect(repo.getAll().some((s) => s.id === sched.id)).toBe(true)
    })

    it('Timeline: pending insert materialises into cache after initialize()', async () => {
      const sig = makeSignal()
      pendingMutations = [{
        table: 'timeline_signals',
        operation: 'insert',
        entityId: sig.id,
        userId: 'uid-1',
        payload: signalToRow(sig),
      }]
      mockTimelineSelectAll.mockResolvedValueOnce({ data: [], error: null })

      const repo = new SupabaseTimelineRepository()
      await repo.initialize()

      expect(repo.getAll().some((s) => s.id === sig.id)).toBe(true)
    })

    it('Ratings: pending insert materialises into cache after initialize()', async () => {
      const rating = makeRating()
      pendingMutations = [{
        table: 'ratings',
        operation: 'insert',
        entityId: rating.id,
        userId: 'uid-1',
        payload: ratingToRow(rating),
      }]
      mockRatingSelectAll.mockResolvedValueOnce({ data: [], error: null })

      const repo = new SupabaseRatingRepository()
      await repo.initialize()

      expect(repo.getAll().some((r) => r.id === rating.id)).toBe(true)
    })
  })

  // ── R5: no duplicate when DB already has row ──────────────────────────────

  describe('R5 — pending insert skipped when DB already has row (no duplicate)', () => {
    it('Calendar: queue entry not added twice when DB returns the row', async () => {
      const entry = makeEntry()
      pendingMutations = [{
        table: 'calendar_entries',
        operation: 'insert',
        entityId: entry.id,
        userId: 'uid-1',
        payload: entryToRow(entry),
      }]
      mockCalendarSelectAll.mockResolvedValueOnce({ data: [entryToRow(entry)], error: null })

      const repo = new SupabaseCalendarRepository()
      await repo.initialize()

      expect(repo.getAll().filter((e) => e.id === entry.id).length).toBe(1)
    })

    it('Schedule: queue entry not added twice when DB returns the row', async () => {
      const sched = makeSchedule()
      pendingMutations = [{
        table: 'schedules',
        operation: 'insert',
        entityId: sched.id,
        userId: 'uid-1',
        payload: scheduleToRow(sched),
      }]
      mockScheduleSelectAll.mockResolvedValueOnce({ data: [scheduleToRow(sched)], error: null })

      const repo = new SupabaseScheduleRepository()
      await repo.initialize()

      expect(repo.getAll().filter((s) => s.id === sched.id).length).toBe(1)
    })
  })

  // ── R6: cross-user filter ─────────────────────────────────────────────────

  describe('R6 — pending insert for different uid is NOT hydrated', () => {
    it('Calendar: other-uid insert not materialised', async () => {
      const entry = makeEntry()
      pendingMutations = [{
        table: 'calendar_entries',
        operation: 'insert',
        entityId: entry.id,
        userId: 'uid-other',
        payload: entryToRow(entry),
      }]
      mockCalendarSelectAll.mockResolvedValueOnce({ data: [], error: null })

      const repo = new SupabaseCalendarRepository()
      await repo.initialize()

      expect(repo.getAll().some((e) => e.id === entry.id)).toBe(false)
    })

    it('Calendar: insert without userId IS hydrated (legacy/any-session)', async () => {
      const entry = makeEntry()
      pendingMutations = [{
        table: 'calendar_entries',
        operation: 'insert',
        entityId: entry.id,
        // no userId
        payload: entryToRow(entry),
      }]
      mockCalendarSelectAll.mockResolvedValueOnce({ data: [], error: null })

      const repo = new SupabaseCalendarRepository()
      await repo.initialize()

      expect(repo.getAll().some((e) => e.id === entry.id)).toBe(true)
    })

    it('Notifications: other-uid insert not materialised', async () => {
      const notif = makeNotif()
      pendingMutations = [{
        table: 'notification_signals',
        operation: 'insert',
        entityId: notif.id,
        userId: 'uid-other',
        payload: notifToRow(notif),
      }]
      mockNotifSelectAll.mockResolvedValueOnce({ data: [], error: null })

      const repo = new SupabaseNotificationRepository()
      await repo.initialize()

      expect(repo.getAll().some((s) => s.id === notif.id)).toBe(false)
    })
  })

  // ── R7: malformed payload does not crash ──────────────────────────────────

  describe('R7 — malformed queue payload does not crash repository load', () => {
    it('Calendar: corrupt payload skipped, initialize() resolves', async () => {
      pendingMutations = [{
        table: 'calendar_entries',
        operation: 'insert',
        entityId: 'corrupt-1',
        userId: 'uid-1',
        payload: { bad: true, no_id: true },
      }]
      mockCalendarSelectAll.mockResolvedValueOnce({ data: [], error: null })

      const repo = new SupabaseCalendarRepository()
      await expect(repo.initialize()).resolves.toBeUndefined()
      expect(repo.isHydrated()).toBe(true)
    })

    it('Schedule: corrupt payload skipped, initialize() resolves', async () => {
      pendingMutations = [{
        table: 'schedules',
        operation: 'insert',
        entityId: 'corrupt-2',
        userId: 'uid-1',
        payload: { completely: 'wrong' },
      }]
      mockScheduleSelectAll.mockResolvedValueOnce({ data: [], error: null })

      const repo = new SupabaseScheduleRepository()
      await expect(repo.initialize()).resolves.toBeUndefined()
      expect(repo.isHydrated()).toBe(true)
    })

    it('Timeline: corrupt payload skipped, initialize() resolves', async () => {
      pendingMutations = [{
        table: 'timeline_signals',
        operation: 'insert',
        entityId: 'corrupt-3',
        userId: 'uid-1',
        payload: null,
      }]
      mockTimelineSelectAll.mockResolvedValueOnce({ data: [], error: null })

      const repo = new SupabaseTimelineRepository()
      await expect(repo.initialize()).resolves.toBeUndefined()
      expect(repo.isHydrated()).toBe(true)
    })
  })

  // ── R8: InMemory repos unaffected ─────────────────────────────────────────

  describe('R8 — InMemory repos are unaffected by queue state', () => {
    it('InMemoryTimelineRepository.add() works regardless of pendingMutations', () => {
      pendingMutations = [
        { table: 'timeline_signals', operation: 'insert', entityId: 'x', userId: 'uid-1', payload: {} },
      ]
      const repo = new InMemoryTimelineRepository()
      const sig = makeSignal('sig-inmem')
      repo.add(sig)
      expect(repo.getAll().some((s) => s.id === 'sig-inmem')).toBe(true)
    })

    it('InMemoryTimelineRepository has no hydrateFromQueue dependency', () => {
      const repo = new InMemoryTimelineRepository()
      // InMemory repo has no initialize() — must not throw
      expect(() => repo.getAll()).not.toThrow()
    })
  })
})
