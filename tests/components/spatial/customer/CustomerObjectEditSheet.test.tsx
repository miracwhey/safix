// @vitest-environment jsdom
/**
 * Spatial · CustomerObjectEditSheet · F7 tabbed-sheet (H-SheetTabs)
 *
 * The object edit sheet was too tall when it showed 4 sliders (Position ·
 * Breite · Höhe · Über Boden) — it covered the floorplan. 4-field kinds now
 * split into two tabs (Position | Größe), 3-field doors stay a flat stack.
 *
 * Pins: door = flat 3 sliders, no tablist; window/heating/electrical/fusebox =
 * a 2-tab segmented control with the inactive panel MOUNTED-but-hidden; the
 * roving tabindex (active 0, others -1; Arrow/Home/End move); and the
 * cross-field width→position clamp still firing when the triggering slider
 * lives in the other tab (both panels mounted).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import CustomerObjectEditSheet, {
  type CustomerObjectEditSheetProps,
  type CustomerObjectEditSheetValue,
  type CustomerObjectToolKind,
} from '../../../../src/components/spatial/customer/CustomerObjectEditSheet'

afterEach(cleanup)

const baseValue: CustomerObjectEditSheetValue = {
  positionAlongWallM: 1.2,
  widthM: 0.6,
  heightM: 1.25,
  offsetFromFloorM: 0.9,
}

function renderSheet(
  toolKind: CustomerObjectToolKind,
  over: Partial<CustomerObjectEditSheetProps> = {},
) {
  return render(
    <CustomerObjectEditSheet
      open
      toolKind={toolKind}
      value={baseValue}
      onChange={vi.fn()}
      onDelete={vi.fn()}
      onClose={vi.fn()}
      {...over}
    />,
  )
}

describe('CustomerObjectEditSheet · door (3 fields, flat)', () => {
  it('renders a flat stack of 3 sliders and no tablist', () => {
    renderSheet('door')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getAllByRole('slider')).toHaveLength(3)
  })
})

describe.each<CustomerObjectToolKind>(['window', 'heating', 'electrical', 'fusebox'])(
  'CustomerObjectEditSheet · %s (4 fields, tabbed)',
  (toolKind) => {
    it('splits into a 2-tab segmented control (Position · Größe)', () => {
      renderSheet(toolKind)
      expect(screen.queryByRole('tablist')).not.toBeNull()
      const tabs = screen.getAllByRole('tab')
      expect(tabs.map((t) => t.textContent)).toEqual(['Position', 'Größe'])
    })

    it('shows the active panel’s 2 sliders, the other 2 mounted-but-hidden', () => {
      renderSheet(toolKind)
      // Default tab = 'place' → 2 visible sliders, all 4 mounted.
      expect(screen.getAllByRole('slider')).toHaveLength(2)
      expect(screen.getAllByRole('slider', { hidden: true })).toHaveLength(4)
    })

    it('roving tabindex: active 0, others -1; Arrow/Home/End move the active tab', () => {
      renderSheet(toolKind)
      let tabs = screen.getAllByRole('tab')
      expect(tabs[0].tabIndex).toBe(0)
      expect(tabs[1].tabIndex).toBe(-1)

      fireEvent.keyDown(tabs[0], { key: 'ArrowRight' })
      tabs = screen.getAllByRole('tab')
      expect(tabs[1].tabIndex).toBe(0)
      expect(tabs[0].tabIndex).toBe(-1)
      // 'size' panel now exposes its 2 sliders (Breite · Höhe).
      expect(screen.getAllByRole('slider')).toHaveLength(2)

      fireEvent.keyDown(screen.getAllByRole('tab')[1], { key: 'Home' })
      expect(screen.getAllByRole('tab')[0].tabIndex).toBe(0)

      fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'End' })
      expect(screen.getAllByRole('tab')[1].tabIndex).toBe(0)
    })
  },
)

describe('CustomerObjectEditSheet · cross-field clamp across tabs', () => {
  it('width→position clamp fires even though Breite lives in the other tab', () => {
    const onChange = vi.fn()
    // Breite (Größe-Tab) widens past what the 1.5 m wall allows → the
    // Position field (Position-Tab) must clamp. It only works because BOTH
    // panels stay mounted across the tab switch.
    renderSheet('window', { wallLengthM: 1.5, wallHeightM: 2.5, onChange })
    fireEvent.click(screen.getByRole('tab', { name: 'Größe' }))
    const sliders = screen.getAllByRole('slider') // visible 'size' panel: [Breite, Höhe]
    fireEvent.change(sliders[0], { target: { value: '200' } })
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ widthM: 2, positionAlongWallM: 1 }),
    )
  })
})
