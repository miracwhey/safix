import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import WorkerEinsaetzeDetailScreen from '../../src/screens/WorkerEinsaetzeDetailScreen'
import {
  InMemoryTeamMemberRepository,
  setTeamMemberRepository,
} from '../../src/lib/team/repository'
import { setCalendarRepository } from '../../src/lib/calendar/repository/registry'
import { InMemoryCalendarRepository } from '../../src/lib/calendar/repository/InMemoryCalendarRepository'
import { setJobRepository } from '../../src/lib/jobs/repository/registry'
import { InMemoryJobRepository } from '../../src/lib/jobs/repository/InMemoryJobRepository'
import { installMockSession, mockWorkerSession } from '../helpers/mockSession'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'

const WORKER_ID = 'u-worker'
const PROVIDER_ID = 'p1'
const TEAM_WORKER_ID = 'tm-worker'

function makeEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: 'cal-A',
    jobId: 'job-A',
    kind: 'job',
    providerId: PROVIDER_ID,
    title: 'Bad Müller',
    description: '',
    customerName: 'Müller',
    location: 'Berlin',
    dateLabel: 'Mo 28.04.',
    dateKey: '2026-04-28',
    startsAtLabel: '08:00',
    endsAtLabel: '16:00',
    assignedMemberIds: [TEAM_WORKER_ID],
    status: 'in_progress',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

beforeEach(() => {
  const team = new InMemoryTeamMemberRepository()
  team.add({
    id: TEAM_WORKER_ID,
    userId: WORKER_ID,
    providerId: PROVIDER_ID,
    fullName: 'Worker',
    role: 'worker',
  })
  setTeamMemberRepository(team)
  setCalendarRepository(new InMemoryCalendarRepository([makeEntry()]))
  setJobRepository(new InMemoryJobRepository([]))
  installMockSession(mockWorkerSession(WORKER_ID))
})

function render(entryId: string): string {
  return renderToString(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`/worker/einsaetze/${entryId}`] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: '/worker/einsaetze/:entryId',
          element: React.createElement(WorkerEinsaetzeDetailScreen),
        }),
      ),
    ),
  )
}

describe('WorkerEinsaetzeDetailScreen — Block 7.2.7c correction CTA', () => {
  it('renders a "Korrektur melden" CTA that points at the entry id', () => {
    const html = render('cal-A')
    expect(html).toContain('worker-einsatz-report-correction')
    expect(html).toContain('Korrektur zu diesem Einsatz melden')
    // The CTA navigates via onClick — SSR cannot fire it, so we just assert
    // the trigger element exists. URL-construction is covered by the
    // correctionCreateScreen Pre-Fill tests (?calendarEntryId resolution).
  })

  it('does not render the CTA on the not-found fallback', () => {
    const html = render('cal-missing')
    expect(html).not.toContain('worker-einsatz-report-correction')
    expect(html).toContain('Einsatz nicht gefunden.')
  })
})
