/**
 * Spatial V1.6 · Phase 3 · CustomerCustomCanvasSheet
 *
 * Slide-up bottom sheet for the "Leerer Raum"-tile (Master-Plan §5, B4-D3).
 * Mounted by `CustomerSpatialHubScreen` as a sibling of `CustomerNewRoomSheet`
 * — the hub flips this sheet open when the user taps the third tile in the
 * NewRoomSheet picker. Both sheets cannot be open at once; the hub closes the
 * NewRoomSheet before opening this one.
 *
 * UX contract (TBD #2 / TBD P3-2 binding):
 *   - Three steppers Breite / Länge / Höhe initialised to 250 cm each.
 *   - Save-button stays `disabled` + `aria-disabled=true` until at least one
 *     axis differs from the 250 cm default — see {@link isCustomCanvasDirty}.
 *   - A helper-text "Passe min. einen Wert an, um zu starten" is always
 *     visible underneath the steppers, NOT a tooltip on the disabled button
 *     (iOS broken). The helper-text id is wired via `aria-describedby` for
 *     screen readers.
 *   - ±10 cm step on footprint axes, ±5 cm on height — same units as
 *     `CustomerNewRoomSheet` so the steppers feel consistent across sheets.
 *
 * Pipeline: Save → {@link createCustomerCustomCanvas} → toast + onCreated.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import BottomSheet from '../../ui/BottomSheet'
import { useToast } from '../../../hooks/useToast'
import {
  CUSTOM_CANVAS_DEFAULT_DIMS,
  isCustomCanvasDirty,
} from '../../../lib/spatial/canonical/presets/presetCustomerRooms'
import {
  createCustomerCustomCanvas,
  type CreateCustomerCustomCanvasResult,
} from '../../../lib/spatial/workflow/createCustomerCustomCanvas'
import type { CreateCustomerManualSceneSuccess } from '../../../lib/spatial/workflow/createCustomerManualScene'

const FOOTPRINT_STEP_CM = 10
const HEIGHT_STEP_CM = 5
const MIN_AXIS_CM = 100
const MAX_AXIS_CM = 1500
const MIN_HEIGHT_CM = 200
const MAX_HEIGHT_CM = 400

const HELPER_ID = 'custom-canvas-helper'

type Axis = 'width' | 'length' | 'height'

export interface CustomerCustomCanvasSheetProps {
  open: boolean
  onClose: () => void
  /** Fired after the workflow successfully lands a new scene. The hub uses
   *  this to navigate to `/customer/spatial/scan/:id`. */
  onCreated?: (result: CreateCustomerManualSceneSuccess) => void
}

