/**
 * Worker Einsätze projection — grouping + detail contract
 *
 * Pure function tests: no mocks, no store access.
 */

import { describe, it, expect } from 'vitest'
import {
  deriveEinsaetzeListViewModel,
  deriveEinsaetzeDetailViewModel,
} from '../../src/lib/worker/workerEinsaetzeProjection'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'
import type { Job } from '../../src/lib/jobs/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TODAY = '2026-04-08'
const TOMORROW = '2026-04-09'
const YESTERDAY = '2026-04-07'
const NEXT_WEEK = '2026-04-15'

function makeEntry(overrides: Partial<CalendarEntry>): CalendarEntry {
  return {
    id: 'e-1',
    kind: 'job',
    title: 'Test Einsatz',
    customerName: 'Test Kunde',
    location: 'Hannover',
    dateLabel: 'Heute',
    dateKey: TODAY,
    startsAtLabel: '09:00',
    endsAtLabel: '12:00',
    assignedMemberIds: ['tm-1'],
    status: 'scheduled',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'j-1',
    projectId: 'p-1',
    title: 'Test Job',
    customer: 'Test Kunde',
    location: 'Hannover',
    dateLabel: 'Heute',
    status: 'in_progress',
    amount: '1000',
    description: 'Wasserpumpe tauschen',
    paymentState: 'deposit',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: ['tm-1'],
    notes: ['Material prüfen', 'Absperrung vorbereiten'],
    photoCount: 0,
    activities: [],
    ...overrides,
  } as Job
}

// ── List: empty input ─────────────────────────────────────────────────────────

describe('deriveEinsaetzeListViewModel: empty input', () => {
  it('no entries → all sections empty', () => {
    const vm = deriveEinsaetzeListViewModel([], TODAY)
    expect(vm.heute.jetzt).toHaveLength(0)
    expect(vm.heute.alsNaechstes).toHaveLength(0)
    expect(vm.heute.spaeterHeute).toHaveLength(0)
    expect(vm.demnaechst).toHaveLength(0)
    expect(vm.abgeschlossen).toHaveLength(0)
  })
})

// ── List: Heute grouping ──────────────────────────────────────────────────────

describe('deriveEinsaetzeListViewModel: Heute grouping', () => {
  it('in_progress entry today → jetzt', () => {
    const e = makeEntry({ status: 'in_progress' })
    const vm = deriveEinsaetzeListViewModel([e], TODAY)
    expect(vm.heute.jetzt).toHaveLength(1)
    expect(vm.heute.jetzt[0].id).toBe('e-1')
    expect(vm.heute.alsNaechstes).toHaveLength(0)
    expect(vm.heute.spaeterHeute).toHaveLength(0)
  })

  it('single scheduled today → alsNaechstes', () => {
    const e = makeEntry({ status: 'scheduled' })
    const vm = deriveEinsaetzeListViewModel([e], TODAY)
    expect(vm.heute.alsNaechstes).toHaveLength(1)
    expect(vm.heute.alsNaechstes[0].id).toBe('e-1')
    expect(vm.heute.spaeterHeute).toHaveLength(0)
  })

  it('two scheduled today → first in alsNaechstes, rest in spaeterHeute', () => {
    const entries = [
      makeEntry({ id: 'e-1', status: 'scheduled', startsAtLabel: '08:00' }),
      makeEntry({ id: 'e-2', status: 'scheduled', startsAtLabel: '14:00' }),
      makeEntry({ id: 'e-3', status: 'scheduled', startsAtLabel: '17:00' }),
    ]
    const vm = deriveEinsaetzeListViewModel(entries, TODAY)
    expect(vm.heute.alsNaechstes).toHaveLength(1)
    expect(vm.heute.alsNaechstes[0].id).toBe('e-1')
    expect(vm.heute.spaeterHeute).toHaveLength(2)
    expect(vm.heute.spaeterHeute[0].id).toBe('e-2')
    expect(vm.heute.spaeterHeute[1].id).toBe('e-3')
  })

  it('cancelled today → excluded from all Heute groups', () => {
    const e = makeEntry({ status: 'cancelled' })
    const vm = deriveEinsaetzeListViewModel([e], TODAY)
    expect(vm.heute.jetzt).toHaveLength(0)
    expect(vm.heute.alsNaechstes).toHaveLength(0)
    expect(vm.heute.spaeterHeute).toHaveLength(0)
  })

  it('completed today → excluded from Heute (goes to Abgeschlossen)', () => {
    const e = makeEntry({ status: 'completed' })
    const vm = deriveEinsaetzeListViewModel([e], TODAY)
    expect(vm.heute.jetzt).toHaveLength(0)
    expect(vm.heute.alsNaechstes).toHaveLength(0)
    expect(vm.heute.spaeterHeute).toHaveLength(0)
    expect(vm.abgeschlossen).toHaveLength(1)
  })

  it('jetzt + scheduled today → jetzt in jetzt, scheduled in alsNaechstes', () => {
    const entries = [
      makeEntry({ id: 'e-active', status: 'in_progress' }),
      makeEntry({ id: 'e-next', status: 'scheduled', startsAtLabel: '14:00' }),
      makeEntry({ id: 'e-later', status: 'scheduled', startsAtLabel: '17:00' }),
    ]
    const vm = deriveEinsaetzeListViewModel(entries, TODAY)
    expect(vm.heute.jetzt).toHaveLength(1)
    expect(vm.heute.jetzt[0].id).toBe('e-active')
    expect(vm.heute.alsNaechstes).toHaveLength(1)
    expect(vm.heute.alsNaechstes[0].id).toBe('e-next')
    expect(vm.heute.spaeterHeute).toHaveLength(1)
    expect(vm.heute.spaeterHeute[0].id).toBe('e-later')
  })
})

