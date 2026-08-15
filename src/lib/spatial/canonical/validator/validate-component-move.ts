/**
 * Spatial · Canonical · Validator · Per-Move Validator (Phase 2 · Block 2.5-2.8)
 *
 * The INCREMENTAL pre-apply constraint check for the edit-system. Given one
 * {@link EditOperation} and the current resolved {@link RoomScene}, it decides:
 *
 *   - Hard-Reject (2.6 · Master-Spec §8.1) — return `{ ok: false, error }`.
 *     The command MUST NOT be applied. `editHistoryStore.apply()` gates on this.
 *   - Soft-Warn  (2.7 · Master-Spec §8.2) — return `{ ok: true, warnings }`.
 *     The command IS applied; the warnings drive the Confirm-Toast UI.
 *   - Auto-Snap  (2.8 · Master-Spec §8.3) — return `{ ok: true, correctedTransform }`.
 *     The caller adopts the corrected transform before applying.
 *
 * Distinct from `run-validator.ts`, which validates the WHOLE scene post-apply
 * (debounced). This validator is per-edit and runs BEFORE the command touches
 * the override stack.
 *
 * Layer: pure L1 — no three.js / React / DOM. Snap uses the existing resolvers
 * in `../snap/asset-snap.ts` — nothing is re-implemented here.
 */

import type { Transform, Vector3 } from '../types/primitives.ts'
import { EPSILON } from '../types/primitives.ts'
import type { RoomScene } from '../types/scene-graph.ts'
import type { Wall, WallOpening } from '../types/geometry.ts'
import type { SpatialObject } from '../types/objects.ts'
import type { EditOperation } from '../types/commands.ts'
import { lengthCompute, projectPointOntoWallPlane } from '../geometry/wall-geometry.ts'
import { toEuler, fromEuler } from '../algebra/quaternion.ts'
import { resolveWallSnap, resolveFloorSnap, DEFAULT_SNAP_RULE } from '../snap/asset-snap.ts'

import {
  type ConstraintWarning,
  type MoveValidationResult,
  hardReject,
  accept,
} from './move-validation.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Tolerances (Master-Spec §8 — binding numeric thresholds)
// ─────────────────────────────────────────────────────────────────────────────

/** Floor-plane lock epsilon — a floor object's `y` must be within this of 0. */
const FLOOR_PLANE_EPS_M = 0.05
/** Wall-plane lock epsilon — a wall object's distance to the wall face. */
const WALL_PLANE_EPS_M = 0.05
/** Object→wall auto-snap distance (§8.3). */
const SNAP_WALL_DISTANCE_M = 0.15
/** Object→floor auto-snap distance (§8.3). */
const SNAP_FLOOR_DISTANCE_M = 0.05
/** Rotation auto-snap step in degrees (§8.3 · Edit-Spec §2.1). */
const ROTATION_SNAP_STEP_DEG = 15
/** Soft-warn: door within this distance of a corner is "near corner" (§8.2). */
const DOOR_NEAR_CORNER_M = 0.2
/** Soft-warn: window sill below this height is "too low" (§8.2). */
const WINDOW_SILL_MIN_M = 0.3
/** Default object↔object clearance buffer when no per-asset metadata exists. */
const DEFAULT_CLEARANCE_BUFFER_M = 0.2
/** AABB containment tolerance for room-bounds checks. */
const BOUNDS_EPS_M = 1e-6

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate one {@link EditOperation} against the current resolved scene.
 *
 * Generalises over every {@link EditOperation} variant: the function switches
 * on `op.kind` and routes to the matching constraint set. Operations that
 * carry no geometric constraint (`set_material`, `delete_node`) are accepted
 * unconditionally — they still flow through here so `apply()` has one uniform
 * gate.
 *
 * `scene` is the RESOLVED scene (post-override) — pass
 * `useCanonicalSceneStore.getState().resolved`. The validator never mutates it.
 */
