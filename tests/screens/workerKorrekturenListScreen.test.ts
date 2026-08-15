import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import WorkerKorrekturenScreen from '../../src/screens/WorkerKorrekturenScreen'
import {
  setCorrectionRepository,
  type CorrectionRequest,
} from '../../src/lib/corrections'
import { InMemoryCorrectionRepository } from '../../src/lib/corrections/repository/InMemoryCorrectionRepository'

// `useWorkerCorrections` filtert in In-Memory-Mode auf workerTeamMemberId === 'tm-1'.
const WORKER_TEAM_MEMBER_ID = 'tm-1'

function makeRequest(overrides: Partial<CorrectionRequest> = {}): CorrectionRequest {
  return {
    id: 'cr-1',
    providerId: 'p1',
    workerTeamMemberId: WORKER_TEAM_MEMBER_ID,
    workerProfileId: 'u-worker',
    kind: 'wrong_time',
    description: 'desc',
    status: 'open',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  }
}

function render(requests: CorrectionRequest[]): string {
  setCorrectionRepository(new InMemoryCorrectionRepository(requests))
  return renderToString(
    React.createElement(
      MemoryRouter,
      { initialEntries: ['/worker/korrekturen'] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: '/worker/korrekturen',
          element: React.createElement(WorkerKorrekturenScreen),
        }),
      ),
    ),
  )
}

beforeEach(() => {
  setCorrectionRepository(new InMemoryCorrectionRepository([]))
})

describe('WorkerKorrekturenScreen — Block 7.2.7d apply indicator', () => {
  it('renders no apply indicator while a row is still open', () => {
    const html = render([makeRequest({ status: 'open' })])
    expect(html).not.toContain('correction-list-apply-indicator')
  })

  it('renders emerald applied-indicator on resolved + appliedAt rows', () => {
    const html = render([
      makeRequest({
        id: 'cr-applied',
        status: 'resolved',
        appliedAt: 1700000000000 + 3_600_000,
        appliedTargetEntryId: 'cal-1',
      }),
    ])
    expect(html).toContain('correction-list-apply-indicator')
    expect(html).toContain('data-state="applied"')
    expect(html).toContain('Übernommen')
    expect(html).toContain('bg-emerald-500')
  })

  it('renders amber manual-indicator on invalid_time_format skip', () => {
    const html = render([
      makeRequest({
        id: 'cr-manual',
        status: 'resolved',
        applySkipReason: 'invalid_time_format',
      }),
    ])
    expect(html).toContain('data-state="manual"')
    expect(html).toContain('Manuell prüfen')
    expect(html).toContain('bg-amber-500')
  })

  it('renders amber manual-indicator on missing_calendar_entry skip', () => {
    const html = render([
      makeRequest({
        id: 'cr-manual2',
        status: 'resolved',
        applySkipReason: 'missing_calendar_entry',
      }),
    ])
    expect(html).toContain('data-state="manual"')
    expect(html).toContain('Manuell prüfen')
  })

  it('renders red error-indicator on repository_error skip', () => {
    const html = render([
      makeRequest({
        id: 'cr-err',
        status: 'resolved',
        applySkipReason: 'repository_error',
      }),
    ])
    expect(html).toContain('data-state="error"')
    expect(html).toContain('Apply fehlgeschlagen')
    expect(html).toContain('bg-red-500')
  })

  it('renders no apply indicator on kind_not_supported (status pill is enough)', () => {
    const html = render([
      makeRequest({
        id: 'cr-other',
        kind: 'other',
        status: 'resolved',
        applySkipReason: 'kind_not_supported',
      }),
    ])
    expect(html).not.toContain('correction-list-apply-indicator')
  })

  it('renders no apply indicator on legacy resolved rows without trace', () => {
    const html = render([makeRequest({ id: 'cr-legacy', status: 'resolved' })])
    expect(html).not.toContain('correction-list-apply-indicator')
  })
})
