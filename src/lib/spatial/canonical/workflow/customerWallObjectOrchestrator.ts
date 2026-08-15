/**
 * Customer wall-object move orchestration — PURE domain layer (V1.6.1).
 *
 * Direct-manipulation drag for WALL objects (openings = doors/windows,
 * wall_mounted = heating/electrical), mirroring `customerFurnitureOrchestrator`
 * for floor furniture. Each function takes an absolute wall-local target,
 * clamps it into the wall, applies the mutation, then re-validates against the
 * wall (out-of-wall / ceiling / floor / AABB-overlap with the OTHER objects).
 *
 * `excludeId` is mandatory in the validation — without it the object being
 * dragged would always overlap itself and every move would be rejected.
 *
 * ZERO React / zustand / three.js / supabase imports — the gesture layer
 * applies the store write / persist / toast.
 */
import {
  addOpeningToWall,
  addWallMountedObjectToWall,
  removeOpeningFromWall,
  removeWallMountedObjectFromWall,
  updateOpeningInWall,
  updateWallMountedObjectInWall,
} from '../mutations/customerObjectMutator'
import {
  aabbForOpening,
  aabbForWallMounted,
  validateObjectPosition,
} from '../validator/objectPositionValidator'
import {
  evaluateWallObjectDin,
  snapWallObjectVerticalToDin,
  type DinWarning,
} from '../validator/wallObjectDinValidator'
import { clampOffsetForObject, wallLengthMeters } from '../geometry/wallCoords'
import type { RoomScene } from '../types/scene-graph'
import type { WallOpening } from '../types/geometry'
import type { SpatialObject } from '../types/objects'

export type WallObjectMoveResult =
  | { kind: 'updated'; scene: RoomScene; warnings: DinWarning[] }
  | { kind: 'rejected'; message: string }
  | { kind: 'missing' }

function clamp(value: number, lo: number, hi: number): number {
  if (hi < lo) return lo
  return Math.max(lo, Math.min(hi, value))
}

/**
 * Move a wall opening (door/window) to an absolute wall-local pose. Both axes
 * are clamped into the wall so a drag slides to the edge instead of rejecting;
 * only an AABB-overlap with another object on the wall rejects (caller holds
 * the last valid pose). `offsetAlongWallM` is the LEFT edge.
 */
export function moveWallOpening(input: {
  scene: RoomScene
  wallId: string
  openingId: string
  offsetAlongWallM: number
  offsetFromFloorM: number
}): WallObjectMoveResult {
  const wall = input.scene.walls.find((w) => w.id === input.wallId)
  if (!wall) return { kind: 'missing' }
  const opening = wall.openings.find((o) => o.id === input.openingId)
  if (!opening) return { kind: 'missing' }
  const wallLengthM = wallLengthMeters(wall)
  const along = clampOffsetForObject(input.offsetAlongWallM, opening.width_m, wallLengthM)
  const up = clamp(input.offsetFromFloorM, 0, wall.height_m - opening.height_m)
  const next = updateOpeningInWall(input.scene, {
    wallId: input.wallId,
    openingId: input.openingId,
    patch: { offset_along_wall_m: along, offset_from_floor_m: up },
  })
  const nextWall = next.walls.find((w) => w.id === input.wallId)
  const nextOpening = nextWall?.openings.find((o) => o.id === input.openingId)
  let warnings: DinWarning[] = []
  if (nextWall && nextOpening) {
    const validation = validateObjectPosition({
      wall: nextWall,
      wallLengthM,
      candidate: aabbForOpening(nextOpening),
      excludeId: input.openingId,
    })
    if (!validation.ok) return { kind: 'rejected', message: validation.message }
    warnings = evaluateWallObjectDin({
      wall: nextWall,
      wallLengthM,
      candidate: { kind: 'opening', opening: nextOpening },
      excludeId: input.openingId,
      roomCategory: input.scene.category,
    })
  }
  return { kind: 'updated', scene: next, warnings }
}

/**
 * Move a wall-mounted object (heating/electrical) to an absolute wall-local
 * pose. Same clamp + overlap-validate contract as `moveWallOpening`.
 */
export function moveWallMountedObject(input: {
  scene: RoomScene
  wallId: string
  objectId: string
  offsetAlongWallM: number
  offsetFromFloorM: number
}): WallObjectMoveResult {
  const wall = input.scene.walls.find((w) => w.id === input.wallId)
  if (!wall) return { kind: 'missing' }
  const obj = wall.wall_mounted.find((o) => o.id === input.objectId)
  if (!obj) return { kind: 'missing' }
  const wallLengthM = wallLengthMeters(wall)
  const along = clampOffsetForObject(input.offsetAlongWallM, obj.dimensions.width_m, wallLengthM)
  // DIN auto-snap (switch→1,05 m / outlet→0,30|1,10 m) magnetizes the vertical
  // axis NEAR a reference height before the wall-bounds clamp; doors/windows/
  // radiators pass through unchanged.
  const snappedUp = snapWallObjectVerticalToDin(obj.category, input.offsetFromFloorM)
  const up = clamp(snappedUp, 0, wall.height_m - obj.dimensions.height_m)
  const next = updateWallMountedObjectInWall(input.scene, {
    wallId: input.wallId,
    objectId: input.objectId,
    patch: { offset_along_wall_m: along, height_from_floor_m: up },
  })
  const nextWall = next.walls.find((w) => w.id === input.wallId)
  const nextObj = nextWall?.wall_mounted.find((o) => o.id === input.objectId)
  let warnings: DinWarning[] = []
  if (nextWall && nextObj) {
    const candidate = aabbForWallMounted(nextObj)
    if (candidate) {
      const validation = validateObjectPosition({
        wall: nextWall,
        wallLengthM,
        candidate,
        excludeId: input.objectId,
      })
      if (!validation.ok) return { kind: 'rejected', message: validation.message }
    }
    warnings = evaluateWallObjectDin({
      wall: nextWall,
      wallLengthM,
      candidate: { kind: 'wall_mounted', object: nextObj },
      excludeId: input.objectId,
      roomCategory: input.scene.category,
    })
  }
  return { kind: 'updated', scene: next, warnings }
}

