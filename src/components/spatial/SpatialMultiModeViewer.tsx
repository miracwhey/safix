/**
 * Spatial · SpatialMultiModeViewer
 *
 * Fullscreen canonical viewer that gives a provider the same "switch between
 * Grundriss / Dollhouse / Begehen" experience the customer has on their hub —
 * as a tap-away modal on their OWN rooms (presales / privat), so the operative
 * area stays the provider's home.
 *
 * It mirrors {@link SpatialFullscreenViewer}'s chrome (portal, safe-area top
 * bar, close button, AR-Quick-Look slot, Escape + Capacitor back-button) but
 * mounts the parametric {@link CanonicalSceneRoot} instead of the GLB
 * model-viewer, and reuses {@link CustomerViewModeSwitcher} for the camera-mode
 * switch.
 *
 * ── Manual editing (Lane-2.5 · Stream B) ────────────────────────────────────
 * When `editable` is set the viewer becomes the craftsman's manual room editor.
 * Two layers of editing, both ported from the customer hub so they feel proven:
 *
 *  1. **Grundriss (2D)** — tap a wall → it GLOWS + a non-modal measure bar opens
 *     (Länge/Höhe/Dicke). Drag the wall's MID-BAR to slide it (room grows; the
 *     adjoining walls follow). "Ecke einfügen" splits a wall for L/U shapes.
 *  2. **3D / Begehen** — an "Ansehen ↔ Bearbeiten" toggle arms a curated trade
 *     palette (Tür/Fenster/Steckdose/Schalter/Sicherungskasten/Heizkörper +
 *     Badewanne/Waschbecken/WC + Wandmaterial). Tap a surface to place; tap an
 *     existing fixture to move/resize/delete it. Reuses the customer's edit
 *     layers (`CustomerFurnitureEditLayer`/`CustomerWallObjectEditLayer`),
 *     sheets (`CustomerObjectEditSheet`/`CustomerWallFinishSheet`), pure mutators
 *     and validators — only the orchestration is craftsman-local. Decorative
 *     furniture is deliberately excluded.
 *
 * Every mutation routes through `onPersist` (the host debounces the blob
 * re-upload, RLS + workflow `callerCanEdit` back the write). None of this changes
 * any existing view-only caller (`editable` default false).
 *
 * ── Shared-store isolation (CRITICAL) ───────────────────────────────────────
 * The canonical scene store is a GLOBAL singleton. This host resets the
 * transient view-state (cameraMode/selectedSurface/focus/lock) on mount AND
 * clears it on unmount, so it neither inherits nor leaks state into the next
 * CanonicalSceneRoot mount (customer hub / job-3D-tab).
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Capacitor } from '@capacitor/core'
import { registerBackInterceptor } from '../../lib/native/backButton'
import { Info, Trash2, X } from 'lucide-react'

import { CanonicalSceneRoot } from './three/canonical/CanonicalSceneRoot'
import type { DimensionInputSheetValues } from './edit/DimensionInputSheet'
import { DimensionMeasureBar } from './edit/DimensionMeasureBar'
import CustomerObjectEditSheet, {
  type CustomerObjectToolKind,
  type CustomerObjectEditSheetValue,
} from './customer/CustomerObjectEditSheet'
import CustomerWallFinishSheet from './customer/CustomerWallFinishSheet'
import CraftsmanSpatialToolBar, {
  type CraftsmanSpatialTool,
} from './CraftsmanSpatialToolBar'
import { deriveCraftsmanToolCounts } from './deriveCraftsmanToolCounts'
import {
  setEdgeLength,
  setAllWallsHeight,
  setWallDims,
  insertWallCorner,
} from '../../lib/spatial/canonical/workflow/wallPointOrchestrator'
import {
  addOpeningToWall,
  updateOpeningInWall,
  removeOpeningFromWall,
  buildDefaultOpening,
  addWallMountedObjectToWall,
  updateWallMountedObjectInWall,
  removeWallMountedObjectFromWall,
  buildDefaultWallMountedObject,
  addFloorObjectToFloor,
  removeFloorObjectFromFloor,
  removeCeilingMountedObject,
  setWallMaterial,
  type CustomerWallMountedKind,
} from '../../lib/spatial/canonical/mutations/customerObjectMutator'
import {
  worldPointToWallLocalOffset,
  wallLengthMeters,
  findWallObjectAtOffset,
} from '../../lib/spatial/canonical/geometry/wallCoords'
import {
  validateObjectPosition,
  aabbForOpening,
  aabbForWallMounted,
  validateFloorObjectPosition,
  clampFloorObjectIntoRoom,
} from '../../lib/spatial/canonical/validator/objectPositionValidator'
import {
  snapWallObjectVerticalToDin,
  evaluateWallObjectDin,
  summarizeDinWarnings,
  type DinWarning,
} from '../../lib/spatial/canonical/validator/wallObjectDinValidator'
import { polygonAreaM2 } from '../../lib/spatial/canonical/geometry/footprint'
import CustomerViewModeSwitcher, {
  type CustomerViewMode,
} from './customer/CustomerViewModeSwitcher'
import SpatialSceneErrorBoundary from './SpatialSceneErrorBoundary'
import { SpatialQuickLookButton } from './SpatialQuickLookButton'
import {
  useCanonicalSceneStore,
  type CanonicalSceneState,
} from '../../lib/spatial/canonical/store/sceneStore'
import type { TappedSurfaceKind } from './three/canonical/surfaceTap'
import { useToast } from '../../hooks/useToast'
import { useHaptics } from '../../hooks/useHaptics'
import { useSpatialFirstRunFlag } from '../../hooks/useSpatialFirstRunFlag'
import { useImmersiveStatusBar } from '../../hooks/useImmersiveStatusBar'
import type { RoomScene } from '../../lib/spatial/canonical/types/scene-graph'
import type { SpatialObject, ObjectCategory } from '../../lib/spatial/canonical/types/objects'
import type { NodeOverride, Variant } from '../../lib/spatial/canonical/types/variants'

const IS_NATIVE = Capacitor.isNativePlatform()

/** One-shot key for the "tippe eine Wand"-hint (bump suffix to re-show). */
const WALL_HINT_KEY = 'fixup.spatial.craftsman.wallHint.v1'

