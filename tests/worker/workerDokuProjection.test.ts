/**
 * Worker Doku projection — list + detail contract
 *
 * Pure function tests: no mocks, no store access.
 */

import { describe, it, expect } from 'vitest'
import {
  deriveDokuListViewModel,
  deriveDokuDetailViewModel,
} from '../../src/lib/worker/workerDokuProjection'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'
import type { Job } from '../../src/lib/jobs/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TODAY = '2026-04-08'
const YESTERDAY = '2026-04-07'
const TOMORROW = '2026-04-09'

function makeEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: 'e-1',
    kind: 'job',
    jobId: 'j-1',
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
    description: 'Test Beschreibung',
    paymentState: 'deposit',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: ['tm-1'],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  } as Job
}

// ── List: case grouping ───────────────────────────────────────────────────────

describe('deriveDokuListViewModel: grouping rules', () => {
  it('scheduled entry → offen', () => {
    const vm = deriveDokuListViewModel([makeEntry({ status: 'scheduled' })], [makeJob()])
    expect(vm.offen).toHaveLength(1)
    expect(vm.abgeschlossen).toHaveLength(0)
  })

  it('pending entry → offen', () => {
    const vm = deriveDokuListViewModel([makeEntry({ status: 'pending' })], [makeJob()])
    expect(vm.offen).toHaveLength(1)
    expect(vm.abgeschlossen).toHaveLength(0)
  })

  it('in_progress entry → offen', () => {
    const vm = deriveDokuListViewModel([makeEntry({ status: 'in_progress' })], [makeJob()])
    expect(vm.offen).toHaveLength(1)
    expect(vm.abgeschlossen).toHaveLength(0)
  })

  it('completed entry → abgeschlossen', () => {
    const vm = deriveDokuListViewModel([makeEntry({ status: 'completed' })], [makeJob()])
    expect(vm.offen).toHaveLength(0)
    expect(vm.abgeschlossen).toHaveLength(1)
  })

  it('cancelled entry → excluded from both sections', () => {
    const vm = deriveDokuListViewModel([makeEntry({ status: 'cancelled' })], [makeJob()])
    expect(vm.offen).toHaveLength(0)
    expect(vm.abgeschlossen).toHaveLength(0)
  })

  it('empty entries → both sections empty', () => {
    const vm = deriveDokuListViewModel([], [])
    expect(vm.offen).toHaveLength(0)
    expect(vm.abgeschlossen).toHaveLength(0)
  })

  it('mixed states → correct grouping', () => {
    const entries = [
      makeEntry({ id: 'e-1', status: 'scheduled' }),
      makeEntry({ id: 'e-2', status: 'in_progress' }),
      makeEntry({ id: 'e-3', status: 'completed' }),
      makeEntry({ id: 'e-4', status: 'cancelled' }),
    ]
    const vm = deriveDokuListViewModel(entries, [makeJob()])
    expect(vm.offen).toHaveLength(2)
    expect(vm.abgeschlossen).toHaveLength(1)
  })
})

// ── List: case identity ───────────────────────────────────────────────────────

describe('deriveDokuListViewModel: case identity', () => {
  it('caseId equals CalendarEntry.id', () => {
    const entry = makeEntry({ id: 'cal-abc-123', status: 'scheduled' })
    const vm = deriveDokuListViewModel([entry], [makeJob()])
    expect(vm.offen[0].caseId).toBe('cal-abc-123')
  })

  it('card fields reflect entry identity', () => {
    const entry = makeEntry({
      title: 'Heizung Wartung',
      customerName: 'Familie Becker',
      location: 'Bad Münder',
      dateLabel: '08. Apr',
    })
    const vm = deriveDokuListViewModel([entry], [makeJob()])
    const card = vm.offen[0]
    expect(card.assignmentTitle).toBe('Heizung Wartung')
    expect(card.customerName).toBe('Familie Becker')
    expect(card.location).toBe('Bad Münder')
    expect(card.dateLabel).toBe('08. Apr')
  })
})

// ── List: offen sort order ────────────────────────────────────────────────────

