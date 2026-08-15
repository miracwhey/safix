// @vitest-environment jsdom
/**
 * Spatial · DimensionMeasureBar tests
 *
 * Pins the live-carry data-integrity contract (TEIL E review fix #3): when the
 * selected wall's height/thickness is reshaped EXTERNALLY (neighbour mid-bar
 * slide, "Höhe für alle") between renders, a subsequent LENGTH edit must carry
 * the wall's LIVE height/thickness into onApply — never the once-seeded draft —
 * or the live change is silently reverted (data loss). Length already had this
 * guard since TEIL D; this also regression-guards that path.
 *
 * Also covers: seeding, direct-field edits win over the live carry, out-of-range
 * values are skipped (no onApply spam), the coarse slider applies a value, the
 * "Höhe für alle" toggle, and the close / split callbacks.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import { DimensionMeasureBar } from '../../../src/components/spatial/edit/DimensionMeasureBar'
import type { Wall } from '../../../src/lib/spatial/canonical/types/geometry'

afterEach(cleanup)

/** Minimal Wall — the bar only reads length/height/thickness + endpoints. */
function mkWall(over: Partial<Wall> = {}): Wall {
  return {
    id: 'w1',
    type: 'wall',
    start_point: { x: 0, y: 0, z: 0 },
    end_point: { x: 3, y: 0, z: 0 },
    height_m: 2.5,
    thickness_m: 0.15,
    length_m: 3,
    ...over,
  } as unknown as Wall
}

const lengthInput = () => screen.getByLabelText('Länge') as HTMLInputElement
const heightInput = () => screen.getByLabelText('Höhe') as HTMLInputElement
const thicknessInput = () => screen.getByLabelText('Dicke') as HTMLInputElement

describe('DimensionMeasureBar · seeding + rendering', () => {
  it('seeds the three rows from the wall', () => {
    render(<DimensionMeasureBar wall={mkWall()} onApply={vi.fn()} onClose={vi.fn()} />)
    expect(lengthInput().value).toBe('3.00')
    expect(heightInput().value).toBe('2.50')
    expect(thicknessInput().value).toBe('15.0')
  })

  it('does not call onApply on mount', () => {
    const onApply = vi.fn()
    render(<DimensionMeasureBar wall={mkWall()} onApply={onApply} onClose={vi.fn()} />)
    expect(onApply).not.toHaveBeenCalled()
  })
})

describe('DimensionMeasureBar · live-carry data integrity (TEIL E #3)', () => {
  it('carries the LIVE wall height into a length edit after an external height change', () => {
    const onApply = vi.fn()
    const { rerender } = render(
      <DimensionMeasureBar wall={mkWall({ height_m: 2.5 })} onApply={onApply} onClose={vi.fn()} />,
    )
    // External reshape (e.g. "Höhe für alle") raises THIS wall's height in the store.
    rerender(
      <DimensionMeasureBar wall={mkWall({ height_m: 3.0 })} onApply={onApply} onClose={vi.fn()} />,
    )
    // User edits length only — must NOT clobber the live 3.0 height back to the 2.5 seed.
    fireEvent.change(lengthInput(), { target: { value: '2.00' } })
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ lengthM: 2, heightM: 3.0 }),
    )
  })

  it('carries the LIVE wall thickness into a length edit after an external thickness change', () => {
    const onApply = vi.fn()
    const { rerender } = render(
      <DimensionMeasureBar wall={mkWall({ thickness_m: 0.15 })} onApply={onApply} onClose={vi.fn()} />,
    )
    rerender(
      <DimensionMeasureBar wall={mkWall({ thickness_m: 0.2 })} onApply={onApply} onClose={vi.fn()} />,
    )
    fireEvent.change(lengthInput(), { target: { value: '2.00' } })
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ lengthM: 2, thicknessM: 0.2 }),
    )
  })

  it('carries the LIVE wall length into a height edit after an external length change', () => {
    const onApply = vi.fn()
    const { rerender } = render(
      <DimensionMeasureBar wall={mkWall({ length_m: 3 })} onApply={onApply} onClose={vi.fn()} />,
    )
    // Neighbour mid-bar slide reshaped THIS wall's length in the store.
    rerender(
      <DimensionMeasureBar wall={mkWall({ length_m: 5 })} onApply={onApply} onClose={vi.fn()} />,
    )
    fireEvent.change(heightInput(), { target: { value: '2.80' } })
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ lengthM: 5, heightM: 2.8 }),
    )
  })
})

describe('DimensionMeasureBar · direct edits win + validation', () => {
  it('a direct height edit sends the typed value, not the carry', () => {
    const onApply = vi.fn()
    render(<DimensionMeasureBar wall={mkWall()} onApply={onApply} onClose={vi.fn()} />)
    fireEvent.change(heightInput(), { target: { value: '2.80' } })
    expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ heightM: 2.8 }))
  })

  it('skips onApply for an out-of-range value (no spam)', () => {
    const onApply = vi.fn()
    render(<DimensionMeasureBar wall={mkWall()} onApply={onApply} onClose={vi.fn()} />)
    // 1.0 m is below HEIGHT_MIN_M (1.8) → push must bail without calling onApply.
    fireEvent.change(heightInput(), { target: { value: '1.0' } })
    expect(onApply).not.toHaveBeenCalled()
  })
})

describe('DimensionMeasureBar · slider + toggles + callbacks', () => {
  it('the coarse slider applies a length value via the same onChange path', () => {
    const onApply = vi.fn()
    render(<DimensionMeasureBar wall={mkWall({ length_m: 3 })} onApply={onApply} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Länge grob einstellen'), { target: { value: '4.5' } })
    expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ lengthM: 4.5 }))
  })

  it('"Höhe für alle Wände" sets applyHeightToAllWalls', () => {
    const onApply = vi.fn()
    render(<DimensionMeasureBar wall={mkWall()} onApply={onApply} onClose={vi.fn()} />)
    // "Höhe für alle" lebt jetzt im Höhe-Tabpanel (Default-Tab = Länge) → erst dorthin wechseln.
    fireEvent.click(screen.getByRole('tab', { name: 'Höhe' }))
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ applyHeightToAllWalls: true }),
    )
  })

  it('fires onClose and onSplitWall', () => {
    const onClose = vi.fn()
    const onSplitWall = vi.fn()
    render(
      <DimensionMeasureBar
        wall={mkWall()}
        onApply={vi.fn()}
        onClose={onClose}
        onSplitWall={onSplitWall}
      />,
    )
    fireEvent.click(screen.getByLabelText('Maße schließen'))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('Ecke einfügen (Wand teilen)'))
    expect(onSplitWall).toHaveBeenCalledTimes(1)
  })
})
