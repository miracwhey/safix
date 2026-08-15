/**
 * Spatial · WallMeasureFieldRow
 *
 * The shared `[−] [number] [+]` stepper row used by both {@link DimensionInputSheet}
 * (modal) and {@link DimensionMeasureBar} (non-modal). Exact-tap + fine-step on
 * the SAME footprint-first data; light selection haptic on each step. Stepping
 * snaps from the DISPLAYED (rounded) value first so a tap always moves the
 * visible number by exactly one step even after finer typed precision.
 */
import { useCallback } from 'react'

import { useHaptics } from '../../../hooks/useHaptics'
import { stepped } from './dimensionFieldConfig'

export interface FieldRowProps {
  id: string
  label: string
  unitLabel: string
  value: number
  min: number
  max: number
  step: number
  decimals: number
  valid: boolean
  onChange: (raw: string) => void
}

export function FieldRow({
  id,
  label,
  unitLabel,
  value,
  min,
  max,
  step,
  decimals,
  valid,
  onChange,
}: FieldRowProps) {
  const haptics = useHaptics()

  const atMin = Number.isFinite(value) && value <= min
  const atMax = Number.isFinite(value) && value >= max

  const stepBy = useCallback(
    (delta: number) => {
      const display = Number.isFinite(value) ? Number(value.toFixed(decimals)) : min
      onChange(stepped(display, delta, min, max, decimals))
      haptics.selection()
    },
    [value, min, max, decimals, onChange, haptics],
  )

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label
          htmlFor={id}
          className="text-[12px] font-bold uppercase tracking-[0.6px] text-white/75"
        >
          {label}
        </label>
        <span className="text-[11px] text-white/55">
          {min.toFixed(decimals)} – {max.toFixed(decimals)} {unitLabel}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => stepBy(-step)}
          disabled={atMin}
          aria-label={`${label} verringern`}
          className="h-11 w-11 shrink-0 rounded-xl border border-white/14 bg-white/[0.06] text-[18px] font-bold text-white transition active:scale-95 disabled:opacity-40"
        >
          −
        </button>
        <div
          className={[
            'flex flex-1 items-center gap-2 rounded-[14px] bg-white/[0.04] px-3 py-2.5 ring-1',
            valid ? 'ring-white/14' : 'ring-rose-400/60',
          ].join(' ')}
        >
          <input
            id={id}
            type="number"
            inputMode="decimal"
            step={step}
            min={min}
            max={max}
            value={Number.isFinite(value) ? value.toFixed(decimals) : ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full flex-1 bg-transparent text-[20px] font-semibold tabular-nums text-white outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <span className="text-[14px] font-semibold text-white/55">{unitLabel}</span>
        </div>
        <button
          type="button"
          onClick={() => stepBy(step)}
          disabled={atMax}
          aria-label={`${label} erhöhen`}
          className="h-11 w-11 shrink-0 rounded-xl border border-white/14 bg-white/[0.06] text-[18px] font-bold text-white transition active:scale-95 disabled:opacity-40"
        >
          +
        </button>
      </div>
    </div>
  )
}
