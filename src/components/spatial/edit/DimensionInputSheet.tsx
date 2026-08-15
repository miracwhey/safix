/**
 * Spatial · Lane 2.5 · Stream B · DimensionInputSheet
 *
 * Bottom-sheet for adjusting one wall on a craftsman's manual room — the
 * precise counterpart to dragging a corner in the 2D Grundriss. Three
 * complementary inputs feed the SAME footprint-first data:
 *   - drag a corner = coarse,
 *   - type the exact measured value = exact (a pro with a laser/tape),
 *   - tap +/− = fine.
 *
 * Editable fields:
 *   - **length_m** — wall length. The craftsman BUILDS the room, so length is
 *     editable here (unlike the customer's read-only length): the host applies
 *     it via the footprint-first `setEdgeLength` orchestrator, which moves the
 *     shared end corner and re-derives floor/ceiling. Step ±1 cm.
 *   - **height_m** — wall height (or, via the toggle, the whole room's). Step ±1 cm.
 *   - **thickness_m** — wall thickness. Step ±0,5 cm.
 *
 * Visuals mirror the customer's {@link CustomerWallEditSheet}: dark-glass panel,
 * +/− steppers flanking an exact number field (no slider — imprecise for a
 * measurement), light selection haptics on each step. This sheet is HW-only at
 * render time (only {@link SpatialMultiModeViewer} mounts it); the customer flow
 * is untouched.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, RulerDimensionLine, X } from 'lucide-react'

import { useFocusTrap } from '../../../lib/spatial/hooks/useFocusTrap'
import type { Wall } from '../../../lib/spatial/canonical/types/geometry'
import { FieldRow } from './WallMeasureFieldRow'
import {
  SHEET_GLASS,
  clamp,
  distance,
  LENGTH_MIN_M,
  LENGTH_MAX_M,
  HEIGHT_MIN_M,
  HEIGHT_MAX_M,
  THICKNESS_MIN_CM,
  THICKNESS_MAX_CM,
} from './dimensionFieldConfig'

const APPLY_GLASS: React.CSSProperties = {
  background: 'linear-gradient(135deg, #2563EB 0%, #1d4ed8 100%)',
  boxShadow:
    '0 8px 18px rgba(37,99,235,0.42), inset 0 1px 0 rgba(255,255,255,0.22)',
}

export interface DimensionInputSheetValues {
  /** Wall length in metres (footprint-first: moves the shared end corner). */
  lengthM: number
  /** Wall height in metres. */
  heightM: number
  /** Wall thickness in metres. */
  thicknessM: number
  /** When true, apply the height to every wall. */
  applyHeightToAllWalls: boolean
}

export interface DimensionInputSheetProps {
  /** The currently selected wall. The sheet seeds its draft from this. */
  wall: Wall
  /**
   * Apply handler. Implementation routes length → `setEdgeLength`, height →
   * `setWallDims`/`setAllWallsHeight`, thickness → `setWallDims`, then commits.
   * The sheet stays open until the parent closes it (so an error toast can
   * surface without losing the draft state).
   */
  onApply: (values: DimensionInputSheetValues) => Promise<void> | void
  onClose: () => void
}

