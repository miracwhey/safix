import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import CraftsmanKorrekturDetailScreen from '../../src/screens/CraftsmanKorrekturDetailScreen'
import WorkerKorrekturDetailScreen from '../../src/screens/WorkerKorrekturDetailScreen'

import {
  setCorrectionRepository,
  type CorrectionRequest,
} from '../../src/lib/corrections'
import { InMemoryCorrectionRepository } from '../../src/lib/corrections/repository/InMemoryCorrectionRepository'
import {
  InMemoryTeamMemberRepository,
  setTeamMemberRepository,
} from '../../src/lib/team/repository'
import { setCalendarRepository } from '../../src/lib/calendar/repository/registry'
import { InMemoryCalendarRepository } from '../../src/lib/calendar/repository/InMemoryCalendarRepository'
import { installMockSession, mockOwnerSession, mockWorkerSession } from '../helpers/mockSession'

const PROVIDER_ID = 'p1'
const OWNER_ID = 'u-owner'
const WORKER_ID = 'u-worker'
const TEAM_OWNER = 'tm-owner'
const TEAM_WORKER = 'tm-worker'

function makeRequest(overrides: Partial<CorrectionRequest> = {}): CorrectionRequest {
  return {
    id: 'cr-1',
    providerId: PROVIDER_ID,
    workerTeamMemberId: TEAM_WORKER,
    workerProfileId: WORKER_ID,
    kind: 'wrong_time',
    description: 'falsche Zeit',
    status: 'open',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  }
}

beforeEach(() => {
  setCalendarRepository(new InMemoryCalendarRepository([]))
  const team = new InMemoryTeamMemberRepository()
  team.add({
    id: TEAM_OWNER,
    userId: OWNER_ID,
    providerId: PROVIDER_ID,
    fullName: 'Owner',
    role: 'owner',
  })
  team.add({
    id: TEAM_WORKER,
    userId: WORKER_ID,
    providerId: PROVIDER_ID,
    fullName: 'Worker',
    role: 'worker',
  })
  setTeamMemberRepository(team)
})

function renderOwnerDetail(request: CorrectionRequest): string {
  setCorrectionRepository(new InMemoryCorrectionRepository([request]))
  installMockSession(mockOwnerSession(OWNER_ID))
  return renderToString(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`/craftsman/korrekturen/${request.id}`] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: '/craftsman/korrekturen/:id',
          element: React.createElement(CraftsmanKorrekturDetailScreen),
        }),
      ),
    ),
  )
}

function renderWorkerDetail(request: CorrectionRequest): string {
  setCorrectionRepository(new InMemoryCorrectionRepository([request]))
  installMockSession(mockWorkerSession(WORKER_ID))
  return renderToString(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`/worker/korrekturen/${request.id}`] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: '/worker/korrekturen/:id',
          element: React.createElement(WorkerKorrekturDetailScreen),
        }),
      ),
    ),
  )
}

describe('CraftsmanKorrekturDetailScreen — Block 7.2.3 approval refactor', () => {
  it('renders structured-fields section when fields are present', () => {
    const html = renderOwnerDetail(
      makeRequest({
        field: 'Arbeitszeit Mo 28.04.',
        currentValue: '6h',
        proposedValue: '8h',
        reason: 'Foto zeigt 7:30–15:30',
      }),
    )
    expect(html).toContain('correction-structured-fields')
    expect(html).toContain('Arbeitszeit Mo 28.04.')
    expect(html).toContain('Aktuell')
    expect(html).toContain('6h')
    expect(html).toContain('Vorschlag')
    expect(html).toContain('8h')
    expect(html).toContain('Foto zeigt 7:30–15:30')
  })

  it('omits structured-fields section when no structured field set', () => {
    const html = renderOwnerDetail(makeRequest())
    expect(html).not.toContain('correction-structured-fields')
  })

  it('shows Approve and Reject CTAs while status is open', () => {
    const html = renderOwnerDetail(makeRequest())
    expect(html).toContain('Übernehmen')
    expect(html).toContain('Ablehnen')
  })

  it('hides Approve/Reject CTAs once the correction is terminal', () => {
    const html = renderOwnerDetail(makeRequest({ status: 'resolved', ownerNote: 'ok' }))
    expect(html).not.toContain('Übernehmen')
    expect(html).not.toContain('Ablehnen')
  })

  it('disables Reject when ownerNote is empty (initial render)', () => {
    const html = renderOwnerDetail(makeRequest())
    // Reject button is rendered but in disabled-styled state.
    // SSR cannot validate the disabled attribute precisely without a parser, so
    // we assert the disabled-cursor class accompanies the Ablehnen label.
    const rejectIdx = html.indexOf('Ablehnen')
    expect(rejectIdx).toBeGreaterThan(-1)
    const window = html.slice(Math.max(0, rejectIdx - 200), rejectIdx)
    expect(window).toContain('cursor-not-allowed')
  })
})

