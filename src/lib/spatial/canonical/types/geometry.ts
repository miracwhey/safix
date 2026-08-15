/**
 * Spatial · Canonical · Geometry Types
 *
 * Parametric wall / floor / ceiling / opening definitions per Master-Spec §1.6-§1.8.
 *
 * Walls are stored PARAMETRICALLY (start-point, end-point, height, thickness),
 * not as triangle-soup. This is the cornerstone of the data-model-first
 * approach: every renderer derives its meshes from these parameters at run
 * time, so a single source of truth survives edits, variant overrides, and
 * re-scans without geometry drift.
 */

import type { Vector3 } from './primitives.ts'
import type { Node } from './scene-graph.ts'
import type { SpatialObject } from './objects.ts'

/**
 * A planar room boundary segment.
 *
 * Conventions (binding · Master-Spec §1.6):
 *
 *   - `start_point` and `end_point` are world-space (top-level), not parent-
 *     relative, to keep wall-host-detection cheap. Walls participate in the
 *     scene-graph via `parent_id = roomScene.id`, but their geometric anchors
 *     are world-space.
 *   - `thickness_m` defaults to 0.15 m when RoomPlan does not supply a value
 *     (RoomPlan's wall-thickness inference is unreliable — see Risk R12 on
 *     wall-doubling collapse).
 *   - `polygon_override` carries iOS 17+ RoomPlan polygon walls (irregular
 *     shapes, e.g. dormer cuts). When present it replaces the default
 *     rectangle constructed from start/end/height during rendering. Pin-UV
 *     resolution against a polygon_override wall falls back to nearest-vertex
 *     projection (Risk R15).
 *   - `length_m` and `normal` are COMPUTED on demand by `geometry/wall-geometry.ts`
 *     and persisted only as cached convenience fields; the canonical truth
 *     remains `start_point` + `end_point` + `thickness_m`.
 *   - Outward-facing normal is computed as the right-hand-perpendicular of
 *     (end - start) — i.e. when walking from start to end, the wall's outer
 *     face is on the right. This convention drives door-host matching and
 *     walkable-area subtraction.
 */
export interface Wall extends Node {
  type: 'wall'

  // ── Parametric geometry (canonical truth) ────────────────────────────────
  /** World-space start of the wall centerline (X, 0, Z at floor level). */
  start_point: Vector3
  /** World-space end of the wall centerline. */
  end_point: Vector3
  /** Wall height in meters · top edge at base_height_m + height_m. */
  height_m: number
  /** Thickness in meters · default 0.15 when RoomPlan does not supply a value. */
  thickness_m: number
  /** Z-coordinate of the wall base (typically 0 = floor plane). */
  base_height_m: number

  /** iOS 17+ non-rectangular wall polygon override (world-space ring · CCW). */
  polygon_override?: Vector3[]

  // ── Children (scene-graph) ───────────────────────────────────────────────
  /** Doors, windows, and unframed openings hosted by this wall. */
  openings: WallOpening[]
  /** Wall-mounted objects (sinks, radiators, shelves, ...). */
  wall_mounted: SpatialObject[]

  // ── Rendering & collision metadata ───────────────────────────────────────
  /** RoomPlan flag · used by validator for "no-doors-on-exterior-wall" hints. */
  is_exterior_wall: boolean
  /** Always `true` for Walls · kept as a literal for collision-layer filtering. */
  walkable_blocker: true
  /** Optional material override — `null` falls back to room default. */
  material_id?: string

  // ── Computed convenience fields (do NOT mutate · refreshed on edit) ──────
  /** Cached `|end_point - start_point|`. */
  length_m: number
  /** Cached outward-facing unit normal in world-space. */
  normal: Vector3
}

/**
 * The floor of a room — a single horizontal polygon.
 *
 * Multiple RoomPlan-detected floors are merged into one canonical Floor at
 * the bridge boundary (Day 8 B13). The polygon ring is CCW and lies at
 * `position.y = 0` in world-space; lifted floors (raised platforms) are
 * represented as floor-mounted SpatialObjects, not as additional floors.
 */
export interface Floor extends Node {
  type: 'floor'
  /** Outline polygon · CCW · world-space · Y = floor-level. */
  polygon: Vector3[]
  material_id?: string
  /** Always `true` for Floors · kept as a literal for walkable-layer filtering. */
  walkable_surface: true
  /** Children of the floor — objects whose `host === 'floor'`. */
  floor_mounted: SpatialObject[]
}

/**
 * The ceiling of a room. Mirrors Floor structure plus an explicit height
 * (the perpendicular distance from floor plane to ceiling plane).
 *
 * V1 supports only flat ceilings. Vaulted / sloped ceilings are V1.x and
 * will be represented via a `polygon_override` analogous to Wall.
 */
export interface Ceiling extends Node {
  type: 'ceiling'
  polygon: Vector3[]
  /** Height above floor plane in meters · validator flags <2.0 m or >4.0 m. */
  height_m: number
  material_id?: string
  ceiling_mounted: SpatialObject[]
}

/**
 * Opening category embedded in a wall.
 *
 *   - 'door'    : a walkable portal · `is_walkable_portal === true`
 *   - 'window'  : a non-walkable opening · `is_walkable_portal === false`
 *   - 'opening' : an unframed wall break (e.g. archway) · walkable
 */
export type WallOpeningType = 'door' | 'window' | 'opening'

/**
 * Door / window / unframed opening hosted by a wall.
 *
 * Master-Spec §1.8. Stored parametrically as offsets along the host wall
 * (NOT as a free-floating world transform) so the opening follows the wall
 * if the wall is later moved or resized — guarantees that doors stay anchored
 * to their walls under any edit operation.
 *
 * Invariants (enforced by validator §9.2):
 *   - 0 ≤ offset_along_wall_m ≤ host_wall.length_m − width_m
 *   - 0 ≤ offset_from_floor_m ≤ host_wall.height_m − height_m
 *   - Doors are walkable portals; windows are not.
 */
export interface WallOpening extends Node {
  type: WallOpeningType

  /** ID of the host wall · must exist in the same RoomScene. */
  host_wall_id: string

  /** Distance from the host wall's `start_point` to the opening's left edge. */
  offset_along_wall_m: number
  /** Distance from the floor plane to the opening's bottom edge. */
  offset_from_floor_m: number
  /** Width in meters · measured along the wall direction. */
  width_m: number
  /** Height in meters · measured perpendicular to the floor. */
  height_m: number

  // ── Door-specific (only meaningful when type === 'door') ────────────────
  /** Hinge side or 'sliding'; 'unknown' when RoomPlan cannot determine. */
  swing_direction?: 'left' | 'right' | 'sliding' | 'unknown'
  /** True for doors and unframed openings · false for windows. */
  is_walkable_portal: boolean
  /** Adjacent rooms · null = leads to exterior (Multi-Room V1.x). */
  connects_room_ids?: [string, string]

  // ── Window-specific (alias of `offset_from_floor_m` for explicit reads) ─
  sill_height_m?: number

  /** Optional material override (door material vs. wall material). */
  material_id?: string

  /**
   * Bridge-supplied confidence that `host_wall_id` is the correct host wall
   * (1.0 = unambiguous · <1.0 = a second candidate was within tolerance).
   * Populated by the converter (Day 8 B13) and consumed by the validator's
   * `DOOR_HOST_WALL_AMBIGUOUS` rule (H17 audit-fix).
   */
  host_wall_confidence?: number
}
