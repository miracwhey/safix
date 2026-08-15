// @vitest-environment jsdom
/**
 * CustomerReScanCta · Phase 3 floating-pill visibility + confirm-flow tests.
 *
 * The CTA must:
 *   - stay hidden for HW-shared scans (ownerType='craftsman')
 *   - stay hidden when lidarAvailable is null (probe pending) or false
 *   - render and open the confirm sheet on tap when ownerType='customer'
 *   - call onConfirm after the user accepts the confirm sheet
 */

import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import CustomerReScanCta from '../../../../src/components/spatial/customer/CustomerReScanCta'

describe('CustomerReScanCta', () => {
  it('renders nothing for craftsman-owned scans', () => {
    const { container } = render(
      <CustomerReScanCta
        ownerType="craftsman"
        lidarAvailable
        onConfirm={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing while the LiDAR probe is still pending (null)', () => {
    const { container } = render(
      <CustomerReScanCta
        ownerType="customer"
        lidarAvailable={null}
        onConfirm={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing on non-LiDAR devices (false)', () => {
    const { container } = render(
      <CustomerReScanCta
        ownerType="customer"
        lidarAvailable={false}
        onConfirm={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders the pill for customer-owned scan on LiDAR device', () => {
    render(
      <CustomerReScanCta
        ownerType="customer"
        lidarAvailable
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByTestId('customer-rescan-cta')).toBeTruthy()
    expect(screen.getByRole('button', { name: /erneut scannen/i })).toBeTruthy()
  })

  it('tap opens the confirm sheet, confirm fires onConfirm exactly once', () => {
    const onConfirm = vi.fn()
    render(
      <CustomerReScanCta
        ownerType="customer"
        lidarAvailable
        onConfirm={onConfirm}
      />,
    )
    fireEvent.click(screen.getByTestId('customer-rescan-cta'))
    // Confirm sheet now mounted — its primary CTA reads "Neuen Scan starten"
    const confirmBtn = screen.getByRole('button', { name: /neuen scan starten/i })
    fireEvent.click(confirmBtn)
    expect(onConfirm).toHaveBeenCalledOnce()
  })
})
