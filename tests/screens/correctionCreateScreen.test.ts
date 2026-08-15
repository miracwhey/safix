import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import WorkerKorrekturCreateScreen from '../../src/screens/WorkerKorrekturCreateScreen'

import { setCorrectionRepository } from '../../src/lib/corrections'
import { InMemoryCorrectionRepository } from '../../src/lib/corrections/repository/InMemoryCorrectionRepository'
import {
  InMemoryTeamMemberRepository,
  setTeamMemberRepository,
} from '../../src/lib/team/repository'
import { setNotificationRepository } from '../../src/lib/notifications/repository'
import { InMemoryNotificationRepository } from '../../src/lib/notifications/repository/InMemoryNotificationRepository'
import { setCalendarRepository } from '../../src/lib/calendar/repository/registry'
import { InMemoryCalendarRepository } from '../../src/lib/calendar/repository/InMemoryCalendarRepository'
import { installMockSession, mockWorkerSession } from '../helpers/mockSession'

const WORKER_ID = 'u-worker'
const PROVIDER_ID = 'p1'

beforeEach(() => {
  setCorrectionRepository(new InMemoryCorrectionRepository([]))
  setNotificationRepository(new InMemoryNotificationRepository())
  setCalendarRepository(new InMemoryCalendarRepository([]))
  const team = new InMemoryTeamMemberRepository()
  team.add({
    id: 'tm-worker',
    userId: WORKER_ID,
    providerId: PROVIDER_ID,
    fullName: 'Worker',
    role: 'worker',
  })
  setTeamMemberRepository(team)
  installMockSession(mockWorkerSession(WORKER_ID))
})

function render(initialEntry: string = '/worker/korrekturen/neu'): string {
  return renderToString(
    React.createElement(
      MemoryRouter,
      { initialEntries: [initialEntry] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: '/worker/korrekturen/neu',
          element: React.createElement(WorkerKorrekturCreateScreen),
        }),
      ),
    ),
  )
}

describe('WorkerKorrekturCreateScreen — Block 7.2.4 structured-fields submit', () => {
  it('renders the structured-input section with 4 named fields', () => {
    const html = render()
    expect(html).toContain('correction-structured-input')
    expect(html).toContain('id="correction-field"')
    expect(html).toContain('id="correction-current"')
    expect(html).toContain('id="correction-proposed"')
    expect(html).toContain('id="correction-reason"')
  })

  it('uses red/emerald palette for current/proposed comparison', () => {
    const html = render()
    // Aktuell-Feld
    const currentIdx = html.indexOf('id="correction-current"')
    const aroundCurrent = html.slice(Math.max(0, currentIdx - 200), currentIdx + 200)
    expect(aroundCurrent).toContain('bg-red-50')
    // Vorschlag-Feld
    const proposedIdx = html.indexOf('id="correction-proposed"')
    const aroundProposed = html.slice(Math.max(0, proposedIdx - 200), proposedIdx + 200)
    expect(aroundProposed).toContain('bg-emerald-50')
  })

  it('marks all four structured fields as optional in their labels', () => {
    const html = render()
    // "Was" + "Begründung" haben "(optional)"-Suffix; Aktuell/Vorschlag stehen ohne (matches mockup pair)
    const fieldLabelIdx = html.indexOf('Was ')
    expect(fieldLabelIdx).toBeGreaterThan(-1)
    const reasonLabelIdx = html.indexOf('Begründung ')
    expect(reasonLabelIdx).toBeGreaterThan(-1)
    expect(html.slice(fieldLabelIdx, fieldLabelIdx + 200)).toContain('(optional)')
    expect(html.slice(reasonLabelIdx, reasonLabelIdx + 200)).toContain('(optional)')
  })
})

// ── Block 7.2.7c — Pre-Fill aus Worker-Einsatz-Detail ────────────────────────

describe('WorkerKorrekturCreateScreen — Block 7.2.7c calendar-entry anchor', () => {
  it('renders the Bezug-banner with dateLabel + title when ?calendarEntryId resolves', () => {
    setCalendarRepository(
      new InMemoryCalendarRepository([
        {
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
          assignedMemberIds: ['tm-worker'],
          status: 'in_progress',
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    )
    const html = render('/worker/korrekturen/neu?calendarEntryId=cal-A')
    expect(html).toContain('correction-linked-entry-banner')
    expect(html).toContain('Mo 28.04.')
    expect(html).toContain('Bad Müller')
    // requestedDate-input pre-filled aus entry.dateKey
    const dateIdx = html.indexOf('id="requested-date"')
    expect(dateIdx).toBeGreaterThan(-1)
    expect(html.slice(dateIdx, dateIdx + 300)).toContain('value="2026-04-28"')
  })

  it('renders no Bezug-banner when ?calendarEntryId is missing', () => {
    const html = render('/worker/korrekturen/neu')
    expect(html).not.toContain('correction-linked-entry-banner')
  })

  it('renders no Bezug-banner when ?calendarEntryId points to an unknown entry (graceful)', () => {
    setCalendarRepository(new InMemoryCalendarRepository([]))
    const html = render('/worker/korrekturen/neu?calendarEntryId=cal-unknown')
    expect(html).not.toContain('correction-linked-entry-banner')
    // requestedDate stays empty (not pre-filled)
    const dateIdx = html.indexOf('id="requested-date"')
    expect(html.slice(dateIdx, dateIdx + 300)).toContain('value=""')
  })
})
