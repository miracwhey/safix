// @vitest-environment jsdom
/**
 * Render tests for the Block-3.3 `MeasureNumericPicker`.
 *
 * Covers: 1 cm stepper increments, the hard MIN/MAX clamp, the original-value
 * hint, and that the validation hint is surfaced when supplied.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

// `spatialVerifyWorkflow` transitively imports the session module which
// constructs the real Supabase client — mock it so jsdom does not crash on
// the auth auto-refresh tick.
vi.mock('../../../src/lib/supabase', () => ({
  supabase: { auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) } },
}))

import { MeasureNumericPicker } from '../../../src/components/spatial/verify/MeasureNumericPicker'
import {
  VERIFY_MEASURE_MAX_M,
  VERIFY_MEASURE_MIN_M,
} from '../../../src/lib/spatial/workflow/spatialVerifyWorkflow'

afterEach(cleanup)

describe('MeasureNumericPicker', () => {
  it('renders the value with a German comma + the original hint', () => {
    render(
      <MeasureNumericPicker
        label="Höhe der Wand"
        valueM={3.4}
        originalM={3.2}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId('measure-picker-value').textContent).toContain('3,40')
    expect(screen.getByText(/3,20m/)).toBeTruthy()
  })

  it('the + stepper raises the value by exactly 1 cm', () => {
    const onChange = vi.fn()
    render(
      <MeasureNumericPicker
        label="Höhe"
        valueM={2.5}
        originalM={2.5}
        onChange={onChange}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Wert erhöhen' }))
    expect(onChange).toHaveBeenCalledWith(2.51)
  })

  it('the − stepper lowers the value by exactly 1 cm', () => {
    const onChange = vi.fn()
    render(
      <MeasureNumericPicker label="Höhe" valueM={2.5} originalM={2.5} onChange={onChange} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Wert verringern' }))
    expect(onChange).toHaveBeenCalledWith(2.49)
  })

  it('clamps to the hard MIN bound — the − stepper is disabled at MIN', () => {
    render(
      <MeasureNumericPicker
        label="Höhe"
        valueM={VERIFY_MEASURE_MIN_M}
        originalM={2.5}
        onChange={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'Wert verringern' }).hasAttribute('disabled'),
    ).toBe(true)
  })

  it('clamps to the hard MAX bound — the + stepper is disabled at MAX', () => {
    render(
      <MeasureNumericPicker
        label="Höhe"
        valueM={VERIFY_MEASURE_MAX_M}
        originalM={2.5}
        onChange={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'Wert erhöhen' }).hasAttribute('disabled'),
    ).toBe(true)
  })

  it('surfaces a validation hint when one is supplied', () => {
    render(
      <MeasureNumericPicker
        label="Höhe"
        valueM={2.5}
        originalM={2.5}
        onChange={vi.fn()}
        validationHint="Das ist zu klein."
      />,
    )
    expect(screen.getByTestId('measure-validation-hint').textContent).toBe(
      'Das ist zu klein.',
    )
  })
})
