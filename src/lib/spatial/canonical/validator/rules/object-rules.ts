/**
 * Spatial · Canonical · Validator · Object Rules
 *
 * Checks SpatialObjects against:
 *   - existence of their declared host (wall / floor / ceiling)
 *   - room-AABB containment
 *   - floating (host == floor but Y > epsilon above floor plane)
 *   - clearance-zone overlap with neighbouring objects
 *
 * Mirrors Master-Spec §9.2 object-rule semantics.
 */

import type { RoomScene } from '../../types/scene-graph.ts'
import type { SpatialObject } from '../../types/objects.ts'
import type { ValidationIssue } from '../../types/validation.ts'

const FLOOR_EPS_M = 0.05

export function checkObjectHostNotFound(scene: RoomScene): ValidationIssue[] {
  const wallIds = new Set(scene.walls.map(w => w.id))
  const floorId = scene.floor?.id ?? '__none__'
  const ceilingId = scene.ceiling?.id ?? '__none__'

  const all = collectObjects(scene)
  const objectIds = new Set(all.map(o => o.id))
  return all
    .filter(obj => !isHostKnown(obj, wallIds, floorId, ceilingId, objectIds))
    .map(obj => ({
      code: 'OBJECT_HOST_NOT_FOUND',
      severity: 'error',
      affected_node_ids: [obj.id],
      message: `Object ${obj.id} declares host=${obj.host} with id=${obj.host_id} but no such node exists in this room`,
    }))
}

export function checkObjectOutsideRoomBounds(scene: RoomScene): ValidationIssue[] {
  const { bounds_min: min, bounds_max: max } = scene
  return collectObjects(scene)
    .filter(obj => {
      const p = obj.transform.position
      return p.x < min.x - 1e-6 || p.x > max.x + 1e-6 || p.z < min.z - 1e-6 || p.z > max.z + 1e-6
    })
    .map(obj => ({
      code: 'OBJECT_OUTSIDE_ROOM_BOUNDS',
      severity: 'error',
      affected_node_ids: [obj.id],
      message: `Object ${obj.id} at (${obj.transform.position.x.toFixed(2)}, ${obj.transform.position.z.toFixed(2)}) sits outside the room bounding box`,
    }))
}

export function checkObjectFloating(scene: RoomScene): ValidationIssue[] {
  return collectObjects(scene)
    .filter(obj => obj.host === 'floor' && obj.transform.position.y > FLOOR_EPS_M)
    .map(obj => ({
      code: 'OBJECT_FLOATING',
      severity: 'warning',
      affected_node_ids: [obj.id],
      message: `Object ${obj.id} is hosted on the floor but sits ${obj.transform.position.y.toFixed(2)} m above it`,
    }))
}

export function checkObjectClearanceViolated(scene: RoomScene): ValidationIssue[] {
  // V1: only flags clearance overlap with floor-mounted siblings using a
  // simple AABB-vs-AABB overlap test expanded by 0.20 m (Master-Spec default
  // clearance_buffer). A full clearance-zone-aware check arrives in V1.x
  // when individual assets ship per-direction clearance metadata via the
  // asset catalog.
  const objects = collectObjects(scene).filter(o => o.host === 'floor' || o.host === 'free')
  const issues: ValidationIssue[] = []
  for (let i = 0; i < objects.length; i++) {
    for (let j = i + 1; j < objects.length; j++) {
      if (objectsOverlap(objects[i], objects[j], 0.2)) {
        issues.push({
          code: 'OBJECT_CLEARANCE_VIOLATED',
          severity: 'warning',
          affected_node_ids: [objects[i].id, objects[j].id],
          message: `Objects ${objects[i].id} and ${objects[j].id} sit within each other's clearance zone`,
        })
      }
    }
  }
  return issues
}

