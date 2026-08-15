// @vitest-environment jsdom
/**
 * CustomerSpatialHomeCard — state coverage (Block 5).
 *
 * Locks the spatial-error fix: an `error` status surfaces a retry CTA and must
 * NEVER fall through to the empty "Demnächst hier" state (the prior silent bug).
 *
 * .test.ts + createElement (vitest glob scopes .test.tsx to the spatial tree).
 * The hook is mocked so each status is rendered deterministically.
 */

import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type {
  CustomerSpatialScansStatus,
  UseCustomerSpatialScansResult,
} from '../../src/lib/spatial/hooks/useCustomerSpatialScans'
import type { Scan } from '../../src/lib/spatial/types'

const hookState = vi.hoisted(() => ({
  current: null as unknown as UseCustomerSpatialScansResult,
}))

vi.mock('../../src/lib/spatial/hooks/useCustomerSpatialScans', () => ({
  useCustomerSpatialScans: () => hookState.current,
}))

import { CustomerSpatialHomeCard } from '../../src/components/home/CustomerSpatialHomeCard'

// The card only reads id / ownerType / createdAt — minimal fixture is faithful
// to that contract (the real hook produces full Scans, mocked away here).
function scan(id: string, ownerType: Scan['ownerType'] = 'craftsman'): Scan {
  return { id, ownerType, createdAt: 1_700_000_000_000 } as unknown as Scan
}

function setHook(partial: Partial<UseCustomerSpatialScansResult>) {
  hookState.current = {
    scans: [],
    status: 'ready' as CustomerSpatialScansStatus,
    isHydrated: true,
    error: null,
    reload: vi.fn().mockResolvedValue(undefined),
    ...partial,
  }
}

function renderCard() {
  return render(createElement(MemoryRouter, null, createElement(CustomerSpatialHomeCard)))
}

afterEach(cleanup)

describe('CustomerSpatialHomeCard — states', () => {
  it('loading (not hydrated) → skeleton, no content', () => {
    setHook({ status: 'loading', isHydrated: false })
    const { container } = renderCard()
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
    expect(screen.queryByText('Demnächst hier')).toBeNull()
  })

  it('unauthenticated → renders nothing', () => {
    setHook({ status: 'unauthenticated' })
    const { container } = renderCard()
    expect(container.firstChild).toBeNull()
  })

  it('error → surfaces retry, NEVER the empty state', () => {
    const reload = vi.fn().mockResolvedValue(undefined)
    setHook({ status: 'error', error: 'network_error', reload })
    renderCard()
    expect(screen.getByText('Aufmaße konnten nicht geladen werden')).toBeTruthy()
    expect(screen.queryByText('Demnächst hier')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Erneut' }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('ready + empty → "Demnächst hier"', () => {
    setHook({ status: 'ready', scans: [] })
    renderCard()
    expect(screen.getByText('Demnächst hier')).toBeTruthy()
  })

  it('ready + single scan → one scan card linking to the scan', () => {
    setHook({ status: 'ready', scans: [scan('s1')] })
    renderCard()
    const link = screen.getByRole('link', { name: /Aufmaß vom Handwerker/ })
    expect(link.getAttribute('href')).toBe('/customer/spatial/scan/s1')
  })

  it('ready + multiple scans → list + "Alle N ansehen"', () => {
    setHook({ status: 'ready', scans: [scan('s1'), scan('s2'), scan('s3')] })
    renderCard()
    expect(screen.getByText(/Alle 3 Räume ansehen/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Alle 3 Räume ansehen/ }).getAttribute('href')).toBe(
      '/customer/spatial/list',
    )
  })
})
