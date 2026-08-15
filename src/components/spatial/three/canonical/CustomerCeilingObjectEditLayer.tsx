/**
 * Spatial · Canonical · Three · CustomerCeilingObjectEditLayer (V1.6.1)
 *
 * In-Canvas r3f wrapper that turns a 1-finger drag on the SELECTED ceiling
 * object (lamp / pendant) into a continuous reposition across the ceiling
 * plane. The ceiling sibling of `CustomerFurnitureEditLayer`:
 *
 *   - drag (>8px) on the focused ceiling object → ray-plane intersection at
 *     `Y = ceiling.height_m` (NOT screen-delta — that breaks under the tilted
 *     dollhouse camera). `moveCeilingObject` clamps the XZ into the room.
 *   - NO pinch-scale and NO rotation: a ceiling light's scale/rotation are not
 *     meaningful in this MVP (the renderer only rotates floor/free hosts), so
 *     this layer is drag-only — smaller + lower-risk than the floor layer.
 *
 * Mutates the store LIVE per frame; persistence is deferred to gesture release
 * via `onTransformCommit` → the host's debounced + RBAC-guarded persist tail.
 * Coexists with the floor + wall layers by nesting: each layer only arms when
 * the finger is on ITS focused object id (floor / ceiling are disjoint hosts,
 * and at most one is non-null because the store holds a single focused host).
 */

import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { useThree, type ThreeEvent } from '@react-three/fiber'
import { Raycaster, Vector2 } from 'three'

import {
  PROBE_OFFSETS_PX,
  resolveTappedSurface,
  voteWinner,
  type ProbeSample,
  type TappedSurface,
} from './surfaceTap'
import { bindRaycasterToPickLayer } from './pickLayer'
import { useCanonicalSceneStore } from '../../../../lib/spatial/canonical/store/sceneStore'
import { moveCeilingObject } from '../../../../lib/spatial/canonical/workflow/customerCeilingObjectOrchestrator'
import type { RoomScene } from '../../../../lib/spatial/canonical/types/scene-graph'

/** Drag promotes to move only past this screen distance (mirrors the floor layer). */
const DRAG_DISTANCE_PX = 8

export interface CustomerCeilingObjectEditLayerProps {
  /** `true` only in arrange-mode dollhouse/walk with edit rights — else passthrough. */
  enabled: boolean
  /** Currently focused ceiling object id (the gesture target), else null. */
  selectedObjectId: string | null
  /** Called on gesture release with the live scene → host schedules persist. */
  onTransformCommit?: (scene: RoomScene) => void
  /** Scene content the layer wraps (wall layer + tap layer + SceneRenderer). */
  children?: ReactNode
}

interface PointerInfo {
  clientX: number
  clientY: number
}

interface GestureState {
  mode: 'pending' | 'drag' | 'spent'
  primaryId: number
  armedOnObject: boolean
  startClientX: number
  startClientY: number
  grabOffsetX: number
  grabOffsetZ: number
  committed: boolean
}

/** Probe-only raycaster bound to PICK_LAYER (mirrors the floor layer). */
function useProbeRaycaster(): Raycaster {
  const [raycaster] = useState(() => new Raycaster())
  useEffect(() => {
    bindRaycasterToPickLayer(raycaster)
  }, [raycaster])
  return raycaster
}