describe('deriveDokuListViewModel: offen sort order', () => {
  it('in_progress sorts before scheduled', () => {
    const entries = [
      makeEntry({ id: 'e-sched', status: 'scheduled', dateKey: TODAY }),
      makeEntry({ id: 'e-active', status: 'in_progress', dateKey: TODAY }),
    ]
    const vm = deriveDokuListViewModel(entries, [makeJob()])
    expect(vm.offen[0].caseId).toBe('e-active')
    expect(vm.offen[1].caseId).toBe('e-sched')
  })

  it('in_progress sorts before pending', () => {
    const entries = [
      makeEntry({ id: 'e-pend', status: 'pending', dateKey: TODAY }),
      makeEntry({ id: 'e-active', status: 'in_progress', dateKey: TODAY }),
    ]
    const vm = deriveDokuListViewModel(entries, [makeJob()])
    expect(vm.offen[0].caseId).toBe('e-active')
  })

  it('scheduled sorts before pending', () => {
    const entries = [
      makeEntry({ id: 'e-pend', status: 'pending', dateKey: TODAY }),
      makeEntry({ id: 'e-sched', status: 'scheduled', dateKey: TODAY }),
    ]
    const vm = deriveDokuListViewModel(entries, [makeJob()])
    expect(vm.offen[0].caseId).toBe('e-sched')
  })

  it('within same status, earlier dateKey sorts first', () => {
    const entries = [
      makeEntry({ id: 'e-later', status: 'scheduled', dateKey: TOMORROW }),
      makeEntry({ id: 'e-now', status: 'scheduled', dateKey: TODAY }),
    ]
    const vm = deriveDokuListViewModel(entries, [makeJob()])
    expect(vm.offen[0].caseId).toBe('e-now')
    expect(vm.offen[1].caseId).toBe('e-later')
  })
})

// ── List: abgeschlossen sort order ────────────────────────────────────────────

describe('deriveDokuListViewModel: abgeschlossen sort order', () => {
  it('newer dateKey sorts first', () => {
    const entries = [
      makeEntry({ id: 'e-old', status: 'completed', dateKey: YESTERDAY }),
      makeEntry({ id: 'e-new', status: 'completed', dateKey: TODAY }),
    ]
    const vm = deriveDokuListViewModel(entries, [makeJob()])
    expect(vm.abgeschlossen[0].caseId).toBe('e-new')
    expect(vm.abgeschlossen[1].caseId).toBe('e-old')
  })
})

// ── List: completeness from job ───────────────────────────────────────────────

describe('deriveDokuListViewModel: completeness derivation', () => {
  it('no job linked → hasJobData false, doneCount 0', () => {
    const entry = makeEntry({ jobId: undefined })
    const vm = deriveDokuListViewModel([entry], [makeJob()])
    const c = vm.offen[0].completeness
    expect(c.hasJobData).toBe(false)
    expect(c.doneCount).toBe(0)
    expect(c.isComplete).toBe(false)
  })

  it('jobId not found in jobs → hasJobData false', () => {
    const entry = makeEntry({ jobId: 'nonexistent' })
    const vm = deriveDokuListViewModel([entry], [makeJob({ id: 'j-other' })])
    expect(vm.offen[0].completeness.hasJobData).toBe(false)
  })

  it('job with photoCount 0 and no notes → 0/2 done', () => {
    const vm = deriveDokuListViewModel(
      [makeEntry()],
      [makeJob({ photoCount: 0, notes: [] })]
    )
    const c = vm.offen[0].completeness
    expect(c.doneCount).toBe(0)
    expect(c.totalCount).toBe(2)
    expect(c.isComplete).toBe(false)
    expect(c.missingLabels).toContain('Fotos fehlen')
    expect(c.missingLabels).toContain('Bericht offen')
  })

  it('job with photos but no notes → 1/2 done', () => {
    const vm = deriveDokuListViewModel(
      [makeEntry()],
      [makeJob({ photoCount: 3, notes: [] })]
    )
    const c = vm.offen[0].completeness
    expect(c.doneCount).toBe(1)
    expect(c.isComplete).toBe(false)
    expect(c.missingLabels).not.toContain('Fotos fehlen')
    expect(c.missingLabels).toContain('Bericht offen')
  })

  it('job with notes but no photos → 1/2 done', () => {
    const vm = deriveDokuListViewModel(
      [makeEntry()],
      [makeJob({ photoCount: 0, notes: ['eine Notiz'] })]
    )
    const c = vm.offen[0].completeness
    expect(c.doneCount).toBe(1)
    expect(c.missingLabels).toContain('Fotos fehlen')
    expect(c.missingLabels).not.toContain('Bericht offen')
  })

  it('job with photos and notes → 2/2 done, isComplete true', () => {
    const vm = deriveDokuListViewModel(
      [makeEntry()],
      [makeJob({ photoCount: 2, notes: ['Notiz'] })]
    )
    const c = vm.offen[0].completeness
    expect(c.doneCount).toBe(2)
    expect(c.totalCount).toBe(2)
    expect(c.isComplete).toBe(true)
    expect(c.missingLabels).toHaveLength(0)
    expect(c.progressPct).toBe(100)
  })

  it('progressPct 0 when nothing done', () => {
    const vm = deriveDokuListViewModel(
      [makeEntry()],
      [makeJob({ photoCount: 0, notes: [] })]
    )
    expect(vm.offen[0].completeness.progressPct).toBe(0)
  })

  it('progressPct 50 when one of two done', () => {
    const vm = deriveDokuListViewModel(
      [makeEntry()],
      [makeJob({ photoCount: 1, notes: [] })]
    )
    expect(vm.offen[0].completeness.progressPct).toBe(50)
  })
})

