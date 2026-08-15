/**
 * Spatial · Edit · EditModeViewerHost (Phase 2 · Block 2.9-2.12 · Carry-Over)
 *
 * The integration component that turns the read-only canonical viewer into an
 * edit-mode surface. It wires together every Block-2.9-2.12 piece:
 *
 *   - `<CanonicalSceneRoot>`  — the L3 renderer (mounted in edit mode),
 *   - `<MaterialPickerSheet>` — surface-tap → material apply,
 *   - `<LightingSwitcher>`    — lighting preset switch,
 *   - `<VariantSwitcher>`     — active-variant switch (2.9),
 *   - `<VisualDiffOverlay>`   — added/removed/modified tinting (2.12),
 *   - `<EditHistoryTimeline>` — persistent audit trail + reverter (2.14-2.15),
 *   - Undo / Redo controls    — gated on `editHistoryStore.canUndo/canRedo`,
 *   - Edit-Mode + Diff + History toggles.
 *
 * ── Edit-history persistence (Block 2.13) ───────────────────────────────────
 * After every `applied:true` result the host calls the WORKFLOW helper
 * `persistEditCommand` — never the repository directly (layer rule). The
 * append is BEST-EFFORT: a persistence failure is surfaced as a non-blocking
 * toast and the local edit STAYS APPLIED (the override stack is the source of
 * truth; the audit trail may have a gap). On a successful persist the history
 * panel's `refreshKey` is bumped so the new row appears live. The host needs a
 * `sceneId` to address the audit rows; when it is absent (bare preview) the
 * persistence step is skipped.
 *
 * ── Host contract (CRITICAL) ────────────────────────────────────────────────
 *  1. `<MaterialPickerSheet>` AND `<LightingSwitcher>` are mounted
 *     PERMANENTLY — only their `open` state toggles. The MaterialPickerSheet
 *     owns an 8 s Undo-Toast + a polite live-region that MUST survive a panel
 *     close; conditionally rendering the component would drop the toast.
 *  2. A surface tap (raycast) opens the matching picker for the tapped node.
 *  3. `MaterialPickerSheet.onApply` builds a `SetMaterialCommand` with the
 *     ROLE-CORRECT `variant_id` from `useSpatialEditPermissions` — never the
 *     merely-active variant id (Block 2.11) — and runs it through
 *     `editHistoryStore.apply()`.
 *  4. `apply()` result is evaluated:
 *       - `applied: false`            → reject toast (`error` / `hint`),
 *       - `applied: true` + warnings  → soft-warn confirm toast.
 *  5. `onUndo` → `editHistoryStore.undo()`.
 *
 * ── Variant-layer-write (Block 2.11) ────────────────────────────────────────
 * The active variant (what the renderer shows) and the writable variant (what
 * the user may edit) are DISTINCT. A user can inspect a read-only variant
 * (`base_roomplan`, a sealed `job_*_final`, a foreign provider layer) while
 * their own edits always land on their writable layer.
 *
 * Chosen UX (robust path · documented): when the active variant ≠ the
 * writable variant, an edit AUTO-SWITCHES the active variant to the writable
 * one and surfaces an info toast ("Bearbeitung auf deiner Ebene …"). This is
 * preferred over disabling the controls because the user's intent ("change
 * this material") is unambiguous and a silent no-op would be confusing — the
 * switch makes the edit + its result immediately visible on the layer it
 * actually wrote. When the user has NO writable layer at all, edit mode is not
 * offered (the toggle is disabled with an explanation).
 */

import {
  useCallback,
  useMemo,
  useState,
  type ReactElement,
} from 'react'

import { CanonicalSceneRoot } from '../three/canonical/CanonicalSceneRoot'
import { VisualDiffOverlay } from '../three/canonical/VisualDiffOverlay'
import {
  tappedKindToMaterialSurface,
  tappedKindToPickerSurfaceType,
  type TappedSurface,
  type TappedSurfaceKind,
} from '../three/canonical/surfaceTap'
import { LightingSwitcher } from '../lighting/LightingSwitcher'
import { MaterialPickerSheet, type MaterialPickerSurface } from './MaterialPickerSheet'
import { VariantSwitcher } from './VariantSwitcher'
import { EditHistoryTimeline } from './EditHistoryTimeline'