// ── List: pending classification ─────────────────────────────────────────────

describe('deriveEinsaetzeListViewModel: pending classification', () => {
  it('pending today → appears in alsNaechstes if no scheduled entry', () => {
    const e = makeEntry({ status: 'pending' })
    const vm = deriveEinsaetzeListViewModel([e], TODAY)
    expect(vm.heute.alsNaechstes).toHaveLength(1)
    expect(vm.heute.alsNaechstes[0].status).toBe('pending')
    expect(vm.heute.jetzt).toHaveLength(0)
  })

  it('pending today sorts after scheduled today in operational order', () => {
    const entries = [
      makeEntry({ id: 'e-sched', status: 'scheduled', startsAtLabel: '10:00' }),
      makeEntry({ id: 'e-pend',  status: 'pending',   startsAtLabel: '08:00' }),
    ]
    const vm = deriveEinsaetzeListViewModel(entries, TODAY)
    // scheduled (e-sched) should be alsNaechstes, pending (e-pend) spaeterHeute
    expect(vm.heute.alsNaechstes[0].id).toBe('e-sched')
    expect(vm.heute.spaeterHeute[0].id).toBe('e-pend')
  })

  it('pending future → visible in Demnächst', () => {
    const e = makeEntry({ id: 'e-f', status: 'pending', dateKey: TOMORROW, dateLabel: 'Morgen' })
    const vm = deriveEinsaetzeListViewModel([e], TODAY)
    expect(vm.demnaechst).toHaveLength(1)
    expect(vm.demnaechst[0].entries[0].id).toBe('e-f')
  })

  it('pending past → excluded everywhere', () => {
    const e = makeEntry({ id: 'e-p', status: 'pending', dateKey: YESTERDAY, dateLabel: 'Gestern' })
    const vm = deriveEinsaetzeListViewModel([e], TODAY)
    expect(vm.heute.alsNaechstes).toHaveLength(0)
    expect(vm.demnaechst).toHaveLength(0)
    expect(vm.abgeschlossen).toHaveLength(0)
  })
})

// ── List: Demnächst grouping ──────────────────────────────────────────────────