// ── List: only open cases ─────────────────────────────────────────────────────

describe('deriveDokuListViewModel: only offen cases', () => {
  it('worker with only open cases → abgeschlossen empty', () => {
    const entries = [
      makeEntry({ id: 'e-1', status: 'scheduled' }),
      makeEntry({ id: 'e-2', status: 'in_progress' }),
    ]
    const vm = deriveDokuListViewModel(entries, [makeJob()])
    expect(vm.offen).toHaveLength(2)
    expect(vm.abgeschlossen).toHaveLength(0)
  })
})

// ── List: only completed cases ────────────────────────────────────────────────

describe('deriveDokuListViewModel: only abgeschlossen cases', () => {
  it('worker with only completed cases → offen empty', () => {
    const entries = [
      makeEntry({ id: 'e-1', status: 'completed' }),
      makeEntry({ id: 'e-2', status: 'completed' }),
    ]
    const vm = deriveDokuListViewModel(entries, [makeJob()])
    expect(vm.offen).toHaveLength(0)
    expect(vm.abgeschlossen).toHaveLength(2)
  })
})

// ── List: no owner/admin leakage ──────────────────────────────────────────────

describe('deriveDokuListViewModel: no owner/admin leakage', () => {
  it('card vm does not expose finance or payment state', () => {
    const vm = deriveDokuListViewModel([makeEntry()], [makeJob()])
    const card = vm.offen[0]
    expect('paymentState' in card).toBe(false)
    expect('amount' in card).toBe(false)
    expect('disputeStatus' in card).toBe(false)
  })

  it('card vm does not expose internal job fields', () => {
    const vm = deriveDokuListViewModel([makeEntry()], [makeJob()])
    const card = vm.offen[0]
    expect('activities' in card).toBe(false)
    expect('description' in card).toBe(false)
    expect('projectId' in card).toBe(false)
  })
})

// ── Detail: basic ─────────────────────────────────────────────────────────────

describe('deriveDokuDetailViewModel: basic', () => {
  it('returns correct case identity', () => {
    const entry = makeEntry({ id: 'e-detail', title: 'Badezimmer Sanierung' })
    const vm = deriveDokuDetailViewModel(entry, [makeJob()])
    expect(vm.caseId).toBe('e-detail')
    expect(vm.assignmentTitle).toBe('Badezimmer Sanierung')
    expect(vm.entryStatus).toBe('scheduled')
  })

  it('scheduled → caseStatus offen', () => {
    const vm = deriveDokuDetailViewModel(makeEntry({ status: 'scheduled' }), [makeJob()])
    expect(vm.caseStatus).toBe('offen')
  })

  it('in_progress → caseStatus offen', () => {
    const vm = deriveDokuDetailViewModel(makeEntry({ status: 'in_progress' }), [makeJob()])
    expect(vm.caseStatus).toBe('offen')
  })

  it('completed → caseStatus abgeschlossen', () => {
    const vm = deriveDokuDetailViewModel(makeEntry({ status: 'completed' }), [makeJob()])
    expect(vm.caseStatus).toBe('abgeschlossen')
  })
})

