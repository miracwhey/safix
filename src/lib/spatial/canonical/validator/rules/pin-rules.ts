/**
 * Spatial · Canonical · Validator · Pin Rules
 *
 * Checks Pin annotations against their anchoring surface:
 *   - the referenced surface (wall / floor / ceiling / object) must exist
 *   - the UV anchor must be within [0, 1]²; otherwise the pin would resolve
 *     to a point off the actual surface mesh.
 */

import type { Pin } from '../../types/annotations.ts'
import type { RoomScene } from '../../types/scene-graph.ts'
import type { ValidationIssue } from '../../types/validation.ts'
import type { SpatialObject } from '../../types/objects.ts'

export function checkPinAnchorNotFound(scene: RoomScene): ValidationIssue[] {
  const wallIds = new Set(scene.walls.map(w => w.id))
  const floorId = scene.floor?.id
  const ceilingId = scene.ceiling?.id
  const objectIds = new Set<string>()
  pushObjects(scene, objectIds)

  return scene.pins
    .filter(p => !isAnchorKnown(p, wallIds, floorId, ceilingId, objectIds))
    .map(p => ({
      code: 'PIN_ANCHOR_NOT_FOUND',
      severity: 'error',
      affected_node_ids: [p.id],
      message: `Pin ${p.id} anchors to ${p.anchor_surface_type} ${p.anchor_surface_id} which does not exist`,
    }))
}

export function checkPinOffSurface(scene: RoomScene): ValidationIssue[] {
  return scene.pins
    .filter(p => p.anchor_uv.u < -1e-6 || p.anchor_uv.u > 1 + 1e-6 || p.anchor_uv.v < -1e-6 || p.anchor_uv.v > 1 + 1e-6)
    .map(p => ({
      code: 'PIN_OFF_SURFACE',
      severity: 'warning',
      affected_node_ids: [p.id],
      message: `Pin ${p.id} has UV (${p.anchor_uv.u.toFixed(2)}, ${p.anchor_uv.v.toFixed(2)}) outside [0,1]²`,
    }))
}

export const PIN_RULES = [checkPinAnchorNotFound, checkPinOffSurface] as const

function pushObjects(scene: RoomScene, ids: Set<string>) {
  for (const o of scene.free_objects) ids.add(o.id)
  for (const o of scene.floor?.floor_mounted ?? []) ids.add(o.id)
  for (const o of scene.ceiling?.ceiling_mounted ?? []) ids.add(o.id)
  for (const w of scene.walls) for (const o of w.wall_mounted) ids.add(o.id)
}

function isAnchorKnown(
  pin: Pin,
  wallIds: Set<string>,
  floorId: string | undefined,
  ceilingId: string | undefined,
  objectIds: Set<string>,
): boolean {
  switch (pin.anchor_surface_type) {
    case 'wall':
      return wallIds.has(pin.anchor_surface_id)
    case 'floor':
      return pin.anchor_surface_id === floorId
    case 'ceiling':
      return pin.anchor_surface_id === ceilingId
    case 'object':
      return objectIds.has(pin.anchor_surface_id)
    default:
      return false
  }
}

// Tree-shaking friendly export so SpatialObject is referenced from the file
// even if checks don't currently use it directly.
export type _ObjectShape = SpatialObject
