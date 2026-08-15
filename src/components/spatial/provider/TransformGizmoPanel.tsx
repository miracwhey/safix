/**
 * TransformGizmoPanel — CD-5 · Panel-based move/resize/snap gizmo (Phase B · B-4)
 *
 * A floating control panel that issues the canonical command classes
 * (MoveNodeCommand / ResizeWallCommand / SnapObjectCommand) when an element is
 * selected in the 3D viewer.
 *
 * ## Architecture
 * Full 3D drag-handle hit-testing (pointer-event → world-ray → node selection)
 * is out of reach in Phase B: it requires the three.js r3f event bridge wired
 * through `SurfaceTapLayer` + scene-graph node lookup, which is the Phase-C
 * CD-3 interactive-gizmo block.  This panel therefore exposes:
 *
 *   - **Nudge buttons** (Move mode): ±X / ±Z in 5 cm / 20 cm steps.
 *   - **Resize inputs** (Resize mode): height_m / thickness_m number fields for
 *     the selected wall, with live ResizeWallCommand dispatch.
 *   - **Snap toggle + host selector** (Snap mode): snap the selected object onto
 *     a surface using `resolveCounterSnap` (or floor/wall equivalents), then
 *     issue a SnapObjectCommand.
 *
 * ## Phase-C seam
 * The `selectedNode` prop carries the node id + minimal geometry — in Phase C
 * this will be populated by `SurfaceTapLayer.onTap` from the live 3D canvas.
 * Currently the consumer (JobSpatial3DTab) exposes a "Objekt auswählen" entry
 * and passes a minimal stub for demonstration.  All commands dispatch through
 * `editHistoryStore.apply()` exactly as they will in Phase C — the seam is
 * purely at the selection source.
 *
 * Props are intentionally minimal: the panel is self-contained beyond the
 * selected node descriptor and the writable variant id from the permission hook.
 */

import { useCallback, useState } from 'react'
import { Move, Minimize2, Layers } from 'lucide-react'

import { useEditHistoryStore } from '../../../lib/spatial/canonical/store/editHistoryStore'
import { MoveNodeCommand } from '../../../lib/spatial/canonical/commands/MoveNodeCommand'
import { ResizeWallCommand } from '../../../lib/spatial/canonical/commands/ResizeWallCommand'
import { SnapObjectCommand, snapResultToTransform } from '../../../lib/spatial/canonical/commands/SnapObjectCommand'
import { resolveCounterSnap } from '../../../lib/spatial/canonical/snap/asset-snap'
import type { VariantId } from '../../../lib/spatial/canonical/types/variants'
import type { ObjectHost } from '../../../lib/spatial/canonical/types/objects'
import { useHaptics } from '../../../hooks/useHaptics'
import { useToast } from '../../../hooks/useToast'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type GizmoMode = 'move' | 'resize' | 'snap'

export type GizmoNodeKind = 'object' | 'wall'

export interface GizmoSelectedNode {
  /** Scene-graph base node id. */
  nodeId: string
  /** Human label (e.g. "Waschtisch · Wand Nord"). */
  label: string
  /** Node type — drives which modes are available. */
  kind: GizmoNodeKind
  /**
   * Current transform position in meters (required for nudge computation).
   * Phase-C seam: in Phase C this comes from the resolved scene-graph node.
   * The caller must supply it from their own scene data or leave it at the
   * zero-vector default.
   */
  positionM?: { x: number; y: number; z: number }
  /**
   * Current rotation quaternion.  When present, nudge commands preserve it
   * instead of defaulting to identity.
   * Phase-C seam: resolved from the live scene-graph node transform.
   */
  rotation?: { x: number; y: number; z: number; w: number }
  /**
   * Current wall dimensions (meters) — only relevant when kind='wall'.
   * Phase-C seam: resolved from the scene-graph wall node.
   */
  wallDimensions?: { heightM: number; thicknessM: number }
  /**
   * Counter-top height in meters — used for counter-snap resolve.
   * Phase-C seam: resolved from the parent counter object's dimensions.
   */
  counterTopHeightM?: number
  /**
   * Measured dimensions in meters — the scan reference handed to the
   * Maß-editor (wall: `length_m` / `height_m`; object: `dimensions`).
   * Optional: the editor renders a per-field scan reference only when set.
   */
  measuredWidthM?: number
  measuredHeightM?: number
}

