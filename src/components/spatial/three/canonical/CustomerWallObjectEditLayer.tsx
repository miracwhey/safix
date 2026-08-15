/**
 * Spatial · Canonical · Three · CustomerWallObjectEditLayer (V1.6.1)
 *
 * In-Canvas r3f wrapper that drags the WALL object under the finger along its
 * wall — the parity equivalent of `CustomerFurnitureEditLayer` (floor) for
 * doors/windows (openings) + heating/electrical (wall_mounted).
 *
 *   - 1-finger drag (>8px) on a placed wall object → slides it on the wall
 *     plane (along + vertical). Per-move ray-plane intersection against the
 *     wall plane (NOT screen-delta — wrong under the tilted Dollhouse camera).
 *     Doors stay floor-anchored (vertical locked). Overlap with another wall
 *     object holds the last valid pose + `onReject(message)`.
 *
 * Selection is by GEOMETRY, not pick-kind: openings render as a CSG hole (no
 * own pick proxy), so a wall hit's wall-local offset is tested against the
 * wall's openings/wall_mounted via `findWallObjectAtOffset`. wall_mounted
 * objects additionally resolve directly as a `kind:'object'` pick.
 *
 * Live store mutation per frame (`setScene` + `invalidate`, frameloop="demand");
 * persist deferred to release via `onTransformCommit`. A small tap (<8px) is NOT
 * intercepted → falls through to the host's tap handler (reopen edit sheet).
 * Nests with `CustomerFurnitureEditLayer`; hit sets are disjoint (floor object
 * vs wall/opening), so only one layer ever arms.
 */

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useThree, type ThreeEvent } from '@react-three/fiber'
import { Plane, Raycaster, Vector2, Vector3 } from 'three'

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
  findWallObjectAtOffset,
  wallLengthMeters,
  worldPointToWallLocalOffset,
} from '../../../../lib/spatial/canonical/geometry/wallCoords'
import {
  moveWallMountedObject,
  moveWallObjectToWall,
  moveWallOpening,
} from '../../../../lib/spatial/canonical/workflow/customerWallObjectOrchestrator'
import type { DinWarning } from '../../../../lib/spatial/canonical/validator/wallObjectDinValidator'
import type { RoomScene } from '../../../../lib/spatial/canonical/types/scene-graph'
import type { Wall } from '../../../../lib/spatial/canonical/types/geometry'

const DRAG_DISTANCE_PX = 8

export interface CustomerWallObjectEditLayerProps {
  /** `true` only in dollhouse edit-mode with edit rights — else passthrough. */
  enabled: boolean
  /** Called on drag release with the live scene → host schedules persist. */
  onTransformCommit?: (scene: RoomScene) => void
  /** Called once per drag when a move is rejected (overlap), with the reason. */
  onReject?: (message: string) => void
  /** Called once on drag release with the final pose's DIN soft-warnings (if any). */
  onDinWarning?: (warnings: DinWarning[]) => void
  /** Scene content the layer wraps. */
  children?: ReactNode
}

interface Armed {
  pointerId: number
  wallId: string
  objectId: string
  isOpening: boolean
  /** Doors stay floor-anchored — vertical drag is suppressed. */
  isDoor: boolean
  /** Object pose minus hit pose at grab time, so it doesn't snap to the finger. */
  grabAlong: number
  grabUp: number
  /** Snapshot for the projection math (wall geometry is stable during a drag). */
  wall: Wall
  plane: Plane
  wallLengthM: number
  startClientX: number
  startClientY: number
  mode: 'pending' | 'drag' | 'spent'
  committed: boolean
  rejectSignaled: boolean
  /** Latest DIN soft-warnings from the most recent accepted move; emitted on release. */
  lastWarnings: DinWarning[]
  /** Cross-wall hysteresis: a different wall must win for ≥2 frames before re-host. */
  pendingCrossWallId: string | null
  pendingCrossCount: number
}

/** Probe-only raycaster bound to PICK_LAYER (mirrors SurfaceTapLayer). */
function useProbeRaycaster(): Raycaster {
  const [raycaster] = useState(() => new Raycaster())
  useEffect(() => {
    bindRaycasterToPickLayer(raycaster)
  }, [raycaster])
  return raycaster
}

