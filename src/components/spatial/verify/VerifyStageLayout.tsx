/**
 * Spatial · Verify · Stage 3 — Layout (Phase 3 · Block 3.5)
 *
 * The Customer-Verify Stage-3 layout check (Mockup 15 · Phone 3). OPTIONAL —
 * the customer can skip straight through. V1 scope (Implementation-Spec
 * §Stage-3 + §6 #4):
 *   - DELETE a mis-detected wall (`DeleteNodeCommand`),
 *   - MOVE a door / window opening along its host wall (`MoveNodeCommand`),
 *   - ADD a door to a wall (`AddDoorCommand`).
 *
 * NOT in V1: adding a free-form WALL or MOVING a wall — walls are the immutable
 * room boundary (Phase-2 constraint engine: `move_node` on a wall is a hard
 * `WALL_IMMOVABLE` reject; there is no wall-add path). The Mockup-15 "+ Wand"
 * toolbar button is V1.x and is intentionally omitted here.
 *
 * ── Selection (binding · A11y + reliability) ────────────────────────────────
 * Two parallel selection affordances, exactly as Stage 2:
 *   1. the 3D preview with a `SurfaceTapLayer` raycast (tap a wall in 3D),
 *   2. a textual element list — the A11y text-duplicate (verify-flow-spec §7)
 *      and the reliable path under jsdom / reduced-motion. Openings are NOT
 *      tap-resolvable in 3D (they render as children of the wall group, so a
 *      raycast resolves to the host wall) — the list is the opening-select
 *      path.
 *
 * Pure presentation + local view-state. Every edit is delegated to the
 * `on*` callbacks (the VerifySheet wires them to `useVerifyFlow`); this
 * component constructs NO command and makes NO DB call. The edit outcomes
 * gate through the Phase-2 constraint validator inside `editHistoryStore`.
 */

import { useCallback, useMemo, useState, type ReactElement } from 'react'

import { CanonicalSceneRoot } from '../three/canonical/CanonicalSceneRoot'
import { SurfaceTapLayer } from '../three/canonical/SurfaceTapLayer'
import type { TappedSurface } from '../three/canonical/surfaceTap'
import type { RoomScene } from '../../../lib/spatial/canonical/types/scene-graph'
import type { WallOpening } from '../../../lib/spatial/canonical/types/geometry'
import type { NodeOverride, Variant, VariantId } from '../../../lib/spatial/canonical/types/variants'
import type { VerifyMeasureCorrectionOutcome } from './VerifyStageMeasure'

/** A wall row for the textual layout list. */
interface WallRow {
  id: string
  label: string
  lengthM: number
}

/** An opening row for the textual layout list. */
interface OpeningRow {
  id: string
  wallId: string
  wallLabel: string
  label: string
  type: WallOpening['type']
  /** Current offset of the opening's left edge along the host wall (m). */
  offsetM: number
  /** Host wall length (m) — the offset slider bound. */
  wallLengthM: number
  /** Opening width (m). */
  widthM: number
}

export interface VerifyStageLayoutProps {
  /** The resolved scene (with `customer_corrections` overrides applied). */
  scene: RoomScene
  /** Override stack — passed to the canonical renderer. */
  overrides: NodeOverride[]
  /** Variant chain — passed to the canonical renderer. */
  variants: Variant[]
  /** The variant the preview renders on (the writable customer layer). */
  activeVariantId: VariantId | null
  /** Whether there is a verify edit to undo (drives the Undo button). */
  canUndo: boolean
  /** Delete a mis-detected wall. */
  onDeleteWall: (wallId: string) => Promise<VerifyMeasureCorrectionOutcome>
  /** Re-position an opening along its host wall. */
  onMoveOpening: (
    openingId: string,
    newOffsetAlongWallM: number,
  ) => Promise<VerifyMeasureCorrectionOutcome>
  /** Insert a new door, centred at `offsetAlongWallM` on `wallId`. */
  onAddDoor: (wallId: string, offsetAlongWallM: number) => Promise<VerifyMeasureCorrectionOutcome>
  /** Undo the most recent verify edit. */
  onUndo: () => void
}

/** German label for a wall — its name, else a stable index label. */
function wallLabel(scene: RoomScene, wallId: string, index: number): string {
  const wall = scene.walls.find((w) => w.id === wallId)
  return wall?.name?.trim() || `Wand ${index + 1}`
}

/** German label for an opening kind. */
const OPENING_KIND_LABEL: Record<WallOpening['type'], string> = {
  door: 'Tür',
  window: 'Fenster',
  opening: 'Durchgang',
}