describe('deriveEinsaetzeListViewModel: Demnächst grouping', () => {
  it('future scheduled entry → Demnächst', () => {
    const e = makeEntry({ id: 'e-f', dateKey: TOMORROW, dateLabel: 'Morgen', status: 'scheduled' })
    const vm = deriveEinsaetzeListViewModel([e], TODAY)
    expect(vm.demnaechst).toHaveLength(1)
    expect(vm.demnaechst[0].dateKey).toBe(TOMORROW)
    expect(vm.demnaechst[0].dateLabel).toBe('Morgen')
    expect(vm.demnaechst[0].entries).toHaveLength(1)
  })

  it('two future entries on same day → one group', () => {
    const entries = [
      makeEntry({ id: 'e-1', dateKey: TOMORROW, dateLabel: 'Morgen', startsAtLabel: '08:00', status: 'scheduled' }),
      makeEntry({ id: 'e-2', dateKey: TOMORROW, dateLabel: 'Morgen', startsAtLabel: '14:00', status: 'scheduled' }),
    ]
    const vm = deriveEinsaetzeListViewModel(entries, TODAY)
    expect(vm.demnaechst).toHaveLength(1)
    expect(vm.demnaechst[0].entries).toHaveLength(2)
  })

  it('future entries on different days → separate groups, sorted chronologically', () => {
    const entries = [
      makeEntry({ id: 'e-nw', dateKey: NEXT_WEEK, dateLabel: 'Nächste Woche', status: 'scheduled' }),
      makeEntry({ id: 'e-tm', dateKey: TOMORROW,  dateLabel: 'Morgen',        status: 'scheduled' }),
    ]
    const vm = deriveEinsaetzeListViewModel(entries, TODAY)
    expect(vm.demnaechst).toHaveLength(2)
    expect(vm.demnaechst[0].dateKey).toBe(TOMORROW)
    expect(vm.demnaechst[1].dateKey).toBe(NEXT_WEEK)
  })

  it('today entries do not appear in Demnächst', () => {
    const e = makeEntry({ dateKey: TODAY, status: 'scheduled' })
    const vm = deriveEinsaetzeListViewModel([e], TODAY)
    expect(vm.demnaechst).toHaveLength(0)
  })

  it('completed future entry excluded from Demnächst', () => {
    const e = makeEntry({ id: 'e-f', dateKey: TOMORROW, status: 'completed' })
    const vm = deriveEinsaetzeListViewModel([e], TODAY)
    expect(vm.demnaechst).toHaveLength(0)
    expect(vm.abgeschlossen).toHaveLength(1)
  })

  it('cancelled future entry excluded from Demnächst', () => {
    const e = makeEntry({ id: 'e-f', dateKey: TOMORROW, status: 'cancelled' })
    const vm = deriveEinsaetzeListViewModel([e], TODAY)
    expect(vm.demnaechst).toHaveLength(0)
  })
})

// ── List: Abgeschlossen ───────────────────────────────────────────────────────

describe('deriveEinsaetzeListViewModel: Abgeschlossen', () => {
  it('completed entries across dates → Abgeschlossen', () => {
    const entries = [
      makeEntry({ id: 'e-today', dateKey: TODAY,     status: 'completed' }),
      makeEntry({ id: 'e-past',  dateKey: YESTERDAY, status: 'completed' }),
    ]
    const vm = deriveEinsaetzeListViewModel(entries, TODAY)
    expect(vm.abgeschlossen).toHaveLength(2)
  })

  it('Abgeschlossen sorted newest first', () => {
    const entries = [
      makeEntry({ id: 'e-old',  dateKey: YESTERDAY, status: 'completed', startsAtLabel: '09:00' }),
      makeEntry({ id: 'e-new',  dateKey: TODAY,     status: 'completed', startsAtLabel: '08:00' }),
    ]
    const vm = deriveEinsaetzeListViewModel(entries, TODAY)
    expect(vm.abgeschlossen[0].id).toBe('e-new')
    expect(vm.abgeschlossen[1].id).toBe('e-old')
  })

  it('no completed entries → Abgeschlossen empty', () => {
    const e = makeEntry({ status: 'scheduled' })
    const vm = deriveEinsaetzeListViewModel([e], TODAY)
    expect(vm.abgeschlossen).toHaveLength(0)
  })
})

// ── List: mixed state scenarios ───────────────────────────────────────────────

describe('deriveEinsaetzeListViewModel: mixed states', () => {
  it('worker with active + next today + upcoming + completed', () => {
    const entries = [
      makeEntry({ id: 'a', status: 'in_progress',  dateKey: TODAY }),
      makeEntry({ id: 'b', status: 'scheduled',    dateKey: TODAY,    startsAtLabel: '15:00' }),
      makeEntry({ id: 'c', status: 'scheduled',    dateKey: TOMORROW, dateLabel: 'Morgen' }),
      makeEntry({ id: 'd', status: 'completed',    dateKey: YESTERDAY }),
    ]
    const vm = deriveEinsaetzeListViewModel(entries, TODAY)
    expect(vm.heute.jetzt[0].id).toBe('a')
    expect(vm.heute.alsNaechstes[0].id).toBe('b')
    expect(vm.heute.spaeterHeute).toHaveLength(0)
    expect(vm.demnaechst).toHaveLength(1)
    expect(vm.abgeschlossen).toHaveLength(1)
  })

  it('worker with empty Heute but populated Demnächst', () => {
    const e = makeEntry({ id: 'e-f', dateKey: TOMORROW, dateLabel: 'Morgen', status: 'scheduled' })
    const vm = deriveEinsaetzeListViewModel([e], TODAY)
    expect(vm.heute.jetzt).toHaveLength(0)
    expect(vm.heute.alsNaechstes).toHaveLength(0)
    expect(vm.demnaechst).toHaveLength(1)
  })

  it('fully empty schedule → all sections empty', () => {
    const vm = deriveEinsaetzeListViewModel([], TODAY)
    expect(vm.heute.jetzt).toHaveLength(0)
    expect(vm.heute.alsNaechstes).toHaveLength(0)
    expect(vm.heute.spaeterHeute).toHaveLength(0)
    expect(vm.demnaechst).toHaveLength(0)
    expect(vm.abgeschlossen).toHaveLength(0)
  })
})

