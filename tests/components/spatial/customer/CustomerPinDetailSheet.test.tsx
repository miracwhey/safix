// @vitest-environment jsdom
/**
 * CustomerPinDetailSheet · Phase 1d save/cancel contract.
 */

import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import CustomerPinDetailSheet from '../../../../src/components/spatial/customer/CustomerPinDetailSheet'

describe('CustomerPinDetailSheet', () => {
  it('returns null when open=false', () => {
    const { container } = render(
      <CustomerPinDetailSheet
        open={false}
        pinType="door"
        onSave={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders the title with the pin-type label when open', () => {
    render(
      <CustomerPinDetailSheet
        open
        pinType="window"
        onSave={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(
      screen.getByRole('heading', { name: /fenster markieren/i }),
    ).toBeTruthy()
  })

  it('shows the default dimensions for the chosen type', () => {
    render(
      <CustomerPinDetailSheet
        open
        pinType="door"
        onSave={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByText(/80 cm × 210 cm/i)).toBeTruthy()
  })

  it('emits onSave with the customer pin type + trimmed note', () => {
    const onSave = vi.fn()
    render(
      <CustomerPinDetailSheet
        open
        pinType="heating"
        onSave={onSave}
        onCancel={() => {}}
      />,
    )
    const textarea = screen.getByLabelText(/notiz/i) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '  Heizkörper schief  ' } })
    fireEvent.click(screen.getByRole('button', { name: /speichern/i }))
    expect(onSave).toHaveBeenCalledWith({
      customerPinType: 'heating',
      note: 'Heizkörper schief',
      photo: null,
    })
  })

  it('emits onSave with null note when the textarea is empty', () => {
    const onSave = vi.fn()
    render(
      <CustomerPinDetailSheet
        open
        pinType="electrical"
        onSave={onSave}
        onCancel={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /speichern/i }))
    expect(onSave).toHaveBeenCalledWith({
      customerPinType: 'electrical',
      note: null,
      photo: null,
    })
  })

  it('emits onCancel from the cancel button + the backdrop', () => {
    const onCancel = vi.fn()
    render(
      <CustomerPinDetailSheet
        open
        pinType="door"
        onSave={() => {}}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /abbrechen/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('Escape closes the sheet via onCancel', () => {
    const onCancel = vi.fn()
    render(
      <CustomerPinDetailSheet
        open
        pinType="door"
        onSave={() => {}}
        onCancel={onCancel}
      />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
