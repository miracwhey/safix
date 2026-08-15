/**
 * Spatial · Canonical · Fixture · L-shaped POC bath-room (Day 14)
 *
 * The Day-12 fixture is a 3 × 4 m rectangle. Day 14 promotes the POC to
 * an L-shape so the renderer is stress-tested with non-convex walkable
 * polygon + 6 walls + an internal corner. Used by `/dev/spatial-poc`
 * + the Day 17 quality-compare doc.
 */

import type { RoomScene } from '../../../../../lib/spatial/canonical/types/scene-graph'
import type { Wall, Floor, Ceiling } from '../../../../../lib/spatial/canonical/types/geometry'
import type { Pin } from '../../../../../lib/spatial/canonical/types/annotations'
import {
  IDENTITY_QUATERNION,
  IDENTITY_VECTOR3,
  ONE_VECTOR3,
} from '../../../../../lib/spatial/canonical/types/primitives'

const NOW = '2026-05-19T00:00:00.000Z'

function baseNode<T extends string>(id: string, type: T, parentId: string) {
  return {
    id,
    type,
    parent_id: parentId,
    children_ids: [] as string[],
    variant_id: 'base_roomplan',
    source: 'manual' as const,
    confidence: 1,
    transform: {
      position: IDENTITY_VECTOR3,
      rotation: IDENTITY_QUATERNION,
      scale: ONE_VECTOR3,
    },
    created_at: NOW,
    updated_at: NOW,
  }
}

function mkWall(id: string, ax: number, az: number, bx: number, bz: number): Wall {
  return {
    ...baseNode(id, 'wall', 'poc-l'),
    start_point: { x: ax, y: 0, z: az },
    end_point: { x: bx, y: 0, z: bz },
    height_m: 2.5,
    thickness_m: 0.15,
    base_height_m: 0,
    openings: [],
    wall_mounted: [],
    is_exterior_wall: true,
    walkable_blocker: true as const,
    length_m: Math.hypot(bx - ax, bz - az),
    normal: { x: 0, y: 0, z: 0 },
  }
}

function mkPin(id: string, surfaceId: string, u: number, v: number, t: Pin['pin_type']): Pin {
  return {
    ...baseNode(id, 'pin', 'poc-l'),
    pin_type: t,
    anchor_surface_id: surfaceId,
    anchor_surface_type: 'wall',
    anchor_uv: { u, v },
    anchor_offset_normal_m: 0.01,
    linked_photo_ids: [],
    linked_note_ids: [],
    linked_task_ids: [],
  }
}

/**
 * L-shape footprint (CCW):
 *   (0,0) → (4,0) → (4,2) → (2,2) → (2,4) → (0,4) → close
 *
 * Six walls, one internal corner at (2,2).
 */
export function buildPocBathLShaped(): RoomScene {
  const ring = [
    { x: 0, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
    { x: 4, y: 0, z: 2 },
    { x: 2, y: 0, z: 2 },
    { x: 2, y: 0, z: 4 },
    { x: 0, y: 0, z: 4 },
  ]
  const floor: Floor = {
    ...baseNode('poc-l-floor', 'floor', 'poc-l'),
    polygon: ring,
    walkable_surface: true as const,
    floor_mounted: [],
  }
  const ceiling: Ceiling = {
    ...baseNode('poc-l-ceiling', 'ceiling', 'poc-l'),
    polygon: ring,
    height_m: 2.5,
    ceiling_mounted: [],
  }
  const walls = [
    mkWall('w_s', 0, 0, 4, 0),
    mkWall('w_e', 4, 0, 4, 2),
    mkWall('w_corner_h', 4, 2, 2, 2),
    mkWall('w_corner_v', 2, 2, 2, 4),
    mkWall('w_n', 2, 4, 0, 4),
    mkWall('w_w', 0, 4, 0, 0),
  ]
  const pins = [
    mkPin('pin-1', 'w_s', 0.4, 0.6, 'damage'),
    mkPin('pin-2', 'w_corner_h', 0.5, 0.5, 'note'),
    mkPin('pin-3', 'w_n', 0.6, 0.5, 'task'),
    mkPin('pin-4', 'w_w', 0.3, 0.7, 'material'),
  ]
  return {
    ...baseNode('poc-l', 'room', 'poc-l-building'),
    category: 'bathroom',
    walls,
    floor,
    ceiling,
    free_objects: [],
    pins,
    photos: [],
    notes: [],
    bounds_min: { x: 0, y: 0, z: 0 },
    bounds_max: { x: 4, y: 2.5, z: 4 },
    computed_area_m2: 12, // 4×2 + 2×2
    computed_volume_m3: 30,
  }
}
