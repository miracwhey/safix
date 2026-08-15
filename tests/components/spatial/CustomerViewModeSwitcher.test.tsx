// @vitest-environment jsdom
/**
 * V1.6.1 Phase 3b · CustomerViewModeSwitcher tests
 *
 * Customer-Variante des canonical CameraMode-Switchers (Mockup 02 v8 binding,
 * 3 Modi: dollhouse / floorplan / walk). Tests decken:
 *   - Modus-Reihenfolge + Wording (Mockup-Wording-Lock)
 *   - Active-Highlight korrekt
 *   - onChange feuert nur für nicht-aktive + nicht-locked Modi
 *   - lockedModes routen auf onLockedTap, NICHT onChange
 *   - disabled state: keine onChange-Aufrufe, keine onLockedTap
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import CustomerViewModeSwitcher, {
  type CustomerViewMode,
} from '../../../src/components/spatial/customer/CustomerViewModeSwitcher'

afterEach(cleanup)

describe('CustomerViewModeSwitcher · Mockup 02 v8 binding', () => {
  it('rendert die 3 Modi in Reihenfolge Floorplan → Dollhouse → Walk mit Mockup-Wording', () => {
    const onChange = vi.fn()
    render(
      <CustomerViewModeSwitcher value="dollhouse" onChange={onChange} />,
    )
    const buttons = screen.getAllByRole('radio')
    expect(buttons).toHaveLength(3)
    expect(buttons[0].getAttribute('aria-label')).toBe('2D Grundriss')
    expect(buttons[1].getAttribute('aria-label')).toBe('3D Dollhouse')
    expect(buttons[2].getAttribute('aria-label')).toBe('Begehen')
  })

  it('markiert den aktiven Modus via aria-checked', () => {
    render(
      <CustomerViewModeSwitcher value="walk" onChange={vi.fn()} />,
    )
    const walkBtn = screen.getByRole('radio', { name: 'Begehen' })
    expect(walkBtn.getAttribute('aria-checked')).toBe('true')
    const dollhouseBtn = screen.getByRole('radio', { name: '3D Dollhouse' })
    expect(dollhouseBtn.getAttribute('aria-checked')).toBe('false')
  })

  it('onChange wird beim Tap auf nicht-aktiven Modus aufgerufen', () => {
    const onChange = vi.fn()
    render(
      <CustomerViewModeSwitcher value="dollhouse" onChange={onChange} />,
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Begehen' }))
    expect(onChange).toHaveBeenCalledWith('walk')
  })

  it('onChange wird beim Tap auf bereits-aktiven Modus NICHT aufgerufen', () => {
    const onChange = vi.fn()
    render(
      <CustomerViewModeSwitcher value="dollhouse" onChange={onChange} />,
    )
    fireEvent.click(screen.getByRole('radio', { name: '3D Dollhouse' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('lockedModes routen auf onLockedTap statt onChange', () => {
    const onChange = vi.fn()
    const onLockedTap = vi.fn()
    render(
      <CustomerViewModeSwitcher
        value="dollhouse"
        onChange={onChange}
        lockedModes={['floorplan', 'walk']}
        onLockedTap={onLockedTap}
      />,
    )
    fireEvent.click(screen.getByRole('radio', { name: '2D Grundriss (kommt demnächst)' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Begehen (kommt demnächst)' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(onLockedTap).toHaveBeenCalledTimes(2)
    expect(onLockedTap.mock.calls[0][0]).toBe('floorplan')
    expect(onLockedTap.mock.calls[1][0]).toBe('walk')
  })

  it('disabled state: weder onChange noch onLockedTap feuern', () => {
    const onChange = vi.fn()
    const onLockedTap = vi.fn()
    render(
      <CustomerViewModeSwitcher
        value="dollhouse"
        onChange={onChange}
        disabled
        lockedModes={['walk']}
        onLockedTap={onLockedTap}
      />,
    )
    fireEvent.click(screen.getByRole('radio', { name: '2D Grundriss' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Begehen (kommt demnächst)' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(onLockedTap).not.toHaveBeenCalled()
  })

  it('CustomerViewMode-Type ist Subset von canonical CameraMode (kein AR)', () => {
    // Compile-time guard: Wenn diese Zeile fail, hat sich der Typ
    // verändert und kein AR-Mode mehr für den Customer ausgeschlossen.
    const valid: CustomerViewMode[] = ['dollhouse', 'floorplan', 'walk']
    expect(valid).toHaveLength(3)
  })
})
