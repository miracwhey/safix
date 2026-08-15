/**
 * Worker Nachrichten projection — segment classification + view model contract
 *
 * Pure function tests: no mocks, no store access.
 */

import { describe, it, expect } from 'vitest'
import {
  deriveNachrichtenViewModel,
  findNachrichtenThread,
  deriveInitials,
  deriveTimestamp,
  einsatzThreadOrder,
} from '../../src/lib/worker/workerNachrichtenProjection'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TODAY = '2026-04-08'
const TOMORROW = '2026-04-09'
const YESTERDAY = '2026-04-07'
const NEXT_WEEK = '2026-04-15'

function makeEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: 'e-1',
    kind: 'job',
    title: 'Badezimmersanierung',
    customerName: 'Müller GmbH',
    location: 'Hannover',
    dateLabel: 'Mi, 8. Apr',
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

// ── Segment classification ─────────────────────────────────────────────────────

describe('deriveNachrichtenViewModel: segment classification', () => {
  it('no entries → all segments empty', () => {
    const vm = deriveNachrichtenViewModel([], TODAY)
    expect(vm.einsaetze).toHaveLength(0)
    expect(vm.team).toHaveLength(0)
    expect(vm.buero).toHaveLength(0)
  })

  it('team segment is always empty (no infrastructure)', () => {
    const vm = deriveNachrichtenViewModel([makeEntry()], TODAY)
    expect(vm.team).toHaveLength(0)
  })

  it('buero segment is always empty (no infrastructure)', () => {
    const vm = deriveNachrichtenViewModel([makeEntry()], TODAY)
    expect(vm.buero).toHaveLength(0)
  })

  it('scheduled entry → einsaetze segment', () => {
    const vm = deriveNachrichtenViewModel([makeEntry({ status: 'scheduled' })], TODAY)
    expect(vm.einsaetze).toHaveLength(1)
    expect(vm.einsaetze[0].segment).toBe('einsaetze')
  })

  it('in_progress entry → einsaetze segment', () => {
    const vm = deriveNachrichtenViewModel([makeEntry({ status: 'in_progress' })], TODAY)
    expect(vm.einsaetze).toHaveLength(1)
  })

  it('pending entry → einsaetze segment', () => {
    const vm = deriveNachrichtenViewModel([makeEntry({ status: 'pending' })], TODAY)
    expect(vm.einsaetze).toHaveLength(1)
  })

  it('completed entry → einsaetze segment', () => {
    const vm = deriveNachrichtenViewModel([makeEntry({ status: 'completed' })], TODAY)
    expect(vm.einsaetze).toHaveLength(1)
  })

  it('cancelled entry → excluded from einsaetze', () => {
    const vm = deriveNachrichtenViewModel([makeEntry({ status: 'cancelled' })], TODAY)
    expect(vm.einsaetze).toHaveLength(0)
  })

  it('mixed statuses — cancelled excluded, others included', () => {
    const entries = [
      makeEntry({ id: 'e-1', status: 'scheduled' }),
      makeEntry({ id: 'e-2', status: 'cancelled' }),
      makeEntry({ id: 'e-3', status: 'completed' }),
    ]
    const vm = deriveNachrichtenViewModel(entries, TODAY)
    expect(vm.einsaetze).toHaveLength(2)
    expect(vm.einsaetze.map((t) => t.einsatzContext?.entryId)).not.toContain('e-2')
  })
})

// ── Thread ID and fields ───────────────────────────────────────────────────────

describe('deriveNachrichtenViewModel: thread fields', () => {
  it('thread ID uses einsatz- prefix + entry id', () => {
    const vm = deriveNachrichtenViewModel([makeEntry({ id: 'abc-123' })], TODAY)
    expect(vm.einsaetze[0].id).toBe('einsatz-abc-123')
  })

  it('title comes from entry.title', () => {
    const vm = deriveNachrichtenViewModel([makeEntry({ title: 'Dacharbeiten' })], TODAY)
    expect(vm.einsaetze[0].title).toBe('Dacharbeiten')
  })

  it('subtitle comes from entry.customerName', () => {
    const vm = deriveNachrichtenViewModel(
      [makeEntry({ customerName: 'Schmidt AG' })],
      TODAY
    )
    expect(vm.einsaetze[0].subtitle).toBe('Schmidt AG')
  })

  it('lastMessage is empty when no enrichment provided', () => {
    const vm = deriveNachrichtenViewModel([makeEntry()], TODAY)
    expect(vm.einsaetze[0].lastMessage).toBe('')
  })

  it('unread is false when no enrichment provided', () => {
    const vm = deriveNachrichtenViewModel([makeEntry()], TODAY)
    expect(vm.einsaetze[0].unread).toBe(false)
  })

  it('needsResponse is always false', () => {
    const vm = deriveNachrichtenViewModel([makeEntry()], TODAY)
    expect(vm.einsaetze[0].needsResponse).toBe(false)
  })

  it('canSend is false when no thread enrichment data provided', () => {
    // Without enrichment the screen has no real thread connection yet.
    const vm = deriveNachrichtenViewModel([makeEntry()], TODAY)
    expect(vm.canSend).toBe(false)
  })

  it('canSend is true when thread enrichment data is provided', () => {
    const vm = deriveNachrichtenViewModel([makeEntry()], TODAY, new Map())
    expect(vm.canSend).toBe(true)
  })

  it('einsatzContext carries real entry fields', () => {
    const e = makeEntry({
      id: 'e-x',
      title: 'Fliesenlegen',
      dateLabel: 'Do, 9. Apr',
      location: 'Musterstraße 1',
    })
    const vm = deriveNachrichtenViewModel([e], TODAY)
    const ctx = vm.einsaetze[0].einsatzContext!
    expect(ctx.entryId).toBe('e-x')
    expect(ctx.title).toBe('Fliesenlegen')
    expect(ctx.date).toBe('Do, 9. Apr')
    expect(ctx.location).toBe('Musterstraße 1')
  })
})