export function CustomerCeilingObjectEditLayer({
  enabled,
  selectedObjectId,
  onTransformCommit,
  children,
}: CustomerCeilingObjectEditLayerProps): ReactElement {
  const { camera, scene, gl, invalidate } = useThree()
  const probe = useProbeRaycaster()
  const setStoreScene = useCanonicalSceneStore((s) => s.setScene)
  const setObjectInteractionLocked = useCanonicalSceneStore((s) => s.setObjectInteractionLocked)

  const pointers = useRef<Map<number, PointerInfo>>(new Map())
  const gesture = useRef<GestureState | null>(null)

  // Safety: never leave the camera locked if the layer unmounts mid-gesture.
  useEffect(
    () => () => setObjectInteractionLocked(false),
    [setObjectInteractionLocked],
  )

  // Safety net: a pointerup/cancel ANYWHERE (incl. over the empty background,
  // where R3F delivers no event because the ray hits no mesh) force-releases the
  // camera lock and clears the gesture. Mirrors the identical backstop in the
  // floor + wall layers — without it a finger lifted off-mesh mid-drag leaves
  // `objectInteractionLocked` true forever (camera dead).
  useEffect(() => {
    const release = (event: PointerEvent): void => {
      if (!pointers.current.has(event.pointerId) && !gesture.current) return
      pointers.current.delete(event.pointerId)
      const g = gesture.current
      if (g && g.mode === 'drag' && g.committed) {
        const committed = useCanonicalSceneStore.getState().scene
        if (committed) onTransformCommit?.(committed)
        g.committed = false
      }
      if (pointers.current.size === 0) {
        setObjectInteractionLocked(false)
        gesture.current = null
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
        .scene?.ceiling.ceiling_mounted.find((o) => o.id === selectedObjectId) ?? null
    )
  }

  /** World X/Z under a screen point on the ceiling plane (Y = ceiling height).
   *  Works both looking UP (walk) and looking DOWN from above the ceiling
   *  (dollhouse top-down, even with the auto-cutaway hiding the ceiling mesh):
   *  `t = (ceilingY − origin.y) / dir.y` is positive in both cases. Near-
   *  horizontal rays fall back to a bounded forward projection so we never
   *  freeze; the room-clamp downstream keeps the result sane. */
  const ceilingPointAt = (clientX: number, clientY: number): { x: number; z: number } | null => {
    const rect = gl.domElement.getBoundingClientRect()
    const w = rect.width
    const h = rect.height
    if (w <= 0 || h <= 0) return null
    const ceilingY = useCanonicalSceneStore.getState().scene?.ceiling.height_m ?? 2.5
    const ndc = new Vector2(((clientX - rect.left) / w) * 2 - 1, -(((clientY - rect.top) / h) * 2 - 1))
    probe.setFromCamera(ndc, camera)
    const { origin, direction } = probe.ray
    const EPS = 1e-3
    const MAX_T = 50
    const t =
      Math.abs(direction.y) > EPS
        ? Math.min(Math.max((ceilingY - origin.y) / direction.y, 0), MAX_T)
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
    const fp = ceilingPointAt(clientX, clientY)
    const base = liveScene()
    if (!fp || !base) return
    const result = moveCeilingObject({
      scene: base,
      objectId: selectedObjectId,
      x: fp.x + g.grabOffsetX,
      z: fp.z + g.grabOffsetZ,
    })
    if (result.kind === 'updated') {
      setStoreScene(result.scene)
      g.committed = true
      invalidate()
    } else if (result.kind === 'rejected') {
      // Hold the last valid pose (object bigger than the room — rare).
      invalidate()
    }
  }

  const handlePointerDown = (event: ThreeEvent<PointerEvent>): void => {
    if (!enabled || !selectedObjectId) return
    const native = event.nativeEvent
    pointers.current.set(event.pointerId, { clientX: native.clientX, clientY: native.clientY })
    if (pointers.current.size !== 1) return

    // First pointer: is it on the focused ceiling object? Pre-compute the grab
    // offset so the object does not snap its centre to the finger.
    const armed = objectIdUnderFinger(native.clientX, native.clientY) === selectedObjectId
    let grabOffsetX = 0
    let grabOffsetZ = 0
    if (armed) {
      const fp = ceilingPointAt(native.clientX, native.clientY)
      const obj = liveSelectedObject()
      if (fp && obj) {
        grabOffsetX = (obj.transform?.position?.x ?? 0) - fp.x
        grabOffsetZ = (obj.transform?.position?.z ?? 0) - fp.z
      }
      // Lock the camera the moment a finger lands on the focused object — keeps a
      // 1-finger drag from orbiting.
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
      committed: false,
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
        doDragMove(event.nativeEvent.clientX, event.nativeEvent.clientY, g)
        event.stopPropagation()
      }
    }
  }

  const endPointer = (event: ThreeEvent<PointerEvent>): void => {
    pointers.current.delete(event.pointerId)
    const g = gesture.current
    if (!g) return

    if (g.mode === 'drag') {
      if (g.committed) {
        const committed = liveScene()
        if (committed) onTransformCommit?.(committed)
      }
      // A gesture happened → mark spent so the remaining finger neither drags nor
      // lets a stray tap fire.
      g.mode = 'spent'
      g.armedOnObject = false
      g.committed = false
      event.stopPropagation()
    }

    if (pointers.current.size === 0) {
      setObjectInteractionLocked(false)
      gesture.current = null
    }
  }

  return (
    <group
      name="ceiling-edit-gesture-layer"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
    >
      {children}
    </group>
  )
}