import { useCanonicalSceneStore } from '../../../lib/spatial/canonical/store/sceneStore'
import { useEditHistoryStore } from '../../../lib/spatial/canonical/store/editHistoryStore'
import { useSpatialEditPermissions } from '../../../lib/spatial/hooks/useSpatialEditPermissions'
import { SetMaterialCommand } from '../../../lib/spatial/canonical/commands/SetMaterialCommand'
import { persistEditCommand } from '../../../lib/spatial/canonical/workflow/persistEditCommand'
import { needsConfirm } from '../../../lib/spatial/canonical/validator/move-validation'
import { resolveScene } from '../../../lib/spatial/canonical/overrides/variant-resolve'
import { diffVariants } from '../../../lib/spatial/canonical/overrides/diff-variants'
import { buildDiffMarkers } from '../../../lib/spatial/canonical/overrides/diff-markers'
import { STANDARD_VARIANTS } from '../../../lib/spatial/canonical/types/variants'
import type { VariantId } from '../../../lib/spatial/canonical/types/variants'
import type { RoomScene, Node } from '../../../lib/spatial/canonical/types/scene-graph'
import type { NodeOverride, Variant } from '../../../lib/spatial/canonical/types/variants'
import type { CatalogMaterial } from '../../../lib/spatial/canonical/catalog/material-types'
import { useToast } from '../../../hooks/useToast'

const EMPTY_OVERRIDES: readonly NodeOverride[] = Object.freeze([])
const EMPTY_VARIANTS: readonly Variant[] = Object.freeze([])

/**
 * A node-selection event reported by {@link EditModeViewerHost.onNodeSelect}
 * (Phase C · C-3). Neutral on purpose — the host resolves the scene-graph
 * node; the consumer (the provider 3D tab) decides what is gizmo-editable.
 */
export type SceneNodeSelection =
  | {
      kind: 'node'
      /** Canonical node id of the tapped surface. */
      nodeId: string
      /** Resolved scene-graph node, or `null` when it is not in the graph. */
      node: Node | null
      /** Which surface kind the raycast hit. */
      surfaceKind: TappedSurfaceKind
    }
  /** A tap into empty space — the consumer should clear its selection. */
  | { kind: 'cleared' }

export interface EditModeViewerHostProps {
  /**
   * The canonical scene id (`spatial_scenes.id`) — addresses the persistent
   * `spatial_edit_history` audit rows. When `null` the host runs as a bare
   * preview: edits still apply + undo locally, but nothing is persisted and the
   * history panel is hidden.
   */
  sceneId?: string | null
  /** Base canonical scene (hydrates the canonical store via CanonicalSceneRoot). */
  scene: RoomScene | null
  /** Override stack — hydrated into the store; commands extend it in-place. */
  overrides?: NodeOverride[]
  /** Variant chain — hydrated into the store; drives the VariantSwitcher. */
  variants?: Variant[]
  /**
   * The variant the renderer should START on. The host then owns the active
   * variant (the VariantSwitcher + the 2.11 auto-switch mutate it). Defaults
   * to the first `is_default` variant, else `base_roomplan`.
   */
  initialActiveVariantId?: string | null
  /** Lighting preset id — controlled here so the LightingSwitcher can change it. */
  initialLightingPresetId?: string
  /** Opt-in for preset HDRI IBL (passed straight to CanonicalSceneRoot). */
  presetHdriEnabled?: boolean
  /** Outer wrapper class for layout (the host is `relative`). */
  className?: string
  /**
   * Phase C (C-3): when supplied, a surface tap REPORTS the resolved node
   * instead of opening the material picker — this turns the host into a
   * node-selection surface for an external transform gizmo. A tap into empty
   * space reports `{ kind: 'cleared' }`. Selection only fires in edit mode.
   */
  onNodeSelect?: (selection: SceneNodeSelection) => void
  /**
   * F5: suppress the walk-mode joystick while an edit overlay is open. The
   * joystick is a `z-index:70` body-level node that otherwise covers the
   * provider edit sheets; forwarded straight to CanonicalSceneRoot.
   */
  joystickSuppressed?: boolean
}