export function CustomerWallObjectEditLayer({
  enabled,
  onTransformCommit,
  onReject,
  onDinWarning,
  children,
}: CustomerWallObjectEditLayerProps): ReactElement {
  const { camera, scene, gl, invalidate } = useThree()
  const probe = useProbeRaycaster()
  const setStoreScene = useCanonicalSceneStore((s) => s.setScene)
  const setObjectInteractionLocked = useCanonicalSceneStore((s) => s.setObjectInteractionLocked)
  const armed = useRef<Armed | null>(null)

  // Safety: never leave the camera locked if the layer unmounts mid-gesture.
  useEffect(() => () => setObjectInteractionLocked(false), [setObjectInteractionLocked])

  // Safety net: a pointerup/cancel ANYWHERE (incl. over the empty background,
  // where R3F delivers no event to the group because the ray hits no mesh)
  // force-releases the camera lock and clears the gesture. Without this, lifting
  // the finger off-mesh mid-drag would leave `objectInteractionLocked` true
  // forever (camera dead) and `armed.current` set (object un-draggable). On a
  // normal in-canvas release `endPointer` runs first and nulls `armed.current`,
  // so this handler is then a no-op. Mirrors the commit/warn path of endPointer.
  useEffect(() => {
    const release = (event: PointerEvent): void => {
      const a = armed.current
      if (!a || a.pointerId !== event.pointerId) return
      if (a.mode === 'drag' && a.committed) {
        const committed = useCanonicalSceneStore.getState().scene
        if (committed) onTransformCommit?.(committed)
        if (a.lastWarnings.length > 0) onDinWarning?.(a.lastWarnings)
      }
      setObjectInteractionLocked(false)
      armed.current = null
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [onTransformCommit, onDinWarning, setObjectInteractionLocked])

  const liveScene = (): RoomScene | null => useCanonicalSceneStore.getState().scene

  /** 9-point PICK_LAYER probe → winning surface + world hit point. */
  const probeAt = (
    clientX: number,
    clientY: number,
  ): { surface: TappedSurface; point?: { x: number; y: number; z: number } } | null => {
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
      let nearestPoint: { x: number; y: number; z: number } | undefined
      for (const hit of hits) {
        const surface = resolveTappedSurface(hit.object)
        if (!surface) continue
        if (hit.distance < nearestDist) {
          nearest = surface
          nearestDist = hit.distance
          nearestPoint = hit.point ? { x: hit.point.x, y: hit.point.y, z: hit.point.z } : undefined
        }
      }
      samples.push({ surface: nearest, distance: nearestDist, point: nearestPoint })
    }
    return voteWinner(samples)
  }

  /** Build the wall plane (vertical, through the wall centerline). */
  const wallPlane = (wall: Wall): Plane => {
    const n = new Vector3(wall.normal?.x ?? 0, 0, wall.normal?.z ?? 1)
    if (n.lengthSq() < 1e-9) n.set(0, 0, 1)
    n.normalize()
    return new Plane().setFromNormalAndCoplanarPoint(
      n,
      new Vector3(wall.start_point.x, 0, wall.start_point.z),
    )
  }

  /** Resolve the wall object under the finger into an armed drag state. */
  const armFromProbe = (clientX: number, clientY: number): Armed | null => {
    const hit = probeAt(clientX, clientY)
    const base = liveScene()
    if (!hit?.point || !base) return null

    let wall: Wall | undefined
    if (hit.surface.kind === 'wall') {
      wall = base.walls.find((w) => w.id === hit.surface.nodeId)
    } else if (hit.surface.kind === 'object') {
      wall = base.walls.find((w) => w.wall_mounted.some((o) => o.id === hit.surface.nodeId))
    }
    if (!wall) return null

    const wallLengthM = wallLengthMeters(wall)
    const local = worldPointToWallLocalOffset(wall, hit.point, wallLengthM, wall.height_m)

    const target =
      hit.surface.kind === 'object'
        ? ({ kind: 'wall_mounted', id: hit.surface.nodeId } as const)
        : findWallObjectAtOffset(wall, local)
    if (!target) return null

    const common = {
      pointerId: -1,
      wallId: wall.id,
      wall,
      plane: wallPlane(wall),
      wallLengthM,
      startClientX: clientX,
      startClientY: clientY,
      mode: 'pending' as const,
      committed: false,
      rejectSignaled: false,
      lastWarnings: [] as DinWarning[],
      pendingCrossWallId: null as string | null,
      pendingCrossCount: 0,
    }

    if (target.kind === 'opening') {
      const op = wall.openings.find((o) => o.id === target.id)
      if (!op) return null
      return {
        ...common,
        objectId: op.id,
        isOpening: true,
        isDoor: op.type !== 'window',
        grabAlong: op.offset_along_wall_m - local.offset_along_wall_m,
        grabUp: op.offset_from_floor_m - local.offset_from_floor_m,
      }
    }
    const obj = wall.wall_mounted.find((o) => o.id === target.id)
    if (!obj) return null
    return {
      ...common,
      objectId: obj.id,
      isOpening: false,
      isDoor: false,
      grabAlong: (obj.offset_along_wall_m ?? 0) - local.offset_along_wall_m,
      grabUp: (obj.height_from_floor_m ?? 0) - local.offset_from_floor_m,
    }
  }

  const doDrag = (clientX: number, clientY: number, a: Armed): void => {
    const rect = gl.domElement.getBoundingClientRect()
    const w = rect.width
    const h = rect.height
    if (w <= 0 || h <= 0) return
    const base = liveScene()
    if (!base) return

    // Probe the surface under the finger. A WALL hit (any wall) drives the move
    // — same wall → slide; a DIFFERENT wall → cross-wall re-host. Object/floor
    // hits (incl. the dragged object occluding itself) are ignored so the drag
    // never gets stuck on its own mesh; we then fall back to the armed wall's
    // plane so a same-wall slide keeps working when no wall proxy is hit.
    const hit = probeAt(clientX, clientY)
    let wall: Wall | undefined
    let worldHit: { x: number; y: number; z: number } | undefined
    let usedFallback = false
    if (hit?.point && hit.surface.kind === 'wall') {
      const w2 = base.walls.find((x) => x.id === hit.surface.nodeId)
      if (w2) {
        wall = w2
        worldHit = hit.point
      }
    }
    if (!wall || !worldHit) {
      // Fallback: stay on the armed wall via its plane (tilt-correct).
      usedFallback = true
      const ndc = new Vector2(((clientX - rect.left) / w) * 2 - 1, -(((clientY - rect.top) / h) * 2 - 1))
      probe.setFromCamera(ndc, camera)
      const wp = new Vector3()
      if (!probe.ray.intersectPlane(a.plane, wp)) return
      wall = a.wall
      worldHit = { x: wp.x, y: wp.y, z: wp.z }
    }

    const wallLengthM = wall.id === a.wallId ? a.wallLengthM : wallLengthMeters(wall)
    const local = worldPointToWallLocalOffset(wall, worldHit, wallLengthM, wall.height_m)
    // Near a corner the camera can project the plane-fallback ray far off the
    // armed wall. Instead of freezing the frame (drag felt stuck at corners), we
    // clamp the along-offset to the wall span so the object glides to the wall
    // end and holds there. Real wall-proxy hits are trusted as-is (only the
    // tilt-correct plane fallback can escape the segment).
    if (usedFallback) {
      local.offset_along_wall_m = Math.min(Math.max(local.offset_along_wall_m, 0), wallLengthM)
    }
    const crossing = wall.id !== a.wallId
    // Cross-wall hysteresis: a real hit on a DIFFERENT wall must persist for 2
    // consecutive frames before we re-host. Kills the single-frame vote-flip
    // ping-pong when the finger hovers a shared corner between two walls.
    if (crossing) {
      if (a.pendingCrossWallId === wall.id) {
        a.pendingCrossCount += 1
      } else {
        a.pendingCrossWallId = wall.id
        a.pendingCrossCount = 1
      }
      if (a.pendingCrossCount < 2) return
    } else {
      a.pendingCrossWallId = null
      a.pendingCrossCount = 0
    }
    // On a cross the grab offset (computed for the old wall's axis) no longer
    // applies — drop the object at the finger's local offset on the new wall.
    const along = crossing ? local.offset_along_wall_m : local.offset_along_wall_m + a.grabAlong
    const up = a.isDoor
      ? 0
      : crossing
        ? local.offset_from_floor_m
        : local.offset_from_floor_m + a.grabUp

    const result = crossing
      ? moveWallObjectToWall({
          scene: base,
          objectId: a.objectId,
          isOpening: a.isOpening,
          fromWallId: a.wallId,
          toWallId: wall.id,
          offsetAlongWallM: along,
          offsetFromFloorM: up,
        })
      : a.isOpening
        ? moveWallOpening({
            scene: base,
            wallId: a.wallId,
            openingId: a.objectId,
            offsetAlongWallM: along,
            offsetFromFloorM: up,
          })
        : moveWallMountedObject({
            scene: base,
            wallId: a.wallId,
            objectId: a.objectId,
            offsetAlongWallM: along,
            offsetFromFloorM: up,
          })

    if (result.kind === 'updated') {
      setStoreScene(result.scene)
      a.committed = true
      // Re-arm the reject toast: a later genuine overlap in the SAME drag should
      // warn again instead of being swallowed by the first reject's latch.
      a.rejectSignaled = false
      a.lastWarnings = result.warnings
      if (crossing) {
        // Adopt the new wall + recompute the grab offset from the moved object's
        // actual pose so continued sliding on the new wall stays under the finger.
        const movedWall = result.scene.walls.find((x) => x.id === wall.id)
        const movedAlong = a.isOpening
          ? movedWall?.openings.find((o) => o.id === a.objectId)?.offset_along_wall_m
          : movedWall?.wall_mounted.find((o) => o.id === a.objectId)?.offset_along_wall_m
        const movedUp = a.isOpening
          ? movedWall?.openings.find((o) => o.id === a.objectId)?.offset_from_floor_m
          : movedWall?.wall_mounted.find((o) => o.id === a.objectId)?.height_from_floor_m
        a.wallId = wall.id
        a.wall = wall
        a.plane = wallPlane(wall)
        a.wallLengthM = wallLengthM
        a.grabAlong = (movedAlong ?? local.offset_along_wall_m) - local.offset_along_wall_m
        a.grabUp = (movedUp ?? local.offset_from_floor_m) - local.offset_from_floor_m
      }
      invalidate()
    } else if (result.kind === 'rejected') {
      if (!a.rejectSignaled) {
        a.rejectSignaled = true
        onReject?.(result.message)
      }
      invalidate()
    }
  }

  const handlePointerDown = (event: ThreeEvent<PointerEvent>): void => {
    if (!enabled || armed.current) return
    const native = event.nativeEvent
    const a = armFromProbe(native.clientX, native.clientY)
    if (!a) return
    a.pointerId = event.pointerId
    armed.current = a
    // Lock camera the moment a finger lands on a wall object (no orbit while
    // dragging). Released on up/cancel; no stopPropagation yet so a small tap
    // still reaches the host's reopen-edit path.
    setObjectInteractionLocked(true)
  }

  const handlePointerMove = (event: ThreeEvent<PointerEvent>): void => {
    const a = armed.current
    if (!a || a.pointerId !== event.pointerId) return
    if (a.mode === 'drag') {
      doDrag(event.nativeEvent.clientX, event.nativeEvent.clientY, a)
      event.stopPropagation()
      return
    }
    if (a.mode === 'pending') {
      const dx = event.nativeEvent.clientX - a.startClientX
      const dy = event.nativeEvent.clientY - a.startClientY
      if (Math.hypot(dx, dy) > DRAG_DISTANCE_PX) {
        a.mode = 'drag'
        doDrag(event.nativeEvent.clientX, event.nativeEvent.clientY, a)
        event.stopPropagation()
      }
    }
  }

  const endPointer = (event: ThreeEvent<PointerEvent>): void => {
    const a = armed.current
    if (!a || a.pointerId !== event.pointerId) return
    if (a.mode === 'drag') {
      if (a.committed) {
        const committed = liveScene()
        if (committed) onTransformCommit?.(committed)
        if (a.lastWarnings.length > 0) onDinWarning?.(a.lastWarnings)
      }
      event.stopPropagation()
    }
    setObjectInteractionLocked(false)
    armed.current = null
  }

  return (
    <group
      name="customer-wall-object-edit-layer"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
    >
      {children}
    </group>
  )
}
