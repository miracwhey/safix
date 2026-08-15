/**
 * Spatial · Canonical · Walkable Scene
 *
 * Master-Spec §3. The walkable-scene layer is the second cornerstone of the
 * canonical data model: it answers "where can a camera (or human) actually
 * stand" — separately from the rendering-scene that answers "what should be
 * drawn".
 *
 * Walkable polygon = floor − wall-footprints − floor-mounted-object-footprints
 *                          + door-opening-cutouts.
 *
 * Collision volumes drive walk-mode camera collision (Risk R14 · Y-clamp
 * fallback after 3 resolve iterations).
 *
 * Door portals + room-connectivity graph drive multi-room navigation in V1.x.
 */

import type { ISO8601 } from './scene-graph.ts'
import type { Vector3 } from './primitives.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Walkable polygon
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A polygon with one outer ring and an arbitrary number of hole rings.
 *
 * Convention (matches polygon-clipping / GeoJSON / mfogel-lib):
 *   - `outer` is CCW when viewed from above (+Y).
 *   - Each `holes` ring is CW.
 *   - All rings lie on the floor plane (Y == floor.base_height_m).
 *   - Rings are closed implicitly (first vertex == last vertex is OPTIONAL;
 *     the algebra layer normalises).
 *
 * V1 supports exactly ONE outer ring per room. polygon-clipping may return
 * multiple disjoint outer rings (e.g. when a door cutout protrudes past the
 * room's exterior wall); `geometry/walkable.ts` reconciles that by keeping
 * only the largest-area outer ring and dropping the rest. Multi-room
 * connectivity is modelled at the {@link RoomConnectivityGraph} layer
 * instead.
 */
export interface WalkablePolygon {
  outer: Vector3[]
  holes: Vector3[][]
}

/**
 * The set of floor-plane points a camera-capsule can stand on without
 * intersecting a wall or floor-mounted obstacle. Computed by
 * `geometry/walkable.ts#computeWalkableArea` (Day 3 A11) via polygon-clipping
 * boolean operations.
 *
 * Risk R13: columns are modelled as floor-mounted SpatialObjects, NOT as
 * walls, so their footprints are subtracted via the same object-subtraction
 * pass — resulting in a polygon with one outer ring and one hole per column.
 *
 * `obstacles` is kept around for debug visualisation only; the canonical
 * truth is `polygon`.
 */
export interface WalkableArea {
  room_id: string
  polygon: WalkablePolygon
  computed_at: ISO8601
  obstacles: ObstacleFootprint[]
}

/**
 * 2D footprint of a single obstacle subtracted from the walkable polygon.
 *
 * Kept side-by-side with the walkable polygon so a renderer can visually
 * highlight blocked zones (e.g. red overlay in debug mode), and so the
 * validator can pinpoint which obstacle is over-constraining a room.
 */
export interface ObstacleFootprint {
  /** wall_id or object_id that produced this footprint. */
  source_id: string
  source_type: 'wall' | 'object'
  /** 2D polygon projected onto the floor plane. */
  polygon: Vector3[]
  /** Buffer applied around the obstacle (default 0.20 m around free-standing objects). */
  clearance_buffer_m: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Collision volumes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generic collision-shape categories. Capsules approximate humans / cameras;
 * boxes approximate furniture and architectural elements; cylinders are used
 * for columns / round objects; the `mesh` variant is reserved for V2 where
 * an asset ships its own collision-mesh in glb form.
 */
export type CollisionShapeKind = 'capsule' | 'box' | 'cylinder' | 'mesh'

export interface CapsuleShape {
  kind: 'capsule'
  radius_m: number
  /** Total height of the capsule from foot-tip to head-tip. */
  height_m: number
}

export interface BoxShape {
  kind: 'box'
  width_m: number
  height_m: number
  depth_m: number
}

export interface CylinderShape {
  kind: 'cylinder'
  radius_m: number
  height_m: number
}

/** Reserved for V2 · the glb supplies a separate collision mesh. */
export interface MeshShape {
  kind: 'mesh'
  glb_url: string
}

export type CollisionShape = CapsuleShape | BoxShape | CylinderShape | MeshShape

/**
 * A collision volume attached to a node in the scene-graph.
 *
 * The collision volume is OPAQUE to the validator (which only cares about
 * footprints in `WalkableArea.obstacles`); it is consumed by the walk-mode
 * camera controller (`WalkController.tsx`, Day 16 P15) to resolve capsule-vs-
 * shape collisions.
 */
export interface CollisionVolume {
  node_id: string
  shape: CollisionShape
  /** True for walls / floor-mounted objects; false for ceiling lamps etc. */
  is_walkable_blocker: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Camera capsule (walk-mode)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Camera-capsule used in walk-mode. Per Master-Spec §19 Decision #7, V1
 * ships fixed dimensions (radius 0.25 m, height 1.70 m); a V2 user-setting
 * will override these via a configuration panel.
 *
 * `near_clip_protection_m` ensures the near-clip plane never crosses a wall:
 * if the capsule centre is within this distance of any wall plane, the
 * collision resolver pushes the camera back along the wall normal.
 */
export interface CameraCapsule {
  radius_m: number
  height_m: number
  near_clip_protection_m: number
}

export const DEFAULT_CAMERA_CAPSULE: CameraCapsule = Object.freeze({
  radius_m: 0.25,
  height_m: 1.7,
  near_clip_protection_m: 0.1,
})

// ─────────────────────────────────────────────────────────────────────────────
// Door portals + connectivity graph
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walkable cross-section of a door (or unframed opening). Used by the walk-
 * mode controller to detect when the camera-capsule has traversed the
 * portal — at which point the active `room_id` switches.
 *
 * V1 ships single-room scenes (`connects_room_ids` is always
 * `[room_id, exterior]`), but the data shape already supports the multi-room
 * V1.x case where `connects_room_ids` connects two interior rooms.
 */
export interface DoorPortal {
  door_id: string
  host_wall_id: string
  /** [room_a, room_b] · the second entry may be a sentinel like `'exterior'`. */
  connects_room_ids: [string, string]
  /** 2D rectangle on the floor plane corresponding to the door opening. */
  walkable_polygon: Vector3[]
  /** Direction from room_a to room_b (unit vector). */
  portal_normal: Vector3
}

/**
 * Graph of rooms connected by walkable portals (doors / unframed openings).
 *
 * V1 produces a single-node, zero-edge graph. The multi-room V1.x case is
 * already representable here so no schema migration is needed when
 * RoomPlan's `StructureBuilder` API is integrated.
 */
export interface RoomConnectivityGraph {
  id: string
  nodes: RoomConnectivityNode[]
  edges: RoomConnectivityEdge[]
}

export interface RoomConnectivityNode {
  id: string
  room_id: string
}

export interface RoomConnectivityEdge {
  from_room_id: string
  to_room_id: string
  /** Either via_door_id or via_opening_id must be set; never both. */
  via_door_id?: string
  via_opening_id?: string
  is_walkable: boolean
}
