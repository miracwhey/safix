/**
 * Spatial · Canonical · Three · CustomerFurnitureEditLayer (V1.6.1 Phase 5a/5b)
 *
 * In-Canvas r3f wrapper that turns finger gestures on the SELECTED floor object
 * into direct manipulation:
 *
 *   - 1-Finger-Drag (>8px) on the selected object → continuous reposition on the
 *     floor plane (per-move ray-plane intersection, NOT screen-delta — that
 *     breaks under the tilted Dollhouse camera). Out-of-bounds holds the last
 *     valid pose + a red footprint + `onOutOfBounds` signal.
 *   - 2-Finger-Pinch while the first finger is on the selected object → uniform
 *     scale (distance-ratio × start-scale, clamped). Disambiguation: a pinch in
 *     empty space leaves the camera untouched (OrbitControls dolly/zoom).
 *
 * The layer mutates the store LIVE per frame (`setScene` + `invalidate()` — the
 * canvas is `frameloop="demand"`). Persistence is deferred to gesture release
 * via `onTransformCommit` → the host's debounced + RBAC-guarded persist tail.
 *
 * Coexistence with `SurfaceTapLayer`: this layer is the OUTER wrapper; it never
 * pre-empts a small tap (it only arms a drag past the 8px threshold, by which
 * point the inner tap-classifier has already self-cancelled). Taps that are not
 * on the selected object fall straight through to tap-select / camera-orbit.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { useThree, type ThreeEvent } from '@react-three/fiber'
import {
  BufferGeometry,
  Float32BufferAttribute,
  Raycaster,
  Vector2,
} from 'three'

import {
  PROBE_OFFSETS_PX,
  resolveTappedSurface,
  voteWinner,
  type ProbeSample,
  type TappedSurface,
} from './surfaceTap'
import { bindRaycasterToPickLayer } from './pickLayer'
import { useCanonicalSceneStore } from '../../../../lib/spatial/canonical/store/sceneStore'
import {
  moveFurniture,
  setFurnitureScale,
} from '../../../../lib/spatial/canonical/workflow/customerFurnitureOrchestrator'
import { floorFootprintCorners } from '../../../../lib/spatial/canonical/validator/objectPositionValidator'
import type { RoomScene } from '../../../../lib/spatial/canonical/types/scene-graph'

/** Drag promotes to move only past this screen distance (mirrors SurfaceTapLayer). */
const DRAG_DISTANCE_PX = 8

export interface CustomerFurnitureEditLayerProps {
  /** `true` only in dollhouse edit-mode with edit rights — else pure passthrough. */
  enabled: boolean
  /** Currently selected floor object id (the gesture target). */
  selectedObjectId: string | null
  /** Called on gesture release with the live scene → host schedules persist. */
  onTransformCommit?: (scene: RoomScene) => void
  /** Called once per drag when the move first leaves the room (host toasts). */
  onOutOfBounds?: () => void
  /** Scene content the layer wraps (SurfaceTapLayer + SceneRenderer). */
  children?: ReactNode
}

interface PointerInfo {
  clientX: number
  clientY: number
}

interface GestureState {
  mode: 'pending' | 'drag' | 'pinch' | 'spent'
  primaryId: number
  armedOnObject: boolean
  startClientX: number
  startClientY: number
  grabOffsetX: number
  grabOffsetZ: number
  pinchStartDist: number
  pinchStartScale: number
  committed: boolean
  outOfBoundsSignaled: boolean
}

/** Probe-only raycaster bound to PICK_LAYER (mirrors SurfaceTapLayer). */
function useProbeRaycaster(): Raycaster {
  const [raycaster] = useState(() => new Raycaster())
  useEffect(() => {
    bindRaycasterToPickLayer(raycaster)
  }, [raycaster])
  return raycaster
}

/**
 * Green/red footprint loop at the live object's rotated+scaled floor footprint.
 * Reuses the validator's `floorFootprintCorners` so the indicator matches the
 * exact polygon the bounds-check uses.
 */
