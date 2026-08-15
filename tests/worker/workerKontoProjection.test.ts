/**
 * Worker Konto projection — view-model derivation contract
 *
 * Tests the pure deriveWorkerKontoViewModel function. No mocks needed:
 * inputs are plain objects matching the domain types.
 */

import { describe, it, expect } from 'vitest'
import { deriveWorkerKontoViewModel } from '../../src/lib/worker/workerKontoProjection'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'
import type { WorkerMembership } from '../../src/lib/company/membership'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TODAY_KEY = '2026-04-08' // Wednesday in the week Mon 6 – Sun 12 Apr

const MEMBERSHIP: WorkerMembership = {
  teamMemberId: 'tm-1',
  providerId: 'prov-1',
  role: 'Elektriker',
  name: 'Leon Becker',
}

function makeEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: 'e-1',
    kind: 'job',
    title: 'Elektroinstallation',
    customerName: 'Mustermann',
    location: 'Hannover',
    dateLabel: 'Heute',
    dateKey: TODAY_KEY,
    startsAtLabel: '08:00',
    endsAtLabel: '14:00', // 6h
    assignedMemberIds: ['tm-1'],
    status: 'scheduled',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

// ── Header derivation ─────────────────────────────────────────────────────────

describe('header', () => {
  it('uses membership name when present', () => {
    const vm = deriveWorkerKontoViewModel({
      membership: MEMBERSHIP,
      email: 'leon@example.com',
      companyName: 'Muster GmbH',
      workerEntries: [],
      todayKey: TODAY_KEY,
    })
    expect(vm.header.displayName).toBe('Leon Becker')
    expect(vm.header.initials).toBe('LB')
    expect(vm.header.roleLabel).toBe('Elektriker')
    expect(vm.header.companyName).toBe('Muster GmbH')
    expect(vm.header.email).toBe('leon@example.com')
  })

  it('falls back to humanised email when membership has no name', () => {
    const vm = deriveWorkerKontoViewModel({
      membership: { ...MEMBERSHIP, name: '' },
      email: 'leon.becker@example.com',
      companyName: null,
      workerEntries: [],
      todayKey: TODAY_KEY,
    })
    expect(vm.header.displayName).toBe('Leon Becker')
    expect(vm.header.initials).toBe('LB')
  })

  it('falls back to email when no membership at all', () => {
    const vm = deriveWorkerKontoViewModel({
      membership: null,
      email: 'max@example.com',
      companyName: null,
      workerEntries: [],
      todayKey: TODAY_KEY,
    })
    expect(vm.header.displayName).toBe('Max')
    expect(vm.header.roleLabel).toBe('Mitarbeiter')
    expect(vm.header.companyName).toBeNull()
  })

  it('uses "Mitarbeiter" as role fallback when role is empty string', () => {
    const vm = deriveWorkerKontoViewModel({
      membership: { ...MEMBERSHIP, role: '' },
      email: 'test@example.com',
      companyName: null,
      workerEntries: [],
      todayKey: TODAY_KEY,
    })
    expect(vm.header.roleLabel).toBe('Mitarbeiter')
  })

  it('does not leak owner/admin role labels into worker context', () => {
    // The projection only reads membership.role — it does not interpret
    // craftsmanRole or isOperator, preventing accidental owner leakage.
    const vm = deriveWorkerKontoViewModel({
      membership: { ...MEMBERSHIP, role: 'Monteur' },
      email: 'monteur@example.com',
      companyName: null,
      workerEntries: [],
      todayKey: TODAY_KEY,
    })
    expect(vm.header.roleLabel).toBe('Monteur')
    // No "Inhaber" or "Admin" values creep in from the projection
    expect(vm.header.roleLabel).not.toBe('Inhaber')
    expect(vm.header.roleLabel).not.toBe('Admin')
  })
})

// ── Zeitübersicht — empty state ───────────────────────────────────────────────

describe('zeitubersicht — empty state', () => {
  it('isEmpty = true when no entries exist', () => {
    const vm = deriveWorkerKontoViewModel({
      membership: MEMBERSHIP,
      email: 'leon@example.com',
      companyName: null,
      workerEntries: [],
      todayKey: TODAY_KEY,
    })
    expect(vm.zeitubersicht.isEmpty).toBe(true)
    expect(vm.zeitubersicht.weekCount).toBe(0)
    expect(vm.zeitubersicht.todayCount).toBe(0)
    expect(vm.zeitubersicht.weekHoursLabel).toBe('0,0')
    expect(vm.zeitubersicht.todayHoursLabel).toBe('0,0')
  })

  it('isEmpty = true when all entries are cancelled', () => {
    const vm = deriveWorkerKontoViewModel({
      membership: MEMBERSHIP,
      email: 'leon@example.com',
      companyName: null,
      workerEntries: [makeEntry({ status: 'cancelled' })],
      todayKey: TODAY_KEY,
    })
    expect(vm.zeitubersicht.isEmpty).toBe(true)
    expect(vm.zeitubersicht.weekCount).toBe(0)
  })

  it('includes the correct week range string', () => {
    const vm = deriveWorkerKontoViewModel({
      membership: MEMBERSHIP,
      email: 'leon@example.com',
      companyName: null,
      workerEntries: [],
      todayKey: TODAY_KEY,
    })
    // Week of 2026-04-08 (Wednesday) runs Mon 6 Apr – Sun 12 Apr
    expect(vm.zeitubersicht.weekRange).toContain('6. Apr')
    expect(vm.zeitubersicht.weekRange).toContain('12. Apr')
  })
})

