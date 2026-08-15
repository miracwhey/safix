// @vitest-environment jsdom
/**
 * ScanQualityPill · TBD #5 locked render contract.
 *
 * Pill renders only when quality_score IS NOT NULL (no "—" placeholder for
 * Manual-Preset / legacy rows). Scope = both self-captured + HW-shared scans;
 * no owner_type guard at this layer.
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import ScanQualityPill from '../../../../src/components/spatial/customer/ScanQualityPill'
import type { Scan } from '../../../../src/lib/spatial/types'

function scan(overrides: Partial<Scan> = {}): Scan {
  return {
    id: 'scan_test',
    jobId: null,
    projectId: null,
    presalesProjectId: null,
    parentScanId: null,
    status: 'captured',
    source: 'roomplan',
    capturedBy: 'user_test',
    deviceMeta: {},
    scanStartedAt: null,
    scanEndedAt: null,
    archivedAt: null,
    ownerType: 'customer',
    sharedWithCustomer: false,
    sharedAt: null,
    sharedWithProviderId: null,
    sharedWithProviderAt: null,
    qualityScore: null,
    qualityLabel: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('ScanQualityPill', () => {
  it('renders null when scan is null', () => {
    const { container } = render(<ScanQualityPill scan={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders null when quality_score is NULL (Manual-Preset / legacy row)', () => {
    const { container } = render(<ScanQualityPill scan={scan()} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders "Gut" with status role for qualityLabel=high', () => {
    render(<ScanQualityPill scan={scan({ qualityScore: 92, qualityLabel: 'high' })} />)
    const pill = screen.getByRole('status')
    expect(pill.textContent).toContain('Gut')
    expect(pill.getAttribute('aria-label')).toMatch(/scan-qualität: gut/i)
  })

  it('renders "Mittel" for qualityLabel=medium', () => {
    render(<ScanQualityPill scan={scan({ qualityScore: 65, qualityLabel: 'medium' })} />)
    expect(screen.getByRole('status').textContent).toContain('Mittel')
  })

  it('renders "Niedrig" for qualityLabel=low', () => {
    render(<ScanQualityPill scan={scan({ qualityScore: 30, qualityLabel: 'low' })} />)
    expect(screen.getByRole('status').textContent).toContain('Niedrig')
  })

  it('renders for HW-shared scans without owner_type guard (TBD #5)', () => {
    render(
      <ScanQualityPill
        scan={scan({
          ownerType: 'craftsman',
          sharedWithCustomer: true,
          qualityScore: 88,
          qualityLabel: 'high',
        })}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain('Gut')
  })
})
