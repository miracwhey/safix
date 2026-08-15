/**
 * Spatial Core · Block E3 (D12) · Section-Cut Slider
 *
 * UI surface for slicing the 3D scene with a clipping plane: axis switch
 * (X/Y/Z), height slider, flip-toggle. State lives here, the slice itself
 * is applied inside `<Scene>` via `Material.clippingPlanes` (three.js
 * built-in — no extra dependency).
 *
 * Defaults: Z-axis (height), height = 1.2m, not flipped. The slider's
 * range is the bounding box height in meters; the controller doesn't know
 * the scene extents until the parent has the scan ready, so the parent
 * passes `maxHeight` for the slider extent.
 *
 * Snap-to-likely-wall-heights: the slider sticks softly at 0.5m / 1.0m /
 * 1.5m / 2.0m / 2.5m. Each snap fires a `useHaptics.selection()` so the
 * craftsman feels the wall boundary without looking at the value. Snap
 * state is held in a `useRef` so re-firing during a continuous drag does
 * not trigger a component re-render — only the haptic engine sees it.
 */

import { useEffect, useMemo, useRef } from 'react'
import { useHaptics } from '../../hooks/useHaptics'
import type { SectionAxis, SectionCutState } from './sectionCutTypes'

export type { SectionAxis, SectionCutState } from './sectionCutTypes'
export { DEFAULT_SECTION_CUT_STATE } from './sectionCutTypes'

export interface SectionCutControllerProps {
  value: SectionCutState
  onChange: (next: SectionCutState) => void
  /** Max value for the slider, in meters. Falls back to 3m if the parent
   *  has not yet measured the scan bounds. */
  maxHeight?: number
  className?: string
}

const AXIS_LABELS: Record<SectionAxis, string> = {
  x: 'X (Wand)',
  y: 'Y (Tiefe)',
  z: 'Z (Höhe)',
}

const SNAP_CANDIDATES = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0]
const SNAP_TOLERANCE_M = 0.05

export function SectionCutController(props: SectionCutControllerProps) {
  const haptics = useHaptics()
  const lastSnappedRef = useRef<number | null>(null)
  const maxHeight = props.maxHeight ?? 3

  // Pure derivation — `null` when no candidate is within tolerance.
  const snapTarget = useMemo<number | null>(() => {
    if (!props.value.enabled) return null
    const candidates = SNAP_CANDIDATES.filter(c => c <= maxHeight)
    return candidates.reduce<number | null>((acc, c) => {
      const d = Math.abs(c - props.value.height)
      if (
        d < SNAP_TOLERANCE_M &&
        (acc == null || d < Math.abs(acc - props.value.height))
      ) {
        return c
      }
      return acc
    }, null)
  }, [props.value.enabled, props.value.height, maxHeight])

  // Side-effect only — no setState, no cascading render. The ref change
  // is invisible to React's render pipeline.
  useEffect(() => {
    if (snapTarget != null && snapTarget !== lastSnappedRef.current) {
      haptics.selection()
      lastSnappedRef.current = snapTarget
    } else if (snapTarget == null) {
      lastSnappedRef.current = null
    }
  }, [snapTarget, haptics])

  if (!props.value.enabled) {
    return (
      <div className={'p-3 ' + (props.className ?? '')}>
        <button
          type="button"
          onClick={() => props.onChange({ ...props.value, enabled: true })}
          className="text-xs font-medium text-emerald-700 hover:text-emerald-900"
        >
          Schnitt einblenden
        </button>
      </div>
    )
  }

  return (
    <div
      className={
        'flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-3 ' +
        (props.className ?? '')
      }
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-neutral-700">Schnitt</span>
        <button
          type="button"
          onClick={() => props.onChange({ ...props.value, enabled: false })}
          className="text-[11px] text-neutral-500 hover:text-neutral-900"
        >
          ausblenden
        </button>
      </div>

      <div className="flex items-center gap-2">
        {(['x', 'y', 'z'] as SectionAxis[]).map(axis => (
          <button
            key={axis}
            type="button"
            onClick={() => props.onChange({ ...props.value, axis })}
            className={
              'flex-1 rounded px-2 py-1 text-xs font-medium transition ' +
              (props.value.axis === axis
                ? 'bg-emerald-100 text-emerald-700'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200')
            }
            aria-pressed={props.value.axis === axis}
          >
            {AXIS_LABELS[axis]}
          </button>
        ))}
      </div>

      <label className="block text-[11px] text-neutral-500">
        Höhe: {props.value.height.toFixed(2)} m
      </label>
      <input
        type="range"
        min={0}
        max={maxHeight}
        step={0.01}
        value={props.value.height}
        onChange={e =>
          props.onChange({ ...props.value, height: Number(e.target.value) })
        }
        aria-label="Schnitt-Höhe"
      />

      <label className="flex items-center gap-2 text-xs text-neutral-600">
        <input
          type="checkbox"
          checked={props.value.flipped}
          onChange={e => props.onChange({ ...props.value, flipped: e.target.checked })}
        />
        Andere Seite zeigen
      </label>
    </div>
  )
}
