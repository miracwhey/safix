import { describe, expect, it } from 'vitest'

import {
  buildIstMinutesIndex,
  computeElapsedMinutes,
  deriveActiveDayState,
  deriveActiveJobState,
  deriveHoursBarData,
  deriveUnderTargetMembers,
  deriveWeeklyHoursIst,
} from '../../src/lib/team/timeEntrySelectors'
import type { TimeEntry } from '../../src/lib/team/timeEntryTypes'
import type { TeamMember } from '../../src/lib/jobs/types'

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: overrides.id ?? 'te-1',
    providerId: overrides.providerId ?? 'p-1',
    memberId: overrides.memberId ?? 'm-1',
    kind: overrides.kind ?? 'day',
    jobId: overrides.jobId ?? null,
    startedAt: overrides.startedAt ?? '2026-05-04T07:00:00Z',
    endedAt: overrides.endedAt ?? null,
    durationMinutes: overrides.durationMinutes ?? null,
    note: overrides.note ?? null,
    status: overrides.status ?? 'active',
    rejectedReason: overrides.rejectedReason ?? null,
    rejectedBy: overrides.rejectedBy ?? null,
    createdAt: overrides.createdAt ?? '2026-05-04T07:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-05-04T07:00:00Z',
  }
}

function makeMember(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    id: 'm-1',
    name: 'Anna',
    role: 'worker',
    isActive: true,
    userId: 'u-1',
    phone: null,
    email: null,
    avatarUrl: null,
    weeklyTargetHours: null,
    dailyTargetHours: null,
    ...overrides,
  } as TeamMember
}

const WEEK = {
  // Monday 2026-05-04 00:00 UTC → Sunday 2026-05-10 23:59:59
  startIso: '2026-05-04T00:00:00Z',
  endIso: '2026-05-11T00:00:00Z',
}

