/**
 * Spatial · Canonical · Three · FloorplanDragLayer (Manual footprint edit)
 *
 * 2D top-down wall editing for manual rooms — turns the read-only
 * `FloorplanCadOverlay` into an editor. After the device test of free corner
 * dragging ("hängt, springt, katastrophal") the corner-reshape gesture was
 * REMOVED. Editing is now a single, robust handle per wall:
 *
 *   - **Tap a wall** → select it (the wall glows; the host opens the measure
 *     bar). Tap empty → deselect.
 *   - **Drag the MID-BAR** (the bar+arrow handle at the selected wall's
 *     midpoint) → slide the WHOLE wall along its outward normal. The room grows/
 *     shrinks in that direction; the two ADJOINING walls stretch with it and the
 *     ring stays closed + rectilinear (1 DOF — a crooked shape is impossible).
 *     The wall under the bar does NOT get longer; its neighbours do.
 *
 * L/U shapes: there is no free corner drag anymore — instead the measure bar's
 * "Ecke einfügen" splits the selected wall at its midpoint (`splitWallAtMidpoint`),
 * and the two resulting segments are each slid by their own mid-bar. Every
 * rectilinear L/U is reachable that way, without the crooked-corner failure mode.
 *
 * Feel:
 *   - The grabbed edge follows the finger LIVE every frame via `previewWallEdge`,
 *     which keeps the walls following even through an INVALID pose (floor held at
 *     the last valid shape, red tint) instead of freezing. The authoritative
 *     commit happens on RELEASE — valid → persist, invalid → snap back + toast.
 *   - Soft magnets in SCREEN PIXELS (neighbour alignment lines + 5 cm grid)
 *     gently snap the slide; they NEVER lock (drag past the ~SNAP_PX band → free)
 *     and never merge a corner onto a foreign corner. Each acquire fires a light
 *     haptic + an emerald flash.
 *   - The handle is screen-pixel-constant (unit meshes scaled per-frame against
 *     the ortho frustum) so it doesn't balloon/shrink with zoom.
 *
 * Camera disambiguation: grabbing the bar locks the floorplan camera
 * (`objectInteractionLocked` → `FloorplanController` disables OrbitControls pan
 * AND flushes residual momentum), so a drag never pans the map. A pointer-down
 * that hits no handle leaves the camera free (pan / pinch-zoom as normal).
 *
 * Gated by `enabled` (caller: `footprintEditEnabled && cameraMode==='floorplan'`);
 * pure passthrough otherwise.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import {
  BufferGeometry,
  Float32BufferAttribute,
  type Mesh,
  OrthographicCamera,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
} from 'three'

import { useCanonicalSceneStore } from '../../../../lib/spatial/canonical/store/sceneStore'
import {
  previewWallEdge,
  wallOutwardNormalXZ,
  type LiveWallEdit,
} from '../../../../lib/spatial/canonical/workflow/wallPointOrchestrator'
import {
  resolveFloorplanHit,
  isWithinBarSegmentPx,
  type FloorplanTapResult,
} from '../../../../lib/spatial/canonical/geometry/floorplanHitTest'
import { useHaptics } from '../../../../hooks/useHaptics'
import type { RoomScene } from '../../../../lib/spatial/canonical/types/scene-graph'

/** Drag promotes to move only past this screen distance (mirrors SurfaceTapLayer). */
const DRAG_DISTANCE_PX = 8
/** A pointer-down within this many screen px of the mid-bar SEGMENT grabs it. */
const HANDLE_HIT_PX = 30
/** A TAP within this many screen px of an opening / wall-mounted object selects it. */
const OPENING_HIT_PX = 22
/** A TAP within this many screen px of a floor/free object's footprint edge selects it. */
const OBJECT_HIT_PX = 16
/** A TAP within this many screen px of a wall segment selects it (opens the bar). */
const WALL_HIT_RADIUS_PX = 18
/** Soft-magnet capture band, in SCREEN px (alignment lines + grid). */
const SNAP_PX = 14
/** 5 cm grid magnet (Dec 5 default) — a soft magnet, NOT a hard lattice. */
const GRID_M = 0.05
/** Endpoints within this of each other count as the same ring vertex. */
const VERTEX_EPS_M = 0.05
/** Screen-constant handle sizing, in CSS px (meshes built at unit scale). */
const HANDLE_PX_IDLE = 12
const HANDLE_PX_ACTIVE = 16
/** Emerald magnet-acquire flash duration. */
const FLASH_MS = 180