function FootprintIndicator({
  objectId,
  valid,
}: {
  objectId: string
  valid: boolean
}): ReactElement | null {
  const object = useCanonicalSceneStore(
    (s) => s.scene?.floor.floor_mounted.find((o) => o.id === objectId) ?? null,
  )
  const geometry = useMemo(() => {
    if (!object) return null
    const corners = floorFootprintCorners(object)
    const positions: number[] = []
    for (const c of corners) positions.push(c.x, 0.02, c.z)
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(positions, 3))
    return g
  }, [object])
  useEffect(() => () => geometry?.dispose(), [geometry])
  if (!geometry) return null
  return (
    <lineLoop geometry={geometry} renderOrder={3}>
      <lineBasicMaterial
        color={valid ? '#34d399' : '#f43f5e'}
        transparent
        opacity={0.95}
        depthTest={false}
      />
    </lineLoop>
  )
}

export function CustomerFurnitureEditLayer({
  enabled,
  selectedObjectId,
  onTransformCommit,
  onOutOfBounds,
  children,
}: CustomerFurnitureEditLayerProps): ReactElement {
  const { camera, scene, gl, invalidate } = useThree()
  const probe = useProbeRaycaster()
  const setStoreScene = useCanonicalSceneStore((s) => s.setScene)
  const setObjectInteractionLocked = useCanonicalSceneStore((s) => s.setObjectInteractionLocked)

  const pointers = useRef<Map<number, PointerInfo>>(new Map())
  const gesture = useRef<GestureState | null>(null)
  // Footprint visibility + validity (low-frequency: flips on boundary crossing).
  const [footprint, setFootprint] = useState<{ valid: boolean } | null>(null)

  // Safety: never leave the camera locked if the layer unmounts mid-gesture.
  useEffect(
    () => () => setObjectInteractionLocked(false),
    [setObjectInteractionLocked],
  )

  // Safety net: a pointerup/cancel ANYWHERE (incl. over the empty background,
  // where R3F delivers NO event to the group because the ray hits no mesh)
  // force-releases the camera lock and clears the gesture. Without this, lifting
  // the finger off-mesh mid-drag/pinch — very common with the tilted Dollhouse
  // camera + a small object + multi-touch — leaves `objectInteractionLocked`
  // true forever (camera dead: DollhouseController disables orbit + zoom), so the
  // 3D view appears frozen after a few taps / a pinch on the object. Mirrors the
  // identical backstop in CustomerWallObjectEditLayer. On a normal in-canvas
  // release `endPointer` runs first and empties `pointers`, so this then only
  // confirms the terminal cleanup (idempotent).
  useEffect(() => {
    const release = (event: PointerEvent): void => {
      if (!pointers.current.has(event.pointerId) && !gesture.current) return
      pointers.current.delete(event.pointerId)
      const g = gesture.current
      if (g && (g.mode === 'drag' || g.mode === 'pinch') && g.committed) {
        const committed = useCanonicalSceneStore.getState().scene
        if (committed) onTransformCommit?.(committed)
        g.committed = false
      }
      if (pointers.current.size === 0) {
        setObjectInteractionLocked(false)
        gesture.current = null
        setFootprint(null)
      }
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [onTransformCommit, setObjectInteractionLocked])

  const liveScene = (): RoomScene | null => useCanonicalSceneStore.getState().scene
  const liveSelectedObject = () => {
    if (!selectedObjectId) return null
    return (
      useCanonicalSceneStore
        .getState()
        .scene?.floor.floor_mounted.find((o) => o.id === selectedObjectId) ?? null
    )
  }

  const setFootprintValidity = (valid: boolean): void => {
    setFootprint((prev) => (prev && prev.valid === valid ? prev : { valid }))
  }

  /** World floor X/Z under a screen point (ray-plane, tilt-correct).
   *  Horizon-robust: when the finger drags toward the horizon the ray turns
   *  near-parallel to the floor → `intersectPlane` returns null (freeze) or a
   *  point at infinity (fling). Both broke the drag. We instead clamp the ray
   *  parameter `t` to a bounded range and always return a point; `moveFurniture`
   *  then slides the object flush into the room, so it glides to the far wall
   *  and holds there instead of freezing or flying off. */
  const floorPointAt = (clientX: number, clientY: number): { x: number; z: number } | null => {
    const rect = gl.domElement.getBoundingClientRect()
    const w = rect.width
    const h = rect.height
    if (w <= 0 || h <= 0) return null
    const ndc = new Vector2(((clientX - rect.left) / w) * 2 - 1, -(((clientY - rect.top) / h) * 2 - 1))
    probe.setFromCamera(ndc, camera)
    const { origin, direction } = probe.ray
    const EPS = 1e-3
    const MAX_T = 50
    // Floor plane y=0: t = -origin.y / dir.y. dir.y < 0 → looking down (normal
    // case). Near-parallel / upward → bounded projection ahead so we never
    // freeze; the room-clamp downstream keeps the result sane.
    const t =
      direction.y < -EPS
        ? Math.min(Math.max(-origin.y / direction.y, 0), MAX_T)
        : MAX_T
    return { x: origin.x + direction.x * t, z: origin.z + direction.z * t }
  }

  /** Nearest object id under a screen point via the 9-point pick probe. */
  const objectIdUnderFinger = (clientX: number, clientY: number): string | null => {
    const rect = gl.domElement.getBoundingClientRect()
    const w = rect.width
    const h = rect.height
    if (w <= 0 || h <= 0) return null
    const baseX = clientX - rect.left
    const baseY = clientY - rect.top
    const ndc = new Vector2()
    const samples: ProbeSample[] = []
    for (const [dx, dy] of PROBE_OFFSETS_PX) {
      ndc.set(((baseX + dx) / w) * 2 - 1, -(((baseY + dy) / h) * 2 - 1))
      probe.setFromCamera(ndc, camera)
      const hits = probe.intersectObjects(scene.children, true)
      let nearest: TappedSurface | null = null
      let nearestDist = Number.POSITIVE_INFINITY
      for (const hit of hits) {
        const surface = resolveTappedSurface(hit.object)
        if (!surface) continue
        if (hit.distance < nearestDist) {
          nearest = surface
          nearestDist = hit.distance
        }
      }
      samples.push({ surface: nearest, distance: nearestDist })
    }
    const winner = voteWinner(samples)
    return winner && winner.surface.kind === 'object' ? winner.surface.nodeId : null
  }

  const doDragMove = (clientX: number, clientY: number, g: GestureState): void => {
    if (!selectedObjectId) return
    const fp = floorPointAt(clientX, clientY)
    const base = liveScene()
    if (!fp || !base) return
    const result = moveFurniture({
      scene: base,
      objectId: selectedObjectId,
      x: fp.x + g.grabOffsetX,
      z: fp.z + g.grabOffsetZ,
    })
    if (result.kind === 'updated') {
      setStoreScene(result.scene)
      g.committed = true
      setFootprintValidity(true)
      invalidate()
    } else if (result.kind === 'rejected') {
      // Hold the last valid pose; flag the breach once per drag.
      setFootprintValidity(false)
      if (!g.outOfBoundsSignaled) {
        g.outOfBoundsSignaled = true
        onOutOfBounds?.()
      }
      invalidate()
    }
  }

  const handlePointerDown = (event: ThreeEvent<PointerEvent>): void => {
    if (!enabled || !selectedObjectId) return
    const native = event.nativeEvent
    pointers.current.set(event.pointerId, { clientX: native.clientX, clientY: native.clientY })

    // Second pointer while armed on the object → pinch-to-scale.
    if (pointers.current.size === 2 && gesture.current?.armedOnObject) {
      const pts = [...pointers.current.values()]
      const dist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY)
      const obj = liveSelectedObject()
      gesture.current.mode = 'pinch'
      gesture.current.pinchStartDist = dist || 1
      gesture.current.pinchStartScale = obj?.transform?.scale?.x ?? 1
      setObjectInteractionLocked(true)
      event.stopPropagation()
      return
    }

    if (pointers.current.size !== 1) return

    // First pointer: is it on the selected object? Pre-compute the grab offset so
    // the object does not snap its centre to the finger.
    const armed = objectIdUnderFinger(native.clientX, native.clientY) === selectedObjectId
    let grabOffsetX = 0
    let grabOffsetZ = 0
    if (armed) {
      const fp = floorPointAt(native.clientX, native.clientY)
      const obj = liveSelectedObject()
      if (fp && obj) {
        grabOffsetX = (obj.transform?.position?.x ?? 0) - fp.x
        grabOffsetZ = (obj.transform?.position?.z ?? 0) - fp.z
      }
      // Lock the camera the moment a finger lands on the selected object — keeps
      // a 1-finger drag from orbiting and arms the pinch-vs-zoom disambiguation.
      setObjectInteractionLocked(true)
    }
    gesture.current = {
      mode: 'pending',
      primaryId: event.pointerId,
      armedOnObject: armed,
      startClientX: native.clientX,
      startClientY: native.clientY,
      grabOffsetX,
      grabOffsetZ,
      pinchStartDist: 0,
      pinchStartScale: 1,
      committed: false,
      outOfBoundsSignaled: false,
    }
    // No stopPropagation: a small tap must still reach the inner tap-layer.
  }

  const handlePointerMove = (event: ThreeEvent<PointerEvent>): void => {
    const info = pointers.current.get(event.pointerId)
    if (!info) return
    info.clientX = event.nativeEvent.clientX
    info.clientY = event.nativeEvent.clientY
    const g = gesture.current
    if (!g) return

    if (g.mode === 'pinch') {
      const pts = [...pointers.current.values()]
      if (pts.length < 2 || !selectedObjectId) return
      const dist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY)
      const base = liveScene()
      if (!base) return
      const result = setFurnitureScale({
        scene: base,
        objectId: selectedObjectId,
        scale: g.pinchStartScale * (dist / (g.pinchStartDist || 1)),
      })
      if (result.kind === 'updated') {
        setStoreScene(result.scene)
        g.committed = true
        invalidate()
      }
      event.stopPropagation()
      return
    }

    if (g.mode === 'drag') {
      doDragMove(info.clientX, info.clientY, g)
      event.stopPropagation()
      return
    }

    if (g.mode === 'pending' && g.armedOnObject && event.pointerId === g.primaryId) {
      const dx = event.nativeEvent.clientX - g.startClientX
      const dy = event.nativeEvent.clientY - g.startClientY
      if (Math.hypot(dx, dy) > DRAG_DISTANCE_PX) {
        g.mode = 'drag'
        setObjectInteractionLocked(true)
        setFootprint({ valid: true })
        doDragMove(event.nativeEvent.clientX, event.nativeEvent.clientY, g)
        event.stopPropagation()
      }
    }
  }

  const endPointer = (event: ThreeEvent<PointerEvent>): void => {
    pointers.current.delete(event.pointerId)
    const g = gesture.current
    if (!g) return

    if (g.mode === 'drag' || g.mode === 'pinch') {
      if (g.committed) {
        const committed = liveScene()
        if (committed) onTransformCommit?.(committed)
      }
      // A gesture happened → mark spent so the remaining finger neither drags
      // nor lets a stray tap fire.
      g.mode = 'spent'
      g.armedOnObject = false
      g.committed = false
      event.stopPropagation()
    }

    if (pointers.current.size === 0) {
      setObjectInteractionLocked(false)
      gesture.current = null
      setFootprint(null)
    }
  }

  return (
    <group
      name="furniture-edit-gesture-layer"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
    >
      {children}
      {footprint && selectedObjectId && (
        <FootprintIndicator objectId={selectedObjectId} valid={footprint.valid} />
      )}
    </group>
  )
}