// ── Detail: module set ────────────────────────────────────────────────────────

describe('deriveDokuDetailViewModel: module set', () => {
  it('always returns all 5 modules', () => {
    const vm = deriveDokuDetailViewModel(makeEntry(), [makeJob()])
    expect(vm.modules).toHaveLength(5)
    const keys = vm.modules.map((m) => m.key)
    expect(keys).toContain('fotos')
    expect(keys).toContain('bericht')
    expect(keys).toContain('material')
    expect(keys).toContain('maengel')
    expect(keys).toContain('unterschrift')
  })

  it('material, maengel, unterschrift → unavailable status', () => {
    const vm = deriveDokuDetailViewModel(makeEntry(), [makeJob()])
    const unavailable = vm.modules.filter((m) => m.status === 'unavailable')
    const unavailableKeys = unavailable.map((m) => m.key)
    expect(unavailableKeys).toContain('material')
    expect(unavailableKeys).toContain('maengel')
    expect(unavailableKeys).toContain('unterschrift')
  })

  it('unavailable modules are not actionable', () => {
    const vm = deriveDokuDetailViewModel(makeEntry(), [makeJob()])
    const unavailable = vm.modules.filter((m) => m.status === 'unavailable')
    unavailable.forEach((m) => expect(m.isActionable).toBe(false))
  })
})

// ── Detail: module state from job ─────────────────────────────────────────────

describe('deriveDokuDetailViewModel: module state', () => {
  it('fotos module complete when photoCount > 0', () => {
    const vm = deriveDokuDetailViewModel(makeEntry(), [makeJob({ photoCount: 3 })])
    const fotos = vm.modules.find((m) => m.key === 'fotos')!
    expect(fotos.status).toBe('complete')
    expect(fotos.summary).toBe('3 Fotos hochgeladen')
  })

  it('fotos module open when photoCount 0', () => {
    const vm = deriveDokuDetailViewModel(makeEntry(), [makeJob({ photoCount: 0 })])
    const fotos = vm.modules.find((m) => m.key === 'fotos')!
    expect(fotos.status).toBe('open')
    expect(fotos.summary).toBe('Noch keine Fotos')
  })

  it('fotos summary singular for photoCount 1', () => {
    const vm = deriveDokuDetailViewModel(makeEntry(), [makeJob({ photoCount: 1 })])
    const fotos = vm.modules.find((m) => m.key === 'fotos')!
    expect(fotos.summary).toBe('1 Foto hochgeladen')
  })

  it('bericht module complete when notes.length > 0 (legacy fallback)', () => {
    const vm = deriveDokuDetailViewModel(makeEntry(), [makeJob({ notes: ['eine Notiz'] })])
    const bericht = vm.modules.find((m) => m.key === 'bericht')!
    expect(bericht.status).toBe('complete')
    // Block C.3 — Wording vereinheitlicht auf „Bericht" (job_reports ist
    // canonical truth; Legacy notes-Array geht über dieselbe Summary-Logik).
    expect(bericht.summary).toBe('1 Bericht erfasst')
  })

  it('bericht module open when notes empty', () => {
    const vm = deriveDokuDetailViewModel(makeEntry(), [makeJob({ notes: [] })])
    const bericht = vm.modules.find((m) => m.key === 'bericht')!
    expect(bericht.status).toBe('open')
    expect(bericht.summary).toBe('Noch kein Bericht')
  })

  it('bericht summary plural for multiple notes', () => {
    const vm = deriveDokuDetailViewModel(makeEntry(), [makeJob({ notes: ['a', 'b', 'c'] })])
    const bericht = vm.modules.find((m) => m.key === 'bericht')!
    expect(bericht.summary).toBe('3 Berichte erfasst')
  })

  it('no job linked → fotos and bericht show no-data summary', () => {
    const vm = deriveDokuDetailViewModel(makeEntry({ jobId: undefined }), [makeJob()])
    const fotos = vm.modules.find((m) => m.key === 'fotos')!
    const bericht = vm.modules.find((m) => m.key === 'bericht')!
    expect(fotos.status).toBe('open')
    expect(fotos.summary).toBe('Keine Auftragsdaten verknüpft')
    expect(bericht.status).toBe('open')
    expect(bericht.summary).toBe('Keine Auftragsdaten verknüpft')
  })
})

