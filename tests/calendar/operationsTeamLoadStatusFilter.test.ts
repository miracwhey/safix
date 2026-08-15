import { describe, it, expect } from 'vitest'
import {
  buildTodayTeamLoad,
  getOverbookedMembers,
  getBusyMembers,
} from '../../src/lib/calendar/operationsEngine'
import type { CalendarEntry, CalendarEntryStatus } from '../../src/lib/calendar/calendarTypes'

function todayEntry(id: string, status: CalendarEntryStatus, members: string[]): CalendarEntry {
  return {
    id,
    kind: 'job',
    jobId: id,
    title: '',
    description: '',
    customerName: '',
    location: '',
    dateLabel: 'Heute', // forces isTodayEntry regardless of dateKey
    dateKey: '2020-01-01',
    startsAtLabel: '09:00',
    endsAtLabel: '11:00',
    assignedMemberIds: members,
    status,
    createdAt: 0,
    updatedAt: 0,
  }
}

// ---------------------------------------------------------------------------
// U2 — today team-load must only count active (scheduled / in_progress) work.
// Completed / awaiting_payment / cancelled / pending entries must not inflate
// a member's load or trigger a false overbooked alert.
// ---------------------------------------------------------------------------

describe('buildTodayTeamLoad — active-status filter (U2)', () => {
  it('excludes completed/awaiting_payment/cancelled/pending from a member load', () => {
    const entries = [
      todayEntry('a', 'completed', ['m1']),
      todayEntry('b', 'awaiting_payment', ['m1']),
      todayEntry('c', 'cancelled', ['m1']),
      todayEntry('d', 'pending', ['m1']),
      todayEntry('e', 'scheduled', ['m1']),
    ]
    const loads = buildTodayTeamLoad(entries)
    const m1 = loads.find((l) => l.memberId === 'm1')
    expect(m1?.jobs.length).toBe(1) // only the scheduled entry counts
  })

  it('does NOT flag a member overbooked for 3 finished jobs today', () => {
    const finished = [
      todayEntry('a', 'completed', ['m1']),
      todayEntry('b', 'completed', ['m1']),
      todayEntry('c', 'completed', ['m1']),
    ]
    expect(getOverbookedMembers(buildTodayTeamLoad(finished))).toHaveLength(0)
    expect(getBusyMembers(buildTodayTeamLoad(finished))).toHaveLength(0)
  })

  it('DOES flag a member overbooked for 3 active jobs today', () => {
    const active = [
      todayEntry('a', 'scheduled', ['m2']),
      todayEntry('b', 'scheduled', ['m2']),
      todayEntry('c', 'in_progress', ['m2']),
    ]
    const overbooked = getOverbookedMembers(buildTodayTeamLoad(active))
    expect(overbooked).toHaveLength(1)
    expect(overbooked[0].memberId).toBe('m2')
  })
})
