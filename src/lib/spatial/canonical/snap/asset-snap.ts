/**
 * Spatial · Canonical · Snap · Asset Snap Rules
 *
 * The placement foundation for the Phase-2 edit-system: which host surfaces
 * each catalog category may snap to, the default per-object {@link SnapRule}
 * (mount height, alignment, clearances), and pure resolvers that turn a
 * parametric placement into a world-space transform.
 *
 * Phase 1 ships the rule DATA + the resolvers as tested L1 logic; the
 * interactive drag-and-drop that consumes them lands in Phase 2 (Day 24+).
 *
 * `AssetCategory` is the coarse catalog grouping (picker tabs · snap targets);
 * `ObjectCategory` (objects.ts) is the fine functional type of a placed
 * SpatialObject. One coarse category fans out to many fine ones.
 *
 * Pure L1: no three.js / React / DOM.
 */

import type { Vector3 } from '../types/primitives.ts'
import { EPSILON } from '../types/primitives.ts'
import type { ObjectCategory, ObjectHost } from '../types/objects.ts'
import { CATEGORY_DEFAULT_HOST } from '../types/objects.ts'
import type { SnapRule } from '../types/asset.ts'
import {
  type WallGeometryInput,
  lengthCompute,
  innerNormalCompute,
} from '../geometry/wall-geometry.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Categories + snap targets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coarse catalog category. Drives the asset-picker tabs and the per-category
 * snap-target table. Matches the four-way sourcing split in
 * `spatial-v1-asset-source-map.md §0`.
 */
export type AssetCategory = 'sanitary' | 'kitchen' | 'architecture' | 'furniture'

export const ASSET_CATEGORIES: readonly AssetCategory[] = Object.freeze([
  'sanitary',
  'kitchen',
  'architecture',
  'furniture',
])

/**
 * A surface kind an asset can snap to.
 *
 *   - 'floor'        : floor plane
 *   - 'wall'         : a wall's room-facing face
 *   - 'ceiling'      : ceiling plane
 *   - 'corner'       : a wall-wall corner (corner showers, ...)
 *   - 'counter'      : the top surface of a counter / vanity object
 *   - 'wall-opening' : an existing door / window cut-out in a wall
 */
export type SnapTarget = 'floor' | 'wall' | 'ceiling' | 'corner' | 'counter' | 'wall-opening'

/**
 * Which snap targets each catalog category is allowed to use. Consolidated
 * from `asset-source-map.md §8` — the granular legacy targets ('wall-stud',
 * 'floor-builtin', ...) collapse onto this clean set, since the parametric
 * placement fields carry the fine detail.
 *
 * The FIRST entry is the category's preferred default target.
 */
export const SNAP_RULES: Readonly<Record<AssetCategory, readonly SnapTarget[]>> = Object.freeze({
  sanitary: Object.freeze(['floor', 'wall', 'corner', 'counter'] as const),
  kitchen: Object.freeze(['counter', 'wall', 'floor'] as const),
  architecture: Object.freeze(['wall-opening', 'wall', 'corner'] as const),
  furniture: Object.freeze(['floor', 'wall'] as const),
})

/** Whether `target` is a legal snap surface for `category`. */
export function isSnapTargetAllowed(category: AssetCategory, target: SnapTarget): boolean {
  return SNAP_RULES[category].includes(target)
}

/** The preferred default snap target for a category. */
export function defaultSnapTarget(category: AssetCategory): SnapTarget {
  return SNAP_RULES[category][0]
}

// ─────────────────────────────────────────────────────────────────────────────
// ObjectCategory → AssetCategory
// ─────────────────────────────────────────────────────────────────────────────

const OBJECT_TO_ASSET_CATEGORY: Readonly<Record<ObjectCategory, AssetCategory>> = Object.freeze({
  // Sanitary
  toilet: 'sanitary',
  sink: 'sanitary',
  bathtub: 'sanitary',
  shower: 'sanitary',
  bidet: 'sanitary',
  towel_rail: 'sanitary',
  mirror: 'sanitary',
  washing_machine: 'sanitary',
  toilet_paper_holder: 'sanitary',
  // Kitchen
  kitchen_sink: 'kitchen',
  cooktop: 'kitchen',
  oven: 'kitchen',
  refrigerator: 'kitchen',
  dishwasher: 'kitchen',
  range_hood: 'kitchen',
  kitchen_faucet: 'kitchen',
  // HVAC / electrical → architecture fixtures
  radiator: 'architecture',
  electrical_outlet: 'architecture',
  light_switch: 'architecture',
  fuse_box: 'architecture',
  lamp: 'furniture',
  // Furniture
  sofa: 'furniture',
  armchair: 'furniture',
  bed: 'furniture',
  wardrobe: 'furniture',
  bookshelf: 'furniture',
  table: 'furniture',
  chair: 'furniture',
  cabinet: 'furniture',
  tv_cabinet: 'furniture',
  plant: 'furniture',
  curtains: 'furniture',
  fireplace: 'furniture',
  rug: 'furniture',
  // Structural
  column: 'architecture',
  // Fallback
  generic_cuboid: 'furniture',
})