// ── Initials derivation ───────────────────────────────────────────────────────

describe('deriveInitials', () => {
  it('two words → first char of each, uppercase', () => {
    expect(deriveInitials('Badezimmer Sanierung')).toBe('BS')
  })

  it('more than two words → first two chars', () => {
    expect(deriveInitials('Dach und Fassade')).toBe('DU')
  })

  it('single word → first two chars uppercase', () => {
    expect(deriveInitials('Hannover')).toBe('HA')
  })

  it('single char word → handled without crash', () => {
    expect(deriveInitials('A Bau')).toBe('AB')
  })
})

// ── Timestamp derivation ──────────────────────────────────────────────────────

describe('deriveTimestamp', () => {
  it('today + startsAtLabel → returns startsAtLabel', () => {
    const e = makeEntry({ dateKey: TODAY, startsAtLabel: '09:00' })
    expect(deriveTimestamp(e, TODAY)).toBe('09:00')
  })

  it('today + no startsAtLabel → "Heute"', () => {
    const e = makeEntry({ dateKey: TODAY, startsAtLabel: '' })
    expect(deriveTimestamp(e, TODAY)).toBe('Heute')
  })

  it('yesterday → "Gestern"', () => {
    const e = makeEntry({ dateKey: YESTERDAY, dateLabel: 'Di, 7. Apr' })
    expect(deriveTimestamp(e, TODAY)).toBe('Gestern')
  })

  it('other date → entry.dateLabel', () => {
    const e = makeEntry({ dateKey: NEXT_WEEK, dateLabel: 'Mi, 15. Apr' })
    expect(deriveTimestamp(e, TODAY)).toBe('Mi, 15. Apr')
  })

  it('tomorrow → entry.dateLabel (not Gestern)', () => {
    const e = makeEntry({ dateKey: TOMORROW, dateLabel: 'Do, 9. Apr' })
    expect(deriveTimestamp(e, TODAY)).toBe('Do, 9. Apr')
  })
})

// ── Thread ordering ───────────────────────────────────────────────────────────

describe('einsatzThreadOrder', () => {
  it('in_progress before scheduled', () => {
    const a = makeEntry({ id: 'a', status: 'in_progress' })
    const b = makeEntry({ id: 'b', status: 'scheduled' })
    expect(einsatzThreadOrder(a, b, TODAY)).toBeLessThan(0)
  })

  it('scheduled before completed', () => {
    const a = makeEntry({ id: 'a', status: 'scheduled' })
    const b = makeEntry({ id: 'b', status: 'completed' })
    expect(einsatzThreadOrder(a, b, TODAY)).toBeLessThan(0)
  })

  it('today before future, same status', () => {
    const a = makeEntry({ id: 'a', status: 'scheduled', dateKey: TODAY })
    const b = makeEntry({ id: 'b', status: 'scheduled', dateKey: TOMORROW })
    expect(einsatzThreadOrder(a, b, TODAY)).toBeLessThan(0)
  })

  it('completed: newer dateKey sorts before older', () => {
    const a = makeEntry({ id: 'a', status: 'completed', dateKey: TODAY })
    const b = makeEntry({ id: 'b', status: 'completed', dateKey: YESTERDAY })
    expect(einsatzThreadOrder(a, b, TODAY)).toBeLessThan(0)
  })
})

