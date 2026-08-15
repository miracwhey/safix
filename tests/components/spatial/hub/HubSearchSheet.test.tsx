// @vitest-environment jsdom
/**
 * Tests for {@link HubSearchSheet} — debounced filter across jobs + presales,
 * empty + clear behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { HubSearchSheet, type HubSearchJob } from '../../../../src/components/spatial/hub/HubSearchSheet'
import type { PresalesProject } from '../../../../src/domain/presales/presalesProjectTypes'

const jobs: HubSearchJob[] = [
  {
    jobId: 'j-1',
    title: 'Badrenovierung Schmidt',
    customerName: 'Maria Schmidt',
    locationLabel: 'Hannover Linden',
    hasScene: true,
  },
  {
    jobId: 'j-2',
    title: 'Küche Müller',
    customerName: 'Tom Müller',
    locationLabel: 'Hannover Mitte',
    hasScene: false,
  },
]

const presales: PresalesProject[] = [
  {
    id: 'p-1',
    providerOrgId: 'org-1',
    createdByUserId: 'usr-1',
    title: 'Heizung Bauer',
    locationHint: 'Garbsen',
    customerNameDraft: 'Lisa Bauer',
    customerEmailDraft: null,
    customerPhoneDraft: null,
    notes: null,
    status: 'scanned',
    scannedAt: '2026-05-20T10:00:00Z',
    quotedAt: null,
    convertedAt: null,
    convertedToJobId: null,
    createdAt: '2026-05-20T09:00:00Z',
    updatedAt: '2026-05-20T10:00:00Z',
  },
]

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

function tickDebounce() {
  act(() => {
    vi.advanceTimersByTime(250)
  })
}

describe('HubSearchSheet', () => {
  it('shows idle hint when no query', () => {
    render(
      <HubSearchSheet
        jobs={jobs}
        presales={presales}
        onSelectJob={() => {}}
        onSelectPresales={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/Suche nach Job-Titel/)).toBeTruthy()
  })

  it('filters jobs by title and surfaces only matching results', () => {
    const onSelectJob = vi.fn()
    render(
      <HubSearchSheet
        jobs={jobs}
        presales={presales}
        onSelectJob={onSelectJob}
        onSelectPresales={() => {}}
        onClose={() => {}}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Suchfeld/), { target: { value: 'badrenovierung' } })
    tickDebounce()
    expect(screen.getByText('Badrenovierung Schmidt')).toBeTruthy()
    expect(screen.queryByText('Küche Müller')).toBeNull()
    expect(screen.queryByText('Heizung Bauer')).toBeNull()
    fireEvent.click(screen.getByText('Badrenovierung Schmidt'))
    expect(onSelectJob).toHaveBeenCalledWith('j-1')
  })

  it('filters presales by customer-name-draft', () => {
    const onSelectPresales = vi.fn()
    render(
      <HubSearchSheet
        jobs={jobs}
        presales={presales}
        onSelectJob={() => {}}
        onSelectPresales={onSelectPresales}
        onClose={() => {}}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Suchfeld/), { target: { value: 'lisa' } })
    tickDebounce()
    expect(screen.getByText('Heizung Bauer')).toBeTruthy()
    expect(screen.queryByText('Badrenovierung Schmidt')).toBeNull()
    fireEvent.click(screen.getByText('Heizung Bauer'))
    expect(onSelectPresales).toHaveBeenCalledWith('p-1')
  })

  it('renders empty state with "keine Treffer" + clear-button', () => {
    render(
      <HubSearchSheet
        jobs={jobs}
        presales={presales}
        onSelectJob={() => {}}
        onSelectPresales={() => {}}
        onClose={() => {}}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Suchfeld/), { target: { value: 'zzzzz' } })
    tickDebounce()
    // Live-region count message uses "Keine Treffer für „zzzzz"".
    const noResults = screen.getAllByText(/Keine Treffer/)
    expect(noResults.length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /Suche löschen/ }))
    expect(screen.getByText(/Suche nach Job-Titel/)).toBeTruthy()
  })

  it('jobs-without-scan show "Ohne Scan" badge', () => {
    render(
      <HubSearchSheet
        jobs={jobs}
        presales={[]}
        onSelectJob={() => {}}
        onSelectPresales={() => {}}
        onClose={() => {}}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Suchfeld/), { target: { value: 'müller' } })
    tickDebounce()
    expect(screen.getByText('Ohne Scan')).toBeTruthy()
  })
})
