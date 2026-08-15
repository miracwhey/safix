// @vitest-environment jsdom
/**
 * Render tests for LightingSwitcher (Mockup 43) — the Quick-Pill → Sheet
 * expand, tap-to-apply, the multi-tap guard, and the Standard reset.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import { LightingSwitcher } from '../../../../src/components/spatial/lighting/LightingSwitcher.tsx'

function setup(overrides: Partial<Parameters<typeof LightingSwitcher>[0]> = {}) {
  const onApply = vi.fn()
  const onResetDefault = vi.fn()
  const utils = render(
    <LightingSwitcher
      presetId="modern-bath"
      onApply={onApply}
      onResetDefault={onResetDefault}
      {...overrides}
    />,
  )
  return { onApply, onResetDefault, ...utils }
}

afterEach(cleanup)

describe('LightingSwitcher', () => {
  it('renders the Quick-Pill with the active preset', () => {
    setup()
    expect(screen.getByRole('button', { name: /Lichtquelle wechseln · aktuell Modern Bath/ })).toBeTruthy()
  })

  it('expands to the sheet with all 8 preset rows on pill tap', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /Lichtquelle wechseln/ }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getAllByRole('radio')).toHaveLength(8)
  })

  it('tap-to-apply: tapping a preset row applies it and closes the sheet', () => {
    const { onApply } = setup()
    fireEvent.click(screen.getByRole('button', { name: /Lichtquelle wechseln/ }))
    fireEvent.click(screen.getByRole('radio', { name: /Goldene Stunde/ }))
    expect(onApply).toHaveBeenCalledWith('golden-hour')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('multi-tap guard: two fast row taps apply only once', () => {
    const { onApply } = setup()
    fireEvent.click(screen.getByRole('button', { name: /Lichtquelle wechseln/ }))
    const dusk = screen.getByRole('radio', { name: /Abenddämmerung/ })
    const studio = screen.getByRole('radio', { name: /Studio Weiß/ })
    fireEvent.click(dusk)
    fireEvent.click(studio)
    expect(onApply).toHaveBeenCalledTimes(1)
  })

  it('tapping the already-active row is a no-op', () => {
    const { onApply } = setup()
    fireEvent.click(screen.getByRole('button', { name: /Lichtquelle wechseln/ }))
    fireEvent.click(screen.getByRole('radio', { name: /Modern Bath · .* · aktiv/ }))
    expect(onApply).not.toHaveBeenCalled()
  })

  it('Standard restores the default preset and closes the sheet', () => {
    const { onResetDefault } = setup()
    fireEvent.click(screen.getByRole('button', { name: /Lichtquelle wechseln/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Standard' }))
    expect(onResetDefault).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Escape closes the sheet without applying', () => {
    const { onApply } = setup()
    fireEvent.click(screen.getByRole('button', { name: /Lichtquelle wechseln/ }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onApply).not.toHaveBeenCalled()
  })

  it('the Phase-2 default-save button is disabled', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /Lichtquelle wechseln/ }))
    const lockBtn = screen.getByRole('button', { name: /Als Standard für diesen Raum speichern/ })
    expect((lockBtn as HTMLButtonElement).disabled).toBe(true)
  })
})
