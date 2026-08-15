/**
 * Block C.3 · workerDokuProjection — neue Source-Layer (job_photos, job_reports).
 *
 * Lock-Tests gegen die erweiterte Signatur:
 *   - photos[] und reports[] werden bevorzugt vor Job.photoCount / Job.notes
 *   - leere Arrays falle auf Legacy-Felder zurück
 *   - isActionable wird basierend auf neuen Quellen gesetzt
 */

import { describe, it, expect } from 'vitest'

import {
  deriveDokuDetailViewModel,
  deriveDokuListViewModel,
} from '../../src/lib/worker/workerDokuProjection'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'
import type { Job } from '../../src/lib/jobs/types'
import type { JobPhoto, JobReport } from '../../src/lib/worker/dokuTypes'

function makeEntry(over: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: 'e-1',
    kind: 'job',
    jobId: 'j-1',
    title: 'Einsatz',
    customerName: 'Kunde',
    location: 'HH',
    dateLabel: 'Heute',
    dateKey: '2026-05-08',
    startsAtLabel: '09:00',
    endsAtLabel: '12:00',
    assignedMemberIds: ['tm-1'],
    status: 'in_progress',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: 'j-1',
    projectId: 'p-1',
    title: 'Job',
    customer: 'Kunde',
    location: 'HH',
    dateLabel: 'Heute',
    status: 'in_progress',
    amount: '1000',
    photoCount: 0,
    notes: [],
    ...over,
  } as Job
}

function makePhoto(id: string, jobId = 'j-1'): JobPhoto {
  return {
    id,
    jobId,
    providerId: 'prov-1',
    uploadedBy: 'u-1',
    storagePath: `jobs/${jobId}/${id}.jpg`,
    clientUuid: id,
    createdAt: 1,
  }
}

function makeReport(id: string, jobId = 'j-1'): JobReport {
  return {
    id,
    jobId,
    providerId: 'prov-1',
    authoredBy: 'u-1',
    body: 'Bericht-Text',
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('Block C.3 · workerDokuProjection — neue Quellen', () => {
  describe('detail · fotos module', () => {
    it('zählt aus photos[] wenn nicht-leer (überstimmt Job.photoCount)', () => {
      const vm = deriveDokuDetailViewModel(
        makeEntry(),
        [makeJob({ photoCount: 999 })],
        [makePhoto('p1'), makePhoto('p2')],
        [],
      )
      const fotos = vm.modules.find((m) => m.key === 'fotos')!
      expect(fotos.status).toBe('complete')
      expect(fotos.summary).toBe('2 Fotos hochgeladen')
    })

    it('fällt auf Job.photoCount zurück wenn photos[] leer', () => {
      const vm = deriveDokuDetailViewModel(
        makeEntry(),
        [makeJob({ photoCount: 3 })],
        [],
        [],
      )
      const fotos = vm.modules.find((m) => m.key === 'fotos')!
      expect(fotos.status).toBe('complete')
      expect(fotos.summary).toBe('3 Fotos hochgeladen')
    })

    it('isActionable=true für fotos auch bei complete (Worker kann mehr adden)', () => {
      const vm = deriveDokuDetailViewModel(
        makeEntry(),
        [makeJob()],
        [makePhoto('p1')],
        [],
      )
      const fotos = vm.modules.find((m) => m.key === 'fotos')!
      expect(fotos.isActionable).toBe(true)
    })
  })

  describe('detail · bericht module', () => {
    it('zählt aus reports[] wenn nicht-leer (überstimmt Job.notes)', () => {
      const vm = deriveDokuDetailViewModel(
        makeEntry(),
        [makeJob({ notes: ['x', 'y', 'z', 'a'] })],
        [],
        [makeReport('r1')],
      )
      const bericht = vm.modules.find((m) => m.key === 'bericht')!
      expect(bericht.status).toBe('complete')
      expect(bericht.summary).toBe('1 Bericht erfasst')
    })

    it('isActionable=true wenn count=0, false wenn ≥1 (MVP: ein Bericht reicht)', () => {
      const open = deriveDokuDetailViewModel(makeEntry(), [makeJob()], [], [])
      expect(open.modules.find((m) => m.key === 'bericht')!.isActionable).toBe(true)

      const filled = deriveDokuDetailViewModel(
        makeEntry(),
        [makeJob()],
        [],
        [makeReport('r1')],
      )
      expect(filled.modules.find((m) => m.key === 'bericht')!.isActionable).toBe(false)
    })
  })

  describe('detail · completeness', () => {
    it('zählt mit kombinierten neuen Quellen', () => {
      const vm = deriveDokuDetailViewModel(
        makeEntry(),
        [makeJob({ photoCount: 0, notes: [] })],
        [makePhoto('p1')],
        [makeReport('r1')],
      )
      expect(vm.completeness.doneCount).toBe(2)
      expect(vm.completeness.totalCount).toBe(2)
      expect(vm.completeness.isComplete).toBe(true)
    })

    it('teilweise-vollständig zeigt missingLabels', () => {
      const vm = deriveDokuDetailViewModel(
        makeEntry(),
        [makeJob()],
        [makePhoto('p1')],
        [],
      )
      expect(vm.completeness.doneCount).toBe(1)
      expect(vm.completeness.missingLabels).toEqual(['Bericht offen'])
    })
  })

  describe('list · photosByJobId / reportsByJobId Maps', () => {
    it('bevorzugt Map-Werte vor Job-Legacy-Feldern', () => {
      const entries = [makeEntry({ id: 'e-a', jobId: 'j-a' })]
      const jobs = [makeJob({ id: 'j-a', photoCount: 99, notes: ['legacy'] })]
      const photos = new Map([['j-a', [makePhoto('p1', 'j-a')]]])
      const reports = new Map([['j-a', [makeReport('r1', 'j-a')]]])

      const vm = deriveDokuListViewModel(entries, jobs, photos, reports)
      const card = vm.offen[0]!
      expect(card.completeness.doneCount).toBe(2)
      expect(card.completeness.isComplete).toBe(true)
    })

    it('default-leere Maps fallen auf Legacy-Felder zurück (backwards-compat)', () => {
      const entries = [makeEntry({ id: 'e-a', jobId: 'j-a' })]
      const jobs = [makeJob({ id: 'j-a', photoCount: 5, notes: ['leg'] })]

      const vm = deriveDokuListViewModel(entries, jobs)
      const card = vm.offen[0]!
      expect(card.completeness.doneCount).toBe(2)
      expect(card.completeness.isComplete).toBe(true)
    })
  })
})