describe('WorkerKorrekturDetailScreen — Block 7.2.3 read-only structured + banner', () => {
  it('renders structured fields read-only when present', () => {
    const html = renderWorkerDetail(
      makeRequest({
        field: 'Pause',
        proposedValue: '30 min',
      }),
    )
    expect(html).toContain('correction-structured-fields')
    expect(html).toContain('Pause')
    expect(html).toContain('30 min')
  })

  it('renders rejection banner with red styling and reject copy when status=rejected', () => {
    const html = renderWorkerDetail(
      makeRequest({ status: 'rejected', ownerNote: 'Pause abziehen' }),
    )
    expect(html).toContain('correction-owner-note-banner')
    expect(html).toContain('Begründung der Ablehnung')
    expect(html).toContain('Pause abziehen')
    expect(html).toContain('bg-red-50')
  })

  it('renders blue banner with "Antwort" copy when status=resolved', () => {
    const html = renderWorkerDetail(
      makeRequest({ status: 'resolved', ownerNote: 'übernommen' }),
    )
    expect(html).toContain('correction-owner-note-banner')
    expect(html).toContain('Antwort')
    expect(html).toContain('übernommen')
    expect(html).toContain('bg-blue-50')
  })

  // Block 7.2.5 — Mini-Timeline
  it('renders mini-timeline with single "submitted" entry for open corrections', () => {
    const html = renderWorkerDetail(makeRequest())
    expect(html).toContain('correction-mini-timeline')
    expect(html).toContain('Du hast eingereicht')
    expect(html).not.toContain('Admin hat übernommen')
    expect(html).not.toContain('Admin hat abgelehnt')
  })

  it('renders mini-timeline with submitted + resolved when terminal', () => {
    const html = renderWorkerDetail(
      makeRequest({
        status: 'resolved',
        ownerNote: 'ok',
        createdAt: 1700000000000,
        updatedAt: 1700000000000 + 3_600_000,
      }),
    )
    expect(html).toContain('Du hast eingereicht')
    expect(html).toContain('Admin hat übernommen')
  })

  it('renders mini-timeline with submitted + rejected when terminal-rejected', () => {
    const html = renderWorkerDetail(
      makeRequest({
        status: 'rejected',
        ownerNote: 'no',
        createdAt: 1700000000000,
        updatedAt: 1700000000000 + 3_600_000,
      }),
    )
    expect(html).toContain('Du hast eingereicht')
    expect(html).toContain('Admin hat abgelehnt')
  })
})

// ── Block 7.2.7b — CorrectionApplyBadge ─────────────────────────────────────

describe('CorrectionApplyBadge — Block 7.2.7b', () => {
  it('worker: emerald applied-badge when appliedAt set on resolved correction', () => {
    const html = renderWorkerDetail(
      makeRequest({
        status: 'resolved',
        ownerNote: 'ok',
        appliedAt: 1700000000000 + 3_600_000,
        appliedTargetEntryId: 'cal-1',
      }),
    )
    expect(html).toContain('correction-apply-badge')
    expect(html).toContain('Eintrag automatisch aktualisiert')
    expect(html).toContain('bg-emerald-50')
  })

  it('worker: amber manual-badge for invalid_time_format', () => {
    const html = renderWorkerDetail(
      makeRequest({
        status: 'resolved',
        applySkipReason: 'invalid_time_format',
      }),
    )
    expect(html).toContain('correction-apply-badge')
    expect(html).toContain('Bitte Eintrag manuell anpassen')
    expect(html).toContain('bg-amber-50')
  })

  it('worker: amber manual-badge for missing_calendar_entry', () => {
    const html = renderWorkerDetail(
      makeRequest({
        status: 'resolved',
        applySkipReason: 'missing_calendar_entry',
      }),
    )
    expect(html).toContain('Bitte Eintrag manuell anpassen')
    expect(html).toContain('bg-amber-50')
  })

  it('worker: red error-badge for repository_error', () => {
    const html = renderWorkerDetail(
      makeRequest({
        status: 'resolved',
        applySkipReason: 'repository_error',
      }),
    )
    expect(html).toContain('Eintrag-Update fehlgeschlagen')
    expect(html).toContain('bg-red-50')
  })

  it('worker: no badge for kind_not_supported (expected case)', () => {
    const html = renderWorkerDetail(
      makeRequest({
        kind: 'other',
        status: 'resolved',
        applySkipReason: 'kind_not_supported',
      }),
    )
    expect(html).not.toContain('correction-apply-badge')
  })

  it('worker: no badge while status is still open', () => {
    const html = renderWorkerDetail(
      makeRequest({
        status: 'open',
        applySkipReason: 'invalid_time_format',
      }),
    )
    expect(html).not.toContain('correction-apply-badge')
  })

  it('owner: emerald applied-badge mirrors worker view on resolved', () => {
    const html = renderOwnerDetail(
      makeRequest({
        status: 'resolved',
        appliedAt: 1700000000000 + 3_600_000,
        appliedTargetEntryId: 'cal-1',
      }),
    )
    expect(html).toContain('correction-apply-badge')
    expect(html).toContain('Eintrag automatisch aktualisiert')
  })
})