/** Default (DIN-ish) cuboid footprints for the craftsman sanitary fixtures (w·d·h, m). */
const SANITARY_DIMS: Record<
  'bathtub' | 'sink' | 'toilet',
  { width_m: number; depth_m: number; height_m: number }
> = {
  bathtub: { width_m: 1.7, depth_m: 0.75, height_m: 0.6 },
  sink: { width_m: 0.6, depth_m: 0.46, height_m: 0.85 },
  toilet: { width_m: 0.4, depth_m: 0.68, height_m: 0.78 },
}

/** Crypto-strong id with a Date/Math fallback (mirrors the customer hub). */
function freshId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `obj-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * Build a floor-mounted sanitary fixture (no `asset_id` → renders as a labelled
 * cuboid, which is exactly what a measure/markup needs and avoids any
 * missing-GLB failure mode). X/Z come from the floor tap; rotation/scale default.
 */
function buildSanitaryFloorObject(input: {
  id: string
  floorId: string
  category: ObjectCategory
  dimensions: { width_m: number; depth_m: number; height_m: number }
  variantId: string
  generatedAt: string
  tapX: number
  tapZ: number
}): SpatialObject {
  return {
    id: input.id,
    type: 'object',
    parent_id: input.floorId,
    children_ids: [],
    transform: {
      position: { x: input.tapX, y: 0, z: input.tapZ },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    },
    source: 'manual',
    confidence: 1,
    variant_id: input.variantId,
    created_at: input.generatedAt,
    updated_at: input.generatedAt,
    category: input.category,
    dimensions: { ...input.dimensions },
    host: 'floor',
    host_id: input.floorId,
    rotation_around_y_deg: 0,
  }
}

/**
 * Transient view-state reset to defaults — keeps the shared store leak-free.
 * A factory (not a frozen const) so each reset writes a FRESH `hiddenWallIds`
 * array rather than sharing one mutable reference across mounts.
 */
function transientViewDefaults(): Partial<CanonicalSceneState> {
  return {
    cameraMode: 'dollhouse' as const,
    cutawaySetting: 'none' as const,
    hiddenWallIds: [] as string[],
    sectionSliderY: null,
    selectedSurface: null,
    focusedObjectId: null,
    focusedHost: null,
    objectInteractionLocked: false,
  }
}

export interface SpatialMultiModeViewerProps {
  /** Hydrated parametric scene — caller gates on `canRenderMultiMode`. */
  roomScene: RoomScene
  /** Override stack (usually empty for a self-scan). */
  overrides?: NodeOverride[]
  /** Variant chain (usually empty for a self-scan). */
  variants?: Variant[]
  /** Optional USDZ storage path for the iOS AR Quick Look off-ramp. */
  usdzStoragePath?: string | null
  /** Display title shown top-left (e.g. the Aufmaß title). */
  title?: string
  /**
   * Manual editing (Lane-2.5 · Stream B): when `true` the viewer arms footprint
   * editing (2D) + the 3D/Walk trade-edit palette. Caller sets this ONLY for
   * owner-held `origin='manual'` scenes. Default `false` → pure view-only.
   */
  editable?: boolean
  /** Called on each edit (footprint or object) with the live scene → host persists (blob). */
  onPersist?: (scene: RoomScene) => void
  /** Closes the modal — host re-mounts/unmounts via `{open && <Viewer/>}`. */
  onClose: () => void
}

export default function SpatialMultiModeViewer({
  roomScene,
  overrides,
  variants,
  usdzStoragePath,
  title,
  editable = false,
  onPersist,
  onClose,
}: SpatialMultiModeViewerProps) {
  const cameraMode = useCanonicalSceneStore((s) => s.cameraMode)
  const setCameraMode = useCanonicalSceneStore((s) => s.setCameraMode)
  const setStoreScene = useCanonicalSceneStore((s) => s.setScene)
  const liveScene = useCanonicalSceneStore((s) => s.scene)
  const focusedObjectId = useCanonicalSceneStore((s) => s.focusedObjectId)
  const focusedHost = useCanonicalSceneStore((s) => s.focusedHost)
  const setFocus = useCanonicalSceneStore((s) => s.setFocus)
  const clearFocus = useCanonicalSceneStore((s) => s.clearFocus)
  const toast = useToast()
  const haptics = useHaptics()

  // Full-bleed 3D: native status bar in overlay mode (self-guards web / non-native).
  useImmersiveStatusBar()

  // Footprint-edit: tap a wall → exact length/height/thickness bar (2D only).
  const [selectedWallId, setSelectedWallId] = useState<string | null>(null)
  const selectedWall = useCanonicalSceneStore((s) =>
    editable && selectedWallId
      ? (s.scene?.walls.find((w) => w.id === selectedWallId) ?? null)
      : null,
  )

  // 3D/Walk editing state.
  const [arrangeOn, setArrangeOn] = useState(false)
  const [activeTool, setActiveTool] = useState<CraftsmanSpatialTool | null>(null)
  const [editingWallFinishId, setEditingWallFinishId] = useState<string | null>(null)
  const [editConflict, setEditConflict] = useState<string | null>(null)
  const [editDinWarnings, setEditDinWarnings] = useState<DinWarning[]>([])
  // Two-tap guard for the destructive floor/ceiling fixture delete (touch mis-tap).
  const [confirmDeleteFocused, setConfirmDeleteFocused] = useState(false)
  const deleteFocusedTimer = useRef<number | null>(null)

  // Tool-bar count badges: a short "glow" pulse on the tool whose object was
  // just placed (visual confirmation while measuring). Auto-clears after one
  // animation cycle. `seq` makes repeated placements of the SAME tool re-fire
  // the timer (a new object identity each time).
  const [pulseTool, setPulseTool] = useState<{ tool: CraftsmanSpatialTool; seq: number } | null>(
    null,
  )
  const firePulse = useCallback((tool: CraftsmanSpatialTool) => {
    setPulseTool((p) => ({ tool, seq: (p?.seq ?? 0) + 1 }))
  }, [])
  useEffect(() => {
    if (!pulseTool) return
    const id = window.setTimeout(() => setPulseTool(null), 1600)
    return () => window.clearTimeout(id)
  }, [pulseTool])

  // One-shot "Tippe eine Wand"-hint (localStorage-gated, survives reloads).
  const { seen: wallHintSeen, markSeen: markWallHintSeen } =
    useSpatialFirstRunFlag(WALL_HINT_KEY)

  // Live room metrics for the info-pill + walk-empty guard.
  const roomMetrics = useMemo(() => {
    const s = liveScene ?? roomScene
    return {
      wallCount: s.walls.length,
      areaM2: polygonAreaM2(s.floor?.polygon ?? []),
    }
  }, [liveScene, roomScene])

  // Per-tool placement counts for the tool-bar badges: door/window openings,
  // wall-mounted electrics by category, floor-mounted sanitary by category.
  // (Material is a finish, not a countable object → no badge.)
  const toolCounts = useMemo(() => {
    // Mirror roomMetrics: prefer the live store scene, fall back to the prop so
    // badges are correct from the first frame (the store hydrates post-paint).
    const c = deriveCraftsmanToolCounts(liveScene ?? roomScene)
    const entry = pulseTool ? c[pulseTool.tool] : undefined
    if (pulseTool && entry) c[pulseTool.tool] = { count: entry.count, glow: true }
    return c
  }, [liveScene, roomScene, pulseTool])

  const viewMode: CustomerViewMode =
    cameraMode === 'floorplan' || cameraMode === 'walk' ? cameraMode : 'dollhouse'
  const is3d = viewMode === 'dollhouse' || viewMode === 'walk'

  // ── Commit helper: store write + (debounced) blob persist ──────────────────
  const commitSceneEdit = useCallback(
    (next: RoomScene) => {
      setStoreScene(next)
      onPersist?.(next)
    },
    [setStoreScene, onPersist],
  )

  // ── Footprint wall selection (2D) ─────────────────────────────────────────
  const clearWallSelection = useCallback(() => {
    setSelectedWallId(null)
    useCanonicalSceneStore.getState().setSelectedSurface(null)
  }, [])

  const handleFootprintWallSelect = useCallback(
    (id: string | null) => {
      setSelectedWallId(id)
      useCanonicalSceneStore.getState().setSelectedSurface(id ? `wall-${id}` : null)
      if (id) {
        haptics.selection()
        if (!wallHintSeen) markWallHintSeen()
      }
    },
    [haptics, wallHintSeen, markWallHintSeen],
  )

  const handleFootprintInvalid = useCallback(
    (message: string) => {
      toast.info(message)
    },
    [toast],
  )

  // Insert a rectilinear corner into the selected wall → forms a clean L the
  // user then refines by sliding the new segments (no slanted edges possible).
  const handleSplitWall = useCallback(() => {
    const scene = useCanonicalSceneStore.getState().scene
    const id = selectedWallId
    if (!scene || !id) return
    const right = freshId()
    const r = insertWallCorner({
      scene,
      wallId: id,
      newWallIdLeft: freshId(),
      newWallIdRiser: freshId(),
      newWallIdRight: right,
      generatedAt: new Date().toISOString(),
    })
    if (r.kind === 'updated') {
      commitSceneEdit(r.scene)
      // Select the pushed-out segment so the next slide deepens the L.
      handleFootprintWallSelect(right)
      haptics.success()
    } else {
      toast.info(r.message)
      haptics.warning()
    }
  }, [selectedWallId, commitSceneEdit, handleFootprintWallSelect, toast, haptics])

  // Apply the measure bar LIVE through the footprint-first orchestrator.
  const applyDim = useCallback(
    (values: DimensionInputSheetValues) => {
      const scene = useCanonicalSceneStore.getState().scene
      const wall = scene?.walls.find((w) => w.id === selectedWallId)
      if (!scene || !selectedWallId || !wall) return
      let working = scene
      const curLen =
        wall.length_m ??
        Math.hypot(
          wall.end_point.x - wall.start_point.x,
          wall.end_point.z - wall.start_point.z,
        )
      if (Math.abs(values.lengthM - curLen) > 1e-4) {
        const r = setEdgeLength({ scene: working, wallId: selectedWallId, lengthM: values.lengthM })
        if (r.kind === 'rejected') {
          toast.info(r.message)
          return
        }
        working = r.scene
      }
      if (values.applyHeightToAllWalls) {
        const r = setAllWallsHeight({ scene: working, heightM: values.heightM })
        if (r.kind === 'rejected') {
          toast.info(r.message)
          return
        }
        working = r.scene
      }
      const rDims = setWallDims({
        scene: working,
        wallId: selectedWallId,
        heightM: values.heightM,
        thicknessM: values.thicknessM,
      })
      if (rDims.kind === 'rejected') {
        toast.info(rDims.message)
        return
      }
      working = rDims.scene
      if (working !== scene) commitSceneEdit(working)
    },
    [selectedWallId, commitSceneEdit, toast],
  )

  // ── 3D/Walk: tap-to-place + tap-to-select orchestration ───────────────────
  const handlePinPlaced = useCallback(
    (input: {
      kind: TappedSurfaceKind
      surfaceExternalId: string
      uv: [number, number]
      worldXyz?: { x: number; y: number; z: number }
    }) => {
      const scene = useCanonicalSceneStore.getState().scene
      if (!scene) {
        toast.info('Raum wird noch geladen — bitte kurz warten')
        return
      }
      const tool = activeTool

      // No tool → select/edit an existing object (focus → opens its edit UI).
      if (!tool) {
        if (input.kind === 'object') {
          clearWallSelection()
          const id = input.surfaceExternalId
          if (scene.floor.floor_mounted.some((o) => o.id === id)) {
            setFocus(id, 'floor')
            return
          }
          if (scene.ceiling.ceiling_mounted.some((o) => o.id === id)) {
            setFocus(id, 'ceiling')
            return
          }
          for (const w of scene.walls) {
            if (w.wall_mounted.some((o) => o.id === id)) {
              setFocus(id, 'wall')
              useCanonicalSceneStore.getState().setSelectedSurface(null)
              return
            }
          }
          return
        }
        // Openings render as a CSG hole (no own pick proxy) → the tap arrives as
        // 'wall'; hit-test the wall-local point against its openings/objects.
        if (input.kind === 'wall' && input.worldXyz) {
          const wall = scene.walls.find((w) => w.id === input.surfaceExternalId)
          if (wall) {
            const local = worldPointToWallLocalOffset(
              wall,
              input.worldXyz,
              wallLengthMeters(wall),
              wall.height_m,
            )
            const hit = findWallObjectAtOffset(wall, local)
            if (hit) {
              clearWallSelection()
              setFocus(hit.id, 'wall')
              useCanonicalSceneStore.getState().setSelectedSurface(null)
              return
            }
            // Nackter Wand-Tap (keine Öffnung/kein Beschlag getroffen) → Wand
            // selektieren statt nur den Fokus zu löschen → öffnet die Maß-Bar,
            // jetzt auch im Dollhouse (3D), nicht nur im Grundriss. Vorher fiel
            // dieser Pfad auf clearFocus() → „ich klicke die Wand an, nichts
            // passiert". handleFootprintWallSelect setzt Glow + selectedWallId.
            clearFocus()
            handleFootprintWallSelect(wall.id)
            return
          }
          clearFocus()
          return
        }
        clearWallSelection()
        clearFocus()
        return
      }

      // Wandmaterial → open the finish sheet for the tapped wall.
      if (tool === 'material') {
        if (input.kind !== 'wall') {
          toast.info('Bitte auf eine Wand tippen')
          return
        }
        setEditingWallFinishId(input.surfaceExternalId)
        setActiveTool(null)
        return
      }

      // Sanitary fixtures → floor object at the tap point (clamp into the room).
      if (tool === 'bathtub' || tool === 'sink' || tool === 'toilet') {
        if (input.kind !== 'floor') {
          toast.info('Bitte auf den Boden tippen')
          return
        }
        const id = freshId()
        let obj = buildSanitaryFloorObject({
          id,
          floorId: scene.floor.id,
          category: tool,
          dimensions: SANITARY_DIMS[tool],
          variantId: scene.floor.variant_id,
          generatedAt: new Date().toISOString(),
          tapX: input.worldXyz?.x ?? 0,
          tapZ: input.worldXyz?.z ?? 0,
        })
        const fit = clampFloorObjectIntoRoom(scene.floor, obj)
        if (!fit) {
          toast.info('Passt nicht komplett in den Raum')
          return
        }
        obj = {
          ...obj,
          transform: { ...obj.transform, position: { ...obj.transform.position, x: fit.x, z: fit.z } },
        }
        const v = validateFloorObjectPosition({
          floor: scene.floor,
          object: obj,
          ceilingHeightM: scene.ceiling.height_m,
        })
        if (!v.ok) {
          toast.info(v.message)
          return
        }
        commitSceneEdit(addFloorObjectToFloor(scene, { floorId: scene.floor.id, object: obj }))
        firePulse(tool)
        setFocus(id, 'floor')
        setActiveTool(null)
        return
      }

      // Openings + wall-mounted electrics → require a wall hit.
      if (input.kind !== 'wall') {
        toast.info('Bitte direkt auf eine Wand tippen')
        return
      }
      const wall = scene.walls.find((w) => w.id === input.surfaceExternalId)
      if (!wall) {
        toast.info('Wand nicht erkannt — bitte erneut tippen')
        return
      }
      const wallLengthM = wallLengthMeters(wall)
      const tapLocal = input.worldXyz
        ? worldPointToWallLocalOffset(wall, input.worldXyz, wallLengthM, wall.height_m)
        : undefined
      const id = freshId()
      const generatedAt = new Date().toISOString()

      if (tool === 'door' || tool === 'window') {
        const opening = buildDefaultOpening({
          id,
          wallId: wall.id,
          wallLengthM,
          wallHeightM: wall.height_m,
          type: tool,
          variantId: wall.variant_id,
          generatedAt,
          tapOffsetAlongWallM: tapLocal?.offset_along_wall_m,
        })
        const validation = validateObjectPosition({
          wall,
          wallLengthM,
          candidate: aabbForOpening(opening),
        })
        if (!validation.ok) {
          toast.info(validation.message)
          return
        }
        commitSceneEdit(addOpeningToWall(scene, { wallId: wall.id, opening }))
        firePulse(tool)
        setFocus(opening.id, 'wall')
        setActiveTool(null)
        useCanonicalSceneStore.getState().setSelectedSurface(null)
        return
      }

      // outlet / switch / fusebox / radiator → wall-mounted object.
      const kind: CustomerWallMountedKind =
        tool === 'radiator'
          ? 'heating'
          : tool === 'outlet'
            ? 'electrical_outlet'
            : tool === 'switch'
              ? 'electrical_switch'
              : 'fuse_box'
      const snapCat: ObjectCategory | null =
        kind === 'heating'
          ? 'radiator'
          : kind === 'electrical_outlet'
            ? 'electrical_outlet'
            : kind === 'electrical_switch'
              ? 'light_switch'
              : null
      const snappedFromFloor =
        tapLocal?.offset_from_floor_m != null && snapCat
          ? snapWallObjectVerticalToDin(snapCat, tapLocal.offset_from_floor_m)
          : tapLocal?.offset_from_floor_m
      const obj = buildDefaultWallMountedObject({
        id,
        wallId: wall.id,
        wallLengthM,
        wallHeightM: wall.height_m,
        kind,
        variantId: wall.variant_id,
        generatedAt,
        tapOffsetAlongWallM: tapLocal?.offset_along_wall_m,
        tapOffsetFromFloorM: snappedFromFloor,
      })
      const aabb = aabbForWallMounted(obj)
      if (aabb) {
        const validation = validateObjectPosition({ wall, wallLengthM, candidate: aabb })
        if (!validation.ok) {
          toast.info(validation.message)
          return
        }
      }
      commitSceneEdit(addWallMountedObjectToWall(scene, { wallId: wall.id, object: obj }))
      firePulse(tool)
      setFocus(obj.id, 'wall')
      setActiveTool(null)
      useCanonicalSceneStore.getState().setSelectedSurface(null)
    },
    [
      activeTool,
      toast,
      commitSceneEdit,
      setFocus,
      clearFocus,
      firePulse,
      clearWallSelection,
      handleFootprintWallSelect,
    ],
  )

  // ── Footprint (2D) object/opening selection → focus its edit UI ───────────
  // FloorplanDragLayer reports a tapped object/opening here; mirror the
  // handlePinPlaced select branch so the 2D grundriss opens the same edit
  // sheet as a 3D tap (clear wall selection + focus + drop surface highlight).
  const handleFootprintObjectSelect = useCallback(
    (sel: { host: 'floor' | 'wall'; id: string }) => {
      clearWallSelection()
      setFocus(sel.id, sel.host)
      useCanonicalSceneStore.getState().setSelectedSurface(null)
    },
    [clearWallSelection, setFocus],
  )

  // ── Wall-object edit (door/window/outlet/switch/fusebox/radiator) ─────────
  const wallObjectEdit = useMemo(() => {
    if (focusedHost !== 'wall' || !focusedObjectId || !liveScene) return null
    for (const wall of liveScene.walls) {
      const op = wall.openings.find((o) => o.id === focusedObjectId)
      if (op) {
        return {
          isWallMounted: false,
          wallId: wall.id,
          objectId: op.id,
          toolKind: (op.type === 'window' ? 'window' : 'door') as CustomerObjectToolKind,
          headerLabel: undefined as string | undefined,
          wallLengthM: wallLengthMeters(wall),
          wallHeightM: wall.height_m,
          value: {
            positionAlongWallM: op.offset_along_wall_m + op.width_m / 2,
            widthM: op.width_m,
            heightM: op.height_m,
            offsetFromFloorM: op.offset_from_floor_m,
          } as CustomerObjectEditSheetValue,
        }
      }
      const wm = wall.wall_mounted.find((o) => o.id === focusedObjectId)
      if (wm) {
        const toolKind: CustomerObjectToolKind =
          wm.category === 'radiator'
            ? 'heating'
            : wm.category === 'fuse_box'
              ? 'fusebox'
              : 'electrical'
        const headerLabel =
          wm.category === 'electrical_outlet'
            ? 'Steckdose'
            : wm.category === 'light_switch'
              ? 'Schalter'
              : undefined
        const offset = wm.offset_along_wall_m ?? 0
        return {
          isWallMounted: true,
          wallId: wall.id,
          objectId: wm.id,
          toolKind,
          headerLabel,
          wallLengthM: wallLengthMeters(wall),
          wallHeightM: wall.height_m,
          value: {
            positionAlongWallM: offset + wm.dimensions.width_m / 2,
            widthM: wm.dimensions.width_m,
            heightM: wm.dimensions.height_m,
            offsetFromFloorM: wm.height_from_floor_m ?? 0,
          } as CustomerObjectEditSheetValue,
        }
      }
    }
    return null
  }, [focusedHost, focusedObjectId, liveScene])

  const handleObjectEditChange = useCallback(
    (next: CustomerObjectEditSheetValue) => {
      const edit = wallObjectEdit
      if (!edit) return
      const scene = useCanonicalSceneStore.getState().scene
      const wall = scene?.walls.find((w) => w.id === edit.wallId)
      if (!scene || !wall) return
      const wallLengthM = wallLengthMeters(wall)
      const offsetAlongWallM = Math.max(0, next.positionAlongWallM - next.widthM / 2)

      if (edit.isWallMounted) {
        const obj = wall.wall_mounted.find((o) => o.id === edit.objectId)
        if (!obj) return
        const fromFloor = snapWallObjectVerticalToDin(obj.category, next.offsetFromFloorM)
        const validation = validateObjectPosition({
          wall,
          wallLengthM,
          candidate: {
            left: offsetAlongWallM,
            right: offsetAlongWallM + next.widthM,
            bottom: fromFloor,
            top: fromFloor + next.heightM,
          },
          excludeId: obj.id,
        })
        if (!validation.ok) {
          setEditConflict(validation.message)
          return
        }
        const updated = updateWallMountedObjectInWall(scene, {
          wallId: edit.wallId,
          objectId: edit.objectId,
          patch: {
            offset_along_wall_m: offsetAlongWallM,
            height_from_floor_m: fromFloor,
            dimensions: {
              width_m: next.widthM,
              depth_m: obj.dimensions.depth_m,
              height_m: next.heightM,
            },
          },
        })
        commitSceneEdit(updated)
        setEditConflict(null)
        const nextWall = updated.walls.find((w) => w.id === edit.wallId)
        const nextObj = nextWall?.wall_mounted.find((o) => o.id === edit.objectId)
        setEditDinWarnings(
          nextWall && nextObj
            ? evaluateWallObjectDin({
                wall: nextWall,
                wallLengthM,
                candidate: { kind: 'wall_mounted', object: nextObj },
                excludeId: nextObj.id,
                roomCategory: scene.category,
              })
            : [],
        )
        return
      }

      const validation = validateObjectPosition({
        wall,
        wallLengthM,
        candidate: {
          left: offsetAlongWallM,
          right: offsetAlongWallM + next.widthM,
          bottom: next.offsetFromFloorM,
          top: next.offsetFromFloorM + next.heightM,
        },
        excludeId: edit.objectId,
      })
      if (!validation.ok) {
        setEditConflict(validation.message)
        return
      }
      const updated = updateOpeningInWall(scene, {
        wallId: edit.wallId,
        openingId: edit.objectId,
        patch: {
          offset_along_wall_m: offsetAlongWallM,
          offset_from_floor_m: next.offsetFromFloorM,
          width_m: next.widthM,
          height_m: next.heightM,
        },
      })
      commitSceneEdit(updated)
      setEditConflict(null)
      const nextWall = updated.walls.find((w) => w.id === edit.wallId)
      const nextOpening = nextWall?.openings.find((o) => o.id === edit.objectId)
      setEditDinWarnings(
        nextWall && nextOpening
          ? evaluateWallObjectDin({
              wall: nextWall,
              wallLengthM,
              candidate: { kind: 'opening', opening: nextOpening },
              excludeId: nextOpening.id,
              roomCategory: scene.category,
            })
          : [],
      )
    },
    [wallObjectEdit, commitSceneEdit],
  )

  const handleObjectEditDelete = useCallback(() => {
    const edit = wallObjectEdit
    if (!edit) return
    const scene = useCanonicalSceneStore.getState().scene
    if (!scene) return
    const updated = edit.isWallMounted
      ? removeWallMountedObjectFromWall(scene, { wallId: edit.wallId, objectId: edit.objectId })
      : removeOpeningFromWall(scene, { wallId: edit.wallId, openingId: edit.objectId })
    commitSceneEdit(updated)
    setEditConflict(null)
    setEditDinWarnings([])
    clearFocus()
  }, [wallObjectEdit, commitSceneEdit, clearFocus])

  const handleObjectEditClose = useCallback(() => {
    setEditConflict(null)
    setEditDinWarnings([])
    clearFocus()
  }, [clearFocus])

  // ── Floor/ceiling object (sanitary) delete ────────────────────────────────
  const handleDeleteFocusedObject = useCallback(() => {
    // First tap arms; second tap within 3s commits. Prevents accidental deletes.
    if (!confirmDeleteFocused) {
      setConfirmDeleteFocused(true)
      if (deleteFocusedTimer.current) window.clearTimeout(deleteFocusedTimer.current)
      deleteFocusedTimer.current = window.setTimeout(() => {
        setConfirmDeleteFocused(false)
        deleteFocusedTimer.current = null
      }, 3000)
      return
    }
    if (deleteFocusedTimer.current) {
      window.clearTimeout(deleteFocusedTimer.current)
      deleteFocusedTimer.current = null
    }
    setConfirmDeleteFocused(false)
    const scene = useCanonicalSceneStore.getState().scene
    const id = focusedObjectId
    if (!scene || !id) return
    let next = scene
    if (focusedHost === 'floor') {
      next = removeFloorObjectFromFloor(scene, { floorId: scene.floor.id, objectId: id })
    } else if (focusedHost === 'ceiling') {
      next = removeCeilingMountedObject(scene, { objectId: id })
    }
    if (next !== scene) commitSceneEdit(next)
    clearFocus()
  }, [confirmDeleteFocused, focusedObjectId, focusedHost, commitSceneEdit, clearFocus])

  // Reset the delete-confirm whenever the focused object changes / clears, and
  // clear any pending timer on change/unmount (no setState-after-unmount).
  useEffect(() => {
    setConfirmDeleteFocused(false)
    return () => {
      if (deleteFocusedTimer.current) {
        window.clearTimeout(deleteFocusedTimer.current)
        deleteFocusedTimer.current = null
      }
    }
  }, [focusedObjectId])

  // ── Wandmaterial ──────────────────────────────────────────────────────────
  const editingWallFinishMaterialId = useMemo(() => {
    if (!editingWallFinishId || !liveScene) return null
    return liveScene.walls.find((w) => w.id === editingWallFinishId)?.material_id ?? null
  }, [editingWallFinishId, liveScene])

  const handleWallFinishSelect = useCallback(
    (slug: string) => {
      const scene = useCanonicalSceneStore.getState().scene
      if (!scene || !editingWallFinishId) return
      commitSceneEdit(setWallMaterial(scene, { wallId: editingWallFinishId, materialId: slug }))
      setEditingWallFinishId(null)
    },
    [editingWallFinishId, commitSceneEdit],
  )

  const handleWallFinishReset = useCallback(() => {
    const scene = useCanonicalSceneStore.getState().scene
    if (!scene || !editingWallFinishId) return
    commitSceneEdit(setWallMaterial(scene, { wallId: editingWallFinishId, materialId: null }))
    setEditingWallFinishId(null)
  }, [editingWallFinishId, commitSceneEdit])

  // ── Ansehen ↔ Bearbeiten toggle (3D/Walk) ─────────────────────────────────
  const handleArrangeToggle = useCallback(
    (on: boolean) => {
      setArrangeOn(on)
      if (!on) {
        setActiveTool(null)
        clearFocus()
        clearWallSelection()
        setEditingWallFinishId(null)
        setEditConflict(null)
        setEditDinWarnings([])
      }
    },
    [clearFocus, clearWallSelection],
  )

  // Transform/gesture commit (footprint drag + furniture/wall-object drag). The
  // gesture layers already wrote the live store scene; here we only mark the edit
  // + schedule the blob persist (no redundant setScene → no extra recompute).
  const handleTransformCommit = useCallback(
    (scene: RoomScene) => {
      onPersist?.(scene)
    },
    [onPersist],
  )

  // ── Closure ───────────────────────────────────────────────────────────────
  // No success toast here: edits persist via the debounced `onPersist`, and the
  // host owns the 'Raum gespeichert' confirmation once its flush actually
  // resolves ok (a viewer-side toast would lie about a persist it can't observe).
  const handleViewerClose = useCallback(() => {
    onClose()
  }, [onClose])

  // ── Shared-store isolation ────────────────────────────────────────────────
  useLayoutEffect(() => {
    useCanonicalSceneStore.setState({
      ...transientViewDefaults(),
      cameraMode: editable ? 'floorplan' : 'dollhouse',
    })
    return () => {
      useCanonicalSceneStore.setState({ ...transientViewDefaults() })
    }
    // editable is stable for the modal's mount lifetime (host remounts per open).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Escape key closes the modal (desktop) ─────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleViewerClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [handleViewerClose])

  // ── Android hardware-back closes the modal ─────────────────────────────────
  // Routed through the central back coordinator (LIFO) so the open viewer
  // consumes the press instead of also triggering app-level navigation.
  useEffect(() => {
    if (!IS_NATIVE) return
    return registerBackInterceptor(() => {
      handleViewerClose()
      return true
    })
  }, [handleViewerClose])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) handleViewerClose()
    },
    [handleViewerClose],
  )

  const target = typeof document !== 'undefined' ? document.body : null
  if (!target) return null

  const isFloorOrCeilingFocused = focusedHost === 'floor' || focusedHost === 'ceiling'
  // Walk-mode joystick suppression: any object/fixture edit overlay that can
  // sit over the joystick (wall-object sheet + wall-finish/material sheet +
  // floor/ceiling fixture actions) disarms the look/move stick. The
  // wall-finish sheet is walk-reachable (material tool tap in 3D), so it must
  // suppress too. DimensionMeasureBar is floorplan/dollhouse only (never walk)
  // → deliberately excluded.
  const editOverlayOpen =
    wallObjectEdit != null ||
    editingWallFinishId != null ||
    (editable && is3d && isFloorOrCeilingFocused)
  const showToolbar =
    editable &&
    is3d &&
    arrangeOn &&
    wallObjectEdit == null &&
    !isFloorOrCeilingFocused &&
    editingWallFinishId == null &&
    // Maß-Bar (selektierte Wand) und Tool-FAB liegen beide bottom/z-30 →
    // FAB ausblenden während gemessen wird (wie beim Objekt-Edit-Sheet).
    selectedWall == null

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-black"
      role="dialog"
      aria-modal="true"
      aria-label={title ? `${title} · 3D-Ansicht` : '3D-Ansicht'}
      onClick={handleBackdropClick}
      // P2: this fullscreen viewer renders into document.body, OUTSIDE the
      // hub's non-immersive AppShell — so AppShell's document-level swipe-nav
      // would otherwise navigate to a neighbour tab when a swipe lands on a
      // chrome overlay (toolbar / switcher / measure-bar). Marking the portal
      // root immunises every descendant (useSwipeNavigation walks closest()).
      data-swipe-nav-skip
    >
      {/* Top-Bar: Titel + Close */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))]">
        <div className="pointer-events-auto max-w-[50%] rounded-[12px] bg-black/55 px-3 py-1.5 text-[13px] font-semibold text-white shadow-[0_2px_8px_rgba(0,0,0,0.35)] backdrop-blur">
          {title ?? '3D-Ansicht'}
        </div>

        {/* Ansehen ↔ Bearbeiten toggle (manual editor, 3D/Walk only). */}
        {editable && is3d && (
          <div className="pointer-events-auto flex rounded-full bg-black/55 p-0.5 text-[12px] font-semibold text-white shadow-[0_2px_8px_rgba(0,0,0,0.4)] backdrop-blur">
            {(
              [
                { k: false, label: 'Ansehen' },
                { k: true, label: 'Bearbeiten' },
              ] as const
            ).map((seg) => (
              <button
                key={seg.label}
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  handleArrangeToggle(seg.k)
                }}
                aria-pressed={arrangeOn === seg.k}
                className={[
                  'rounded-full px-3 py-1 transition active:scale-95',
                  arrangeOn === seg.k ? 'bg-white text-[#0f1525]' : 'text-white/75',
                ].join(' ')}
              >
                {seg.label}
              </button>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            handleViewerClose()
          }}
          aria-label="3D-Ansicht schließen"
          className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full bg-black/65 text-white shadow-[0_2px_8px_rgba(0,0,0,0.4)] backdrop-blur transition active:scale-95"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      {/* Viewer-Layer: fullbleed canonical scene + 3-Modi-Switcher */}
      <div className="relative flex-1" onClick={(e) => e.stopPropagation()}>
        <SpatialSceneErrorBoundary context="SpatialMultiModeViewer">
          <CanonicalSceneRoot
            scene={roomScene}
            overrides={overrides}
            variants={variants}
            editMode={editable && arrangeOn && is3d}
            canEdit={editable}
            arrangeMode={arrangeOn}
            onPinPlaced={editable ? handlePinPlaced : undefined}
            onEditReject={(m) => toast.info(m)}
            onFurnitureOutOfBounds={() => toast.info('Passt nicht komplett in den Raum')}
            onDinWarning={(warnings) => {
              const summary = summarizeDinWarnings(warnings)
              if (summary) toast.info(summary)
            }}
            footprintEditEnabled={editable}
            onFootprintWallSelect={handleFootprintWallSelect}
            onFootprintObjectSelect={handleFootprintObjectSelect}
            selectedFootprintWallId={selectedWallId}
            onFootprintInvalid={handleFootprintInvalid}
            onTransformCommit={handleTransformCommit}
            joystickSuppressed={editOverlayOpen}
            cameraSwitcher={false}
            sectionControls={false}
            className="absolute inset-0 h-full w-full"
          />
        </SpatialSceneErrorBoundary>

        {/* Room-Info-Pill (manual editor only): area + wall-count live. */}
        {editable && (
          <div
            className="pointer-events-none absolute left-3 rounded-[12px] px-3 py-1.5"
            style={{
              top: 'calc(max(env(safe-area-inset-top), 12px) + 46px)',
              background:
                'linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 100%)',
              backdropFilter: 'blur(96px) saturate(240%)',
              WebkitBackdropFilter: 'blur(96px) saturate(240%)',
              border: '1px solid rgba(255,255,255,0.14)',
              boxShadow: '0 20px 50px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.32)',
            }}
          >
            <div className="text-[11px] font-semibold leading-tight tracking-tight text-white/90">
              Manueller Raum
            </div>
            <div className="mt-[2px] text-[10px] leading-tight tabular-nums text-white/65">
              {roomMetrics.areaM2.toLocaleString('de-DE', { maximumFractionDigits: 1 })} m² ·{' '}
              {roomMetrics.wallCount} {roomMetrics.wallCount === 1 ? 'Wand' : 'Wände'}
            </div>
          </div>
        )}

        {/* Walk-empty guard. */}
        {editable && roomMetrics.wallCount < 3 && viewMode === 'walk' && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-8">
            <div className="rounded-[14px] bg-black/55 px-4 py-3 text-center text-[13px] font-medium text-white/80 backdrop-blur">
              Zeichne erst Wände im Grundriss, um den Raum zu begehen.
            </div>
          </div>
        )}

        {/* One-shot "Tippe eine Wand"-hint — Grundriss only. */}
        {editable && viewMode === 'floorplan' && !selectedWall && !wallHintSeen && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center px-4 pb-[max(20px,env(safe-area-inset-bottom))]">
            <div
              className="flex max-w-[320px] items-start gap-2 rounded-[14px] px-3.5 py-2.5 text-[12px] leading-snug text-white/85"
              style={{
                background:
                  'linear-gradient(180deg, rgba(20,28,48,0.82) 0%, rgba(15,21,37,0.9) 100%)',
                backdropFilter: 'blur(40px) saturate(200%)',
                WebkitBackdropFilter: 'blur(40px) saturate(200%)',
                border: '1px solid rgba(255,255,255,0.14)',
                boxShadow: '0 12px 36px rgba(0,0,0,0.5)',
              }}
            >
              <Info size={15} className="mt-0.5 shrink-0 text-blue-300" aria-hidden="true" />
              <span>
                Tippe eine Wand für Maße — oder zieh den Balken in der Wandmitte, um sie zu
                verschieben.
              </span>
            </div>
          </div>
        )}

        {/* 3-Modi-Pill (Grundriss / Dollhouse / Begehen). */}
        <div className="absolute right-3 top-1/2 z-10 -translate-y-1/2">
          <CustomerViewModeSwitcher value={viewMode} onChange={setCameraMode} />
        </div>
      </div>

      {/* Footprint-edit: tap a wall → non-modal measure bar + split.
          Grundriss (2D) UND Dollhouse (3D) — im 3D liefert der SurfaceTapLayer
          den Wand-Tap (handlePinPlaced), in 2D der FloorplanDragLayer. */}
      {editable && (viewMode === 'floorplan' || viewMode === 'dollhouse') && selectedWall && (
        <DimensionMeasureBar
          key={selectedWallId}
          wall={selectedWall}
          onApply={applyDim}
          onSplitWall={handleSplitWall}
          onClose={clearWallSelection}
        />
      )}

      {/* 3D/Walk trade palette. */}
      {showToolbar && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-start px-3 pb-[max(14px,env(safe-area-inset-bottom))]">
          <CraftsmanSpatialToolBar
            activeTool={activeTool}
            onSelectTool={setActiveTool}
            counts={toolCounts}
          />
        </div>
      )}

      {/* Wall-object edit sheet (door/window/outlet/switch/fusebox/radiator). */}
      {wallObjectEdit && (
        <CustomerObjectEditSheet
          open
          toolKind={wallObjectEdit.toolKind}
          headerLabelOverride={wallObjectEdit.headerLabel}
          wallLengthM={wallObjectEdit.wallLengthM}
          wallHeightM={wallObjectEdit.wallHeightM}
          value={wallObjectEdit.value}
          onChange={handleObjectEditChange}
          conflict={editConflict}
          dinWarnings={editDinWarnings}
          onDelete={handleObjectEditDelete}
          onClose={handleObjectEditClose}
        />
      )}

      {/* Floor/ceiling fixture (sanitary) actions. */}
      {editable && is3d && isFloorOrCeilingFocused && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
          <div
            className="pointer-events-auto w-full max-w-[440px] rounded-[18px] px-4 py-3 text-white"
            style={{
              background:
                'linear-gradient(180deg, rgba(20,28,48,0.92) 0%, rgba(15,21,37,0.96) 100%)',
              backdropFilter: 'blur(48px) saturate(220%)',
              WebkitBackdropFilter: 'blur(48px) saturate(220%)',
              border: '1px solid rgba(255,255,255,0.14)',
            }}
          >
            <p className="text-center text-[12px] text-white/70">
              Ziehen = verschieben · Ring = drehen · Kneifen = Größe
            </p>
            <div className="mt-2.5 flex items-center gap-2">
              <button
                type="button"
                onClick={handleDeleteFocusedObject}
                className={
                  confirmDeleteFocused
                    ? 'flex flex-1 items-center justify-center gap-1.5 rounded-full bg-red-500/90 py-2.5 text-[14px] font-bold text-white transition active:scale-[0.98] hover:bg-red-500'
                    : 'flex flex-1 items-center justify-center gap-1.5 rounded-full bg-white/[0.06] py-2.5 text-[14px] font-semibold text-white/82 transition active:scale-[0.98] hover:bg-white/[0.12]'
                }
              >
                <Trash2 size={15} aria-hidden="true" />
                {confirmDeleteFocused ? 'Wirklich löschen?' : 'Löschen'}
              </button>
              <button
                type="button"
                onClick={() => clearFocus()}
                className="flex-1 rounded-full py-2.5 text-[14px] font-bold text-white transition active:scale-[0.98]"
                style={{
                  background: 'linear-gradient(135deg, #2563EB 0%, #1d4ed8 100%)',
                  boxShadow: '0 6px 16px rgba(37,99,235,0.42), inset 0 1px 0 rgba(255,255,255,0.26)',
                }}
              >
                Fertig
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Wandmaterial sheet. */}
      <CustomerWallFinishSheet
        open={editingWallFinishId != null}
        currentMaterialId={editingWallFinishMaterialId}
        onSelect={handleWallFinishSelect}
        onReset={handleWallFinishReset}
        onClose={() => setEditingWallFinishId(null)}
      />

      {/* Bottom-Right: AR Quick Look (nur iOS + USDZ vorhanden) */}
      {usdzStoragePath && (
        <div className="pointer-events-none absolute bottom-0 right-0 z-20 px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
          <div className="pointer-events-auto" onClick={(e) => e.stopPropagation()}>
            <SpatialQuickLookButton usdzStoragePath={usdzStoragePath} iconOnly />
          </div>
        </div>
      )}
    </div>,
    target,
  )
}