/** Find a node anywhere in the scene-graph by id. */
function findNode(scene: RoomScene | null, nodeId: string): Node | null {
  if (!scene) return null
  if (scene.id === nodeId) return scene
  if (scene.floor.id === nodeId) return scene.floor
  if (scene.ceiling.id === nodeId) return scene.ceiling
  for (const w of scene.walls) {
    if (w.id === nodeId) return w
    for (const o of w.openings) if (o.id === nodeId) return o
    for (const o of w.wall_mounted) if (o.id === nodeId) return o
  }
  for (const o of scene.floor.floor_mounted) if (o.id === nodeId) return o
  for (const o of scene.ceiling.ceiling_mounted) if (o.id === nodeId) return o
  for (const o of scene.free_objects) if (o.id === nodeId) return o
  return null
}

/** A surface tap with the picker payload + the resolved material-command surface. */
interface PickerTarget {
  surface: MaterialPickerSurface
  materialSurface: 'wall' | 'floor' | 'ceiling' | 'object'
  currentMaterialSlug: string | null
}

export function EditModeViewerHost({
  sceneId = null,
  scene,
  overrides: overridesProp = EMPTY_OVERRIDES as NodeOverride[],
  variants: variantsProp = EMPTY_VARIANTS as Variant[],
  initialActiveVariantId,
  initialLightingPresetId = 'modern-bath',
  presetHdriEnabled = false,
  className,
  onNodeSelect,
  joystickSuppressed = false,
}: EditModeViewerHostProps): ReactElement {
  const toast = useToast()

  // ── Local view state ─────────────────────────────────────────────────────
  // The host OWNS the active variant id (CanonicalSceneRoot hydrates the store
  // from this prop). The 2.9 VariantSwitcher and the 2.11 auto-switch both
  // mutate it. The default is the first `is_default` variant, else
  // `base_roomplan` — never `null`, so the renderer always resolves a layer.
  const [activeVariantId, setActiveVariantId] = useState<VariantId>(() => {
    if (initialActiveVariantId) return initialActiveVariantId
    return (
      variantsProp.find((v) => v.is_default)?.id ?? STANDARD_VARIANTS.BASE_ROOMPLAN
    )
  })
  const [editMode, setEditMode] = useState(false)
  const [diffMode, setDiffMode] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [lightingPresetId, setLightingPresetId] = useState(initialLightingPresetId)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null)
  const [diffBaseVariantId, setDiffBaseVariantId] = useState<VariantId>(
    STANDARD_VARIANTS.BASE_ROOMPLAN,
  )
  // Bumped after every successful `persistEditCommand` so the history panel
  // re-loads and shows the new audit row without a remount.
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0)

  // ── Store reads ──────────────────────────────────────────────────────────
  // `overrides` is read from the STORE (not the prop) because commands mutate
  // the store's override list in-place during the session — the store is the
  // live source once hydrated. The variant LIST stays the prop: it is static
  // for a scene and feeding it directly avoids the first-render gap before
  // CanonicalSceneRoot hydrates the store.
  const storeOverrides = useCanonicalSceneStore((s) => s.overrides)
  const resolved = useCanonicalSceneStore((s) => s.resolved)
  const overrides = storeOverrides.length > 0 ? storeOverrides : overridesProp
  const variants = variantsProp

  const apply = useEditHistoryStore((s) => s.apply)
  const undo = useEditHistoryStore((s) => s.undo)
  const redo = useEditHistoryStore((s) => s.redo)
  const canUndo = useEditHistoryStore((s) => s.canUndo)
  const canRedo = useEditHistoryStore((s) => s.canRedo)

  const { writableVariantId, canEdit } = useSpatialEditPermissions()

  // ── Variant-layer-write (Block 2.11) ─────────────────────────────────────
  // Ensure the writable variant is the active one before an edit lands. The
  // active variant is what the renderer shows; the writable variant is what
  // the user may edit. If they differ, auto-switch + inform the user so the
  // edit + its result are visible on the layer it actually wrote.
  const ensureWritableActive = useCallback((): VariantId | null => {
    if (!writableVariantId) return null
    if (activeVariantId !== writableVariantId) {
      setActiveVariantId(writableVariantId)
      const target = variants.find((v) => v.id === writableVariantId)
      toast.info(
        `Bearbeitung auf deiner Ebene${target ? ` „${target.display_name}“` : ''} — Ansicht gewechselt.`,
      )
    }
    return writableVariantId
  }, [writableVariantId, activeVariantId, setActiveVariantId, variants, toast])

  // ── Surface tap → open the material picker ───────────────────────────────
  // `<SurfaceTapLayer>` owns the r3f-event → TappedSurface resolution; the
  // host receives the resolved node, so this stays a plain pure handler.
  const handleTap = useCallback(
    (tapped: TappedSurface) => {
      // C-3: in node-selection mode the host reports the resolved scene-graph
      // node to the parent's transform gizmo instead of opening the material
      // picker. The resolved scene (overrides applied) gives current values.
      if (onNodeSelect) {
        onNodeSelect({
          kind: 'node',
          nodeId: tapped.nodeId,
          node: findNode(resolved ?? scene, tapped.nodeId),
          surfaceKind: tapped.kind,
        })
        return
      }
      const node = findNode(scene, tapped.nodeId)
      const currentMaterialSlug =
        node && 'material_id' in node
          ? ((node as { material_id?: string }).material_id ?? null)
          : null

      setPickerTarget({
        surface: {
          id: tapped.nodeId,
          type: tappedKindToPickerSurfaceType(tapped.kind),
          label: nodeLabel(node, tapped),
        },
        materialSurface: tappedKindToMaterialSurface(tapped.kind),
        currentMaterialSlug,
      })
      setPickerOpen(true)
    },
    [scene, resolved, onNodeSelect],
  )

  // R12 fix (#6): route surface taps through CanonicalSceneRoot's `onPinPlaced`
  // so its SurfaceTapLayer WRAPS the SceneRenderer (R3F events bubble through the
  // hit mesh's ancestor chain). The previous child `<SurfaceTapLayer>` sat as a
  // sibling group with no canonical mesh in its subtree → its pointer handler
  // never fired (the exact bug the CanonicalSceneRoot R12 comment documents — the
  // wrap-fix there only covered the onPinPlaced path, not this host's children
  // path). `onPinPlaced` carries the same (kind, nodeId, point) the layer
  // resolved; adapt it back to the `TappedSurface` shape `handleTap` consumes.
  const handlePinPlaced = useCallback(
    (input: {
      kind: TappedSurfaceKind
      surfaceExternalId: string
      uv: [number, number]
      worldXyz?: { x: number; y: number; z: number }
    }) => {
      handleTap({ kind: input.kind, nodeId: input.surfaceExternalId, point: input.worldXyz })
    },
    [handleTap],
  )

  // ── Material apply → SetMaterialCommand → editHistoryStore.apply() ───────
  const handleApplyMaterial = useCallback(
    (material: CatalogMaterial) => {
      if (!pickerTarget) return
      // Block 2.11: edits ALWAYS target the role-correct writable variant.
      const variantId = ensureWritableActive()
      if (!variantId) {
        toast.error('Du darfst dieses Aufmaß nicht bearbeiten.')
        return
      }

      const command = new SetMaterialCommand({
        nodeId: pickerTarget.surface.id,
        surface: pickerTarget.materialSurface,
        materialId: material.slug,
        variantId,
        label: `Material „${material.displayName}“`,
      })

      // Capture the override stack BEFORE the command runs — for the
      // `parametric_sha256_before` content address.
      const overridesBefore = useCanonicalSceneStore.getState().overrides.slice()
      const result = apply(command)

      if (!result.applied) {
        // Hard-reject (Master-Spec §8.1) — nothing was written.
        toast.error(result.hint ?? result.error.message)
        return
      }
      // Soft-warn (Master-Spec §8.2) — applied, but the user should confirm.
      if (needsConfirm(result.warnings)) {
        const first = result.warnings[0]
        toast.info(
          `Übernommen mit Hinweis: ${first?.message ?? 'Bitte prüfen.'} · Rückgängig über ↶`,
        )
      }

      // ── Block 2.13 · persist the edit (best-effort) ──────────────────────
      // Layer-clean: the host calls the WORKFLOW helper, never the repository.
      // A persistence failure does NOT roll back the local edit (see the
      // helper's symmetry note) — it is surfaced as a non-blocking toast.
      if (sceneId) {
        const overridesAfter = useCanonicalSceneStore.getState().overrides.slice()
        void persistEditCommand(result.command, {
          sceneId,
          overridesBefore,
          overridesAfter,
        }).then((persistResult) => {
          if (persistResult.persisted) {
            setHistoryRefreshKey((n) => n + 1)
          } else {
            toast.info('Änderung übernommen — Verlauf konnte nicht gesichert werden.')
          }
        })
      }
    },
    [pickerTarget, ensureWritableActive, apply, toast, sceneId],
  )

  const handleUndoMaterial = useCallback(() => {
    const reverted = undo()
    if (!reverted) toast.info('Nichts zum Rückgängigmachen.')
  }, [undo, toast])

  // ── Undo / Redo controls ─────────────────────────────────────────────────
  const handleUndo = useCallback(() => {
    if (!canUndo) return
    undo()
  }, [canUndo, undo])

  const handleRedo = useCallback(() => {
    if (!canRedo) return
    redo()
  }, [canRedo, redo])

  // ── Visual-diff markers (Block 2.12) ─────────────────────────────────────
  // Resolve the diff base + the active variant, diff them, place markers. The
  // diff is recomputed only when the inputs that feed it change.
  const diffMarkers = useMemo(() => {
    if (!diffMode || !scene || !activeVariantId) return []
    if (diffBaseVariantId === activeVariantId) return []
    const baseScene = resolveScene({
      scene,
      overrides,
      variants,
      activeVariantId: diffBaseVariantId,
    })
    const comparedScene = resolved
    if (!comparedScene) return []
    // diffVariants(a,b): a=base, b=compared. buildDiffMarkers mirrors that.
    return buildDiffMarkers(
      diffVariants(baseScene, comparedScene),
      baseScene,
      comparedScene,
    )
  }, [diffMode, scene, activeVariantId, diffBaseVariantId, overrides, variants, resolved])

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className={className ?? 'spatial-edit-host'} style={{ ...(className ? {} : { position: 'relative', inset: 0 }) }}>
      <CanonicalSceneRoot
        scene={scene}
        overrides={overrides}
        variants={variants}
        activeVariantId={activeVariantId}
        lightingPresetId={lightingPresetId}
        presetHdriEnabled={presetHdriEnabled}
        className="spatial-edit-host-canvas"
        editMode={editMode}
        joystickSuppressed={joystickSuppressed}
        onPinPlaced={handlePinPlaced}
        onBackgroundTap={
          editMode && onNodeSelect ? () => onNodeSelect({ kind: 'cleared' }) : undefined
        }
      >
        {/*
          #6: the surface-tap raycast is wired via `onPinPlaced` above — that
          makes CanonicalSceneRoot WRAP the SceneRenderer in its SurfaceTapLayer
          (controlled by `editMode`), so pointer events bubble through the hit
          mesh's ancestor chain. Mounting our own <SurfaceTapLayer> here as a
          sibling child never received events (it had no scene mesh in subtree).
        */}
        <VisualDiffOverlay markers={diffMarkers} enabled={diffMode} />
      </CanonicalSceneRoot>

      {/* ── Floating controls ───────────────────────────────────────────── */}
      <VariantSwitcher
        variants={variants}
        activeVariantId={activeVariantId}
        onSelect={setActiveVariantId}
        className="absolute left-3 top-3"
      />

      <LightingSwitcher
        presetId={lightingPresetId}
        onApply={setLightingPresetId}
        className="absolute right-3 top-3"
      />

      {/* Edit-mode / diff toggles + undo/redo */}
      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2">
        <ToggleButton
          active={editMode}
          disabled={!canEdit}
          label={editMode ? 'Bearbeiten an' : 'Bearbeiten'}
          ariaLabel={
            canEdit
              ? 'Bearbeitungs-Modus umschalten'
              : 'Bearbeiten nicht verfügbar · keine eigene Ebene'
          }
          onClick={() => canEdit && setEditMode((v) => !v)}
        />
        <ToggleButton
          active={diffMode}
          label="Diff"
          ariaLabel="Visuellen Vergleich umschalten"
          onClick={() => setDiffMode((v) => !v)}
        />
        {sceneId && (
          <ToggleButton
            active={historyOpen}
            label="Verlauf"
            ariaLabel="Bearbeitungs-Verlauf umschalten"
            onClick={() => setHistoryOpen((v) => !v)}
          />
        )}
        {editMode && (
          <>
            <IconButton
              disabled={!canUndo}
              ariaLabel="Rückgängig"
              onClick={handleUndo}
              glyph="↶"
            />
            <IconButton
              disabled={!canRedo}
              ariaLabel="Wiederholen"
              onClick={handleRedo}
              glyph="↷"
            />
          </>
        )}
      </div>

      {/* Diff base-variant picker — visible only while diff mode is on. */}
      {diffMode && variants.length > 1 && (
        <label className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-[14px] bg-black/55 px-2.5 py-1.5 text-[11px] font-medium text-white backdrop-blur-xl">
          <span className="text-white/65">Vergleich mit</span>
          <select
            value={diffBaseVariantId}
            onChange={(e) => setDiffBaseVariantId(e.target.value)}
            aria-label="Vergleichs-Basis-Ebene"
            className="rounded-md bg-white/10 px-1.5 py-0.5 text-white outline-none"
          >
            {variants.map((v) => (
              <option key={v.id} value={v.id} className="text-slate-900">
                {v.display_name}
              </option>
            ))}
          </select>
        </label>
      )}

      {/*
        Edit-History Timeline (Block 2.14) — the persistent audit trail + the
        reverter. Mounted only while `historyOpen`; a remount re-loads the
        history, which is the desired behaviour (a panel-open should reflect
        the latest rows). The `refreshKey` also re-loads it live after an edit.
      */}
      {sceneId && historyOpen && (
        <EditHistoryTimeline
          sceneId={sceneId}
          refreshKey={historyRefreshKey}
          className="absolute right-3 top-16"
        />
      )}

      {/*
        Host contract: MaterialPickerSheet is mounted PERMANENTLY — only `open`
        toggles. It owns the 8 s Undo-Toast + the polite live-region, both of
        which must outlive a panel close. Never conditionally render it.
      */}
      <MaterialPickerSheet
        open={pickerOpen}
        surface={pickerTarget?.surface ?? null}
        currentMaterialSlug={pickerTarget?.currentMaterialSlug ?? null}
        onApply={handleApplyMaterial}
        onUndo={handleUndoMaterial}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Local helpers
