// @vitest-environment jsdom
/**
 * Spatial · V1.6.1 · ExampleRoomPicker contract
 *
 * Three tiles render, NEW-dot reflects unseen set, tap dispatches the kind.
 * Mirrors `CustomerCustomCanvasSheet.test.tsx` patterns (no router / no
 * supabase). The picker is layer-pure — the parent owns persistence.
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import ExampleRoomPicker from '../../../../src/components/spatial/customer/ExampleRoomPicker'
import type { ExampleRoomKind } from '../../../../src/lib/spatial/canonical/presets/exampleRooms'

describe('ExampleRoomPicker', () => {
  it('renders the three example rooms with German titles', () => {
    render(<ExampleRoomPicker onPick={() => {}} />)
    expect(screen.getByText(/Bad · 6 m²/i)).toBeTruthy()
    expect(screen.getByText(/Küche · 13 m²/i)).toBeTruthy()
    expect(screen.getByText(/Wohnen · 17 m²/i)).toBeTruthy()
  })

  it('marks the Bad-tile as Empfohlen (hero recommended badge)', () => {
    render(<ExampleRoomPicker onPick={() => {}} />)
    // Hero card carries the "Empfohlen" badge; sub-cards do not.
    expect(screen.getByText('Empfohlen')).toBeTruthy()
  })

  it('renders an outline-icon plate for every kind (no fake-3D preview)', () => {
    render(<ExampleRoomPicker onPick={() => {}} />)
    expect(screen.getByTestId('example-room-icon-bath')).toBeTruthy()
    expect(screen.getByTestId('example-room-icon-kitchen')).toBeTruthy()
    expect(screen.getByTestId('example-room-icon-living')).toBeTruthy()
  })

  it('shows a NEW dot only for unseen kinds and hides it once seen', () => {
    // First render: bath is unseen, kitchen + living seen.
    const { rerender } = render(
      <ExampleRoomPicker
        onPick={() => {}}
        unseenKinds={new Set<ExampleRoomKind>(['bath'])}
      />,
    )
    const dots = screen.getAllByTestId('example-room-new-dot')
    expect(dots.length).toBe(1)
    // Re-render with empty unseen set → no NEW dot anywhere.
    rerender(
      <ExampleRoomPicker onPick={() => {}} unseenKinds={new Set<ExampleRoomKind>()} />,
    )
    expect(screen.queryByTestId('example-room-new-dot')).toBeNull()
  })

  it('dispatches the picked kind on tile tap', () => {
    const onPick = vi.fn()
    render(<ExampleRoomPicker onPick={onPick} />)
    fireEvent.click(screen.getByTestId('example-room-tile-kitchen'))
    expect(onPick).toHaveBeenCalledWith('kitchen')
    fireEvent.click(screen.getByTestId('example-room-tile-living'))
    expect(onPick).toHaveBeenCalledWith('living')
    fireEvent.click(screen.getByTestId('example-room-tile-bath'))
    expect(onPick).toHaveBeenCalledWith('bath')
    expect(onPick).toHaveBeenCalledTimes(3)
  })
})