const COLOR_ACTIVE = '#4f8dfd'
const COLOR_REJECT = '#f43f5e'
const COLOR_MAGNET = '#34d399'
const COLOR_EDGE = '#7db1ff'

interface XZ {
  x: number
  z: number
}

type Px = { x: number; y: number }

export interface FloorplanDragLayerProps {
  /** `true` only in floorplan edit-mode on an editable manual scene. */
  enabled: boolean
  /** Called on drag release with the live (valid) scene → host schedules persist. */
  onCommit?: (scene: RoomScene) => void
  /** Called when a drag is released on an INVALID pose (after snap-back) → host toasts. */
  onInvalid?: (message: string) => void
  /** Called on a TAP (no drag): the wall under the finger, or null to deselect. */
  onSelectWall?: (wallId: string | null) => void
  /**
   * Called on a TAP that lands on a floor/free object (`host:'floor'`) or a
   * wall-hosted opening / wall-mounted object (`host:'wall'`). The host routes
   * selection to the matching edit surface (the layer never opens it itself).
   */
  onSelectObject?: (sel: { host: 'floor' | 'wall'; id: string }) => void
  /** The currently selected wall — rendered highlighted + shows the mid-bar handle. */
  selectedWallId?: string | null
  /**
   * When `true`, a TAP on a wall selects the WALL even where an opening /
   * wall-mounted object sits on it (openings are collinear with the wall in 2D).
   * Surfaces whose 2D job is wall-dimension editing set this so wall taps stay
   * reliable; openings are then edited in 3D. Default `false` (opening-first).
   */
  preferWallSelection?: boolean
  /** Scene content the layer wraps (the gesture/tap layers + SceneRenderer). */
  children?: ReactNode
}

interface DragState {
  pointerId: number
  mode: 'pending' | 'drag'
  startClientX: number
  startClientY: number
  /** Immutable snapshot of the scene at grab — every preview derives from this. */
  editStartScene: RoomScene
  /** Other ring vertices (alignment targets); fixed for the drag. */
  magnetTargets: XZ[]
  /** Last preview's snap key (drives the magnet-acquire haptic/flash transition). */
  snapKey: string
  /** Last preview's rejection message (null = valid). */
  rejection: string | null
  wallId: string
  normal: XZ
  edgeA: XZ
  edgeB: XZ
  grabStart: XZ
}

/** De-duplicated ring vertices (wall corners) from the wall endpoints. */
function ringVertices(
  walls: { start_point: { x: number; z: number }; end_point: { x: number; z: number } }[],
): XZ[] {
  const out: XZ[] = []
  const push = (p: { x: number; z: number }): void => {
    if (!out.some((q) => Math.hypot(q.x - p.x, q.z - p.z) <= VERTEX_EPS_M)) {
      out.push({ x: p.x, z: p.z })
    }
  }
  for (const w of walls) {
    push(w.start_point)
    push(w.end_point)
  }
  return out
}

const sameCorner = (a: XZ, b: XZ): boolean => Math.hypot(a.x - b.x, a.z - b.z) <= VERTEX_EPS_M

/**
 * Snap a 1-DOF edge-slide distance (along the outward normal) to alignment
 * lines + grid, in SCREEN px. Returns the nearest eligible distance, or the raw
 * distance when nothing is within the capture band. Never merges a moved corner
 * onto a foreign corner.
 */
