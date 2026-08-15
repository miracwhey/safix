import { describe, it, expect, beforeEach, vi } from 'vitest'

// calendarStore transitively imports jobs/service → supabase. Mock the client
// so module load doesn't touch the network; the test drives an InMemory repo.
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
  },
}))

import { setCalendarRepository } from '../../src/lib/calendar/repository/registry'
import { InMemoryCalendarRepository } from '../../src/lib/calendar/repository/InMemoryCalendarRepository'
import {
  syncCalendarEntriesForJobs,
  getCalendarEntryByJobId,
} from '../../src/lib/calendar/calendarStore'
import { clearPersistenceFailures } from '../../src/lib/persistence/persistenceErrorStore'
import type { CalendarEntry, CalendarEntryStatus } from '../../src/lib/calendar/calendarTypes'
import type { Job } from '../../src/lib/jobs/types'

function entry(jobId: string, members: string[], status: CalendarEntryStatus = 'scheduled'): CalendarEntry {
  return {
    id: `cal-${jobId}`,
    kind: 'job',
    jobId,
    providerId: 'prov-1',
    title: '',
    description: '',
    customerName: '',
    location: '',
    dateLabel: 'Morgen',
    dateKey: '2020-01-02',
    startsAtLabel: '09:00',
    endsAtLabel: '11:00',
    assignedMemberIds: members,
    status,
    createdAt: 0,
    updatedAt: 0,
  }
}

function job(id: string, members: string[], status = 'scheduled'): Job {
  return { id, status, assignedMemberIds: members } as unknown as Job
}

beforeEach(() => {
  clearPersistenceFailures()
})

// ---------------------------------------------------------------------------
// M2 — the CalendarEntry's assignedMemberIds snapshot must reconcile to the
// live job truth so the Operations team-load board isn't frozen/empty.
// ---------------------------------------------------------------------------

describe('syncCalendarEntriesForJobs — assignedMemberIds reconcile (M2)', () => {
  it('propagates a newly assigned member to the calendar entry', () => {
    setCalendarRepository(new InMemoryCalendarRepository([entry('j1', ['m1'])]))
    syncCalendarEntriesForJobs([job('j1', ['m1', 'm2'])])
    expect(getCalendarEntryByJobId('j1')?.assignedMemberIds).toEqual(['m1', 'm2'])
  })

  it('propagates a Springer reassignment (sick member → replacement)', () => {
    setCalendarRepository(new InMemoryCalendarRepository([entry('j2', ['sick'])]))
    syncCalendarEntriesForJobs([job('j2', ['replacement'])])
    expect(getCalendarEntryByJobId('j2')?.assignedMemberIds).toEqual(['replacement'])
  })

  it('does not rewrite when members are unchanged (order-insensitive)', () => {
    setCalendarRepository(new InMemoryCalendarRepository([entry('j3', ['m1', 'm2'])]))
    const before = getCalendarEntryByJobId('j3')?.updatedAt
    syncCalendarEntriesForJobs([job('j3', ['m2', 'm1'])])
    // unchanged set → no replace → updatedAt untouched
    expect(getCalendarEntryByJobId('j3')?.updatedAt).toBe(before)
    expect(getCalendarEntryByJobId('j3')?.assignedMemberIds).toEqual(['m1', 'm2'])
  })

  it('carries a status reconcile in the same write as a member change', () => {
    setCalendarRepository(new InMemoryCalendarRepository([entry('j4', ['m1'], 'scheduled')]))
    syncCalendarEntriesForJobs([job('j4', ['m1', 'm2'], 'completed')])
    const result = getCalendarEntryByJobId('j4')
    expect(result?.assignedMemberIds).toEqual(['m1', 'm2'])
    expect(result?.status).toBe('completed')
  })
})