// ── Zeitübersicht — hours derivation ─────────────────────────────────────────

describe('zeitubersicht — planned hours', () => {
  it('counts a today entry in both today and week totals', () => {
    const entry = makeEntry({ dateKey: TODAY_KEY, startsAtLabel: '08:00', endsAtLabel: '14:00', status: 'scheduled' })
    const vm = deriveWorkerKontoViewModel({
      membership: MEMBERSHIP,
      email: 'leon@example.com',
      companyName: null,
      workerEntries: [entry],
      todayKey: TODAY_KEY,
    })
    expect(vm.zeitubersicht.isEmpty).toBe(false)
    expect(vm.zeitubersicht.todayCount).toBe(1)
    expect(vm.zeitubersicht.weekCount).toBe(1)
    expect(vm.zeitubersicht.todayHoursLabel).toBe('6,0')
    expect(vm.zeitubersicht.weekHoursLabel).toBe('6,0')
  })

  it('counts a same-week but non-today entry only in week total', () => {
    const yesterday = makeEntry({
      dateKey: '2026-04-07', // Tuesday — still in Mon–Sun week
      startsAtLabel: '09:00',
      endsAtLabel: '12:00', // 3h
      status: 'completed',
    })
    const vm = deriveWorkerKontoViewModel({
      membership: MEMBERSHIP,
      email: 'leon@example.com',
      companyName: null,
      workerEntries: [yesterday],
      todayKey: TODAY_KEY,
    })
    expect(vm.zeitubersicht.todayCount).toBe(0)
    expect(vm.zeitubersicht.weekCount).toBe(1)
    expect(vm.zeitubersicht.todayHoursLabel).toBe('0,0')
    expect(vm.zeitubersicht.weekHoursLabel).toBe('3,0')
  })

  it('excludes entries outside the current week', () => {
    const nextWeek = makeEntry({ dateKey: '2026-04-14', status: 'scheduled' })
    const vm = deriveWorkerKontoViewModel({
      membership: MEMBERSHIP,
      email: 'leon@example.com',
      companyName: null,
      workerEntries: [nextWeek],
      todayKey: TODAY_KEY,
    })
    expect(vm.zeitubersicht.isEmpty).toBe(true)
    expect(vm.zeitubersicht.weekCount).toBe(0)
  })

  it('accumulates hours across multiple entries correctly', () => {
    const e1 = makeEntry({ id: 'e1', dateKey: TODAY_KEY, startsAtLabel: '07:00', endsAtLabel: '11:00', status: 'in_progress' }) // 4h
    const e2 = makeEntry({ id: 'e2', dateKey: TODAY_KEY, startsAtLabel: '13:00', endsAtLabel: '16:30', status: 'scheduled' })   // 3.5h
    const vm = deriveWorkerKontoViewModel({
      membership: MEMBERSHIP,
      email: 'leon@example.com',
      companyName: null,
      workerEntries: [e1, e2],
      todayKey: TODAY_KEY,
    })
    expect(vm.zeitubersicht.weekCount).toBe(2)
    expect(vm.zeitubersicht.todayCount).toBe(2)
    expect(vm.zeitubersicht.weekHoursLabel).toBe('7,5')
    expect(vm.zeitubersicht.todayHoursLabel).toBe('7,5')
  })

  it('uses comma as decimal separator in German formatting', () => {
    // 1h 30min = 1.5h → should format as "1,5" not "1.5"
    const entry = makeEntry({ startsAtLabel: '10:00', endsAtLabel: '11:30', status: 'scheduled' })
    const vm = deriveWorkerKontoViewModel({
      membership: MEMBERSHIP,
      email: 'leon@example.com',
      companyName: null,
      workerEntries: [entry],
      todayKey: TODAY_KEY,
    })
    expect(vm.zeitubersicht.todayHoursLabel).toBe('1,5')
    expect(vm.zeitubersicht.todayHoursLabel).not.toContain('.')
  })

  it('returns 0,0 hours for an entry with invalid time labels', () => {
    const entry = makeEntry({ startsAtLabel: '', endsAtLabel: '', status: 'scheduled' })
    const vm = deriveWorkerKontoViewModel({
      membership: MEMBERSHIP,
      email: 'leon@example.com',
      companyName: null,
      workerEntries: [entry],
      todayKey: TODAY_KEY,
    })
    expect(vm.zeitubersicht.weekCount).toBe(1) // entry is counted
    expect(vm.zeitubersicht.weekHoursLabel).toBe('0,0') // but 0 hours
  })
})

// ── Company name passthrough ──────────────────────────────────────────────────

describe('company name', () => {
  it('passes null when no company name is provided', () => {
    const vm = deriveWorkerKontoViewModel({
      membership: MEMBERSHIP,
      email: 'leon@example.com',
      companyName: null,
      workerEntries: [],
      todayKey: TODAY_KEY,
    })
    expect(vm.header.companyName).toBeNull()
  })

  it('passes the company name when provided', () => {
    const vm = deriveWorkerKontoViewModel({
      membership: MEMBERSHIP,
      email: 'leon@example.com',
      companyName: 'Elektro Becker GmbH',
      workerEntries: [],
      todayKey: TODAY_KEY,
    })
    expect(vm.header.companyName).toBe('Elektro Becker GmbH')
  })
})
