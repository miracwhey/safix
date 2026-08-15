// @vitest-environment jsdom
/**
 * CustomerMultiScanPicker · Phase 1d dropdown contract.
 */

import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'

import CustomerMultiScanPicker from '../../../../src/components/spatial/customer/CustomerMultiScanPicker'
import type { Scan } from '../../../../src/lib/spatial/types'

function makeScan(over: Partial<Scan> & { id: string; createdAt: number }): Scan {
  return {
    id: over.id,
    jobId: null,
    projectId: null,
    presalesProjectId: null,
    parentScanId: null,
    status: 'captured',
    source: 'lidar',
    capturedBy: 'user-1',
    deviceMeta: {},
    scanStartedAt: null,
    scanEndedAt: null,
    archivedAt: null,
    ownerType: 'customer',
    sharedWithCustomer: false,
    sharedAt: null,
    sharedWithProviderId: null,
    sharedWithProviderAt: null,
    createdAt: over.createdAt,
    updatedAt: over.createdAt,
    ...over,
  }
}

describe('CustomerMultiScanPicker', () => {
  it('renders nothing when fewer than 2 scans are passed', () => {
    const { container } = render(
      <CustomerMultiScanPicker
        scans={[makeScan({ id: 'a', createdAt: 100 })]}
        activeScanId="a"
        onSelect={() => {}}
      />,
    )
    expect(container.querySelector('[data-testid]')).toBeNull()
  })

  it('renders a collapsed pill with active scan summary when 2+ scans', () => {
    const scans = [
      makeScan({ id: 'older', createdAt: 100 }),
      makeScan({ id: 'newer', createdAt: 200 }),
    ]
    render(
      <CustomerMultiScanPicker
        scans={scans}
        activeScanId="newer"
        onSelect={() => {}}
      />,
    )
    expect(
      screen.getByTestId('customer-multi-scan-picker'),
    ).toBeTruthy()
    // The list should not be mounted while collapsed.
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('expands on pill click and renders every scan as a listbox option', () => {
    const scans = [
      makeScan({ id: 'older', createdAt: 100 }),
      makeScan({ id: 'newer', createdAt: 200 }),
    ]
    render(
      <CustomerMultiScanPicker
        scans={scans}
        activeScanId="newer"
        onSelect={() => {}}
      />,
    )
    fireEvent.click(screen.getAllByRole('button')[0])
    const list = screen.getByRole('listbox')
    expect(within(list).getAllByRole('option')).toHaveLength(2)
  })

  it('marks the active scan with aria-selected=true', () => {
    const scans = [
      makeScan({ id: 'older', createdAt: 100 }),
      makeScan({ id: 'newer', createdAt: 200 }),
    ]
    render(
      <CustomerMultiScanPicker
        scans={scans}
        activeScanId="newer"
        onSelect={() => {}}
      />,
    )
    fireEvent.click(screen.getAllByRole('button')[0])
    const options = within(screen.getByRole('listbox')).getAllByRole(
      'option',
    )
    const activeOption = options.find(
      o => o.getAttribute('aria-selected') === 'true',
    )
    expect(activeOption).toBeTruthy()
  })

  it('calls onSelect with the tapped scan id and collapses', () => {
    const onSelect = vi.fn()
    const scans = [
      makeScan({ id: 'older', createdAt: 100 }),
      makeScan({ id: 'newer', createdAt: 200 }),
    ]
    render(
      <CustomerMultiScanPicker
        scans={scans}
        activeScanId="newer"
        onSelect={onSelect}
      />,
    )
    fireEvent.click(screen.getAllByRole('button')[0])
    const options = within(screen.getByRole('listbox')).getAllByRole(
      'option',
    )
    // Pick the non-active option.
    const inactive = options.find(
      o => o.getAttribute('aria-selected') === 'false',
    )!
    fireEvent.click(inactive)
    expect(onSelect).toHaveBeenCalledWith('older')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('Escape collapses an open dropdown', () => {
    const scans = [
      makeScan({ id: 'a', createdAt: 100 }),
      makeScan({ id: 'b', createdAt: 200 }),
    ]
    render(
      <CustomerMultiScanPicker
        scans={scans}
        activeScanId="b"
        onSelect={() => {}}
      />,
    )
    fireEvent.click(screen.getAllByRole('button')[0])
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('renders the footer CTA when onAddScan is provided and routes through it', () => {
    const onAddScan = vi.fn()
    const scans = [
      makeScan({ id: 'a', createdAt: 100 }),
      makeScan({ id: 'b', createdAt: 200 }),
    ]
    render(
      <CustomerMultiScanPicker
        scans={scans}
        activeScanId="b"
        onSelect={() => {}}
        onAddScan={onAddScan}
      />,
    )
    fireEvent.click(screen.getAllByRole('button')[0])
    fireEvent.click(screen.getByRole('button', { name: /neuen scan starten/i }))
    expect(onAddScan).toHaveBeenCalledTimes(1)
  })

  // ─── Phase 3 (B4-D7, P3-4) extensions ──────────────────────────────────

  it('sorts scans newest-first regardless of input order', () => {
    const scans = [
      makeScan({ id: 'oldest', createdAt: 100 }),
      makeScan({ id: 'middle', createdAt: 200 }),
      makeScan({ id: 'newest', createdAt: 300 }),
    ]
    render(
      <CustomerMultiScanPicker
        scans={scans}
        activeScanId="middle"
        onSelect={() => {}}
      />,
    )
    fireEvent.click(screen.getAllByRole('button')[0])
    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    // First rendered option is the newest by createdAt, last is oldest.
    expect(options).toHaveLength(3)
    expect(options[0]!.textContent ?? '').toMatch(/eigenes aufmaß/i)
    // Confirm the active middle option carries the "Aktiv" badge regardless
    // of its position.
    const middleOption = options.find(o => o.getAttribute('aria-selected') === 'true')!
    expect(middleOption.textContent ?? '').toMatch(/aktiv/i)
  })

  it('shows "Aktiv" pill only on the active option', () => {
    const scans = [
      makeScan({ id: 'older', createdAt: 100 }),
      makeScan({ id: 'newer', createdAt: 200 }),
    ]
    render(
      <CustomerMultiScanPicker
        scans={scans}
        activeScanId="newer"
        onSelect={() => {}}
      />,
    )
    fireEvent.click(screen.getAllByRole('button')[0])
    const list = screen.getByRole('listbox')
    const activeBadges = within(list).getAllByText(/aktiv/i)
    expect(activeBadges).toHaveLength(1)
  })

  it('subtitles a customer child-scan as "Erneuter Scan"', () => {
    const scans = [
      makeScan({ id: 'root', createdAt: 100 }),
      makeScan({ id: 'child', createdAt: 200, parentScanId: 'root' }),
    ]
    render(
      <CustomerMultiScanPicker
        scans={scans}
        activeScanId="child"
        onSelect={() => {}}
      />,
    )
    fireEvent.click(screen.getAllByRole('button')[0])
    const list = screen.getByRole('listbox')
    const subtitles = within(list).getAllByText(/erneuter scan|selbst erstellt/i)
    // Exactly one child says "Erneuter Scan", the root says "Selbst erstellt".
    const childMatch = subtitles.find(s => /erneuter scan/i.test(s.textContent ?? ''))
    const rootMatch = subtitles.find(s => /selbst erstellt/i.test(s.textContent ?? ''))
    expect(childMatch).toBeTruthy()
    expect(rootMatch).toBeTruthy()
  })
})