/**
 * Re-host a wall object (opening OR wall_mounted) from one wall onto another at
 * an absolute wall-local pose on the TARGET wall. Atomic: build the candidate
 * scene (remove from old + add re-hosted to new), then validate on the target
 * wall — on reject NOTHING is applied (the caller keeps the object on its old
 * wall at the last valid pose). `offsetAlongWallM` is the LEFT edge on the
 * target wall; both axes are clamped into the target wall.
 *
 * Re-host rewrites every host reference (`parent_id` + `host_wall_id`/`host_id`)
 * and re-projects the offsets onto the target wall — the move-target offsets are
 * already wall-local to the TARGET (the gesture layer projected the world hit
 * onto the target wall). Overlap is checked against the OTHER objects on the
 * target wall (`excludeId` skips the just-added self).
 */
export function moveWallObjectToWall(input: {
  scene: RoomScene
  objectId: string
  isOpening: boolean
  fromWallId: string
  toWallId: string
  offsetAlongWallM: number
  offsetFromFloorM: number
}): WallObjectMoveResult {
  const fromWall = input.scene.walls.find((w) => w.id === input.fromWallId)
  const toWall = input.scene.walls.find((w) => w.id === input.toWallId)
  if (!fromWall || !toWall) return { kind: 'missing' }
  const toWallLengthM = wallLengthMeters(toWall)

  if (input.isOpening) {
    const op = fromWall.openings.find((o) => o.id === input.objectId)
    if (!op) return { kind: 'missing' }
    const along = clampOffsetForObject(input.offsetAlongWallM, op.width_m, toWallLengthM)
    const up = clamp(input.offsetFromFloorM, 0, toWall.height_m - op.height_m)
    const rehosted: WallOpening = {
      ...op,
      parent_id: input.toWallId,
      host_wall_id: input.toWallId,
      offset_along_wall_m: along,
      offset_from_floor_m: up,
    }
    let next = removeOpeningFromWall(input.scene, {
      wallId: input.fromWallId,
      openingId: input.objectId,
    })
    next = addOpeningToWall(next, { wallId: input.toWallId, opening: rehosted })
    const nextWall = next.walls.find((w) => w.id === input.toWallId)
    const nextOpening = nextWall?.openings.find((o) => o.id === input.objectId)
    if (!nextWall || !nextOpening) return { kind: 'missing' }
    const validation = validateObjectPosition({
      wall: nextWall,
      wallLengthM: toWallLengthM,
      candidate: aabbForOpening(nextOpening),
      excludeId: input.objectId,
    })
    if (!validation.ok) return { kind: 'rejected', message: validation.message }
    const warnings = evaluateWallObjectDin({
      wall: nextWall,
      wallLengthM: toWallLengthM,
      candidate: { kind: 'opening', opening: nextOpening },
      excludeId: input.objectId,
      roomCategory: input.scene.category,
    })
    return { kind: 'updated', scene: next, warnings }
  }

  const obj = fromWall.wall_mounted.find((o) => o.id === input.objectId)
  if (!obj) return { kind: 'missing' }
  const along = clampOffsetForObject(input.offsetAlongWallM, obj.dimensions.width_m, toWallLengthM)
  const snappedUp = snapWallObjectVerticalToDin(obj.category, input.offsetFromFloorM)
  const up = clamp(snappedUp, 0, toWall.height_m - obj.dimensions.height_m)
  const rehosted: SpatialObject = {
    ...obj,
    parent_id: input.toWallId,
    host_id: input.toWallId,
    offset_along_wall_m: along,
    height_from_floor_m: up,
  }
  let next = removeWallMountedObjectFromWall(input.scene, {
    wallId: input.fromWallId,
    objectId: input.objectId,
  })
  next = addWallMountedObjectToWall(next, { wallId: input.toWallId, object: rehosted })
  const nextWall = next.walls.find((w) => w.id === input.toWallId)
  const nextObj = nextWall?.wall_mounted.find((o) => o.id === input.objectId)
  if (!nextWall || !nextObj) return { kind: 'missing' }
  const candidate = aabbForWallMounted(nextObj)
  if (candidate) {
    const validation = validateObjectPosition({
      wall: nextWall,
      wallLengthM: toWallLengthM,
      candidate,
      excludeId: input.objectId,
    })
    if (!validation.ok) return { kind: 'rejected', message: validation.message }
  }
  const warnings = evaluateWallObjectDin({
    wall: nextWall,
    wallLengthM: toWallLengthM,
    candidate: { kind: 'wall_mounted', object: nextObj },
    excludeId: input.objectId,
    roomCategory: input.scene.category,
  })
  return { kind: 'updated', scene: next, warnings }
}