export function checkObjectClipping(scene: RoomScene): ValidationIssue[] {
  // V1 simplification: detect when an object's AABB straddles a wall plane,
  // which usually indicates a clipping bug from manual edits. The full
  // boolean intersection against the wall mass is V1.x.
  const issues: ValidationIssue[] = []
  for (const obj of collectObjects(scene)) {
    for (const wall of scene.walls) {
      if (objectClipsWall(obj, wall.start_point, wall.end_point)) {
        issues.push({
          code: 'OBJECT_CLIPPING',
          severity: 'warning',
          affected_node_ids: [obj.id, wall.id],
          message: `Object ${obj.id} overlaps wall ${wall.id}`,
        })
      }
    }
  }
  return issues
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry + helpers
// ─────────────────────────────────────────────────────────────────────────────

export const OBJECT_RULES = [
  checkObjectHostNotFound,
  checkObjectOutsideRoomBounds,
  checkObjectFloating,
  checkObjectClearanceViolated,
  checkObjectClipping,
] as const

function collectObjects(scene: RoomScene): SpatialObject[] {
  const out: SpatialObject[] = [...scene.free_objects, ...(scene.floor?.floor_mounted ?? []), ...(scene.ceiling?.ceiling_mounted ?? [])]
  for (const wall of scene.walls) out.push(...wall.wall_mounted)
  return out
}

function isHostKnown(
  obj: SpatialObject,
  wallIds: Set<string>,
  floorId: string,
  ceilingId: string,
  objectIds: Set<string>,
): boolean {
  switch (obj.host) {
    case 'wall':
    case 'corner':
      return wallIds.has(obj.host_id)
    case 'floor':
    case 'free':
      return obj.host_id === floorId || obj.host === 'free'
    case 'ceiling':
      return obj.host_id === ceilingId
    case 'counter':
      // The host is another SpatialObject (the counter / vanity); it must
      // exist and must not be the object hosting itself.
      return obj.host_id !== obj.id && objectIds.has(obj.host_id)
    default:
      return false
  }
}

function objectsOverlap(a: SpatialObject, b: SpatialObject, buffer: number): boolean {
  const halfW_a = a.dimensions.width_m / 2 + buffer
  const halfD_a = a.dimensions.depth_m / 2 + buffer
  const halfW_b = b.dimensions.width_m / 2 + buffer
  const halfD_b = b.dimensions.depth_m / 2 + buffer
  const dx = Math.abs(a.transform.position.x - b.transform.position.x)
  const dz = Math.abs(a.transform.position.z - b.transform.position.z)
  return dx < halfW_a + halfW_b && dz < halfD_a + halfD_b
}

function objectClipsWall(
  obj: SpatialObject,
  start: { x: number; z: number },
  end: { x: number; z: number },
): boolean {
  // Test whether the object's XZ AABB straddles the wall's line segment.
  const halfW = obj.dimensions.width_m / 2
  const halfD = obj.dimensions.depth_m / 2
  const cx = obj.transform.position.x
  const cz = obj.transform.position.z
  // Project AABB corners onto the wall normal; if min × max < 0 the AABB
  // crosses the wall plane and we additionally need a segment-overlap check.
  const wx = end.x - start.x
  const wz = end.z - start.z
  const len = Math.hypot(wx, wz)
  if (len < 1e-6) return false
  const nx = wz / len
  const nz = -wx / len
  const offsets = [
    nx * (cx - halfW - start.x) + nz * (cz - halfD - start.z),
    nx * (cx + halfW - start.x) + nz * (cz - halfD - start.z),
    nx * (cx + halfW - start.x) + nz * (cz + halfD - start.z),
    nx * (cx - halfW - start.x) + nz * (cz + halfD - start.z),
  ]
  const minOff = Math.min(...offsets)
  const maxOff = Math.max(...offsets)
  if (minOff * maxOff > 0) return false
  // Project AABB onto wall direction.
  const dx = wx / len
  const dz = wz / len
  const along = [
    dx * (cx - halfW - start.x) + dz * (cz - halfD - start.z),
    dx * (cx + halfW - start.x) + dz * (cz - halfD - start.z),
    dx * (cx + halfW - start.x) + dz * (cz + halfD - start.z),
    dx * (cx - halfW - start.x) + dz * (cz + halfD - start.z),
  ]
  const alongMin = Math.min(...along)
  const alongMax = Math.max(...along)
  return alongMax >= 0 && alongMin <= len
}
