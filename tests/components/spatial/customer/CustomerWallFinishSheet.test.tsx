// @vitest-environment jsdom
/**
 * Spatial V1.6.1 · S2 — CustomerWallFinishSheet polish (search + haptics).
 *
 * Covers the net-new S2 layers (the base one-tap grid was already shipped):
 *   - the dark search field filters the wall catalog (debounced) and shows the
 *     empty-state on a no-match query, then restores the full grid on clear;
 *   - applying a finish fires a selection haptic + the onSelect callback.
 *
 * jsdom + mocked supabase/haptics per the spatial component-test convention.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

const selectionMock = vi.fn()
vi.mock('../../../../src/hooks/useHaptics', () => ({
  useHaptics: () => ({
    trigger: vi.fn(),
    selection: selectionMock,
    light: vi.fn(),
    medium: vi.fn(),
    heavy: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    isAvailable: false,
  }),
}))
vi.mock('../../../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}))

import CustomerWallFinishSheet from '../../../../src/components/spatial/customer/CustomerWallFinishSheet'

describe('CustomerWallFinishSheet · S2 polish', () => {
  beforeEach(() => {
    cleanup()
    selectionMock.mockClear()
  })

  const baseProps = {
    open: true,
    onSelect: vi.fn(),
    onReset: vi.fn(),
    onClose: vi.fn(),
  }

  it('renders the wall finish grid when open', () => {
    render(<CustomerWallFinishSheet {...baseProps} onSelect={vi.fn()} />)
    expect(screen.getAllByLabelText(/anwenden$/).length).toBeGreaterThan(0)
  })

  it('renders nothing when closed', () => {
    const { container } = render(
      <CustomerWallFinishSheet {...baseProps} open={false} onSelect={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('filters to the empty-state on a no-match query, then restores on clear', async () => {
    render(<CustomerWallFinishSheet {...baseProps} onSelect={vi.fn()} />)
    const input = screen.getByLabelText('In Wand-Materialien suchen')

    fireEvent.change(input, { target: { value: 'zzzznomatchqq' } })
    await waitFor(() =>
      expect(screen.queryByText('Keine Materialien gefunden')).not.toBeNull(),
    )
    expect(screen.queryAllByLabelText(/anwenden$/)).toHaveLength(0)

    // Clear button restores the full grid.
    fireEvent.click(screen.getByLabelText('Suche löschen'))
    await waitFor(() =>
      expect(screen.queryByText('Keine Materialien gefunden')).toBeNull(),
    )
    expect(screen.getAllByLabelText(/anwenden$/).length).toBeGreaterThan(0)
  })

  it('fires a selection haptic + onSelect with the material slug on apply', () => {
    const onSelect = vi.fn()
    render(<CustomerWallFinishSheet {...baseProps} onSelect={onSelect} />)
    const tiles = screen.getAllByLabelText(/anwenden$/)
    fireEvent.click(tiles[0])
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(typeof onSelect.mock.calls[0][0]).toBe('string')
    expect(selectionMock).toHaveBeenCalled()
  })
})