export interface TransformGizmoPanelProps {
  /** The scene-graph node currently targeted by the gizmo.  Pass null to hide. */
  selectedNode: GizmoSelectedNode | null
  /** Role-correct writable variant id from `useSpatialProviderRole`. */
  writableVariantId: VariantId | null
  /** Positioning classes (e.g. "absolute bottom-32 right-3"). */
  className?: string
  /** Explicit deselect — closes the panel (the "✕" header button · C-3). */
  onClose?: () => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level tab-icon glyphs
// ─────────────────────────────────────────────────────────────────────────────

function ModeTab({
  mode,
  active,
  label,
  icon,
  onClick,
}: {
  mode: GizmoMode
  active: boolean
  label: string
  icon: React.ReactNode
  onClick: (m: GizmoMode) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(mode)}
      aria-pressed={active}
      aria-label={label}
      className={[
        'flex flex-col items-center gap-0.5 rounded-[10px] px-3 py-2 text-[10px] font-[650] transition',
        active
          ? 'bg-brand text-white'
          : 'text-ink-sub hover:bg-canvas',
      ].join(' ')}
    >
      {icon}
      {label}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Nudge step constants (meters)
// ─────────────────────────────────────────────────────────────────────────────

const NUDGE_SMALL_M = 0.05  // 5 cm
const NUDGE_LARGE_M = 0.20  // 20 cm

// Phase-C: floor, wall, and ceiling snap resolvers are not yet implemented.
// Only resolveCounterSnap exists in asset-snap.ts; the picker therefore exposes
// only the counter host.  Remaining hosts are listed as disabled until Phase C.
const SNAP_HOSTS: { key: ObjectHost; label: string; disabled?: boolean }[] = [
  { key: 'counter', label: 'Arbeitsplatte' },
  { key: 'floor', label: 'Boden (Phase-C)', disabled: true },
  { key: 'wall', label: 'Wand (Phase-C)', disabled: true },
  { key: 'ceiling', label: 'Decke (Phase-C)', disabled: true },
]

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function TransformGizmoPanel({
  selectedNode,
  writableVariantId,
  className,
  onClose,
}: TransformGizmoPanelProps) {
  const haptics = useHaptics()
  const toast = useToast()
  const apply = useEditHistoryStore((s) => s.apply)
  const undo = useEditHistoryStore((s) => s.undo)
  const canUndo = useEditHistoryStore((s) => s.canUndo)

  /**
   * Dispatch a command and surface its {@link ApplyResult} — a hard reject
   * (constraint / RBAC) raises an error toast and nothing is written; an
   * applied edit confirms with a toast, carrying the first soft-warning when
   * the validator flagged one. Phase-B discarded this result entirely.
   */
  const applyWithFeedback = useCallback(
    (cmd: Parameters<typeof apply>[0], successMessage: string) => {
      const result = apply(cmd)
      if (!result.applied) {
        toast.error(result.hint ?? result.error.message)
        return
      }
      if (result.warnings.length > 0) {
        toast.info(
          `${successMessage} · Hinweis: ${result.warnings[0]?.message ?? 'bitte prüfen'}`,
        )
      } else {
        toast.info(successMessage)
      }
    },
    [apply, toast],
  )

  const [mode, setMode] = useState<GizmoMode>('move')
  // Default to counter — the only host with a snap resolver in Phase B.
  const [snapHost, setSnapHost] = useState<ObjectHost>('counter')

  // Resize field state — initialised from the selected wall on mount.
  const [heightInput, setHeightInput] = useState(
    () => selectedNode?.wallDimensions?.heightM?.toFixed(2) ?? '2.50',
  )
  const [thicknessInput, setThicknessInput] = useState(
    () => selectedNode?.wallDimensions?.thicknessM?.toFixed(3) ?? '0.200',
  )

  const handleModeChange = useCallback((m: GizmoMode) => {
    haptics.selection()
    setMode(m)
  }, [haptics])

  // ── Move nudge ───────────────────────────────────────────────────────────

  const handleNudge = useCallback(
    (axis: 'x' | 'z', delta: number) => {
      if (!selectedNode || !writableVariantId) return
      haptics.medium()

      const pos = selectedNode.positionM ?? { x: 0, y: 0, z: 0 }
      const newPos = {
        ...pos,
        [axis]: pos[axis] + delta,
      }
      // Preserve existing rotation if supplied; fall back to identity only when absent.
      const rotation = selectedNode.rotation ?? { x: 0, y: 0, z: 0, w: 1 }
      const IDENTITY_S = { x: 1, y: 1, z: 1 }

      const cmd = new MoveNodeCommand({
        nodeId: selectedNode.nodeId,
        newTransform: {
          position: newPos,
          rotation,
          scale: IDENTITY_S,
        },
        variantId: writableVariantId,
        label: `${selectedNode.label} verschoben (${axis.toUpperCase()} ${delta > 0 ? '+' : ''}${Math.round(delta * 100)} cm)`,
      })
      applyWithFeedback(
        cmd,
        `Verschoben · ${axis.toUpperCase()} ${delta > 0 ? '+' : ''}${Math.round(delta * 100)} cm`,
      )
    },
    [selectedNode, writableVariantId, haptics, applyWithFeedback],
  )

  // ── Resize wall ──────────────────────────────────────────────────────────

  const handleResize = useCallback(() => {
    if (!selectedNode || !writableVariantId || selectedNode.kind !== 'wall') return
    haptics.success()

    const newHeightM = parseFloat(heightInput)
    const newThicknessM = parseFloat(thicknessInput)
    if (!Number.isFinite(newHeightM) || newHeightM <= 0) return
    if (!Number.isFinite(newThicknessM) || newThicknessM <= 0) return

    const cmd = new ResizeWallCommand({
      wallId: selectedNode.nodeId,
      newHeightM,
      newThicknessM,
      variantId: writableVariantId,
      label: `${selectedNode.label} angepasst`,
      // Phase-C seam: wall with openings/wall_mounted not supplied here —
      // child re-anchoring (F11) requires the resolved scene-graph Wall object,
      // available in Phase C from useCanonicalSceneStore.
    })
    applyWithFeedback(cmd, 'Wandmaß übernommen')
  }, [selectedNode, writableVariantId, heightInput, thicknessInput, haptics, applyWithFeedback])

  // ── Snap object ──────────────────────────────────────────────────────────

  const handleSnap = useCallback(() => {
    if (!selectedNode || !writableVariantId || selectedNode.kind !== 'object') return
    haptics.success()

    const pos = selectedNode.positionM ?? { x: 0, y: 0, z: 0 }
    const footprint = { x: pos.x, z: pos.z }
    const counterTopM = selectedNode.counterTopHeightM ?? 0.85

    // Use resolveCounterSnap as the canonical snap resolver.  For floor/wall
    // snaps the resolver would be resolveFloorSnap / resolveWallSnap; counter
    // is the primary Phase-B target (Mockup spec §8).
    const snapResult = resolveCounterSnap({
      footprint,
      counterTopHeightM: counterTopM,
    })

    const cmd = new SnapObjectCommand({
      objectId: selectedNode.nodeId,
      newHost: snapHost,
      newHostId: `${snapHost}_surface`,
      snap: snapResultToTransform(snapResult),
      variantId: writableVariantId,
      label: `${selectedNode.label} einrasten (${snapHost})`,
    })
    applyWithFeedback(cmd, 'Objekt eingerastet')
  }, [selectedNode, writableVariantId, snapHost, haptics, applyWithFeedback])

  // ─────────────────────────────────────────────────────────────────────────

  if (!selectedNode) return null

  const isWall = selectedNode.kind === 'wall'
  const hasVariant = writableVariantId !== null

  return (
    <div
      className={[
        'flex w-[220px] flex-col gap-2 rounded-[18px] border border-edge bg-white/95 p-3 shadow-[0_8px_30px_rgba(15,23,42,0.18)] backdrop-blur-xl',
        className ?? '',
      ].join(' ')}
      aria-label="Transform-Gizmo"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <p className="truncate text-[12px] font-[700] text-ink">{selectedNode.label}</p>
          <p className="text-[10px] text-ink-muted">{isWall ? 'Wand' : 'Objekt'}</p>
        </div>
        <div className="ml-2 flex shrink-0 items-center gap-1">
          {canUndo && (
            <button
              type="button"
              onClick={() => { haptics.selection(); undo() }}
              aria-label="Rückgängig"
              className="flex h-7 w-7 items-center justify-center rounded-full bg-canvas text-[15px] text-ink-sub active:scale-90"
            >
              ↶
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={() => { haptics.selection(); onClose() }}
              aria-label="Auswahl aufheben"
              className="flex h-7 w-7 items-center justify-center rounded-full bg-canvas text-[13px] font-[700] text-ink-sub active:scale-90"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Mode tabs */}
      <div className="flex justify-between gap-1 rounded-[12px] bg-canvas p-1">
        <ModeTab
          mode="move"
          active={mode === 'move'}
          label="Move"
          icon={<Move size={13} />}
          onClick={handleModeChange}
        />
        {isWall ? (
          <ModeTab
            mode="resize"
            active={mode === 'resize'}
            label="Resize"
            icon={<Minimize2 size={13} />}
            onClick={handleModeChange}
          />
        ) : (
          <ModeTab
            mode="snap"
            active={mode === 'snap'}
            label="Snap"
            icon={<Layers size={13} />}
            onClick={handleModeChange}
          />
        )}
      </div>

      {/* Disabled hint */}
      {!hasVariant && (
        <p className="rounded-[9px] bg-[#FEF3C7] px-2.5 py-2 text-[10.5px] font-[600] text-warn">
          Keine Bearbeitungs-Ebene — Leseansicht
        </p>
      )}

      {/* Move mode */}
      {mode === 'move' && hasVariant && (
        <div className="flex flex-col gap-1.5">
          {/* X axis */}
          <div className="flex items-center gap-1">
            <span className="w-4 shrink-0 text-[10px] font-[700] text-ink-muted">X</span>
            <NudgeButton label="−20" onClick={() => handleNudge('x', -NUDGE_LARGE_M)} />
            <NudgeButton label="−5" onClick={() => handleNudge('x', -NUDGE_SMALL_M)} />
            <NudgeButton label="+5" onClick={() => handleNudge('x', NUDGE_SMALL_M)} />
            <NudgeButton label="+20" onClick={() => handleNudge('x', NUDGE_LARGE_M)} />
          </div>
          {/* Z axis */}
          <div className="flex items-center gap-1">
            <span className="w-4 shrink-0 text-[10px] font-[700] text-ink-muted">Z</span>
            <NudgeButton label="−20" onClick={() => handleNudge('z', -NUDGE_LARGE_M)} />
            <NudgeButton label="−5" onClick={() => handleNudge('z', -NUDGE_SMALL_M)} />
            <NudgeButton label="+5" onClick={() => handleNudge('z', NUDGE_SMALL_M)} />
            <NudgeButton label="+20" onClick={() => handleNudge('z', NUDGE_LARGE_M)} />
          </div>
          <p className="text-[9.5px] text-ink-muted">Werte in cm</p>
        </div>
      )}

      {/* Resize mode (wall only) */}
      {mode === 'resize' && isWall && hasVariant && (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-[700] text-ink-sub">Höhe (m)</span>
            <input
              type="number"
              step="0.01"
              min="0.5"
              max="6"
              value={heightInput}
              onChange={(e) => setHeightInput(e.target.value)}
              aria-label="Wandhöhe in Metern"
              className="rounded-[9px] border border-edge bg-canvas px-2.5 py-1.5 text-[13px] font-[600] text-ink focus:border-brand focus:outline-none focus:ring-[2px] focus:ring-brand/10"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-[700] text-ink-sub">Stärke (m)</span>
            <input
              type="number"
              step="0.005"
              min="0.05"
              max="1"
              value={thicknessInput}
              onChange={(e) => setThicknessInput(e.target.value)}
              aria-label="Wandstärke in Metern"
              className="rounded-[9px] border border-edge bg-canvas px-2.5 py-1.5 text-[13px] font-[600] text-ink focus:border-brand focus:outline-none focus:ring-[2px] focus:ring-brand/10"
            />
          </label>
          <button
            type="button"
            onClick={handleResize}
            className="w-full rounded-[10px] bg-brand py-2 text-[12px] font-[700] text-white active:scale-[0.97]"
          >
            Maß übernehmen
          </button>
        </div>
      )}

      {/* Snap mode (object only) */}
      {mode === 'snap' && !isWall && hasVariant && (
        <div className="flex flex-col gap-2">
          <p className="text-[10px] font-[700] text-ink-sub">Ziel-Oberfläche</p>
          <div className="grid grid-cols-2 gap-1">
            {SNAP_HOSTS.map(({ key, label, disabled }) => (
              <button
                key={key}
                type="button"
                disabled={disabled}
                aria-pressed={!disabled && snapHost === key}
                aria-label={disabled ? `${label} — nicht verfügbar` : label}
                onClick={() => { if (!disabled) { haptics.selection(); setSnapHost(key) } }}
                className={[
                  'rounded-[9px] border py-2 text-[11px] font-[650] transition',
                  disabled
                    ? 'cursor-not-allowed border-edge bg-canvas text-ink-muted opacity-40'
                    : snapHost === key
                      ? 'border-brand bg-[#EEF2FB] text-brand'
                      : 'border-edge bg-white text-ink-sub',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={handleSnap}
            className="w-full rounded-[10px] bg-brand py-2 text-[12px] font-[700] text-white active:scale-[0.97]"
          >
            Einrasten
          </button>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-primitives (module-level — react-hooks/static-components)
// ─────────────────────────────────────────────────────────────────────────────

function NudgeButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label} cm`}
      className="flex h-7 flex-1 items-center justify-center rounded-[8px] border border-edge bg-white text-[10.5px] font-[700] text-ink shadow-subtle transition active:scale-95 active:bg-canvas"
    >
      {label}
    </button>
  )
}
