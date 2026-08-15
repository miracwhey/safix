// @vitest-environment jsdom
/**
 * CaptureDsgvoConsentSheet · PRIV-D1 legal-gate contract.
 *
 * Legal binding: backdrop-dismiss + ESC must NOT count as consent. The accept
 * CTA is the only path that persists the localStorage flag.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

// localStorage shim — vitest jsdom env has a partial implementation that
// is missing getItem/setItem when stubbed-global elsewhere. Mirrors the
// pattern from tests/calendar/calendarUUIDContract.test.ts.
const memoryStorage = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (k: string): string | null => (k in store ? store[k] : null),
    setItem: (k: string, v: string): void => { store[k] = v },
    removeItem: (k: string): void => { delete store[k] },
    clear: (): void => { store = {} },
    key: (i: number): string | null => Object.keys(store)[i] ?? null,
    get length(): number { return Object.keys(store).length },
  }
})()

vi.stubGlobal('localStorage', memoryStorage)

import CaptureDsgvoConsentSheet from '../../../../src/components/spatial/customer/CaptureDsgvoConsentSheet'
import { CUSTOMER_LIDAR_DSGVO_CONSENT_KEY } from '../../../../src/hooks/customerLidarConsent'

describe('CaptureDsgvoConsentSheet', () => {
  beforeEach(() => {
    memoryStorage.clear()
  })

  it('returns null when open=false', () => {
    const { container } = render(
      <CaptureDsgvoConsentSheet
        open={false}
        onConsented={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders the dialog with all 4 bullets + 2 CTAs when open', () => {
    render(
      <CaptureDsgvoConsentSheet
        open
        onConsented={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByRole('heading', { name: /bevor du scannst/i })).toBeTruthy()
    expect(screen.getByText(/verschlüsselt gespeichert/i)).toBeTruthy()
    expect(screen.getByText(/beauftragte handwerker/i)).toBeTruthy()
    expect(screen.getByText(/nur räume/i)).toBeTruthy()
    expect(screen.getByText(/jederzeit löschen/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /verstanden/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /abbrechen/i })).toBeTruthy()
  })

  it('accept CTA persists the consent flag AND fires onConsented', () => {
    const onConsented = vi.fn()
    const onCancel = vi.fn()
    render(
      <CaptureDsgvoConsentSheet open onConsented={onConsented} onCancel={onCancel} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /verstanden/i }))
    expect(localStorage.getItem(CUSTOMER_LIDAR_DSGVO_CONSENT_KEY)).toBe('1')
    expect(onConsented).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('cancel CTA fires onCancel WITHOUT persisting consent', () => {
    const onConsented = vi.fn()
    const onCancel = vi.fn()
    render(
      <CaptureDsgvoConsentSheet open onConsented={onConsented} onCancel={onCancel} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /abbrechen/i }))
    expect(localStorage.getItem(CUSTOMER_LIDAR_DSGVO_CONSENT_KEY)).toBeNull()
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConsented).not.toHaveBeenCalled()
  })
})
