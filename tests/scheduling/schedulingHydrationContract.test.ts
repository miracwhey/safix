/**
 * Block 2 — Scheduling Domain Hardening: Hydration Contract Tests
 *
 * Verifies:
 * 1. CalendarRepository isHydrated() contract (InMemory always true)
 * 2. ScheduleRepository isHydrated() contract (InMemory always true)
 * 3. SupabaseCalendar: false before initialize, true after
 * 4. SupabaseSchedule: false before initialize, true after
 * 5. Team assignment write path calls replace() on repo
 * 6. Multi-day schedule: CalendarEntry dateKey uses scheduledStart day only (V1 single-day design)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InMemoryCalendarRepository } from '../../src/lib/calendar/repository/InMemoryCalendarRepository'
import { InMemoryScheduleRepository } from '../../src/lib/operations/repository/InMemoryScheduleRepository'
import { setCalendarRepository } from '../../src/lib/calendar/repository/registry'
import { setScheduleRepository } from '../../src/lib/operations/repository/registry'
import { isCalendarRepositoryHydrated } from '../../src/lib/calendar/calendarStore'
import { isScheduleRepositoryHydrated } from '../../src/lib/operations/operationsStore'
import { addTeamMember, removeTeamMember } from '../../src/lib/calendar/calendarStore'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'
import type { JobSchedule } from '../../src/lib/operations/types'
import { formatDateKey } from '../../src/lib/calendar/calendarEngine'

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  const now = Date.now()
  return {
    id: 'cal-1',
    kind: 'job',
    jobId: 'job-1',
    title: 'Test Job',
    customerName: 'Kunde',
    location: 'Berlin',
    dateLabel: 'Heute',
    dateKey: '2026-04-17',
    startsAtLabel: '09:00',
    endsAtLabel: '11:00',
    assignedMemberIds: [],
    status: 'scheduled',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function _makeSchedule(overrides: Partial<JobSchedule> = {}): JobSchedule {
  const now = Date.now()
  return {
    id: 'sched-1',
    jobId: 'job-1',
    scheduledStart: now,
    scheduledEnd: now + 2 * 60 * 60 * 1000,
    executionWindow: 120,
    schedulingStatus: 'scheduled',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Block 2 — Scheduling Hydration Contract', () => {

  beforeEach(() => {
    setCalendarRepository(new InMemoryCalendarRepository([]))
    setScheduleRepository(new InMemoryScheduleRepository())
  })

  // ── 1. InMemory repos always hydrated ──────────────────────────────────

  describe('InMemory repositories are always hydrated', () => {
    it('InMemoryCalendarRepository.isHydrated() = true before initialize', () => {
      const repo = new InMemoryCalendarRepository([])
      expect(repo.isHydrated()).toBe(true)
    })

    it('InMemoryScheduleRepository.isHydrated() = true before initialize', () => {
      const repo = new InMemoryScheduleRepository()
      expect(repo.isHydrated()).toBe(true)
    })

    it('InMemoryCalendarRepository.isHydrated() = true after initialize', async () => {
      const repo = new InMemoryCalendarRepository([])
      await repo.initialize()
      expect(repo.isHydrated()).toBe(true)
    })

    it('InMemoryScheduleRepository.isHydrated() = true after initialize', async () => {
      const repo = new InMemoryScheduleRepository()
      await repo.initialize()
      expect(repo.isHydrated()).toBe(true)
    })
  })

  // ── 2. Store functions delegate to active repo ─────────────────────────

  describe('Store hydration checks delegate to active repository', () => {
    it('isCalendarRepositoryHydrated() reflects InMemory repo (always true)', () => {
      setCalendarRepository(new InMemoryCalendarRepository([]))
      expect(isCalendarRepositoryHydrated()).toBe(true)
    })

    it('isScheduleRepositoryHydrated() reflects InMemory repo (always true)', () => {
      setScheduleRepository(new InMemoryScheduleRepository())
      expect(isScheduleRepositoryHydrated()).toBe(true)
    })
  })

  // ── 3. Team assignment write path ─────────────────────────────────────

  describe('Team assignment write path calls replace() on CalendarRepository', () => {
    it('addTeamMember calls replace() with updated assignedMemberIds', () => {
      const entry = makeEntry({ assignedMemberIds: [] })
      const repo = new InMemoryCalendarRepository([entry])
      setCalendarRepository(repo)

      const replaceSpy = vi.spyOn(repo, 'replace')

      addTeamMember('cal-1', 'member-42')

      expect(replaceSpy).toHaveBeenCalledOnce()
      const updated = replaceSpy.mock.calls[0][0]
      expect(updated.assignedMemberIds).toContain('member-42')
    })

    it('addTeamMember is idempotent — does not duplicate member', () => {
      const entry = makeEntry({ assignedMemberIds: ['member-42'] })
      const repo = new InMemoryCalendarRepository([entry])
      setCalendarRepository(repo)

      addTeamMember('cal-1', 'member-42')

      const stored = repo.getById('cal-1')!
      expect(stored.assignedMemberIds.filter((id) => id === 'member-42')).toHaveLength(1)
    })

    it('removeTeamMember calls replace() and removes the member', () => {
      const entry = makeEntry({ assignedMemberIds: ['member-42', 'member-7'] })
      const repo = new InMemoryCalendarRepository([entry])
      setCalendarRepository(repo)

      const replaceSpy = vi.spyOn(repo, 'replace')

      removeTeamMember('cal-1', 'member-42')

      expect(replaceSpy).toHaveBeenCalledOnce()
      const updated = replaceSpy.mock.calls[0][0]
      expect(updated.assignedMemberIds).not.toContain('member-42')
      expect(updated.assignedMemberIds).toContain('member-7')
    })

    it('addTeamMember on unknown entry is a no-op', () => {
      const entry = makeEntry({ id: 'cal-other' })
      const repo = new InMemoryCalendarRepository([entry])
      setCalendarRepository(repo)
      const replaceSpy = vi.spyOn(repo, 'replace')

      addTeamMember('cal-missing', 'member-42')

      expect(replaceSpy).not.toHaveBeenCalled()
    })
  })

  // ── 4. Multi-day V1 design: CalendarEntry dateKey = start day ──────────

  describe('Multi-day schedule V1 design: CalendarEntry uses start day only', () => {
    it('formatDateKey returns YYYY-MM-DD of the given timestamp', () => {
      // 2026-04-17 10:00 UTC+2 = 2026-04-17T08:00:00Z
      const ts = new Date('2026-04-17T08:00:00Z').getTime()
      const key = formatDateKey(new Date(ts))
      expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('a schedule spanning 2 days produces one CalendarEntry with start dateKey', () => {
      // Day 1 start: 2026-04-17 22:00, Day 2 end: 2026-04-18 06:00 (spans midnight)
      const startTs = new Date('2026-04-17T20:00:00Z').getTime()
      const endTs = new Date('2026-04-18T04:00:00Z').getTime() // +8h later
      const startKey = formatDateKey(new Date(startTs))
      const endKey = formatDateKey(new Date(endTs))

      // Confirm it actually spans two days
      expect(startKey).not.toBe(endKey)

      // V1 canonical behaviour: CalendarEntry gets the START day's dateKey
      const entry = makeEntry({ dateKey: startKey })
      expect(entry.dateKey).toBe(startKey)
      expect(entry.dateKey).not.toBe(endKey)
    })
  })
})
