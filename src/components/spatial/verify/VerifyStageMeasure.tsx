/**
 * Spatial · Verify · Stage 2 — Maße checken (Phase 3 · Block 3.3)
 *
 * The Customer-Verify Stage-2 measurement check (Mockup 15 · Phone 2). The
 * customer selects a wall, sees its length × height, and corrects the height
 * via the {@link MeasureNumericPicker}. A correction goes through the workflow
 * → `ResizeWallCommand` → `editHistoryStore.apply()` (Block 3.3 + 3.4).
 *
 * ── Wall selection (binding · A11y) ─────────────────────────────────────────
 * Two parallel selection affordances are mounted at once:
 *   1. the 3D preview with a `SurfaceTapLayer` raycast (tap a wall in 3D),
 *   2. a textual wall list — the A11y text-duplicate (verify-flow-spec §7:
 *      "Maß-Werte als Text-Duplikat"), and also the reliable selection path
 *      under jsdom / reduced-motion.
 * Both feed the SAME `selectedWallId` state, so the picker is identical
 * regardless of how the wall was chosen.
 *
 * Pure presentation + local view-state — the correction itself is delegated
 * to `onCorrect` (the VerifySheet wires it to `useVerifyFlow.correctWallHeight`).
 * No DB call, no command construction here.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'

import { CanonicalSceneRoot } from '../three/canonical/CanonicalSceneRoot'
import { SurfaceTapLayer } from '../three/canonical/SurfaceTapLayer'
import type { TappedSurface } from '../three/canonical/surfaceTap'
import { MeasureNumericPicker } from './MeasureNumericPicker'
import type { RoomScene } from '../../../lib/spatial/canonical/types/scene-graph'
import type { NodeOverride, Variant, VariantId } from '../../../lib/spatial/canonical/types/variants'
import {
  readWallMeasurement,
  validateMeasurement,
} from '../../../lib/spatial/workflow/spatialVerifyWorkflow'

/** Outcome of a correction — surfaced to the caller for toast handling. */
export interface VerifyMeasureCorrectionOutcome {
  ok: boolean
  /** German hint when `ok` is false, or soft-warn copy when `ok` is true. */
  messages: string[]
}

export interface VerifyStageMeasureProps {
  /** The resolved scene (with `customer_corrections` overrides applied). */
  scene: RoomScene
  /** Override stack — passed to the canonical renderer. */
  overrides: NodeOverride[]
  /** Variant chain — passed to the canonical renderer. */
  variants: Variant[]
  /** The variant the preview renders on (the writable customer layer). */
  activeVariantId: VariantId | null
  /**
   * Apply a wall-height correction. Returns the branchable outcome so this
   * component can show the inline soft-warn / reject feedback. Wired by the
   * VerifySheet to `useVerifyFlow.correctWallHeight`.
   */
  onCorrect: (wallId: string, newHeightM: number) => Promise<VerifyMeasureCorrectionOutcome>
}

/** A wall row for the textual selection list. */
interface WallRow {
  id: string
  label: string
  lengthM: number
  heightM: number
}

/** German label for a wall — its name, else a stable index label. */
function wallLabel(scene: RoomScene, wallId: string, index: number): string {
  const wall = scene.walls.find((w) => w.id === wallId)
  return wall?.name?.trim() || `Wand ${index + 1}`
}