export function VerifyStageLayout({
  scene,
  overrides,
  variants,
  activeVariantId,
  canUndo,
  onDeleteWall,
  onMoveOpening,
  onAddDoor,
  onUndo,
}: VerifyStageLayoutProps): ReactElement {
  const wallRows = useMemo<WallRow[]>(
    () =>
      scene.walls.map((w, i) => ({
        id: w.id,
        label: wallLabel(scene, w.id, i),
        lengthM: w.length_m,
      })),
    [scene],
  )

  const openingRows = useMemo<OpeningRow[]>(() => {
    const rows: OpeningRow[] = []
    scene.walls.forEach((wall, i) => {
      const wLabel = wallLabel(scene, wall.id, i)
      for (const op of wall.openings) {
        rows.push({
          id: op.id,
          wallId: wall.id,
          wallLabel: wLabel,
          label: op.name?.trim() || `${OPENING_KIND_LABEL[op.type]} · ${wLabel}`,
          type: op.type,
          offsetM: op.offset_along_wall_m,
          wallLengthM: wall.length_m,
          widthM: op.width_m,
        })
      }
    })
    return rows
  }, [scene])

  // Selection — a `wall:` or `opening:` discriminated id, or null.
  const [selected, setSelected] = useState<
    | { kind: 'wall'; id: string }
    | { kind: 'opening'; id: string }
    | null
  >(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)
  // Long-press-style two-step confirm for a wall delete (Implementation-Spec
  // §Stage-3 — "Löschen via Long-press → Confirm"). The first tap arms; the
  // second within the armed window confirms. State, not a timer, so it is
  // deterministic under test.
  const [deleteArmedWallId, setDeleteArmedWallId] = useState<string | null>(null)
  // The opening-move draft offset, keyed to the selected opening.
  const [moveDraftM, setMoveDraftM] = useState<number>(0)

  const selectedOpening = useMemo(
    () =>
      selected?.kind === 'opening'
        ? openingRows.find((o) => o.id === selected.id) ?? null
        : null,
    [selected, openingRows],
  )

  const selectWall = useCallback((wallId: string) => {
    setSelected({ kind: 'wall', id: wallId })
    setDeleteArmedWallId(null)
    setFeedback(null)
  }, [])

  const selectOpening = useCallback(
    (row: OpeningRow) => {
      setSelected({ kind: 'opening', id: row.id })
      setMoveDraftM(row.offsetM)
      setDeleteArmedWallId(null)
      setFeedback(null)
    },
    [],
  )

  // 3D tap → select the tapped wall (openings are not 3D-tap-resolvable —
  // they render inside the wall group, so a raycast resolves to the host wall).
  const handleTap = useCallback(
    (tapped: TappedSurface) => {
      if (tapped.kind !== 'wall') return
      selectWall(tapped.nodeId)
    },
    [selectWall],
  )

  /** Run an edit callback, translating its outcome into inline feedback. */
  const runEdit = useCallback(
    async (action: () => Promise<VerifyMeasureCorrectionOutcome>): Promise<boolean> => {
      if (busy) return false
      setBusy(true)
      setFeedback(null)
      try {
        const outcome = await action()
        setFeedback({
          ok: outcome.ok,
          text: outcome.ok
            ? outcome.messages[0] ?? 'Übernommen.'
            : outcome.messages[0] ?? 'Nicht möglich.',
        })
        return outcome.ok
      } finally {
        setBusy(false)
      }
    },
    [busy],
  )

  const handleDeleteWall = useCallback(
    async (wallId: string) => {
      // Two-step confirm: arm on the first tap, delete on the second.
      if (deleteArmedWallId !== wallId) {
        setDeleteArmedWallId(wallId)
        setFeedback(null)
        return
      }
      setDeleteArmedWallId(null)
      const ok = await runEdit(() => onDeleteWall(wallId))
      if (ok) setSelected(null)
    },
    [deleteArmedWallId, runEdit, onDeleteWall],
  )

  const handleMoveOpening = useCallback(async () => {
    if (!selectedOpening) return
    await runEdit(() => onMoveOpening(selectedOpening.id, moveDraftM))
  }, [selectedOpening, moveDraftM, runEdit, onMoveOpening])

  const handleAddDoor = useCallback(
    async (wallId: string) => {
      const wall = wallRows.find((w) => w.id === wallId)
      if (!wall) return
      // Default insert position: the wall midpoint (the build helper centres a
      // 0.9 m door there and the validator re-checks the fit).
      const ok = await runEdit(() => onAddDoor(wallId, wall.lengthM / 2))
      if (ok) setSelected(null)
    },
    [wallRows, runEdit, onAddDoor],
  )

  return (
    <div data-testid="verify-stage-layout">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[22px] font-extrabold leading-tight tracking-[-0.01em] text-slate-900">
            Stimmt das Layout?
          </h2>
          <p className="mb-4 mt-1.5 text-[14px] leading-snug text-slate-500">
            Optional. Falsch erkannte Wand löschen, Tür/Fenster verschieben.
          </p>
        </div>
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          data-testid="verify-layout-undo"
          aria-label="Letzte Änderung rückgängig"
          className="mt-0.5 shrink-0 rounded-full bg-slate-900/[0.05] px-3 py-1.5 text-[12px] font-semibold text-slate-600 transition active:scale-95 disabled:opacity-35"
        >
          ↺ Rückgängig
        </button>
      </div>

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

      {/* Wall list — select + delete + add-door. */}
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[1px] text-slate-400">
        Wände
      </p>
      <ul className="mb-3 space-y-1.5" data-testid="verify-layout-wall-list">
        {wallRows.map((row) => {
          const isSelected = selected?.kind === 'wall' && selected.id === row.id
          const armed = deleteArmedWallId === row.id
          return (
            <li key={row.id} className="space-y-1.5">
              <button
                type="button"
                onClick={() => selectWall(row.id)}
                aria-pressed={isSelected}
                data-testid={`verify-layout-wall-row-${row.id}`}
                className={[
                  'flex w-full items-center justify-between rounded-[10px] px-3 py-2.5 text-left text-[13px] transition',
                  isSelected
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-900/[0.03] text-slate-900',
                ].join(' ')}
              >
                <span className="font-semibold">{row.label}</span>
                <span className={isSelected ? 'text-white/70' : 'text-slate-500'}>
                  {`${row.lengthM.toFixed(2).replace('.', ',')} m`}
                </span>
              </button>
              {isSelected && (
                <div className="flex gap-2 pl-1">
                  <button
                    type="button"
                    onClick={() => void handleAddDoor(row.id)}
                    disabled={busy}
                    data-testid={`verify-layout-add-door-${row.id}`}
                    className="flex-1 rounded-[10px] bg-slate-900/[0.06] px-3 py-2 text-[12px] font-bold text-slate-800 transition active:scale-[0.98] disabled:opacity-40"
                  >
                    + Tür
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteWall(row.id)}
                    disabled={busy}
                    data-testid={`verify-layout-delete-wall-${row.id}`}
                    className={[
                      'flex-1 rounded-[10px] px-3 py-2 text-[12px] font-bold transition active:scale-[0.98] disabled:opacity-40',
                      armed
                        ? 'bg-rose-600 text-white'
                        : 'bg-rose-500/10 text-rose-700',
                    ].join(' ')}
                  >
                    {armed ? 'Wirklich löschen?' : 'Wand löschen'}
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {/* Opening list — select + move. */}
      {openingRows.length > 0 && (
        <>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[1px] text-slate-400">
            Türen &amp; Fenster
          </p>
          <ul className="mb-3 space-y-1.5" data-testid="verify-layout-opening-list">
            {openingRows.map((row) => {
              const isSelected = selected?.kind === 'opening' && selected.id === row.id
              return (
                <li key={row.id} className="space-y-2">
                  <button
                    type="button"
                    onClick={() => selectOpening(row)}
                    aria-pressed={isSelected}
                    data-testid={`verify-layout-opening-row-${row.id}`}
                    className={[
                      'flex w-full items-center justify-between rounded-[10px] px-3 py-2.5 text-left text-[13px] transition',
                      isSelected
                        ? 'bg-slate-900 text-white'
                        : 'bg-slate-900/[0.03] text-slate-900',
                    ].join(' ')}
                  >
                    <span className="font-semibold">{row.label}</span>
                    <span className={isSelected ? 'text-white/70' : 'text-slate-500'}>
                      {`${row.offsetM.toFixed(2).replace('.', ',')} m`}
                    </span>
                  </button>
                  {isSelected && selectedOpening?.id === row.id && (
                    <div className="rounded-[12px] bg-slate-900/[0.04] p-3">
                      <label
                        htmlFor={`verify-opening-offset-${row.id}`}
                        className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[1px] text-slate-400"
                      >
                        Position an der Wand
                      </label>
                      <input
                        id={`verify-opening-offset-${row.id}`}
                        type="range"
                        min={0}
                        max={Math.max(0, row.wallLengthM - row.widthM)}
                        step={0.05}
                        value={moveDraftM}
                        onChange={(e) => setMoveDraftM(Number(e.target.value))}
                        data-testid={`verify-layout-opening-offset-${row.id}`}
                        className="w-full accent-orange-500"
                      />
                      <div className="mt-1 flex items-center justify-between">
                        <span className="text-[12px] font-bold text-slate-900">
                          {`${moveDraftM.toFixed(2).replace('.', ',')} m`}
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleMoveOpening()}
                          disabled={
                            busy ||
                            Math.abs(moveDraftM - row.offsetM) < 0.005
                          }
                          data-testid={`verify-layout-move-opening-${row.id}`}
                          className="rounded-[10px] bg-slate-900 px-3.5 py-2 text-[12px] font-bold text-white transition active:scale-[0.98] disabled:opacity-40"
                        >
                          Verschieben
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}

      {feedback && (
        <p
          role="status"
          data-testid="verify-layout-feedback"
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

      <p className="mt-3 text-center text-[12px] leading-snug text-slate-400">
        Alles richtig erkannt? Dann einfach weiter — dieser Schritt ist optional.
      </p>
    </div>
  )
}
