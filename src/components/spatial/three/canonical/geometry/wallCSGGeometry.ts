/**
 * Spatial · Canonical · Three · Geometry · Wall CSG
 *
 * Builds a wall body with REAL door / window holes — the boolean half of the
 * hybrid opening strategy (corners-edges-design / block-plan A-3).
 *
 *   wall + WallJoinGraph
 *     → buildWallProfile / extrudeWallProfile   (L1 · mitered footprint loft)
 *     → for each opening: `three-bvh-csg` SUBTRACTION of an opening box
 *
 * The boolean runs ONCE per wall-with-openings at mesh-build time and the
 * result is cached upstream (`useMemo` in `WallAdapter`). A wall with no
 * openings never enters this module — its plain footprint loft is used as-is.
 *
 * three-bvh-csg evaluates CPU-side on `BufferGeometry`, so this module is
 * unit-testable without a GPU context.
 */

import { BufferGeometry } from 'three'
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg'

import type { Wall } from '../../../../../lib/spatial/canonical/types/geometry.ts'
import type { WallJoinGraph } from '../../../../../lib/spatial/canonical/geometry/wall-joins.ts'
import { buildWallProfile, extrudeWallProfile } from '../../../../../lib/spatial/canonical/geometry/wall-profile.ts'
import { makeBox } from '../../../../../lib/spatial/canonical/geometry/procedural-primitives.ts'

import { proceduralMeshToBufferGeometry } from './proceduralMeshToBufferGeometry.ts'
import { ensureUv2 } from '../materials/surfaceMaterialHooks.ts'

/**
 * Extra depth added to each opening box beyond the wall thickness so the
 * boolean cleanly punches through both faces — including the slightly
 * thicker mitered footprint near corners.
 */
const OPENING_PUNCH_MARGIN_M = 0.1

/**
 * Build the wall body geometry with its openings subtracted as real holes.
 *
 * Returns `null` when the wall has no mitered footprint (zero-length /
 * override-polygon wall) — the caller falls back to its own handling.
 * A wall with an empty `openings` array still returns the solid footprint
 * loft (callers may prefer to skip this module entirely in that case).
 *
 * The returned geometry is freshly allocated and owns GPU-disposable
 * buffers — the caller disposes it on prop churn / unmount.
 */
/** Below this an opening edge counts as flush with the floor / ceiling. */
const FLUSH_EPSILON_M = 1e-4

export function wallCSGGeometry(wall: Wall, joinGraph: WallJoinGraph): BufferGeometry | null {
  // Override-polygon walls (iOS 17+ irregular) skip the miter/CSG pipeline —
  // the caller renders them via its own fallback.
  if (wall.polygon_override && wall.polygon_override.length > 0) return null

  const spec = buildWallProfile(wall, joinGraph)
  if (spec.footprint.length < 3) return null

  const bodyGeometry = proceduralMeshToBufferGeometry(extrudeWallProfile(spec))
  if (wall.openings.length === 0) {
    ensureUv2(bodyGeometry)
    return bodyGeometry
  }

  const evaluator = new Evaluator()
  evaluator.useGroups = false
  evaluator.attributes = ['position', 'normal', 'uv']

  const dir = wallDirectionXZ(wall)
  const angle = Math.atan2(
    wall.end_point.z - wall.start_point.z,
    wall.end_point.x - wall.start_point.x,
  )
  const holeGeometries: BufferGeometry[] = []

  let result = new Brush(bodyGeometry)
  result.updateMatrixWorld()

  for (const opening of wall.openings) {
    const along = opening.offset_along_wall_m + opening.width_m / 2
    const centerX = wall.start_point.x + dir.x * along
    const centerZ = wall.start_point.z + dir.z * along

    // Extend the box past any wall edge it is flush with — a coplanar face
    // is the classic degenerate boolean case (a floor-height door whose
    // bottom sits exactly on the wall's bottom cap leaves a residue).
    let yBottom = wall.base_height_m + opening.offset_from_floor_m
    let yTop = yBottom + opening.height_m
    if (yBottom <= wall.base_height_m + FLUSH_EPSILON_M) {
      yBottom -= OPENING_PUNCH_MARGIN_M
    }
    if (yTop >= wall.base_height_m + wall.height_m - FLUSH_EPSILON_M) {
      yTop += OPENING_PUNCH_MARGIN_M
    }
    const centerY = (yBottom + yTop) / 2

    const holeGeometry = proceduralMeshToBufferGeometry(
      makeBox({
        x: opening.width_m,
        y: yTop - yBottom,
        z: wall.thickness_m + OPENING_PUNCH_MARGIN_M,
      }),
    )
    holeGeometries.push(holeGeometry)

    const holeBrush = new Brush(holeGeometry)
    holeBrush.position.set(centerX, centerY, centerZ)
    holeBrush.rotation.set(0, -angle, 0)
    holeBrush.updateMatrixWorld()

    const next = evaluator.evaluate(result, holeBrush, SUBTRACTION)
    // Free the intermediate body geometry — only the live `result` is kept.
    if (result.geometry !== bodyGeometry) result.geometry.dispose()
    result = next
  }

  // Body + opening boxes are fully consumed by the boolean output.
  bodyGeometry.dispose()
  for (const g of holeGeometries) g.dispose()

  const out = result.geometry
  ensureUv2(out)
  return out
}

/** Unit centerline direction of a wall on the XZ floor plane. */
function wallDirectionXZ(wall: Wall): { x: number; z: number } {
  const dx = wall.end_point.x - wall.start_point.x
  const dz = wall.end_point.z - wall.start_point.z
  const len = Math.hypot(dx, dz)
  if (len < 1e-9) return { x: 1, z: 0 }
  return { x: dx / len, z: dz / len }
}