// ─────────────────────────────────────────────────────────────────────────────

/** German display label for a tapped node — used as the picker subtitle. */
function nodeLabel(node: Node | null, tapped: TappedSurface): string {
  const kindLabel: Record<TappedSurface['kind'], string> = {
    wall: 'Wand',
    floor: 'Boden',
    ceiling: 'Decke',
    object: 'Objekt',
  }
  if (node && 'category' in node) {
    return `${kindLabel[tapped.kind]} · ${String((node as { category: unknown }).category)}`
  }
  return `${kindLabel[tapped.kind]} · ${tapped.nodeId}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Control primitives
// ─────────────────────────────────────────────────────────────────────────────

function ToggleButton({
  active,
  disabled = false,
  label,
  ariaLabel,
  onClick,
}: {
  active: boolean
  disabled?: boolean
  label: string
  ariaLabel: string
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={ariaLabel}
      className={[
        'rounded-[14px] px-3.5 py-2 text-[13px] font-semibold backdrop-blur-xl transition active:scale-95',
        disabled
          ? 'cursor-not-allowed bg-black/40 text-white/35'
          : active
            ? 'bg-blue-600 text-white'
            : 'bg-black/55 text-white',
      ].join(' ')}
    >
      {label}
    </button>
  )
}

function IconButton({
  disabled = false,
  ariaLabel,
  glyph,
  onClick,
}: {
  disabled?: boolean
  ariaLabel: string
  glyph: string
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={[
        'flex size-9 items-center justify-center rounded-full text-[16px] backdrop-blur-xl transition active:scale-90',
        disabled ? 'cursor-not-allowed bg-black/40 text-white/30' : 'bg-black/55 text-white',
      ].join(' ')}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  )
}