// ── Detail: completeness ──────────────────────────────────────────────────────

describe('deriveDokuDetailViewModel: completeness', () => {
  it('no real modules done → 0/2, not complete', () => {
    const vm = deriveDokuDetailViewModel(makeEntry(), [makeJob({ photoCount: 0, notes: [] })])
    expect(vm.completeness.doneCount).toBe(0)
    expect(vm.completeness.totalCount).toBe(2)
    expect(vm.completeness.isComplete).toBe(false)
  })

  it('both real modules done → 2/2, complete', () => {
    const vm = deriveDokuDetailViewModel(makeEntry(), [makeJob({ photoCount: 1, notes: ['n'] })])
    expect(vm.completeness.doneCount).toBe(2)
    expect(vm.completeness.isComplete).toBe(true)
  })

  it('no job → hasJobData false, not complete', () => {
    const vm = deriveDokuDetailViewModel(makeEntry({ jobId: undefined }), [])
    expect(vm.completeness.hasJobData).toBe(false)
    expect(vm.completeness.isComplete).toBe(false)
  })
})

// ── Detail: hasJobLink ────────────────────────────────────────────────────────

describe('deriveDokuDetailViewModel: hasJobLink', () => {
  it('true when job found', () => {
    const vm = deriveDokuDetailViewModel(makeEntry({ jobId: 'j-1' }), [makeJob({ id: 'j-1' })])
    expect(vm.hasJobLink).toBe(true)
  })

  it('false when no jobId on entry', () => {
    const vm = deriveDokuDetailViewModel(makeEntry({ jobId: undefined }), [makeJob()])
    expect(vm.hasJobLink).toBe(false)
  })

  it('false when jobId not found in jobs', () => {
    const vm = deriveDokuDetailViewModel(makeEntry({ jobId: 'nonexistent' }), [makeJob({ id: 'j-other' })])
    expect(vm.hasJobLink).toBe(false)
  })

  it('false when jobs array empty', () => {
    const vm = deriveDokuDetailViewModel(makeEntry({ jobId: 'j-1' }), [])
    expect(vm.hasJobLink).toBe(false)
  })
})

// ── Detail: no owner leakage ──────────────────────────────────────────────────

describe('deriveDokuDetailViewModel: no owner/admin leakage', () => {
  it('detail vm does not expose finance fields', () => {
    const vm = deriveDokuDetailViewModel(makeEntry(), [makeJob()])
    expect('paymentState' in vm).toBe(false)
    expect('amount' in vm).toBe(false)
    expect('disputeStatus' in vm).toBe(false)
  })

  it('detail vm does not expose internal job fields', () => {
    const vm = deriveDokuDetailViewModel(makeEntry(), [makeJob()])
    expect('activities' in vm).toBe(false)
    expect('projectId' in vm).toBe(false)
  })
})

// ── Detail: partial data safety ───────────────────────────────────────────────

describe('deriveDokuDetailViewModel: partial data safety', () => {
  it('no crash when entry has no jobId and jobs array empty', () => {
    const entry = makeEntry({ jobId: undefined })
    expect(() => deriveDokuDetailViewModel(entry, [])).not.toThrow()
  })

  it('no crash when photoCount missing from job (undefined coalesces to 0)', () => {
    const job = makeJob({ photoCount: undefined as unknown as number })
    expect(() => deriveDokuDetailViewModel(makeEntry(), [job])).not.toThrow()
  })

  it('no crash when notes missing from job (undefined coalesces to [])', () => {
    const job = makeJob({ notes: undefined as unknown as string[] })
    expect(() => deriveDokuDetailViewModel(makeEntry(), [job])).not.toThrow()
  })
})
