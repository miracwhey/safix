/**
 * Customer ceiling-object edit orchestration — PURE domain layer (V1.6.1).
 *
 * Mirror of `customerFurnitureOrchestrator` for ceiling-mounted objects
 * (lamps / pendants / chandeliers). Ceiling objects live in
 * `scene.ceiling.ceiling_mounted` with `host='ceiling'`; the renderer derives
 * their world-Y from `ceilingY − h/2` (ObjectAdapter), so a move only writes
 * the XZ of `transform.position` — Y stays untouched.
 *
 * Re-edit/drag was deferred in the original Customer-Hub build (only placement
 * + render existed). This adds the move + delete domain entry points so the
 * `CustomerCeilingObjectEditLayer` can drag a focused ceiling object the same
 * way `CustomerFurnitureEditLayer` drags a floor object.
 *
 * ZERO React / zustand / three.js / supabase imports — only the canonical
 * mutator + the floor-polygon clamp (reused against the ceiling polygon).
 */
import {
  removeCeilingMountedObject,
  updateCeilingMountedObject,
} from '../mutations/customerObjectMutator'
import { clampFloorObjectIntoRoom } from '../validator/objectPositionValidator'
import type { RoomScene } from '../types/scene-graph'
import type { Floor } from '../types/geometry'

export type CeilingTransformResult =
  | { kind: 'updated'; scene: RoomScene }
  | { kind: 'rejected'; message: string }
  | { kind: 'missing' }

/**
 * Continuous reposition of a ceiling-mounted object to an ABSOLUTE world XZ
 * point. `y` is left untouched (the renderer derives it from `ceilingY − h/2`).
 *
 * Clamp-to-fit against the CEILING polygon (which equals `floor.polygon` for the
 * flat V1 ceilings) so dragging toward the room edge slides the object flush
 * instead of leaving the outline — identical policy to `moveFurniture`. Only an
 * object genuinely larger than the room is rejected.
 */
export function moveCeilingObject(input: {
  scene: RoomScene
  objectId: string
  x: number
  z: number
}): CeilingTransformResult {
  const obj = input.scene.ceiling.ceiling_mounted.find((o) => o.id === input.objectId)
  if (!obj) return { kind: 'missing' }
  const candidate: typeof obj = {
    ...obj,
    transform: {
      ...obj.transform,
      position: { x: input.x, y: obj.transform.position.y, z: input.z },
    },
  }
  // Reuse the floor clamp against the ceiling polygon — a real Floor-shaped
  // surface (the clamp only reads `.polygon`), so no cast and no validator change.
  const clampSurface: Floor = { ...input.scene.floor, polygon: input.scene.ceiling.polygon }
  const fit = clampFloorObjectIntoRoom(clampSurface, candidate)
  if (!fit) return { kind: 'rejected', message: 'Objekt ist größer als dieser Raum' }
  const next = updateCeilingMountedObject(input.scene, {
    objectId: input.objectId,
    patch: {
      transform: {
        ...obj.transform,
        position: { x: fit.x, y: obj.transform.position.y, z: fit.z },
      },
    },
  })
  return { kind: 'updated', scene: next }
}

/** Remove a ceiling-mounted object (Aktionsleiste „Löschen"). */
export function deleteCeilingObject(input: { scene: RoomScene; objectId: string }): RoomScene {
  return removeCeilingMountedObject(input.scene, { objectId: input.objectId })
}