// ─────────────────────────────────────────────────────────────────────────────
// deriveActiveDayState
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveActiveDayState', () => {
  it('returns idle for empty entry list', () => {
    expect(deriveActiveDayState([], 'm-1')).toEqual({ state: 'idle' })
  })

  it('returns active when a day timer is running for the member', () => {
    const entries = [
      makeEntry({ id: 'te-day', kind: 'day', status: 'active', startedAt: '2026-05-04T07:30:00Z' }),
    ]
    expect(deriveActiveDayState(entries, 'm-1')).toEqual({
      state: 'active',
      entryId: 'te-day',
      startedAt: '2026-05-04T07:30:00Z',
      note: null,
    })
  })

  it('ignores closed/rejected entries', () => {
    const entries = [
      makeEntry({ id: 'te-1', kind: 'day', status: 'closed', durationMinutes: 480, endedAt: '2026-05-04T15:00:00Z' }),
      makeEntry({ id: 'te-2', kind: 'day', status: 'rejected', durationMinutes: 480, endedAt: '2026-05-04T15:00:00Z', rejectedReason: 'no' }),
    ]
    expect(deriveActiveDayState(entries, 'm-1')).toEqual({ state: 'idle' })
  })

  it('ignores active job entries', () => {
    const entries = [makeEntry({ kind: 'job', jobId: 'j-1', status: 'active' })]
    expect(deriveActiveDayState(entries, 'm-1')).toEqual({ state: 'idle' })
  })

  it('ignores entries belonging to a different member', () => {
    const entries = [makeEntry({ memberId: 'm-OTHER', kind: 'day', status: 'active' })]
    expect(deriveActiveDayState(entries, 'm-1')).toEqual({ state: 'idle' })
  })

  it('picks the most recent when multiple active rows exist (defensive)', () => {
    const entries = [
      makeEntry({ id: 'old', kind: 'day', status: 'active', startedAt: '2026-05-04T05:00:00Z' }),
      makeEntry({ id: 'new', kind: 'day', status: 'active', startedAt: '2026-05-04T08:00:00Z' }),
    ]
    const r = deriveActiveDayState(entries, 'm-1')
    expect(r.state === 'active' && r.entryId).toBe('new')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// deriveActiveJobState
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveActiveJobState', () => {
  it('returns idle for empty list', () => {
    expect(deriveActiveJobState([], 'm-1')).toEqual({ state: 'idle' })
  })

  it('returns active when a job timer is running', () => {
    const entries = [
      makeEntry({ id: 'te-job', kind: 'job', jobId: 'j-1', status: 'active', startedAt: '2026-05-04T09:00:00Z', note: 'Bad' }),
    ]
    expect(deriveActiveJobState(entries, 'm-1')).toEqual({
      state: 'active',
      entryId: 'te-job',
      jobId: 'j-1',
      startedAt: '2026-05-04T09:00:00Z',
      note: 'Bad',
    })
  })

  it('ignores entries with kind=day', () => {
    const entries = [makeEntry({ kind: 'day', status: 'active' })]
    expect(deriveActiveJobState(entries, 'm-1')).toEqual({ state: 'idle' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// computeElapsedMinutes
// ─────────────────────────────────────────────────────────────────────────────

describe('computeElapsedMinutes', () => {
  it('computes minutes between started and now', () => {
    const started = '2026-05-04T07:00:00Z'
    const now = new Date('2026-05-04T07:30:00Z')
    expect(computeElapsedMinutes(started, now)).toBe(30)
  })

  it('returns 0 for invalid date', () => {
    expect(computeElapsedMinutes('not-a-date', new Date())).toBe(0)
  })

  it('clamps negative to 0', () => {
    const started = '2026-05-04T08:00:00Z'
    const now = new Date('2026-05-04T07:00:00Z')
    expect(computeElapsedMinutes(started, now)).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// deriveWeeklyHoursIst
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveWeeklyHoursIst', () => {
  it('returns 0 for no entries', () => {
    expect(deriveWeeklyHoursIst([], 'm-1', WEEK)).toBe(0)
  })

  it('sums closed day-entries within the week', () => {
    const entries = [
      makeEntry({ id: '1', kind: 'day', status: 'closed', durationMinutes: 480, endedAt: '2026-05-04T15:00:00Z', startedAt: '2026-05-04T07:00:00Z' }),
      makeEntry({ id: '2', kind: 'day', status: 'closed', durationMinutes: 240, endedAt: '2026-05-05T11:00:00Z', startedAt: '2026-05-05T07:00:00Z' }),
    ]
    expect(deriveWeeklyHoursIst(entries, 'm-1', WEEK)).toBe(720)
  })

  it('excludes active entries (no duration)', () => {
    const entries = [
      makeEntry({ kind: 'day', status: 'active', startedAt: '2026-05-04T07:00:00Z' }),
    ]
    expect(deriveWeeklyHoursIst(entries, 'm-1', WEEK)).toBe(0)
  })

  it('excludes rejected entries', () => {
    const entries = [
      makeEntry({ id: 'r', kind: 'day', status: 'rejected', durationMinutes: 480, endedAt: '2026-05-04T15:00:00Z', rejectedReason: 'no' }),
    ]
    expect(deriveWeeklyHoursIst(entries, 'm-1', WEEK)).toBe(0)
  })

  it('excludes job-kind entries (only day counts)', () => {
    const entries = [
      makeEntry({ kind: 'job', jobId: 'j-1', status: 'closed', durationMinutes: 120, endedAt: '2026-05-04T11:00:00Z' }),
    ]
    expect(deriveWeeklyHoursIst(entries, 'm-1', WEEK)).toBe(0)
  })

  it('excludes entries before week start', () => {
    const entries = [
      makeEntry({ kind: 'day', status: 'closed', durationMinutes: 480, startedAt: '2026-05-03T07:00:00Z', endedAt: '2026-05-03T15:00:00Z' }),
    ]
    expect(deriveWeeklyHoursIst(entries, 'm-1', WEEK)).toBe(0)
  })

  it('excludes entries at or after week end (semi-open)', () => {
    const entries = [
      makeEntry({ kind: 'day', status: 'closed', durationMinutes: 480, startedAt: '2026-05-11T00:00:00Z', endedAt: '2026-05-11T08:00:00Z' }),
    ]
    expect(deriveWeeklyHoursIst(entries, 'm-1', WEEK)).toBe(0)
  })

  it('does not bleed across members', () => {
    const entries = [
      makeEntry({ memberId: 'm-OTHER', kind: 'day', status: 'closed', durationMinutes: 480, endedAt: '2026-05-04T15:00:00Z' }),
    ]
    expect(deriveWeeklyHoursIst(entries, 'm-1', WEEK)).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// deriveHoursBarData
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveHoursBarData', () => {
  it('returns gray when soll is null', () => {
    const r = deriveHoursBarData(null, 60)
    expect(r.color).toBe('gray')
    expect(r.pct).toBe(0)
  })

  it('returns gray when soll is 0', () => {
    expect(deriveHoursBarData(0, 60).color).toBe('gray')
  })

  it('amber for 0%', () => {
    expect(deriveHoursBarData(2400, 0).color).toBe('amber')
  })

  it('amber for 49% (boundary just below 50)', () => {
    const r = deriveHoursBarData(40 * 60, Math.floor((49 / 100) * 40 * 60))
    expect(r.color).toBe('amber')
  })

  it('blue at 50% (boundary)', () => {
    const r = deriveHoursBarData(40 * 60, 20 * 60)
    expect(r.color).toBe('blue')
    expect(r.pct).toBe(50)
  })

  it('blue at 100%', () => {
    expect(deriveHoursBarData(40 * 60, 40 * 60).color).toBe('blue')
  })

  it('blue at 110% (still tolerance)', () => {
    expect(deriveHoursBarData(40 * 60, 44 * 60).color).toBe('blue')
  })

  it('red above 110%', () => {
    expect(deriveHoursBarData(40 * 60, 45 * 60).color).toBe('red')
  })

  it('caps capPct at 150 even when over-utilised', () => {
    const r = deriveHoursBarData(40 * 60, 80 * 60) // 200%
    expect(r.pct).toBe(200)
    expect(r.capPct).toBe(150)
    expect(r.color).toBe('red')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// deriveUnderTargetMembers
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveUnderTargetMembers', () => {
  it('filters members under 50% of their soll', () => {
    const members = [
      makeMember({ id: 'a', name: 'Anna', userId: 'u-a', weeklyTargetHours: 40 }),
      makeMember({ id: 'b', name: 'Bob', userId: 'u-b', weeklyTargetHours: 40 }),
      makeMember({ id: 'c', name: 'Cara', userId: 'u-c', weeklyTargetHours: 40 }),
    ]
    const ist = new Map<string, number>([
      ['a', 10 * 60],   // 25% — under
      ['b', 30 * 60],   // 75% — ok
      ['c', 40 * 60],   // 100% — ok
    ])
    const r = deriveUnderTargetMembers(members, ist)
    expect(r.map((m) => m.memberId)).toEqual(['a'])
    expect(r[0]?.istMinutes).toBe(600)
  })

  it('ignores members with no weeklyTargetHours', () => {
    const members = [makeMember({ id: 'a', userId: 'u-a', weeklyTargetHours: null })]
    expect(deriveUnderTargetMembers(members, new Map())).toEqual([])
  })

  it('ignores owners', () => {
    const members = [makeMember({ id: 'o', role: 'owner', weeklyTargetHours: 40 })]
    expect(deriveUnderTargetMembers(members, new Map())).toEqual([])
  })

  it('ignores inactive and stub members', () => {
    const members = [
      makeMember({ id: 'i', userId: 'u-i', weeklyTargetHours: 40, isActive: false }),
      makeMember({ id: 's', userId: undefined, weeklyTargetHours: 40 }),
    ]
    expect(deriveUnderTargetMembers(members, new Map())).toEqual([])
  })

  it('sorts ascending by pct (most-under first)', () => {
    const members = [
      makeMember({ id: 'a', name: 'Anna', userId: 'u-a', weeklyTargetHours: 40 }),
      makeMember({ id: 'b', name: 'Bob', userId: 'u-b', weeklyTargetHours: 40 }),
    ]
    const ist = new Map<string, number>([
      ['a', 12 * 60], // 30%
      ['b', 6 * 60],  // 15%
    ])
    const r = deriveUnderTargetMembers(members, ist)
    expect(r.map((m) => m.memberId)).toEqual(['b', 'a'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// buildIstMinutesIndex
// ─────────────────────────────────────────────────────────────────────────────

describe('buildIstMinutesIndex', () => {
  it('aggregates closed day-minutes per member within range', () => {
    const entries = [
      makeEntry({ id: '1', memberId: 'a', kind: 'day', status: 'closed', durationMinutes: 480, endedAt: '2026-05-04T15:00:00Z', startedAt: '2026-05-04T07:00:00Z' }),
      makeEntry({ id: '2', memberId: 'a', kind: 'day', status: 'closed', durationMinutes: 240, endedAt: '2026-05-05T11:00:00Z', startedAt: '2026-05-05T07:00:00Z' }),
      makeEntry({ id: '3', memberId: 'b', kind: 'day', status: 'closed', durationMinutes: 360, endedAt: '2026-05-04T13:00:00Z', startedAt: '2026-05-04T07:00:00Z' }),
    ]
    const idx = buildIstMinutesIndex(entries, WEEK)
    expect(idx.get('a')).toBe(720)
    expect(idx.get('b')).toBe(360)
  })

  it('skips out-of-range entries', () => {
    const entries = [
      makeEntry({ memberId: 'a', kind: 'day', status: 'closed', durationMinutes: 480, startedAt: '2026-04-30T07:00:00Z', endedAt: '2026-04-30T15:00:00Z' }),
    ]
    const idx = buildIstMinutesIndex(entries, WEEK)
    expect(idx.get('a')).toBeUndefined()
  })
})