export default function CustomerCustomCanvasSheet({
  open,
  onClose,
  onCreated,
}: CustomerCustomCanvasSheetProps) {
  const toast = useToast()
  const [widthCm, setWidthCm] = useState<number>(CUSTOM_CANVAS_DEFAULT_DIMS.widthCm)
  const [lengthCm, setLengthCm] = useState<number>(CUSTOM_CANVAS_DEFAULT_DIMS.lengthCm)
  const [heightCm, setHeightCm] = useState<number>(CUSTOM_CANVAS_DEFAULT_DIMS.heightCm)
  const [submitting, setSubmitting] = useState(false)

  // Reset the dirty state every time the sheet (re-)opens so a previous draft
  // does not bleed into the next session. Async microtask matches the
  // CustomerNewRoomSheet pattern (avoids react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!open) return
    let alive = true
    void Promise.resolve().then(() => {
      if (!alive) return
      setWidthCm(CUSTOM_CANVAS_DEFAULT_DIMS.widthCm)
      setLengthCm(CUSTOM_CANVAS_DEFAULT_DIMS.lengthCm)
      setHeightCm(CUSTOM_CANVAS_DEFAULT_DIMS.heightCm)
      setSubmitting(false)
    })
    return () => {
      alive = false
    }
  }, [open])

  const dirty = useMemo(
    () => isCustomCanvasDirty(widthCm, lengthCm, heightCm),
    [widthCm, lengthCm, heightCm],
  )

  const areaM2 = useMemo(
    () => Math.round((widthCm / 100) * (lengthCm / 100) * 10) / 10,
    [widthCm, lengthCm],
  )

  const stepDelta = useCallback((axis: Axis, sign: 1 | -1) => {
    if (axis === 'height') {
      setHeightCm((prev) => clamp(prev + sign * HEIGHT_STEP_CM, MIN_HEIGHT_CM, MAX_HEIGHT_CM))
      return
    }
    const setter = axis === 'width' ? setWidthCm : setLengthCm
    setter((prev) => clamp(prev + sign * FOOTPRINT_STEP_CM, MIN_AXIS_CM, MAX_AXIS_CM))
  }, [])

  const handleSubmit = useCallback(async () => {
    if (submitting || !dirty) return
    setSubmitting(true)
    let result: CreateCustomerCustomCanvasResult
    try {
      result = await createCustomerCustomCanvas({ widthCm, lengthCm, heightCm })
    } finally {
      setSubmitting(false)
    }
    if (result.ok) {
      toast.success('Raum angelegt ✓')
      onCreated?.(result)
      onClose()
    } else {
      toast.error(result.message || 'Raum konnte nicht angelegt werden.')
    }
  }, [submitting, dirty, widthCm, lengthCm, heightCm, toast, onCreated, onClose])

  return (
    <BottomSheet
      open={open}
      onClose={submitting ? () => undefined : onClose}
      maxWidth={460}
      className="!bg-slate-900/95 !text-white border border-white/10 backdrop-blur-2xl"
    >
      <div aria-labelledby="custom-canvas-title">
        <div className="flex items-start justify-between">
          <div>
            <h3 id="custom-canvas-title" className="text-base font-bold text-white">
              Leerer Raum
            </h3>
            <p className="mt-1 text-xs text-white/65">
              Starte mit eigenen Maßen. Du kannst alles später anpassen.
            </p>
          </div>
          <button
            type="button"
            onClick={submitting ? undefined : onClose}
            className="grid h-8 w-8 place-items-center rounded-full border border-white/10 bg-white/5 text-white/70 transition hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-sky-400/60 disabled:opacity-40"
            aria-label="Schließen"
            disabled={submitting}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="mt-4 space-y-2.5">
          <StepperCard
            label="Breite"
            unit="cm"
            value={widthCm}
            stepCm={FOOTPRINT_STEP_CM}
            min={MIN_AXIS_CM}
            max={MAX_AXIS_CM}
            onDelta={(sign) => stepDelta('width', sign)}
          />
          <StepperCard
            label="Länge"
            unit="cm"
            value={lengthCm}
            stepCm={FOOTPRINT_STEP_CM}
            min={MIN_AXIS_CM}
            max={MAX_AXIS_CM}
            onDelta={(sign) => stepDelta('length', sign)}
          />
          <StepperCard
            label="Höhe"
            unit="cm"
            value={heightCm}
            stepCm={HEIGHT_STEP_CM}
            min={MIN_HEIGHT_CM}
            max={MAX_HEIGHT_CM}
            onDelta={(sign) => stepDelta('height', sign)}
          />
        </div>

        <div className="mt-3 flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-2 text-[11px] text-white/65">
          <span>Geschätzte Fläche</span>
          <span className="font-semibold text-white/85">{areaM2.toFixed(1)} m²</span>
        </div>

        <p
          id={HELPER_ID}
          className={`mt-3 text-[12px] leading-relaxed transition-colors ${
            dirty ? 'text-white/45' : 'text-amber-300/85'
          }`}
        >
          Passe min. einen Wert an, um zu starten.
        </p>

        <div className="mt-4 flex flex-col gap-2.5">
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!dirty || submitting}
            aria-disabled={!dirty || submitting}
            aria-describedby={HELPER_ID}
            aria-busy={submitting}
            className="w-full rounded-2xl bg-gradient-to-br from-sky-500 to-blue-600 px-4 py-3.5 text-sm font-bold text-white shadow-lg shadow-sky-900/40 transition hover:from-sky-400 hover:to-blue-500 focus:outline-none focus:ring-2 focus:ring-sky-300/60 disabled:cursor-not-allowed disabled:from-slate-600 disabled:to-slate-700 disabled:text-white/55 disabled:shadow-none"
          >
            {submitting ? 'Wird angelegt…' : 'Raum anlegen'}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-white/80 transition hover:bg-white/[0.08] disabled:opacity-40"
          >
            Abbrechen
          </button>
        </div>
      </div>
    </BottomSheet>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Stepper card — inline +/- per axis (no active-axis switch needed because
// the sheet only has three steppers and the user is expected to touch all
// three).
// ────────────────────────────────────────────────────────────────────────────

function StepperCard({
  label,
  unit,
  value,
  stepCm,
  min,
  max,
  onDelta,
}: {
  label: string
  unit: string
  value: number
  stepCm: number
  min: number
  max: number
  onDelta: (sign: 1 | -1) => void
}) {
  const atMin = value - stepCm < min
  const atMax = value + stepCm > max
  return (
    <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wider text-white/55">
          {label}
        </div>
        <div className="mt-0.5 text-lg font-bold text-white tabular-nums">
          {value}
          <span className="ml-1 text-xs font-medium text-white/55">{unit}</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <StepperButton
          dir="minus"
          onClick={() => onDelta(-1)}
          disabled={atMin}
          ariaLabel={`${label} verkleinern um ${stepCm} ${unit}`}
        />
        <StepperButton
          dir="plus"
          onClick={() => onDelta(1)}
          disabled={atMax}
          ariaLabel={`${label} vergrößern um ${stepCm} ${unit}`}
        />
      </div>
    </div>
  )
}

function StepperButton({
  dir,
  onClick,
  disabled,
  ariaLabel,
}: {
  dir: 'plus' | 'minus'
  onClick: () => void
  disabled: boolean
  ariaLabel: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className="grid h-9 w-9 place-items-center rounded-full border border-white/15 bg-white/10 text-white transition hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-sky-400/60 disabled:cursor-not-allowed disabled:border-white/5 disabled:bg-white/5 disabled:text-white/30"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        {dir === 'plus' ? <path d="M12 5v14M5 12h14" /> : <path d="M5 12h14" />}
      </svg>
    </button>
  )
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max)
}