export function DimensionInputSheet({
  wall,
  onApply,
  onClose,
}: DimensionInputSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, true)

  const lengthInputId = useId()
  const heightInputId = useId()
  const thicknessInputId = useId()
  const applyAllId = useId()

  const initialLength = clamp(
    wall.length_m ?? distance(wall.start_point, wall.end_point),
    LENGTH_MIN_M,
    LENGTH_MAX_M,
  )
  const initialHeight = clamp(wall.height_m, HEIGHT_MIN_M, HEIGHT_MAX_M)
  const initialThicknessCm = clamp(
    Math.round((wall.thickness_m ?? 0.15) * 100),
    THICKNESS_MIN_CM,
    THICKNESS_MAX_CM,
  )

  const [lengthM, setLengthM] = useState(initialLength)
  const [heightM, setHeightM] = useState(initialHeight)
  const [thicknessCm, setThicknessCm] = useState(initialThicknessCm)
  const [applyHeightToAllWalls, setApplyHeightToAllWalls] = useState(false)
  const [busy, setBusy] = useState(false)

  // Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const handleLengthChange = useCallback((raw: string) => {
    const parsed = parseFloat(raw.replace(',', '.'))
    if (Number.isNaN(parsed)) return
    setLengthM(parsed)
  }, [])

  const handleHeightChange = useCallback((raw: string) => {
    const parsed = parseFloat(raw.replace(',', '.'))
    if (Number.isNaN(parsed)) return
    setHeightM(parsed)
  }, [])

  const handleThicknessChange = useCallback((raw: string) => {
    const parsed = parseFloat(raw.replace(',', '.'))
    if (Number.isNaN(parsed)) return
    setThicknessCm(parsed)
  }, [])

  const dirty = useMemo(() => {
    const lengthChanged = Math.abs(lengthM - initialLength) > 1e-4
    const heightChanged = Math.abs(heightM - initialHeight) > 1e-4
    const thicknessChanged = Math.abs(thicknessCm - initialThicknessCm) > 1e-4
    return lengthChanged || heightChanged || thicknessChanged || applyHeightToAllWalls
  }, [
    lengthM,
    heightM,
    thicknessCm,
    initialLength,
    initialHeight,
    initialThicknessCm,
    applyHeightToAllWalls,
  ])

  const lengthValid =
    lengthM >= LENGTH_MIN_M && lengthM <= LENGTH_MAX_M && Number.isFinite(lengthM)
  const heightValid =
    heightM >= HEIGHT_MIN_M && heightM <= HEIGHT_MAX_M && Number.isFinite(heightM)
  const thicknessValid =
    thicknessCm >= THICKNESS_MIN_CM &&
    thicknessCm <= THICKNESS_MAX_CM &&
    Number.isFinite(thicknessCm)

  const canApply = dirty && lengthValid && heightValid && thicknessValid && !busy

  const handleApply = useCallback(async () => {
    if (!canApply) return
    setBusy(true)
    try {
      await onApply({
        lengthM,
        heightM,
        thicknessM: thicknessCm / 100,
        applyHeightToAllWalls,
      })
    } finally {
      setBusy(false)
    }
  }, [canApply, lengthM, heightM, thicknessCm, applyHeightToAllWalls, onApply])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)' }}
      onClick={() => {
        if (!busy) onClose()
      }}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dimension-input-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-[460px] flex-col rounded-t-[30px] px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-2.5 text-white outline-none"
        style={SHEET_GLASS}
      >
        <div
          aria-hidden="true"
          className="mx-auto mb-2 h-1 w-10 rounded-full bg-white/24"
        />

        <div className="flex items-start justify-between">
          <div>
            <h2
              id="dimension-input-title"
              className="text-[19px] font-bold text-white"
            >
              Wand-Maße
            </h2>
            <p className="mt-0.5 text-[12.5px] text-white/60">
              Maß tippen oder mit +/− anpassen
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            disabled={busy}
            className="-mr-1 -mt-0.5 shrink-0 rounded-full p-1.5 text-white/60 hover:bg-white/10 hover:text-white active:scale-90 disabled:opacity-50"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="mt-4 space-y-4">
          <FieldRow
            id={lengthInputId}
            label="Länge"
            unitLabel="m"
            value={lengthM}
            min={LENGTH_MIN_M}
            max={LENGTH_MAX_M}
            step={0.01}
            decimals={2}
            valid={lengthValid}
            onChange={handleLengthChange}
          />
          <FieldRow
            id={heightInputId}
            label="Höhe"
            unitLabel="m"
            value={heightM}
            min={HEIGHT_MIN_M}
            max={HEIGHT_MAX_M}
            step={0.01}
            decimals={2}
            valid={heightValid}
            onChange={handleHeightChange}
          />
          <FieldRow
            id={thicknessInputId}
            label="Dicke"
            unitLabel="cm"
            value={thicknessCm}
            min={THICKNESS_MIN_CM}
            max={THICKNESS_MAX_CM}
            step={0.5}
            decimals={1}
            valid={thicknessValid}
            onChange={handleThicknessChange}
          />

          <label
            htmlFor={applyAllId}
            className="flex cursor-pointer items-start gap-2.5 rounded-[14px] bg-white/[0.06] p-3 ring-1 ring-white/14"
          >
            <input
              id={applyAllId}
              type="checkbox"
              checked={applyHeightToAllWalls}
              onChange={(e) => setApplyHeightToAllWalls(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-blue-500"
            />
            <div className="text-[12.5px] leading-snug text-white/75">
              <span className="font-semibold text-white">
                Höhe für alle Wände
              </span>
              <span className="ml-1 text-white/55">
                — Raumhöhe ändern, nicht nur diese Wand.
              </span>
            </div>
          </label>
        </div>

        <div className="mt-4 flex items-center gap-2.5 border-t border-white/10 pt-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-[13px] border border-white/16 bg-white/[0.04] px-3 py-3 text-[13px] font-semibold text-white/85 active:scale-[0.98] disabled:opacity-50"
          >
            Abbrechen
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={!canApply}
            className="flex flex-1 items-center justify-center gap-2 rounded-[13px] py-3 text-[14px] font-bold text-white active:scale-[0.98] disabled:opacity-50"
            style={APPLY_GLASS}
          >
            {busy ? (
              <>
                <RulerDimensionLine className="size-4 animate-pulse" />
                Übernehme …
              </>
            ) : (
              <>
                <Check className="size-4" />
                Übernehmen
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

// FieldRow + the stepping/clamp/distance helpers + SHEET_GLASS + field ranges
// moved to ./WallMeasureFieldRow + ./dimensionFieldConfig so the non-modal
// DimensionMeasureBar can reuse them without a react-refresh mixed-export error.
