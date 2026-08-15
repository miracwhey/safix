/**
 * Spatial · Canonical · Cameras · Walk Inputs (Zwischen-Latte · B-4)
 *
 * Derives the two inputs `WalkController` needs from a resolved `RoomScene`:
 *   - the walkable polygon (`computeWalkableArea`), and
 *   - the obstacle list — walls + floor-mounted objects as oriented boxes.
 *
 * Walls and rotated objects carry a `rotationY`, so the B-1 oriented-box
 * collision keeps the camera off the true footprint instead of an inflated
 * axis-aligned hull. Pure — no three.js, no React.
 */

import { computeWalkableArea } from '../../../../../lib/spatial/canonical/geometry/walkable.ts'
import { boxBoundsFromShape, type CameraObstacle } from '../../../../../lib/spatial/canonical/geometry/collision.ts'
import type { RoomScene } from '../../../../../lib/spatial/canonical/types/scene-graph.ts'
import type { WalkablePolygon } from '../../../../../lib/spatial/canonical/types/walkable.ts'
import type { SpatialObject } from '../../../../../lib/spatial/canonical/types/objects.ts'

export interface WalkInputs {
  walkable: WalkablePolygon
  obstacles: CameraObstacle[]
}

/** Floor-mounted + free objects — the ones a walking camera can bump into. */
function groundObjects(scene: RoomScene): SpatialObject[] {
  return [...scene.floor.floor_mounted, ...scene.free_objects]
}

/**
 * Build the walkable polygon + obstacle list for the walk camera.
 */
export function deriveWalkInputs(scene: RoomScene): WalkInputs {
  const objects = groundObjects(scene)

  const walkable = computeWalkableArea({
    room_id: scene.id,
    floor: scene.floor,
    walls: scene.walls,
    objects,
    openings: scene.walls.flatMap((w) =>
      w.openings.map((opening) => ({ host_wall: w, opening })),
    ),
  }).polygon

  const obstacles: CameraObstacle[] = []

  for (const wall of scene.walls) {
    const dx = wall.end_point.x - wall.start_point.x
    const dz = wall.end_point.z - wall.start_point.z
    const len = Math.hypot(dx, dz)
    if (len < 1e-6) continue
    const cx = (wall.start_point.x + wall.end_point.x) / 2
    const cz = (wall.start_point.z + wall.end_point.z) / 2
    const halfThk = wall.thickness_m / 2
    // Local (un-rotated) AABB around the wall centre; `rotationY` orients it.
    obstacles.push({
      id: wall.id,
      bounds: {
        min: { x: cx - len / 2, y: wall.base_height_m, z: cz - halfThk },
        max: { x: cx + len / 2, y: wall.base_height_m + wall.height_m, z: cz + halfThk },
      },
      rotationY: Math.atan2(dz, dx),
    })
  }

  for (const obj of objects) {
    const d = obj.dimensions
    if (!d || d.width_m <= 0 || d.depth_m <= 0) continue
    obstacles.push({
      id: obj.id,
      bounds: boxBoundsFromShape(obj.transform.position, {
        kind: 'box',
        width_m: d.width_m,
        height_m: d.height_m,
        depth_m: d.depth_m,
      }),
      rotationY: ((obj.rotation_around_y_deg ?? 0) * Math.PI) / 180,
    })
  }

  return { walkable, obstacles }
}