export function VerifyStageMeasure({
  scene,
  overrides,
  variants,
  activeVariantId,
  onCorrect,
}: VerifyStageMeasureProps): ReactElement {
  const wallRows = useMemo<WallRow[]>(
    () =>
      scene.walls.map((w, i) => ({
        id: w.id,
        label: wallLabel(scene, w.id, i),
        lengthM: w.length_m,
        heightM: w.height_m,
      })),
    [scene],
  )

  const [selectedWallId, setSelectedWallId] = useState<string | null>(
    () => wallRows[0]?.id ?? null,
  )
  // The picker's working height. Re-seeded whenever the selection changes so a
  // wall switch shows that wall's current height, not the previous draft.
  const [draftHeightM, setDraftHeightM] = useState<number>(
    () => wallRows[0]?.heightM ?? 0,
  )
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)

  // Re-seed the draft when the resolved scene mutates (e.g. after a successful
  // correction the wall's height changed) or when the selected wall changes.
  const selectedMeasurement = useMemo(
    () => (selectedWallId ? readWallMeasurement(scene, selectedWallId) : null),
    [scene, selectedWallId],
  )
  useEffect(() => {
    if (selectedMeasurement) setDraftHeightM(selectedMeasurement.heightM)
  }, [selectedMeasurement])

  const selectWall = useCallback((wallId: string) => {
    setSelectedWallId(wallId)
    setFeedback(null)
  }, [])

  // 3D tap → select the tapped wall (ignore non-wall surfaces in Stage 2).
  const handleTap = useCallback(
    (tapped: TappedSurface) => {
      if (tapped.kind !== 'wall') return
      selectWall(tapped.nodeId)
    },
    [selectWall],
  )

  const validation = useMemo(
    () => validateMeasurement(draftHeightM),
    [draftHeightM],
  )

  const isUnchanged =
    selectedMeasurement != null &&
    Math.abs(selectedMeasurement.heightM - draftHeightM) < 0.005

  const handleConfirm = useCallback(async () => {
    if (!selectedWallId || !validation.ok || busy) return
    setBusy(true)
    setFeedback(null)
    try {
      const outcome = await onCorrect(selectedWallId, draftHeightM)
      setFeedback({
        ok: outcome.ok,
        text: outcome.ok
          ? outcome.messages[0] ?? 'Maß übernommen.'
          : outcome.messages[0] ?? 'Korrektur nicht möglich.',
      })
    } finally {
      setBusy(false)
    }
  }, [selectedWallId, validation.ok, busy, onCorrect, draftHeightM])

  return (
    <div data-testid="verify-stage-measure">
      <h2 className="text-[22px] font-extrabold leading-tight tracking-[-0.01em] text-slate-900">
        Stimmen die Maße?
      </h2>
      <p className="mb-4 mt-1.5 text-[14px] leading-snug text-slate-500">
        Tipp auf eine Wand. Korrigiere die Höhe, wenn nötig.
      </p>

      <div className="mb-3 overflow-hidden rounded-[18px] bg-slate-900 shadow-[0_8px_24px_rgba(10,15,28,0.15)]">
        <CanonicalSceneRoot
          scene={scene}
          overrides={overrides}
          variants={variants}
          activeVariantId={activeVariantId}
          className="aspect-[4/3] w-full"
        >
          <SurfaceTapLayer enabled onTap={handleTap} />
        </CanonicalSceneRoot>
      </div>

      {/* Textual wall list — A11y text-duplicate + the reliable select path. */}
      <ul className="mb-3 space-y-1.5" data-testid="verify-wall-list">
        {wallRows.map((row) => {
          const selected = row.id === selectedWallId
          return (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => selectWall(row.id)}
                aria-pressed={selected}
                data-testid={`verify-wall-row-${row.id}`}
                className={[
                  'flex w-full items-center justify-between rounded-[10px] px-3 py-2.5 text-left text-[13px] transition',
                  selected
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-900/[0.03] text-slate-900',
                ].join(' ')}
              >
                <span className="font-semibold">{row.label}</span>
                <span
                  className={selected ? 'text-white/70' : 'text-slate-500'}
                >
                  {`${row.lengthM.toFixed(2).replace('.', ',')} m × ${row.heightM
                    .toFixed(2)
                    .replace('.', ',')} m`}
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      {selectedMeasurement ? (
        <>
          <MeasureNumericPicker
            label="Höhe der Wand"
            valueM={draftHeightM}
            originalM={selectedMeasurement.heightM}
            onChange={setDraftHeightM}
            validationHint={validation.ok ? null : validation.hint}
          />

          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={!validation.ok || isUnchanged || busy}
            data-testid="verify-measure-confirm"
            className="mt-3 w-full rounded-2xl bg-slate-900 px-4 py-3.5 text-[15px] font-bold text-white shadow-[0_6px_16px_rgba(10,15,28,0.3)] transition active:scale-[0.99] disabled:opacity-40"
          >
            {busy ? 'Wird übernommen …' : 'Maß bestätigen'}
          </button>
          {isUnchanged && validation.ok && (
            <p className="mt-1.5 text-center text-[11px] text-slate-400">
              Der Wert entspricht dem Scan — keine Korrektur nötig.
            </p>
          )}
        </>
      ) : (
        <p className="rounded-xl bg-slate-900/[0.03] px-3 py-4 text-center text-[13px] text-slate-500">
          Keine Wand auswählbar.
        </p>
      )}

      {feedback && (
        <p
          role="status"
          data-testid="verify-measure-feedback"
          className={[
            'mt-2 rounded-lg px-3 py-2 text-center text-[12px] font-medium',
            feedback.ok
              ? 'bg-teal-700/10 text-teal-800'
              : 'bg-rose-500/10 text-rose-800',
          ].join(' ')}
        >
          {feedback.text}
        </p>
      )}
    </div>
  )
}