export function validateComponentMove(
  op: EditOperation,
  scene: RoomScene,
): MoveValidationResult {
  switch (op.kind) {
    case 'move_node':
      return validateMoveNode(op.node_id, op.new_transform, scene)
    case 'snap_object':
      return validateSnapObject(
        op.object_id,
        op.new_host,
        op.new_host_id,
        op.new_transform,
        scene,
      )
    case 'resize_wall':
      return validateResizeWall(op.wall_id, op.new_height_m, op.new_thickness_m, scene)
    case 'set_room_height':
      return validateSetRoomHeight(op.room_id, op.new_height_m, scene)
    case 'add_door':
      return validateAddDoor(op.wall_id, op.door, scene)
    case 'add_pin':
      return validateAddPin(op.pin_id, op.anchor, scene)
    case 'move_pin':
      return validateMovePin(op.pin_id, op.new_anchor, scene)
    case 'set_material':
    case 'delete_node':
    case 'add_wall':
    case 'delete_wall':
      // No geometric constraint — material recolour, plain deletion, manual
      // wall add/remove (Lane-2.5 · Stream B) are always legal at the
      // constraint layer. RBAC / variant-write rules are a separate
      // Block-2.9 concern, and the wall-add/remove commands run on the base
      // scene rather than the override engine, so there is no transform to
      // snap or validate here.
      return accept()
    default: {
      // Exhaustiveness guard — a new EditOperation kind must add a case above.
      const _never: never = op
      void _never
      return accept()
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// move_node
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `move_node` validation. The mover may be a free/floor/ceiling object, a
 * wall-mounted object, or a pin host. Walls are HARD-REJECTED ("Wall-stays-
 * Wall", Master-Spec §8.1 · Edit-Spec §2.1).
 */
function validateMoveNode(
  nodeId: string,
  newTransform: Transform,
  scene: RoomScene,
): MoveValidationResult {
  // Wall move → hard reject. Walls are the room boundary; they are corrected
  // only via re-scan or `resize_wall` (height/thickness), never moved.
  if (scene.walls.some((w) => w.id === nodeId)) {
    return hardReject(
      'WALL_IMMOVABLE',
      [nodeId],
      `Wall ${nodeId} cannot be moved — walls are the immutable room boundary`,
      'Wände können nicht verschoben werden',
    )
  }

  const obj = findObject(scene, nodeId)
  if (obj) return validateObjectTransform(obj, newTransform, scene)

  // A window / door opening can be a move-target. Openings are parametric on
  // their host wall — the `move_node` transform is projected onto the host
  // wall to derive the REQUESTED offset, and that requested offset (not the
  // opening's stale stored offset) is what gets bounds-checked (F9).
  const opening = findOpening(scene, nodeId)
  if (opening) return validateOpeningMove(opening.wall, opening.opening, newTransform)

  // A pin can be a move-target (its host transform). Pins have no geometric
  // footprint of their own beyond the [0,1]² UV — re-anchoring is `move_pin`.
  // A bare `move_node` on a pin is accepted (transform is cosmetic for pins).
  if (scene.pins.some((p) => p.id === nodeId)) return accept()

  // Floor / ceiling cannot be moved either (they are room-defining surfaces).
  if (scene.floor.id === nodeId || scene.ceiling.id === nodeId) {
    return hardReject(
      'WALL_IMMOVABLE',
      [nodeId],
      `Surface ${nodeId} cannot be moved — floor/ceiling are immutable`,
      'Boden und Decke können nicht verschoben werden',
    )
  }

  return hardReject(
    'NODE_NOT_FOUND',
    [nodeId],
    `move_node targets ${nodeId} which does not exist in the resolved scene`,
  )
}

/**
 * Validate + auto-snap an object's new transform.
 *
 * Order (Master-Spec §8): auto-snap FIRST (so the snapped value is what gets
 * bounds-checked), then hard-reject on the snapped value, then soft-warn.
 */
function validateObjectTransform(
  obj: SpatialObject,
  newTransform: Transform,
  scene: RoomScene,
): MoveValidationResult {
  // ── Auto-snap (§8.3) ──────────────────────────────────────────────────────
  const snapped = autoSnapObjectTransform(obj, newTransform, scene)
  const effective = snapped ?? newTransform

  // ── Hard-reject (§8.1) on the EFFECTIVE (post-snap) transform ─────────────
  const pos = effective.position

  if (obj.host === 'floor' || obj.host === 'free') {
    if (Math.abs(pos.y) > FLOOR_PLANE_EPS_M) {
      return hardReject(
        'FLOOR_OBJECT_OFF_PLANE',
        [obj.id],
        `Object ${obj.id} (host=${obj.host}) moved off the floor plane — y=${pos.y.toFixed(3)} m`,
        'Bodenobjekt muss auf dem Boden stehen',
      )
    }
  }

  if (obj.host === 'wall' || obj.host === 'corner') {
    const wall = scene.walls.find((w) => w.id === obj.host_id)
    if (!wall) {
      return hardReject(
        'NODE_NOT_FOUND',
        [obj.id, obj.host_id],
        `Wall-hosted object ${obj.id} references missing host wall ${obj.host_id}`,
      )
    }
    const { signedDistance } = projectPointOntoWallPlane(wall, pos)
    // The object's back face sits flush on the wall surface (centerline ±
    // thickness/2). Allow it to protrude into the room (positive towards the
    // inward normal) by its depth, but never sink past the wall plane.
    const faceOffset = wall.thickness_m / 2
    const distToFace = Math.abs(signedDistance) - faceOffset
    if (distToFace < -WALL_PLANE_EPS_M) {
      return hardReject(
        'WALL_OBJECT_OFF_PLANE',
        [obj.id, wall.id],
        `Wall-hosted object ${obj.id} sank ${(-distToFace).toFixed(3)} m past wall ${wall.id}'s surface`,
        'Wandobjekt muss an der Wand bleiben',
      )
    }
  }

  // Room-bounds AABB check (§8.1) — the object footprint must stay inside.
  const boundsReject = checkRoomBounds(obj, pos, scene, effective)
  if (boundsReject) return boundsReject

  // Object↔object interpenetration (§8.1, F8) — a HARD reject distinct from
  // the soft clearance-buffer warn: two objects' actual footprints (no buffer)
  // must never geometrically overlap.
  const overlapReject = checkObjectInterpenetration(obj, effective, scene)
  if (overlapReject) return overlapReject

  // ── Soft-warn (§8.2) ──────────────────────────────────────────────────────
  const warnings = collectObjectWarnings(obj, effective, scene)

  return accept({
    warnings,
    correctedTransform: snapped ?? undefined,
    hint: snapped ? snapHint(obj, snapped) : undefined,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// snap_object
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `snap_object` validation. The caller already ran a snap resolver and passes
 * the resulting host + transform; this re-validates the result so a stale
 * resolver call (host wall deleted meanwhile) cannot land an illegal override.
 */
function validateSnapObject(
  objectId: string,
  newHost: SpatialObject['host'],
  newHostId: string,
  newTransform: Transform,
  scene: RoomScene,
): MoveValidationResult {
  const obj = findObject(scene, objectId)
  if (!obj) {
    return hardReject(
      'NODE_NOT_FOUND',
      [objectId],
      `snap_object targets ${objectId} which does not exist in the resolved scene`,
    )
  }

  // Validate the host exists for surface-anchored snaps.
  if (newHost === 'wall' || newHost === 'corner') {
    if (!scene.walls.some((w) => w.id === newHostId)) {
      return hardReject(
        'DOOR_HOST_WALL_MISSING',
        [objectId, newHostId],
        `snap_object would host ${objectId} on missing wall ${newHostId}`,
      )
    }
  } else if (newHost === 'ceiling') {
    if (scene.ceiling.id !== newHostId) {
      return hardReject(
        'NODE_NOT_FOUND',
        [objectId, newHostId],
        `snap_object would host ${objectId} on missing ceiling ${newHostId}`,
      )
    }
  } else if (newHost === 'floor') {
    if (scene.floor.id !== newHostId) {
      return hardReject(
        'NODE_NOT_FOUND',
        [objectId, newHostId],
        `snap_object would host ${objectId} on missing floor ${newHostId}`,
      )
    }
  }

  // Re-validate the transform against the NEW host. Build a hypothetical
  // object carrying the new host so the plane/floor checks use the right rule.
  const hypothetical: SpatialObject = { ...obj, host: newHost, host_id: newHostId }
  return validateObjectTransform(hypothetical, newTransform, scene)
}

// ─────────────────────────────────────────────────────────────────────────────
// resize_wall
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `resize_wall` validation. Walls cannot be MOVED, but height/thickness resize
 * is explicitly allowed (Master-Spec §8.1 note). The only hard-reject is a
 * non-positive / non-finite dimension. A resize that would orphan an opening
 * (window now above the shorter wall) is surfaced as a soft-warn — the user is
 * told, but the resize itself is permitted (the post-apply scene-validator
 * raises the hard `WINDOW_ABOVE_CEILING` for the operator).
 */
function validateResizeWall(
  wallId: string,
  newHeightM: number,
  newThicknessM: number,
  scene: RoomScene,
): MoveValidationResult {
  const wall = scene.walls.find((w) => w.id === wallId)
  if (!wall) {
    return hardReject(
      'NODE_NOT_FOUND',
      [wallId],
      `resize_wall targets ${wallId} which does not exist in the resolved scene`,
    )
  }
  const dimReject = checkDimension([wallId], newHeightM, 'height') ??
    checkDimension([wallId], newThicknessM, 'thickness')
  if (dimReject) return dimReject

  const warnings: ConstraintWarning[] = []
  for (const op of wall.openings) {
    if (op.type === 'window' && op.offset_from_floor_m + op.height_m > newHeightM + EPSILON) {
      warnings.push({
        code: 'WINDOW_SILL_TOO_LOW',
        affected_node_ids: [op.id, wallId],
        message: `Resizing wall ${wallId} to ${newHeightM.toFixed(2)} m leaves window ${op.id} extending above it`,
      })
    }
  }
  return accept({ warnings })
}

// ─────────────────────────────────────────────────────────────────────────────
// set_room_height
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `set_room_height` validation. Rejects a non-positive height; warns when any
 * window on any wall would end up above the new ceiling.
 */
function validateSetRoomHeight(
  roomId: string,
  newHeightM: number,
  scene: RoomScene,
): MoveValidationResult {
  const dimReject = checkDimension([roomId], newHeightM, 'room height')
  if (dimReject) return dimReject

  const warnings: ConstraintWarning[] = []
  for (const wall of scene.walls) {
    for (const op of wall.openings) {
      if (op.type === 'window' && op.offset_from_floor_m + op.height_m > newHeightM + EPSILON) {
        warnings.push({
          code: 'WINDOW_SILL_TOO_LOW',
          affected_node_ids: [op.id, wall.id],
          message: `Room height ${newHeightM.toFixed(2)} m leaves window ${op.id} extending above the ceiling`,
        })
      }
    }
  }
  return accept({ warnings })
}

// ─────────────────────────────────────────────────────────────────────────────
// add_door
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `add_door` validation. The door must reference an existing host wall and fit
 * within its length (§8.1). Soft-warn when the door sits within 0.2 m of a
 * wall corner (§8.2 · Edit-Spec §2.1).
 */
function validateAddDoor(
  wallId: string,
  door: WallOpening,
  scene: RoomScene,
): MoveValidationResult {
  const wall = scene.walls.find((w) => w.id === wallId)
  if (!wall) {
    return hardReject(
      'DOOR_HOST_WALL_MISSING',
      [door.id, wallId],
      `add_door references missing host wall ${wallId}`,
    )
  }
  const dimReject = checkDimension([door.id], door.width_m, 'door width') ??
    checkDimension([door.id], door.height_m, 'door height')
  if (dimReject) return dimReject

  const wallLen = lengthCompute(wall)
  if (
    door.offset_along_wall_m < -BOUNDS_EPS_M ||
    door.offset_along_wall_m + door.width_m > wallLen + BOUNDS_EPS_M
  ) {
    return hardReject(
      'DOOR_OUTSIDE_WALL',
      [door.id, wallId],
      `Door ${door.id} (${door.width_m.toFixed(2)} m @ offset ${door.offset_along_wall_m.toFixed(2)} m) does not fit within wall ${wallId} (${wallLen.toFixed(2)} m)`,
      'Tür passt nicht in die Wand',
    )
  }
  if (door.offset_from_floor_m + door.height_m > wall.height_m + BOUNDS_EPS_M) {
    return hardReject(
      'WINDOW_ABOVE_WALL',
      [door.id, wallId],
      `Door ${door.id} extends above wall ${wallId} (top at ${(door.offset_from_floor_m + door.height_m).toFixed(2)} m vs wall height ${wall.height_m.toFixed(2)} m)`,
      'Tür ist höher als die Wand',
    )
  }

  // Soft-warn: door near a wall corner (within 0.2 m of either end).
  const warnings: ConstraintWarning[] = []
  const gapToStart = door.offset_along_wall_m
  const gapToEnd = wallLen - (door.offset_along_wall_m + door.width_m)
  if (gapToStart < DOOR_NEAR_CORNER_M || gapToEnd < DOOR_NEAR_CORNER_M) {
    warnings.push({
      code: 'DOOR_NEAR_CORNER',
      affected_node_ids: [door.id, wallId],
      message: `Door ${door.id} sits within ${DOOR_NEAR_CORNER_M} m of a wall corner`,
    })
  }
  return accept({ warnings })
}

// ─────────────────────────────────────────────────────────────────────────────
// move_pin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `move_pin` validation. The pin's new anchor surface must exist and the UV
 * must lie in [0,1]² (§8.1).
 */
function validateMovePin(
  pinId: string,
  newAnchor: EditOperationPinAnchor,
  scene: RoomScene,
): MoveValidationResult {
  if (!scene.pins.some((p) => p.id === pinId)) {
    return hardReject(
      'NODE_NOT_FOUND',
      [pinId],
      `move_pin targets ${pinId} which does not exist in the resolved scene`,
    )
  }
  if (!surfaceExists(scene, newAnchor.anchor_surface_id)) {
    return hardReject(
      'PIN_ANCHOR_MISSING',
      [pinId, newAnchor.anchor_surface_id],
      `Pin ${pinId} would anchor to missing surface ${newAnchor.anchor_surface_id}`,
      'Markierung muss auf einer Fläche liegen',
    )
  }
  const { u, v } = newAnchor.anchor_uv
  if (u < -BOUNDS_EPS_M || u > 1 + BOUNDS_EPS_M || v < -BOUNDS_EPS_M || v > 1 + BOUNDS_EPS_M) {
    return hardReject(
      'PIN_UV_OUT_OF_RANGE',
      [pinId],
      `Pin ${pinId} UV (${u.toFixed(3)}, ${v.toFixed(3)}) is outside [0,1]²`,
      'Markierung liegt außerhalb der Fläche',
    )
  }
  return accept()
}

/** Local alias of the `move_pin` operation's anchor payload (avoids a cross-file import cycle). */
type EditOperationPinAnchor = (EditOperation & { kind: 'move_pin' })['new_anchor']

// ─────────────────────────────────────────────────────────────────────────────
// add_pin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `add_pin` validation (Phase-3 Customer-Verify Stage-4). Mirrors
 * {@link validateMovePin} EXCEPT the pin-existence check: an `add_pin`
 * introduces a NEW pin, so the pin id is intentionally NOT yet on the resolved
 * scene. The anchor surface must exist and the UV must lie in [0,1]² (§8.1).
 */
function validateAddPin(
  pinId: string,
  anchor: EditOperationPinAnchor,
  scene: RoomScene,
): MoveValidationResult {
  if (!surfaceExists(scene, anchor.anchor_surface_id)) {
    return hardReject(
      'PIN_ANCHOR_MISSING',
      [pinId, anchor.anchor_surface_id],
      `Pin ${pinId} would anchor to missing surface ${anchor.anchor_surface_id}`,
      'Markierung muss auf einer Fläche liegen',
    )
  }
  const { u, v } = anchor.anchor_uv
  if (u < -BOUNDS_EPS_M || u > 1 + BOUNDS_EPS_M || v < -BOUNDS_EPS_M || v > 1 + BOUNDS_EPS_M) {
    return hardReject(
      'PIN_UV_OUT_OF_RANGE',
      [pinId],
      `Pin ${pinId} UV (${u.toFixed(3)}, ${v.toFixed(3)}) is outside [0,1]²`,
      'Markierung liegt außerhalb der Fläche',
    )
  }
  return accept()
}

// ─────────────────────────────────────────────────────────────────────────────
// Opening move (door / window via move_node)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a door / window opening against its host wall (F9).
 *
 * Hard-rejects (§8.1): a missing host wall, or an opening that no longer fits
 * the wall's length / height. Soft-warns (§8.2): a door within 0.2 m of a
 * corner, or a window sill below 0.3 m.
 *
 * The opening is parametric on its host wall (`offset_along_wall_m`,
 * `offset_from_floor_m`). A `move_node` on an opening carries a world-space
 * `newTransform`; the validator projects that transform onto the host wall to
 * derive the REQUESTED offsets and checks THOSE. A door dragged past the wall
 * end via `move_node` is therefore caught — the stale stored offset is never
 * trusted when a new transform is supplied.
 */
function validateOpeningMove(
  wall: Wall,
  op: WallOpening,
  newTransform?: Transform,
): MoveValidationResult {
  const wallLen = lengthCompute(wall)

  // Derive the offsets to validate. When `move_node` supplies a transform we
  // project it onto the host wall; otherwise we fall back to the opening's
  // stored parametric fields (e.g. a host-wall resize re-check).
  let offsetAlong = op.offset_along_wall_m
  let offsetFromFloor = op.offset_from_floor_m
  if (newTransform) {
    // `offset_along_wall_m` is the distance from start_point to the opening's
    // LEFT edge; the transform position is the opening CENTRE.
    offsetAlong = projectedOffsetAlongWall(wall, newTransform.position) - op.width_m / 2
    offsetFromFloor = newTransform.position.y - op.height_m / 2
  }

  if (
    offsetAlong < -BOUNDS_EPS_M ||
    offsetAlong + op.width_m > wallLen + BOUNDS_EPS_M
  ) {
    return hardReject(
      'DOOR_OUTSIDE_WALL',
      [op.id, wall.id],
      `Opening ${op.id} does not fit within wall ${wall.id} (${wallLen.toFixed(2)} m) — requested offset ${offsetAlong.toFixed(2)} m`,
      'Öffnung passt nicht in die Wand',
    )
  }
  if (op.type === 'window') {
    if (offsetFromFloor < -BOUNDS_EPS_M) {
      return hardReject(
        'WINDOW_BELOW_FLOOR',
        [op.id, wall.id],
        `Window ${op.id} sits below the floor (offset ${offsetFromFloor.toFixed(2)} m)`,
        'Fenster liegt unter dem Boden',
      )
    }
    if (offsetFromFloor + op.height_m > wall.height_m + BOUNDS_EPS_M) {
      return hardReject(
        'WINDOW_ABOVE_WALL',
        [op.id, wall.id],
        `Window ${op.id} extends above wall ${wall.id}`,
        'Fenster ist höher als die Wand',
      )
    }
  }

  const warnings: ConstraintWarning[] = []
  const gapToStart = offsetAlong
  const gapToEnd = wallLen - (offsetAlong + op.width_m)
  if ((op.type === 'door' || op.type === 'opening') && (gapToStart < DOOR_NEAR_CORNER_M || gapToEnd < DOOR_NEAR_CORNER_M)) {
    warnings.push({
      code: 'DOOR_NEAR_CORNER',
      affected_node_ids: [op.id, wall.id],
      message: `Door ${op.id} sits within ${DOOR_NEAR_CORNER_M} m of a wall corner`,
    })
  }
  if (op.type === 'window' && offsetFromFloor < WINDOW_SILL_MIN_M) {
    warnings.push({
      code: 'WINDOW_SILL_TOO_LOW',
      affected_node_ids: [op.id, wall.id],
      message: `Window ${op.id} sill at ${offsetFromFloor.toFixed(2)} m is below the ${WINDOW_SILL_MIN_M} m minimum`,
    })
  }
  return accept({ warnings })
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-snap (Master-Spec §8.3) — uses asset-snap.ts resolvers, nothing re-built
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Auto-snap an object transform per Master-Spec §8.3:
 *   - object→floor when |y| ≤ 0.05 m  → `resolveFloorSnap`
 *   - object→wall  when distance to a wall face ≤ 0.15 m → `resolveWallSnap`
 *   - rotation snap to the nearest 15° step
 *
 * Returns the corrected transform, or `null` when nothing snapped.
 */
export function autoSnapObjectTransform(
  obj: SpatialObject,
  transform: Transform,
  scene: RoomScene,
): Transform | null {
  let position = transform.position
  let rotation = transform.rotation
  let changed = false

  // ── Snap-to-wall (only for wall/corner-hosted objects) ────────────────────
  if (obj.host === 'wall' || obj.host === 'corner') {
    const host = scene.walls.find((w) => w.id === obj.host_id)
    if (host) {
      const { signedDistance } = projectPointOntoWallPlane(host, position)
      const faceOffset = host.thickness_m / 2
      const gap = Math.abs(signedDistance) - faceOffset
      if (gap > EPSILON && gap <= SNAP_WALL_DISTANCE_M) {
        // Re-resolve the placement flush on the wall face via the canonical
        // wall-snap resolver — never hand-rolled here.
        const rule = DEFAULT_SNAP_RULE[obj.category]
        const offsetAlong = projectedOffsetAlongWall(host, position)
        const snap = resolveWallSnap({
          wall: host,
          offsetAlongWallM: clamp(offsetAlong, 0, lengthCompute(host)),
          heightFromFloorM:
            obj.height_from_floor_m ?? rule?.default_height_from_floor_m ?? position.y,
          alignToNormal: rule?.align_to_normal ?? true,
        })
        position = snap.position
        rotation = fromEuler(0, (snap.rotationYDeg * Math.PI) / 180, 0)
        changed = true
      }
    }
  }

  // ── Snap-to-floor (floor/free-hosted objects close to the plane) ──────────
  if ((obj.host === 'floor' || obj.host === 'free') && !changed) {
    if (Math.abs(position.y) > EPSILON && Math.abs(position.y) <= SNAP_FLOOR_DISTANCE_M) {
      const snap = resolveFloorSnap({
        footprint: { x: position.x, z: position.z },
        floorHeightM: 0,
        rotationYDeg: toEuler(rotation).y * (180 / Math.PI),
      })
      position = snap.position
      changed = true
    }
  }

  // ── Rotation snap to 15° steps ────────────────────────────────────────────
  const snappedRotation = snapRotationTo15Deg(rotation)
  if (snappedRotation) {
    rotation = snappedRotation
    changed = true
  }

  if (!changed) return null
  return { position, rotation, scale: transform.scale }
}

/**
 * Snap a quaternion's Y-rotation to the nearest 15° step. Returns the snapped
 * quaternion, or `null` when it is already on a step (within ~0.5°). Pitch /
 * roll are preserved.
 */
export function snapRotationTo15Deg(rotation: Transform['rotation']): Transform['rotation'] | null {
  const euler = toEuler(rotation)
  const yDeg = (euler.y * 180) / Math.PI
  const snappedDeg = Math.round(yDeg / ROTATION_SNAP_STEP_DEG) * ROTATION_SNAP_STEP_DEG
  if (Math.abs(snappedDeg - yDeg) < 0.5) return null
  return fromEuler(euler.x, (snappedDeg * Math.PI) / 180, euler.z)
}

// ─────────────────────────────────────────────────────────────────────────────
// Soft-warn collectors (Master-Spec §8.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collect soft-warnings for an object at a candidate transform: object↔object
 * clearance, wall-object near-corner, door blocked by furniture.
 */
function collectObjectWarnings(
  obj: SpatialObject,
  transform: Transform,
  scene: RoomScene,
): ConstraintWarning[] {
  const warnings: ConstraintWarning[] = []
  const pos = transform.position

  // ── Object↔object clearance ───────────────────────────────────────────────
  for (const other of allObjects(scene)) {
    if (other.id === obj.id) continue
    if (objectsWithinClearance(obj, pos, other)) {
      warnings.push({
        code: 'OBJECT_CLEARANCE_VIOLATED',
        affected_node_ids: [obj.id, other.id],
        message: `Object ${obj.id} sits within ${other.id}'s clearance zone`,
      })
    }
  }

  // ── Wall-object near corner ───────────────────────────────────────────────
  if (obj.host === 'wall' || obj.host === 'corner') {
    const wall = scene.walls.find((w) => w.id === obj.host_id)
    if (wall) {
      const offsetAlong = projectedOffsetAlongWall(wall, pos)
      const wallLen = lengthCompute(wall)
      const half = obj.dimensions.width_m / 2
      if (offsetAlong - half < DOOR_NEAR_CORNER_M || wallLen - (offsetAlong + half) < DOOR_NEAR_CORNER_M) {
        warnings.push({
          code: 'WALL_OBJECT_NEAR_CORNER',
          affected_node_ids: [obj.id, wall.id],
          message: `Wall-mounted object ${obj.id} sits within ${DOOR_NEAR_CORNER_M} m of a corner`,
        })
      }
    }
  }

  // ── Door blocked by furniture ─────────────────────────────────────────────
  if (obj.host === 'floor' || obj.host === 'free') {
    for (const wall of scene.walls) {
      for (const op of wall.openings) {
        if (op.type === 'window') continue
        if (objectBlocksDoor(obj, pos, wall, op)) {
          warnings.push({
            code: 'DOOR_BLOCKED_BY_OBJECT',
            affected_node_ids: [obj.id, op.id],
            message: `Object ${obj.id} blocks the pass-through of door ${op.id}`,
          })
        }
      }
    }
  }

  return warnings
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometric helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Every object in the scene (wall-mounted + floor + ceiling + free). */
function allObjects(scene: RoomScene): SpatialObject[] {
  const out: SpatialObject[] = [
    ...scene.free_objects,
    ...scene.floor.floor_mounted,
    ...scene.ceiling.ceiling_mounted,
  ]
  for (const w of scene.walls) out.push(...w.wall_mounted)
  return out
}

/** Find any object by id across all host buckets. */
function findObject(scene: RoomScene, id: string): SpatialObject | undefined {
  return allObjects(scene).find((o) => o.id === id)
}

/** Find an opening (door / window) by id, returning it together with its host wall. */
function findOpening(
  scene: RoomScene,
  id: string,
): { wall: Wall; opening: WallOpening } | undefined {
  for (const wall of scene.walls) {
    const opening = wall.openings.find((o) => o.id === id)
    if (opening) return { wall, opening }
  }
  return undefined
}

/** `true` when `id` is a wall / floor / ceiling / object — a valid pin anchor. */
function surfaceExists(scene: RoomScene, id: string): boolean {
  if (scene.floor.id === id || scene.ceiling.id === id) return true
  if (scene.walls.some((w) => w.id === id)) return true
  return findObject(scene, id) !== undefined
}

/**
 * The four XZ footprint corners of an object at `pos`, given its
 * width/depth half-extents and a Y-rotation in degrees. Rotation is applied
 * around the object centre on the XZ plane (F7).
 */
function footprintCornersXZ(
  obj: SpatialObject,
  pos: Vector3,
  rotationYDeg: number,
): Array<{ x: number; z: number }> {
  const halfW = obj.dimensions.width_m / 2
  const halfD = obj.dimensions.depth_m / 2
  const rad = (rotationYDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  // Local-frame corners (±halfW along local X, ±halfD along local Z) rotated
  // around Y and translated to the world position.
  const local: Array<[number, number]> = [
    [-halfW, -halfD],
    [halfW, -halfD],
    [halfW, halfD],
    [-halfW, halfD],
  ]
  return local.map(([lx, lz]) => ({
    x: pos.x + lx * cos + lz * sin,
    z: pos.z - lx * sin + lz * cos,
  }))
}

/** Y-rotation of an object's effective transform, in degrees. */
function objectRotationYDeg(obj: SpatialObject, transform: Transform): number {
  // Prefer the quaternion on the transform being validated; fall back to the
  // stored floor-rotation field for objects whose pose is parametric.
  const fromQuat = (toEuler(transform.rotation).y * 180) / Math.PI
  if (Number.isFinite(fromQuat) && Math.abs(fromQuat) > 1e-9) return fromQuat
  return obj.rotation_around_y_deg ?? fromQuat
}

/**
 * Room-bounds AABB containment (F7).
 *
 * For floor / free objects the whole FOOTPRINT must stay inside the room AABB —
 * the object's `width_m`/`depth_m` rectangle, rotated by its Y-rotation, with
 * all four rotated corners checked. This catches the bug where a large object
 * passes validation with its centre barely inside while half its body is out
 * of the room.
 *
 * For wall / corner objects the footprint legitimately straddles the wall
 * centerline (the room AABB is the wall centerlines), so only the object's
 * CENTRE is bounds-checked — the wall-plane lock + `WALL_OBJECT_NEAR_CORNER`
 * already constrain those.
 */
function checkRoomBounds(
  obj: SpatialObject,
  pos: Vector3,
  scene: RoomScene,
  transform: Transform,
): MoveValidationResult | null {
  const { bounds_min: min, bounds_max: max } = scene

  const points: Array<{ x: number; z: number }> =
    obj.host === 'wall' || obj.host === 'corner'
      ? [{ x: pos.x, z: pos.z }]
      : footprintCornersXZ(obj, pos, objectRotationYDeg(obj, transform))

  for (const c of points) {
    if (
      c.x < min.x - BOUNDS_EPS_M ||
      c.x > max.x + BOUNDS_EPS_M ||
      c.z < min.z - BOUNDS_EPS_M ||
      c.z > max.z + BOUNDS_EPS_M
    ) {
      return hardReject(
        'OUTSIDE_ROOM_BOUNDS',
        [obj.id],
        `Object ${obj.id} footprint corner (${c.x.toFixed(2)}, ${c.z.toFixed(2)}) lies outside room bounds`,
        'Außerhalb des Raumes',
      )
    }
  }
  return null
}

/** Reject a non-finite / non-positive dimension. */
function checkDimension(
  ids: string[],
  value: number,
  label: string,
): MoveValidationResult | null {
  if (!Number.isFinite(value) || value <= EPSILON) {
    return hardReject(
      'INVALID_DIMENSION',
      ids,
      `Invalid ${label}: ${value} — must be a positive finite number`,
      'Ungültige Abmessung',
    )
  }
  return null
}

/** Signed offset of a point projected onto the wall centerline (may be < 0 or > length). */
function projectedOffsetAlongWall(wall: Wall, point: Vector3): number {
  const len = lengthCompute(wall)
  if (len < EPSILON) return 0
  const dirX = (wall.end_point.x - wall.start_point.x) / len
  const dirZ = (wall.end_point.z - wall.start_point.z) / len
  return (point.x - wall.start_point.x) * dirX + (point.z - wall.start_point.z) * dirZ
}

/**
 * Object↔object clearance test — AABB-vs-AABB on the XZ plane, each box
 * expanded by the per-asset front clearance (or the default buffer). This is
 * the SOFT-WARN encroachment test (F8): the buffered footprints touching
 * still allows the edit, with `OBJECT_CLEARANCE_VIOLATED`.
 */
function objectsWithinClearance(
  moving: SpatialObject,
  movingPos: Vector3,
  other: SpatialObject,
): boolean {
  const bufA = DEFAULT_CLEARANCE_BUFFER_M
  const bufB = DEFAULT_CLEARANCE_BUFFER_M
  const halfWa = moving.dimensions.width_m / 2 + bufA
  const halfDa = moving.dimensions.depth_m / 2 + bufA
  const halfWb = other.dimensions.width_m / 2 + bufB
  const halfDb = other.dimensions.depth_m / 2 + bufB
  const dx = Math.abs(movingPos.x - other.transform.position.x)
  const dz = Math.abs(movingPos.z - other.transform.position.z)
  return dx < halfWa + halfWb && dz < halfDa + halfDb
}

/**
 * Hard-reject when the moving object's footprint geometrically interpenetrates
 * another object's footprint (F8). Distinct from {@link objectsWithinClearance}
 * — this uses the ACTUAL footprints (no clearance buffer) so two objects can
 * never occupy the same space. The test is the Separating-Axis-Theorem on the
 * two rotated footprint rectangles, so it is exact for rotated objects.
 */
function checkObjectInterpenetration(
  obj: SpatialObject,
  transform: Transform,
  scene: RoomScene,
): MoveValidationResult | null {
  const movingCorners = footprintCornersXZ(
    obj,
    transform.position,
    objectRotationYDeg(obj, transform),
  )
  for (const other of allObjects(scene)) {
    if (other.id === obj.id) continue
    const otherCorners = footprintCornersXZ(
      other,
      other.transform.position,
      objectRotationYDeg(other, other.transform),
    )
    if (convexPolygonsOverlap(movingCorners, otherCorners)) {
      return hardReject(
        'OBJECT_OVERLAP',
        [obj.id, other.id],
        `Object ${obj.id} footprint geometrically overlaps object ${other.id}`,
        'Objekte dürfen sich nicht überlappen',
      )
    }
  }
  return null
}

/**
 * Separating-Axis-Theorem overlap test for two convex XZ polygons (here the
 * 4-corner footprint rectangles). Returns `true` when the polygons strictly
 * overlap; edge-touching (projection gap ≈ 0) does NOT count as overlap.
 */
function convexPolygonsOverlap(
  a: Array<{ x: number; z: number }>,
  b: Array<{ x: number; z: number }>,
): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]
      const q = poly[(i + 1) % poly.length]
      // Edge normal (perpendicular to the edge) — the candidate separating axis.
      const axisX = -(q.z - p.z)
      const axisZ = q.x - p.x
      const axisLen = Math.hypot(axisX, axisZ)
      if (axisLen < EPSILON) continue
      const nx = axisX / axisLen
      const nz = axisZ / axisLen
      const [minA, maxA] = projectPolygon(a, nx, nz)
      const [minB, maxB] = projectPolygon(b, nx, nz)
      // A gap on this axis ⇒ no overlap. Use BOUNDS_EPS_M so a flush touch is
      // treated as separated, not interpenetrating.
      if (maxA <= minB + BOUNDS_EPS_M || maxB <= minA + BOUNDS_EPS_M) return false
    }
  }
  return true
}

/** Project a polygon's vertices onto an axis, returning [min, max]. */
function projectPolygon(
  poly: Array<{ x: number; z: number }>,
  nx: number,
  nz: number,
): [number, number] {
  let min = Infinity
  let max = -Infinity
  for (const p of poly) {
    const d = p.x * nx + p.z * nz
    if (d < min) min = d
    if (d > max) max = d
  }
  return [min, max]
}

/**
 * Door-blocked test — does the object's XZ footprint overlap the door's
 * pass-through rectangle (the door opening footprint extruded 0.6 m into the
 * room along the wall's inward normal)?
 */
function objectBlocksDoor(
  obj: SpatialObject,
  objPos: Vector3,
  wall: Wall,
  door: WallOpening,
): boolean {
  const len = lengthCompute(wall)
  if (len < EPSILON) return false
  const dirX = (wall.end_point.x - wall.start_point.x) / len
  const dirZ = (wall.end_point.z - wall.start_point.z) / len
  // Door centre on the wall centerline.
  const centreAlong = door.offset_along_wall_m + door.width_m / 2
  const doorCx = wall.start_point.x + dirX * centreAlong
  const doorCz = wall.start_point.z + dirZ * centreAlong
  // Distance from the object centre to the door centre on the XZ plane.
  const dx = objPos.x - doorCx
  const dz = objPos.z - doorCz
  const dist = Math.hypot(dx, dz)
  // Pass-through clearance radius: half the door width + a 0.6 m approach.
  const objHalf = Math.max(obj.dimensions.width_m, obj.dimensions.depth_m) / 2
  return dist < door.width_m / 2 + 0.6 + objHalf
}

/** Clamp a value to `[lo, hi]`. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** German hint describing what an auto-snap did, for the Confirm-Toast. */
function snapHint(obj: SpatialObject, snapped: Transform): string {
  if (obj.host === 'wall' || obj.host === 'corner') return 'An Wand eingerastet'
  if (Math.abs(snapped.position.y) <= EPSILON) return 'Auf Boden eingerastet'
  return 'Ausgerichtet'
}