/** Coarse catalog category of a fine object category. */
export function objectCategoryToAssetCategory(category: ObjectCategory): AssetCategory {
  return OBJECT_TO_ASSET_CATEGORY[category]
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-object default SnapRule
// ─────────────────────────────────────────────────────────────────────────────

/** Mount heights (m) for wall-anchored object categories. */
const WALL_MOUNT_HEIGHT_M: Partial<Record<ObjectCategory, number>> = {
  sink: 0.85,
  towel_rail: 1.2,
  mirror: 1.35,
  kitchen_sink: 0.9,
  oven: 0.6,
  range_hood: 1.5,
  kitchen_faucet: 1.02,
  radiator: 0.12,
  electrical_outlet: 0.3,
  light_switch: 1.05,
  bookshelf: 1.0,
  cabinet: 1.4,
  toilet_paper_holder: 0.75,
  curtains: 0.05,
}

/**
 * Default {@link SnapRule} per object category. The Phase-2 edit-system and
 * the Day-8 bridge consult this when an asset is dropped (or imported) without
 * an explicit host: the rule decides host surface, mount height, whether to
 * align the asset's forward axis to the host normal, and clearance minima.
 *
 * Derived from {@link CATEGORY_DEFAULT_HOST} so host assignment stays in one
 * place; this table only adds the placement detail on top.
 */
export const DEFAULT_SNAP_RULE: Readonly<Record<ObjectCategory, SnapRule>> = Object.freeze(
  (Object.keys(CATEGORY_DEFAULT_HOST) as ObjectCategory[]).reduce((acc, category) => {
    const host: ObjectHost = CATEGORY_DEFAULT_HOST[category]
    const rule: SnapRule = {
      target_host: host,
      align_to_normal: host === 'wall' || host === 'corner',
    }
    const height = WALL_MOUNT_HEIGHT_M[category]
    if (height !== undefined) rule.default_height_from_floor_m = height
    if (host === 'corner') {
      rule.snap_to_corner = true
      rule.min_distance_to_corner_m = 0
    }
    // Floor fixtures want a little breathing room from the nearest corner so
    // they do not visually fuse into the wall join.
    if (host === 'floor') rule.min_distance_to_corner_m = 0.05
    acc[category] = Object.freeze(rule)
    return acc
  }, {} as Record<ObjectCategory, SnapRule>),
)

// ─────────────────────────────────────────────────────────────────────────────
// Snap resolvers
// ─────────────────────────────────────────────────────────────────────────────

/** A resolved placement — the pivot point in world space + Y-rotation. */
export interface SnapResult {
  /** World position of the asset's pivot reference point. */
  position: Vector3
  /** Rotation around world +Y in degrees, [0, 360). */
  rotationYDeg: number
}

const RAD2DEG = 180 / Math.PI

/** Normalise a degree value into [0, 360). */
function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/**
 * Place a floor-anchored asset. The pivot lands on the floor plane at the
 * requested footprint point; rotation is whatever the caller passes (the
 * edit-system supplies it from the drag gesture).
 */
export function resolveFloorSnap(params: {
  footprint: { x: number; z: number }
  floorHeightM: number
  rotationYDeg?: number
}): SnapResult {
  return {
    position: { x: params.footprint.x, y: params.floorHeightM, z: params.footprint.z },
    rotationYDeg: normalizeDeg(params.rotationYDeg ?? 0),
  }
}

/**
 * Place a wall-anchored asset from parametric fields.
 *
 * The pivot lands on the wall's room-facing face, `offsetAlongWallM` from the
 * wall start and `heightFromFloorM` above the floor. The asset is rotated so
 * its modelled forward axis (local +Z) points along the wall's inward normal
 * — i.e. into the room — when `alignToNormal` is set.
 *
 * `protrusionM` shifts the pivot further into the room (default 0: the asset's
 * back face sits flush against the wall surface).
 */
export function resolveWallSnap(params: {
  wall: WallGeometryInput
  offsetAlongWallM: number
  heightFromFloorM: number
  protrusionM?: number
  alignToNormal?: boolean
}): SnapResult {
  const { wall } = params
  const len = lengthCompute(wall)
  if (len < EPSILON) {
    // Degenerate wall — fall back to the wall start point so callers never
    // get a NaN transform. The validator surfaces WALL_ZERO_LENGTH upstream.
    return {
      position: { ...wall.start_point },
      rotationYDeg: 0,
    }
  }

  const dirX = (wall.end_point.x - wall.start_point.x) / len
  const dirZ = (wall.end_point.z - wall.start_point.z) / len
  const inward = innerNormalCompute(wall)
  const faceOffset = wall.thickness_m / 2 + (params.protrusionM ?? 0)

  const alongX = wall.start_point.x + dirX * params.offsetAlongWallM
  const alongZ = wall.start_point.z + dirZ * params.offsetAlongWallM

  const position: Vector3 = {
    x: alongX + inward.x * faceOffset,
    y: wall.base_height_m + params.heightFromFloorM,
    z: alongZ + inward.z * faceOffset,
  }

  // Local +Z → inward normal: a Y-rotation θ maps (0,0,1) to (sinθ, 0, cosθ).
  const rotationYDeg = (params.alignToNormal ?? true)
    ? normalizeDeg(Math.atan2(inward.x, inward.z) * RAD2DEG)
    : 0

  return { position, rotationYDeg }
}

/**
 * Place an asset on top of a counter / vanity object. The pivot lands on the
 * counter's top surface at the requested footprint point.
 */
export function resolveCounterSnap(params: {
  footprint: { x: number; z: number }
  counterTopHeightM: number
  rotationYDeg?: number
}): SnapResult {
  return {
    position: { x: params.footprint.x, y: params.counterTopHeightM, z: params.footprint.z },
    rotationYDeg: normalizeDeg(params.rotationYDeg ?? 0),
  }
}