// ── Detail: basic ─────────────────────────────────────────────────────────────

describe('deriveEinsaetzeDetailViewModel: basic', () => {
  it('scheduled entry → canStart true, canComplete false', () => {
    const e = makeEntry({ status: 'scheduled' })
    const vm = deriveEinsaetzeDetailViewModel(e, [])
    expect(vm.canStart).toBe(true)
    expect(vm.canComplete).toBe(false)
    expect(vm.entry).toBe(e)
  })

  it('pending entry → canStart true, canComplete false', () => {
    const e = makeEntry({ status: 'pending' })
    const vm = deriveEinsaetzeDetailViewModel(e, [])
    expect(vm.canStart).toBe(true)
    expect(vm.canComplete).toBe(false)
  })

  it('in_progress entry → canStart false, canComplete true', () => {
    const e = makeEntry({ status: 'in_progress' })
    const vm = deriveEinsaetzeDetailViewModel(e, [])
    expect(vm.canStart).toBe(false)
    expect(vm.canComplete).toBe(true)
  })

  it('completed entry → canStart false, canComplete false', () => {
    const e = makeEntry({ status: 'completed' })
    const vm = deriveEinsaetzeDetailViewModel(e, [])
    expect(vm.canStart).toBe(false)
    expect(vm.canComplete).toBe(false)
  })

  it('cancelled entry → canStart false, canComplete false', () => {
    const e = makeEntry({ status: 'cancelled' })
    const vm = deriveEinsaetzeDetailViewModel(e, [])
    expect(vm.canStart).toBe(false)
    expect(vm.canComplete).toBe(false)
  })
})

// ── Detail: job linkage ───────────────────────────────────────────────────────

describe('deriveEinsaetzeDetailViewModel: job linkage', () => {
  it('entry with matching jobId → job resolved', () => {
    const e = makeEntry({ jobId: 'j-1' })
    const j = makeJob({ id: 'j-1' })
    const vm = deriveEinsaetzeDetailViewModel(e, [j])
    expect(vm.job).not.toBeNull()
    expect(vm.job?.id).toBe('j-1')
  })

  it('entry without jobId → job null', () => {
    const e = makeEntry({ jobId: undefined })
    const vm = deriveEinsaetzeDetailViewModel(e, [makeJob()])
    expect(vm.job).toBeNull()
  })

  it('entry with unknown jobId → job null (no crash)', () => {
    const e = makeEntry({ jobId: 'nonexistent' })
    const vm = deriveEinsaetzeDetailViewModel(e, [makeJob({ id: 'j-other' })])
    expect(vm.job).toBeNull()
  })

  it('no jobs array → job null (no crash)', () => {
    const e = makeEntry({ jobId: 'j-1' })
    const vm = deriveEinsaetzeDetailViewModel(e, [])
    expect(vm.job).toBeNull()
  })
})

// ── No owner/admin leakage ────────────────────────────────────────────────────

describe('deriveEinsaetzeListViewModel: no owner/admin leakage', () => {
  it('list vm contains only CalendarEntry fields (no Job finance state)', () => {
    const e = makeEntry({ status: 'scheduled' })
    const vm = deriveEinsaetzeListViewModel([e], TODAY)
    const entry = vm.heute.alsNaechstes[0]
    // These fields must NOT exist on a CalendarEntry
    expect('paymentState' in entry).toBe(false)
    expect('amount' in entry).toBe(false)
    expect('disputeStatus' in entry).toBe(false)
  })
})