function snapEdgeDistance(
  d: number,
  n: XZ,
  edgeA: XZ,
  edgeB: XZ,
  targets: XZ[],
  toPx: (p: XZ) => Px,
): { d: number; key: string } {
  const cands: { d: number; key: string }[] = [
    { d: Math.round(d / GRID_M) * GRID_M, key: 'grid' },
  ]
  for (const t of targets) {
    for (const base of [edgeA, edgeB]) {
      if (Math.abs(n.x) > 1e-3) cands.push({ d: (t.x - base.x) / n.x, key: 'ax' })
      if (Math.abs(n.z) > 1e-3) cands.push({ d: (t.z - base.z) / n.z, key: 'az' })
    }
  }
  const aRawS = toPx({ x: edgeA.x + n.x * d, z: edgeA.z + n.z * d })
  let best: { d: number; key: string } | null = null
  for (const c of cands) {
    const aC: XZ = { x: edgeA.x + n.x * c.d, z: edgeA.z + n.z * c.d }
    if (Math.hypot(toPx(aC).x - aRawS.x, toPx(aC).y - aRawS.y) > SNAP_PX) continue
    const bC: XZ = { x: edgeB.x + n.x * c.d, z: edgeB.z + n.z * c.d }
    const merges = targets.some(
      (t) =>
        Math.hypot(aC.x - t.x, aC.z - t.z) < VERTEX_EPS_M ||
        Math.hypot(bC.x - t.x, bC.z - t.z) < VERTEX_EPS_M,
    )
    if (merges) continue
    if (!best || Math.abs(c.d - d) < Math.abs(best.d - d)) best = c
  }
  return best ?? { d, key: '' }
}

