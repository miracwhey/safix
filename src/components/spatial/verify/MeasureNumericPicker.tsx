/**
 * Spatial · Verify · MeasureNumericPicker (Phase 3 · Block 3.3)
 *
 * The Stage-2 numeric picker for a wall-height correction (Mockup 15 · Phone 2
 * `numeric-picker`). A −/+ stepper (1 cm increments · Implementation-Spec
 * §2.1) over a large value display, plus the original-value hint.
 *
 * Controlled component — the parent owns the value. The picker enforces ONLY
 * the 1 cm grid + clamps to the hard `[VERIFY_MEASURE_MIN_M, MAX]` bounds; the
 * branchable {@link validateMeasurement} verdict (with the German hint) is
 * derived by the parent and passed back in as `validationHint` so the picker
 * stays presentation-only. A failing validation disables nothing here — the
 * parent's confirm CTA is what gates apply.
 */

import type { ReactElement } from 'react'

import {
  VERIFY_MEASURE_MAX_M,
  VERIFY_MEASURE_MIN_M,
} from '../../../lib/spatial/workflow/spatialVerifyWorkflow'

/** 1 cm step (Implementation-Spec §2.1 · "Stepper +/- 1cm"). */
const STEP_M = 0.01

export interface MeasureNumericPickerProps {
  /** German label of the measured dimension (e.g. "Höhe der Wand"). */
  label: string
  /** Current value in meters. */
  valueM: number
  /** The original (scan-measured) value in meters — shown as the hint. */
  originalM: number
  /** Called with the next value (already clamped + grid-snapped). */
  onChange: (nextM: number) => void
  /** A German validation hint to surface below the picker, or `null` when ok. */
  validationHint?: string | null
}

/** Round to the 1 cm grid + clamp to the hard bounds. */
function snap(valueM: number): number {
  const snapped = Math.round(valueM / STEP_M) * STEP_M
  const clamped = Math.min(VERIFY_MEASURE_MAX_M, Math.max(VERIFY_MEASURE_MIN_M, snapped))
  // Kill float dust from the divide/multiply so `3.4` does not become `3.4000001`.
  return Math.round(clamped * 100) / 100
}

/** German 2-decimal display with a comma separator (e.g. "3,40"). */
function formatM(valueM: number): string {
  return valueM.toFixed(2).replace('.', ',')
}

export function MeasureNumericPicker({
  label,
  valueM,
  originalM,
  onChange,
  validationHint = null,
}: MeasureNumericPickerProps): ReactElement {
  const dec = (): void => onChange(snap(valueM - STEP_M))
  const inc = (): void => onChange(snap(valueM + STEP_M))

  return (
    <div
      className="mt-2 rounded-2xl bg-slate-900 p-4 text-white"
      data-testid="measure-numeric-picker"
    >
      <div className="mb-2.5 text-[10px] uppercase tracking-[1px] text-white/50">
        {label}
      </div>
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={dec}
          disabled={valueM <= VERIFY_MEASURE_MIN_M}
          aria-label="Wert verringern"
          className="grid size-11 place-items-center rounded-full bg-white/10 text-[22px] font-bold text-white transition active:scale-90 disabled:opacity-30"
        >
          −
        </button>
        <div
          className="text-[32px] font-extrabold tracking-[-0.02em] text-white"
          data-testid="measure-picker-value"
          aria-live="polite"
        >
          {formatM(valueM)}
          <span className="ml-0.5 text-[14px] text-white/50">m</span>
        </div>
        <button
          type="button"
          onClick={inc}
          disabled={valueM >= VERIFY_MEASURE_MAX_M}
          aria-label="Wert erhöhen"
          className="grid size-11 place-items-center rounded-full bg-white/10 text-[22px] font-bold text-white transition active:scale-90 disabled:opacity-30"
        >
          +
        </button>
      </div>
      <p className="mt-2.5 text-center text-[11px] text-white/50">
        {'Ursprünglich gemessen: '}
        <span className="font-bold text-orange-200">{formatM(originalM)}m</span>
      </p>
      {validationHint && (
        <p
          role="alert"
          data-testid="measure-validation-hint"
          className="mt-2 rounded-lg bg-rose-500/15 px-3 py-1.5 text-center text-[11px] font-medium text-rose-200"
        >
          {validationHint}
        </p>
      )}
    </div>
  )
}
