import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
  applyCorrectionToTarget,
  parseTimeRange,
} from '../../src/lib/workflow/correctionApply'
import {
  setCalendarRepository,
  type CalendarRepository,
} from '../../src/lib/calendar/repository'
import { InMemoryCalendarRepository } from '../../src/lib/calendar/repository/InMemoryCalendarRepository'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'
import type { CorrectionRequest } from '../../src/lib/corrections'

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: 'cal-1',
    jobId: 'job-1',
    kind: 'job',
    providerId: 'prov-A',
    title: 'Bad Müller',
    description: '',
    customerName: 'Müller',
    location: 'Berlin',
    dateLabel: 'Mo 28.04.',
    dateKey: '2026-04-28',
    startsAtLabel: '08:00',
    endsAtLabel: '16:00',
    assignedMemberIds: ['tm-worker'],
    status: 'in_progress',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function makeCorrection(overrides: Partial<CorrectionRequest> = {}): CorrectionRequest {
  return {
    id: 'cr-1',
    providerId: 'prov-A',
    workerTeamMemberId: 'tm-worker',
    workerProfileId: 'user-worker',
    kind: 'wrong_time',
    description: 'falsche Zeit',
    status: 'open',
    calendarEntryId: 'cal-1',
    proposedValue: '09:00-13:00',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

// ── parseTimeRange ───────────────────────────────────────────────────────────

describe('parseTimeRange', () => {
  it('parses canonical HH:MM-HH:MM into normalized labels', () => {
    expect(parseTimeRange('09:00-13:00')).toEqual({
      startsAtLabel: '09:00',
      endsAtLabel: '13:00',
    })
  })

  it('tolerates leading-zero-less hours and pads them', () => {
    expect(parseTimeRange('9:00-13:00')).toEqual({
      startsAtLabel: '09:00',
      endsAtLabel: '13:00',
    })
  })

  it('tolerates surrounding whitespace + spaces around the dash', () => {
    expect(parseTimeRange('  09:00 - 13:00  ')).toEqual({
      startsAtLabel: '09:00',
      endsAtLabel: '13:00',
    })
  })

  it('returns null on completely empty input', () => {
    expect(parseTimeRange('')).toBeNull()
  })

  it('returns null when the dash separator is missing', () => {
    expect(parseTimeRange('09:00 13:00')).toBeNull()
  })

  it('returns null for non-numeric content', () => {
    expect(parseTimeRange('abc-def')).toBeNull()
  })

  it('returns null for out-of-range hours', () => {
    expect(parseTimeRange('25:00-26:00')).toBeNull()
  })

  it('returns null for out-of-range minutes', () => {
    expect(parseTimeRange('09:60-13:00')).toBeNull()
  })

  it('returns null when end <= start (zero or negative duration)', () => {
    expect(parseTimeRange('13:00-09:00')).toBeNull()
    expect(parseTimeRange('09:00-09:00')).toBeNull()
  })
})

// ── applyCorrectionToTarget ──────────────────────────────────────────────────

describe('applyCorrectionToTarget', () => {
  beforeEach(() => {
    setCalendarRepository(new InMemoryCalendarRepository([]))
  })

  it('applies wrong_time onto the linked entry, preserving dateKey', async () => {
    const entry = makeEntry()
    setCalendarRepository(new InMemoryCalendarRepository([entry]))
    const correction = makeCorrection({ proposedValue: '09:30-12:45' })

    const result = await applyCorrectionToTarget(correction)

    expect(result).toEqual({ applied: true, targetEntryId: 'cal-1' })
    const { getCalendarEntryById } = await import(
      '../../src/lib/calendar/calendarStore'
    )
    const updated = getCalendarEntryById('cal-1')
    expect(updated).toBeDefined()
    expect(updated!.dateKey).toBe('2026-04-28') // unchanged
    expect(updated!.startsAtLabel).toBe('09:30')
    expect(updated!.endsAtLabel).toBe('12:45')
  })

  it('skips with kind_not_supported for non-wrong_time kinds', async () => {
    setCalendarRepository(new InMemoryCalendarRepository([makeEntry()]))
    const result = await applyCorrectionToTarget(
      makeCorrection({ kind: 'missing_time' }),
    )
    expect(result).toEqual({ applied: false, skipReason: 'kind_not_supported' })
  })

  it('skips with kind_not_supported for "other"', async () => {
    setCalendarRepository(new InMemoryCalendarRepository([makeEntry()]))
    const result = await applyCorrectionToTarget(makeCorrection({ kind: 'other' }))
    expect(result).toEqual({ applied: false, skipReason: 'kind_not_supported' })
  })

  it('skips with missing_calendar_entry when calendarEntryId is absent', async () => {
    setCalendarRepository(new InMemoryCalendarRepository([]))
    const result = await applyCorrectionToTarget(
      makeCorrection({ calendarEntryId: undefined }),
    )
    expect(result).toEqual({ applied: false, skipReason: 'missing_calendar_entry' })
  })

  it('skips with missing_calendar_entry when entry no longer exists in repo', async () => {
    setCalendarRepository(new InMemoryCalendarRepository([]))
    const result = await applyCorrectionToTarget(makeCorrection())
    expect(result).toEqual({ applied: false, skipReason: 'missing_calendar_entry' })
  })

  it('skips with invalid_time_format when proposedValue is missing', async () => {
    setCalendarRepository(new InMemoryCalendarRepository([makeEntry()]))
    const result = await applyCorrectionToTarget(
      makeCorrection({ proposedValue: undefined }),
    )
    expect(result).toEqual({ applied: false, skipReason: 'invalid_time_format' })
  })

  it('skips with invalid_time_format when proposedValue cannot be parsed', async () => {
    setCalendarRepository(new InMemoryCalendarRepository([makeEntry()]))
    const result = await applyCorrectionToTarget(
      makeCorrection({ proposedValue: 'morgens' }),
    )
    expect(result).toEqual({ applied: false, skipReason: 'invalid_time_format' })
  })

  it('skips with repository_error when updateScheduling rejects', async () => {
    const entry = makeEntry()
    const throwingRepo: CalendarRepository = {
      initialize: async () => {},
      isHydrated: () => true,
      subscribe: () => () => {},
      getAll: () => [entry],
      getById: (id) => (id === entry.id ? entry : undefined),
      getByJobId: () => undefined,
      add: async () => {},
      replace: async () => {},
      updateStatus: async () => {},
      updateScheduling: vi.fn().mockRejectedValue(new Error('boom')),
    }
    setCalendarRepository(throwingRepo)

    const result = await applyCorrectionToTarget(makeCorrection())
    expect(result).toEqual({ applied: false, skipReason: 'repository_error' })
  })
})