export function FloorplanDragLayer({
  enabled,
  onCommit,
  onInvalid,
  onSelectWall,
  onSelectObject,
  selectedWallId,
  preferWallSelection = false,
  children,
}: FloorplanDragLayerProps): ReactElement {
  const { camera, gl, invalidate, size, controls } = useThree()
  const haptics = useHaptics()
  // Latest-value ref for the default controls (OrbitControls, registered via
  // `makeDefault` in FloorplanController). The lock travels to the controls
  // ASYNC through React (`enabled={!objectInteractionLocked}`), but
  // OrbitControls reads `scope.enabled` SYNCHRONOUSLY in its native
  // pointermove listener — so the very first move after a grab can still pan
  // the floorplan under the finger (P1 device-audit). We additionally toggle
  // `controls.enabled` imperatively the instant we grab/release, closing that
  // one-frame race. The React prop + momentum-flush stay as release-defense.
  const controlsRef = useRef<{ enabled: boolean } | null>(null)
  controlsRef.current = (controls as { enabled: boolean } | null) ?? null
  const setStoreScene = useCanonicalSceneStore((s) => s.setScene)
  const setLocked = useCanonicalSceneStore((s) => s.setObjectInteractionLocked)
  const walls = useCanonicalSceneStore((s) => s.resolved?.walls ?? null)

  const drag = useRef<DragState | null>(null)
  const tap = useRef<{ pointerId: number; startX: number; startY: number } | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const barMesh = useRef<Mesh | null>(null)
  const arrowMesh = useRef<Mesh | null>(null)

  const [edgeDragging, setEdgeDragging] = useState(false)
  const [rejected, setRejected] = useState(false)
  const [magnetFlash, setMagnetFlash] = useState(false)
  const [ray] = useState(() => new Raycaster())
  const [scratch] = useState(() => new Vector3())

  // Selected-wall highlight line (start→end, drawn on top).
  const selectedWallGeom = useMemo(() => {
    if (!enabled || !selectedWallId || !walls) return null
    const w = walls.find((x) => x.id === selectedWallId)
    if (!w) return null
    const g = new BufferGeometry()
    g.setAttribute(
      'position',
      new Float32BufferAttribute(
        [w.start_point.x, 0.06, w.start_point.z, w.end_point.x, 0.06, w.end_point.z],
        3,
      ),
    )
    return g
  }, [enabled, selectedWallId, walls])
  useEffect(() => () => selectedWallGeom?.dispose(), [selectedWallGeom])

  // Mid-bar handle: a bar lying ALONG the selected wall at its midpoint + an
  // arrow cone pointing OUT of the room (the slide direction). Recomputes as the
  // wall moves so it tracks during a slide.
  const midBar = useMemo(() => {
    if (!enabled || !selectedWallId || !walls) return null
    const w = walls.find((x) => x.id === selectedWallId)
    if (!w) return null
    const mid: XZ = {
      x: (w.start_point.x + w.end_point.x) / 2,
      z: (w.start_point.z + w.end_point.z) / 2,
    }
    const scene = useCanonicalSceneStore.getState().scene
    const out = scene ? wallOutwardNormalXZ(scene, selectedWallId) : null
    // Arrow: local +Y → outward normal.
    const arrowQ = new Quaternion()
    if (out) arrowQ.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(out.x, 0, out.z))
    // Bar: local +X → wall direction (start→end).
    const dx = w.end_point.x - w.start_point.x
    const dz = w.end_point.z - w.start_point.z
    const len = Math.hypot(dx, dz) || 1
    const barQ = new Quaternion()
    barQ.setFromUnitVectors(new Vector3(1, 0, 0), new Vector3(dx / len, 0, dz / len))
    return {
      mid,
      arrowQuat: [arrowQ.x, arrowQ.y, arrowQ.z, arrowQ.w] as [number, number, number, number],
      barQuat: [barQ.x, barQ.y, barQ.z, barQ.w] as [number, number, number, number],
    }
  }, [enabled, selectedWallId, walls])

  // Safety: never leave the camera locked (or controls disabled) if the layer
  // unmounts mid-drag.
  useEffect(
    () => () => {
      setLocked(false)
      if (controlsRef.current) controlsRef.current.enabled = true
      if (flashTimer.current) clearTimeout(flashTimer.current)
    },
    [setLocked],
  )

  /** World floor X/Z under a screen point (ray-plane y=0; ortho-safe). */
  const floorPointAt = (clientX: number, clientY: number): XZ | null => {
    const rect = gl.domElement.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    )
    ray.setFromCamera(ndc, camera)
    const { origin, direction } = ray.ray
    const EPS = 1e-3
    const t = direction.y < -EPS ? Math.min(Math.max(-origin.y / direction.y, 0), 200) : 200
    return { x: origin.x + direction.x * t, z: origin.z + direction.z * t }
  }

  /** Project a world XZ point to CSS px relative to the canvas. */
  const screenOf = (p: XZ, rect: DOMRect): Px => {
    scratch.set(p.x, 0, p.z).project(camera)
    return {
      x: (scratch.x * 0.5 + 0.5) * rect.width,
      y: (-scratch.y * 0.5 + 0.5) * rect.height,
    }
  }

  /**
   * Half the mid-bar's WORLD length at the idle handle scale — the bar mesh is
   * `boxGeometry[2.6,…]` scaled per-frame so its on-screen length is constant
   * `2.6 · HANDLE_PX_IDLE` px. Projecting `mid ± dir · this` reproduces the two
   * rendered bar ends, so the whole visible bar is grabbable (not just its
   * midpoint). 0 when the camera is not ortho (degenerates to midpoint grab).
   */
  const barHalfLenWorld = (): number => {
    const cam = camera as OrthographicCamera
    if (!cam.isOrthographicCamera) return 0
    const span = cam.top - cam.bottom
    return 1.3 * ((HANDLE_PX_IDLE / size.height) * (span / cam.zoom))
  }

  /**
   * Priority-ordered tap resolver. Default: opening / wall-mounted (`wallObject`)
   * > wall > null. With `preferWallSelection`: wall > opening / wall-mounted >
   * null (tapping a wall stays reliable where a window sits on it; openings are
   * edited in 3D). (Floor/free objects are excluded in 2D — see `objects: []`
   * below.) All radii are CSS px after projecting through the live ortho camera,
   * so targets stay finger-sized at any zoom. Reads the resolved scene (walls +
   * their openings/wall-mounted) from the canonical store.
   */
  const resolveFloorplanTap = (clientX: number, clientY: number): FloorplanTapResult => {
    const rect = gl.domElement.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return { kind: null }
    const store = useCanonicalSceneStore.getState()
    const scene = store.resolved ?? store.scene
    if (!scene) return { kind: null }
    return resolveFloorplanHit({
      point: { x: clientX - rect.left, y: clientY - rect.top },
      walls: scene.walls.map((w) => ({
        id: w.id,
        start: { x: w.start_point.x, z: w.start_point.z },
        end: { x: w.end_point.x, z: w.end_point.z },
        openings: w.openings.map((o) => ({
          id: o.id,
          offsetAlong: o.offset_along_wall_m,
          width: o.width_m,
        })),
        wallMounted: w.wall_mounted.map((o) => ({
          id: o.id,
          offsetAlong: o.offset_along_wall_m ?? 0,
          width: o.dimensions.width_m,
        })),
      })),
      // Floor/free objects are intentionally NOT pickable in 2D: their
      // footprints are not drawn by FloorplanCadOverlay (invisible), they have
      // no floorplan edit surface (the floor/ceiling action bar is is3d-gated),
      // and a leaked floor focus would suppress the Walk joystick on mode
      // switch. Fixtures are selected/edited in 3D (dollhouse/walk). 2D keeps
      // wall + opening + wall-mounted (window/door/outlet/switch) selection.
      objects: [],
      toPx: (p) => screenOf(p, rect),
      openingPx: OPENING_HIT_PX,
      objectPx: OBJECT_HIT_PX,
      wallPx: WALL_HIT_RADIUS_PX,
      preferWall: preferWallSelection,
    })
  }

  /** Fire the magnet-acquire feedback (light haptic + emerald flash). */
  const fireMagnet = (): void => {
    haptics.light()
    setMagnetFlash(true)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setMagnetFlash(false), FLASH_MS)
  }

  const handlePointerDown = (event: ThreeEvent<PointerEvent>): void => {
    if (!enabled || drag.current) return
    const { clientX, clientY } = event.nativeEvent
    const rect = gl.domElement.getBoundingClientRect()
    const scene = useCanonicalSceneStore.getState().scene
    if (!scene) return

    // 1) Mid-bar grab (only on the selected wall) → slide whole wall. Measured
    // to the bar SEGMENT (its two rendered ends), so the whole bar is grabbable.
    if (selectedWallId && midBar) {
      const wall = scene.walls.find((w) => w.id === selectedWallId)
      const out = wall ? wallOutwardNormalXZ(scene, selectedWallId) : null
      const fp = floorPointAt(clientX, clientY)
      const finger: Px = { x: clientX - rect.left, y: clientY - rect.top }
      let onBar = false
      if (wall) {
        const dx = wall.end_point.x - wall.start_point.x
        const dz = wall.end_point.z - wall.start_point.z
        const len = Math.hypot(dx, dz) || 1
        const half = barHalfLenWorld()
        const hx = (dx / len) * half
        const hz = (dz / len) * half
        const barA = screenOf({ x: midBar.mid.x - hx, z: midBar.mid.z - hz }, rect)
        const barB = screenOf({ x: midBar.mid.x + hx, z: midBar.mid.z + hz }, rect)
        onBar = isWithinBarSegmentPx(finger, barA, barB, HANDLE_HIT_PX)
      }
      if (onBar && wall && out && fp) {
        drag.current = {
          pointerId: event.pointerId,
          mode: 'pending',
          startClientX: clientX,
          startClientY: clientY,
          editStartScene: scene,
          magnetTargets: ringVertices(scene.walls).filter(
            (c) =>
              !sameCorner(c, wall.start_point as XZ) && !sameCorner(c, wall.end_point as XZ),
          ),
          snapKey: '',
          rejection: null,
          wallId: selectedWallId,
          normal: out,
          edgeA: { x: wall.start_point.x, z: wall.start_point.z },
          edgeB: { x: wall.end_point.x, z: wall.end_point.z },
          grabStart: fp,
        }
        setEdgeDragging(true)
        setLocked(true)
        // Sync imperative disable — beats the async prop to the native
        // pointermove listener so the grab never pans the map (P1).
        if (controlsRef.current) controlsRef.current.enabled = false
        event.stopPropagation()
        return
      }
    }

    // 2) Not on the handle — record a tap candidate (wall select); camera free.
    tap.current = { pointerId: event.pointerId, startX: clientX, startY: clientY }
  }

  const applyPreview = (d: DragState, clientX: number, clientY: number): void => {
    const rect = gl.domElement.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const fp = floorPointAt(clientX, clientY)
    if (!fp) return
    const toPx = (p: XZ): Px => screenOf(p, rect)

    const drx = fp.x - d.grabStart.x
    const drz = fp.z - d.grabStart.z
    const rawDist = drx * d.normal.x + drz * d.normal.z
    const snap = snapEdgeDistance(rawDist, d.normal, d.edgeA, d.edgeB, d.magnetTargets, toPx)
    const key = snap.key
    const delta: XZ = { x: d.normal.x * snap.d, z: d.normal.z * snap.d }
    const live: LiveWallEdit = previewWallEdge({
      scene: d.editStartScene,
      wallId: d.wallId,
      delta,
    })

    setStoreScene(live.scene)
    if (key && key !== d.snapKey) fireMagnet()
    d.snapKey = key
    if (live.rejection !== d.rejection) {
      d.rejection = live.rejection
      setRejected(live.rejection !== null)
    }
    invalidate()
  }

  const handlePointerMove = (event: ThreeEvent<PointerEvent>): void => {
    // Cancel a pending wall-tap once the finger pans past the threshold.
    const t = tap.current
    if (t && event.pointerId === t.pointerId) {
      const moved = Math.hypot(
        event.nativeEvent.clientX - t.startX,
        event.nativeEvent.clientY - t.startY,
      )
      if (moved > DRAG_DISTANCE_PX) tap.current = null
    }
    const d = drag.current
    if (!enabled || !d || event.pointerId !== d.pointerId) return
    const { clientX, clientY } = event.nativeEvent
    if (d.mode === 'pending') {
      if (Math.hypot(clientX - d.startClientX, clientY - d.startClientY) <= DRAG_DISTANCE_PX) return
      d.mode = 'drag'
    }
    applyPreview(d, clientX, clientY)
    event.stopPropagation()
  }

  /** Commit a valid pose, or snap back + toast an invalid one; always release. */
  const finishDrag = (): void => {
    const d = drag.current
    if (d && d.mode === 'drag') {
      if (d.rejection === null) {
        const scene = useCanonicalSceneStore.getState().scene
        if (scene) onCommit?.(scene)
      } else {
        setStoreScene(d.editStartScene)
        onInvalid?.(d.rejection)
        haptics.warning()
      }
    }
    drag.current = null
    setLocked(false)
    // Re-enable controls imperatively (the React prop flips it back on the next
    // commit too — both settle to enabled, so they never fight).
    if (controlsRef.current) controlsRef.current.enabled = true
    setEdgeDragging(false)
    setRejected(false)
    setMagnetFlash(false)
  }

  const endPointer = (event: ThreeEvent<PointerEvent>): void => {
    const t = tap.current
    if (t && event.pointerId === t.pointerId) {
      tap.current = null
      const hit = resolveFloorplanTap(event.nativeEvent.clientX, event.nativeEvent.clientY)
      switch (hit.kind) {
        case 'object':
          onSelectObject?.({ host: 'floor', id: hit.id })
          break
        case 'wallObject':
          onSelectObject?.({ host: 'wall', id: hit.id })
          break
        case 'wall':
          onSelectWall?.(hit.id)
          break
        default:
          onSelectWall?.(null)
      }
    }
    const d = drag.current
    if (!d || event.pointerId !== d.pointerId) return
    finishDrag()
    event.stopPropagation()
  }

  // Backstop: a pointerup/cancel ANYWHERE (incl. over empty space, where R3F
  // delivers no group event) finishes the drag + force-releases the lock.
  useEffect(() => {
    if (!enabled) return
    // Guard on pointer identity: a stray SECOND finger lifting (palm/thumb, or
    // the advertised 2-finger pan) must NOT end the active drag. handlePointerDown
    // ignores secondary pointers, so only the drag's / tap's own pointerId may
    // terminate it (mirrors CustomerFurnitureEditLayer).
    const release = (event: PointerEvent): void => {
      if (drag.current && event.pointerId === drag.current.pointerId) finishDrag()
      if (tap.current && event.pointerId === tap.current.pointerId) tap.current = null
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
    // finishDrag closes over stable store setters + props; re-bind on enabled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, onCommit, onInvalid])

  // Edit mode can be turned off (cameraMode leaves 'floorplan', or
  // footprintEditEnabled flips) WHILE a drag is in flight, and this layer is the
  // always-mounted outer wrapper so the unmount cleanup does NOT run. The window
  // backstop above is also torn down on !enabled. Force-finish any in-flight
  // drag on that transition so the lock + controls are never left stuck.
  useEffect(() => {
    if (!enabled && drag.current) finishDrag()
    // Only react to the enabled transition; finishDrag reads drag.current via ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  // Screen-constant handle sizing: unit meshes scaled per frame so their on-screen
  // size stays HANDLE_PX_* regardless of ortho zoom. Force a frame only while
  // dragging (demand frameloop) to keep the live drag crisp.
  useFrame(() => {
    const cam = camera as OrthographicCamera
    if (!cam.isOrthographicCamera) return
    const span = cam.top - cam.bottom
    const sIdle = (HANDLE_PX_IDLE / size.height) * (span / cam.zoom)
    const sActive = (HANDLE_PX_ACTIVE / size.height) * (span / cam.zoom)
    const s = edgeDragging ? sActive : sIdle
    if (barMesh.current) barMesh.current.scale.setScalar(s)
    if (arrowMesh.current) arrowMesh.current.scale.setScalar(s)
    if (drag.current) invalidate()
  })

  let handleColor = COLOR_EDGE
  if (edgeDragging) {
    if (rejected) handleColor = COLOR_REJECT
    else if (magnetFlash) handleColor = COLOR_MAGNET
    else handleColor = COLOR_ACTIVE
  }

  return (
    <group
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointer}
    >
      {children}
      {selectedWallGeom && (
        <lineSegments geometry={selectedWallGeom} renderOrder={5}>
          <lineBasicMaterial color={COLOR_ACTIVE} transparent opacity={0.95} depthTest={false} />
        </lineSegments>
      )}
      {enabled && midBar && (
        <group>
          {/* Bar lying along the wall — the grabbable "Balken". */}
          <mesh
            ref={barMesh}
            position={[midBar.mid.x, 0.07, midBar.mid.z]}
            quaternion={midBar.barQuat}
            renderOrder={6}
          >
            <boxGeometry args={[2.6, 0.5, 0.7]} />
            <meshBasicMaterial color={handleColor} transparent opacity={0.96} depthTest={false} />
          </mesh>
          {/* Arrow pointing out of the room — the slide direction. */}
          <mesh
            ref={arrowMesh}
            position={[midBar.mid.x, 0.08, midBar.mid.z]}
            quaternion={midBar.arrowQuat}
            renderOrder={7}
          >
            <coneGeometry args={[0.7, 1.7, 16]} />
            <meshBasicMaterial color={handleColor} transparent opacity={0.98} depthTest={false} />
          </mesh>
        </group>
      )}
    </group>
  )
}