describe('deriveNachrichtenViewModel: thread ordering', () => {
  it('in_progress entry appears first', () => {
    const entries = [
      makeEntry({ id: 'e-sched', status: 'scheduled', startsAtLabel: '08:00' }),
      makeEntry({ id: 'e-active', status: 'in_progress' }),
    ]
    const vm = deriveNachrichtenViewModel(entries, TODAY)
    expect(vm.einsaetze[0].einsatzContext?.entryId).toBe('e-active')
  })

  it('completed entries appear last', () => {
    const entries = [
      makeEntry({ id: 'e-done', status: 'completed', dateKey: TODAY }),
      makeEntry({ id: 'e-next', status: 'scheduled', dateKey: TOMORROW }),
    ]
    const vm = deriveNachrichtenViewModel(entries, TODAY)
    expect(vm.einsaetze[0].einsatzContext?.entryId).toBe('e-next')
    expect(vm.einsaetze[1].einsatzContext?.entryId).toBe('e-done')
  })

  it('today entries appear before future entries', () => {
    const entries = [
      makeEntry({ id: 'e-future', status: 'scheduled', dateKey: TOMORROW }),
      makeEntry({ id: 'e-today', status: 'scheduled', dateKey: TODAY }),
    ]
    const vm = deriveNachrichtenViewModel(entries, TODAY)
    expect(vm.einsaetze[0].einsatzContext?.entryId).toBe('e-today')
  })
})

// ── findNachrichtenThread ─────────────────────────────────────────────────────

describe('findNachrichtenThread', () => {
  it('finds thread by exact id', () => {
    const vm = deriveNachrichtenViewModel([makeEntry({ id: 'e-xyz' })], TODAY)
    const found = findNachrichtenThread(vm, 'einsatz-e-xyz')
    expect(found).toBeDefined()
    expect(found?.id).toBe('einsatz-e-xyz')
  })

  it('returns undefined for unknown id', () => {
    const vm = deriveNachrichtenViewModel([makeEntry({ id: 'e-xyz' })], TODAY)
    expect(findNachrichtenThread(vm, 'einsatz-unknown')).toBeUndefined()
  })

  it('returns undefined when all segments are empty', () => {
    const vm = deriveNachrichtenViewModel([], TODAY)
    expect(findNachrichtenThread(vm, 'einsatz-e-1')).toBeUndefined()
  })
})

// ── No owner/admin leakage ────────────────────────────────────────────────────

describe('deriveNachrichtenViewModel: no owner/admin leakage', () => {
  it('thread has no payment or finance fields', () => {
    const vm = deriveNachrichtenViewModel([makeEntry()], TODAY)
    const thread = vm.einsaetze[0]
    expect('paymentState' in thread).toBe(false)
    expect('amount' in thread).toBe(false)
    expect('disputeStatus' in thread).toBe(false)
    expect('craftsmanUserId' in thread).toBe(false)
    expect('customerUserId' in thread).toBe(false)
  })

  it('einsatzContext has no payment or user identity fields', () => {
    const vm = deriveNachrichtenViewModel([makeEntry()], TODAY)
    const ctx = vm.einsaetze[0].einsatzContext!
    expect('paymentState' in ctx).toBe(false)
    expect('craftsmanUserId' in ctx).toBe(false)
    expect('customerUserId' in ctx).toBe(false)
  })
})

// ── Empty and partial data ────────────────────────────────────────────────────

describe('deriveNachrichtenViewModel: empty and partial data', () => {
  it('worker with only cancelled entries → all segments empty', () => {
    const entries = [
      makeEntry({ id: 'e-1', status: 'cancelled' }),
      makeEntry({ id: 'e-2', status: 'cancelled' }),
    ]
    const vm = deriveNachrichtenViewModel(entries, TODAY)
    expect(vm.einsaetze).toHaveLength(0)
    expect(vm.team).toHaveLength(0)
    expect(vm.buero).toHaveLength(0)
  })

  it('worker with only einsatz entries → only einsaetze populated', () => {
    const entries = [
      makeEntry({ id: 'e-1', status: 'scheduled' }),
      makeEntry({ id: 'e-2', status: 'in_progress' }),
    ]
    const vm = deriveNachrichtenViewModel(entries, TODAY)
    expect(vm.einsaetze).toHaveLength(2)
    expect(vm.team).toHaveLength(0)
    expect(vm.buero).toHaveLength(0)
  })

  it('entry with empty location → no crash, context.location is empty string', () => {
    const e = makeEntry({ location: '' })
    const vm = deriveNachrichtenViewModel([e], TODAY)
    expect(vm.einsaetze[0].einsatzContext?.location).toBe('')
  })

  it('entry with empty startsAtLabel → timestamp falls back to "Heute"', () => {
    const e = makeEntry({ dateKey: TODAY, startsAtLabel: '' })
    const vm = deriveNachrichtenViewModel([e], TODAY)
    expect(vm.einsaetze[0].timestamp).toBe('Heute')
  })
})
