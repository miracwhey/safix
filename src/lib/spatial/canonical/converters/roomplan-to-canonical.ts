/**
 * Spatial · Canonical · Converters · RoomPlan → Canonical (TypeScript Mirror)
 *
 * This is the TS-side mirror of the Swift `CanonicalConverter` (Day 9 B15).
 * It accepts a structurally-equivalent RoomPlan-output JSON dump and
 * produces a canonical {@link ParametricJson} document. The Swift native
 * converter is the authoritative path (it runs in-process during scan
 * capture); this TS mirror exists for:
 *
 *   - **Client-side re-validation** of documents that arrived from the
 *     server (e.g. after upload + ingest, the client can re-derive the
 *     scene to catch bridge bugs early).
 *   - **Test fixtures** in Vitest: we can build a synthetic RoomPlan JSON
 *     and feed it through the same logic the native plugin uses.
 *   - **Recovery path**: if the native plugin fails mid-conversion, the
 *     uploaded raw RoomPlan dump can be re-converted on the server / in
 *     an Edge Function via this code.
 *
 * The full mapping pipeline lives in `bridge/scanToParametric.ts` (Day 8
 * B13), which marshals BLOCK-A capture data into RoomPlan-compatible JSON
 * + then through THIS function. Day 5 ships the skeleton + the host-wall
 * matcher invocation; the rest of the pipeline lands in Phase 0b.
 */

import {
  IDENTITY_QUATERNION,
  IDENTITY_VECTOR3,
  ONE_VECTOR3,
  type Quaternion,
  type Transform,
  type Vector3,
} from '../types/primitives.ts'
import type { Floor, Wall, WallOpening, Ceiling } from '../types/geometry.ts'
import type { SpatialObject } from '../types/objects.ts'
import type { RoomScene } from '../types/scene-graph.ts'
import { decomposeMatrix } from '../algebra/matrix.ts'
import { findHostWall, type HostWallCandidate } from '../geometry/door-portal.ts'
import { lengthCompute, normalCompute } from '../geometry/wall-geometry.ts'
import { CURRENT_SCHEMA_VERSION } from '../schema/version-migration.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Input shape — structurally equivalent to RoomPlan's CapturedRoom JSON dump.
// We only declare the subset we actually consume.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Subset of Apple RoomPlan's CapturedRoom JSON-dump shape. Mirrors the
 * structure produced by `RoomPlanPlugin.swift` when calling
 * `getCanonicalScene()` (Day 9 B17).
 */
export interface RoomPlanRoomDump {
  /** RoomPlan's room identifier. */
  identifier: string
  /** ISO-string capture timestamp. */
  captured_at?: string
  /** Optional room category supplied by RoomPlan's classifier. */
  category?: string
  /** Optional outward-facing structure information. */
  story?: number
  /** Walls as parametric segments (start/end/height/thickness/polygon). */
  walls: RoomPlanWallDump[]
  /** Doors detected by RoomPlan. */
  doors: RoomPlanOpeningDump[]
  /** Windows. */
  windows: RoomPlanOpeningDump[]
  /** Unframed openings (archways, pass-throughs). */
  openings: RoomPlanOpeningDump[]
  /** Objects (toilets, sinks, sofas, ...). */
  objects: RoomPlanObjectDump[]
  /** Floor polygon — may contain multiple disjoint regions; we merge in V1. */
  floors?: RoomPlanFloorDump[]
  /** Device metadata for forensics. */
  device?: RoomPlanDeviceDump
}

export interface RoomPlanWallDump {
  identifier: string
  /** 4×4 column-major transform — RoomPlan's `simd_float4x4` JSON-marshalled. */
  transform?: number[]
  start_point?: Vector3
  end_point?: Vector3
  dimensions?: { width_m: number; height_m: number; depth_m?: number }
  /** iOS 17+ irregular wall polygon, world-space. */
  polygon?: Vector3[]
  confidence?: 'low' | 'medium' | 'high'
}

export interface RoomPlanOpeningDump {
  identifier: string
  /** Closest-point world-position of the opening centroid. */
  position?: Vector3
  transform?: number[]
  dimensions: { width_m: number; height_m: number; depth_m?: number }
  /** Optional offset from the floor plane — set on iOS 18+; derived otherwise. */
  offset_from_floor_m?: number
  confidence?: 'low' | 'medium' | 'high'
  swing_direction?: 'left' | 'right' | 'sliding' | 'unknown'
}

export interface RoomPlanObjectDump {
  identifier: string
  category: string
  position?: Vector3
  transform?: number[]
  dimensions: { width_m: number; depth_m: number; height_m: number }
  confidence?: 'low' | 'medium' | 'high'
}

export interface RoomPlanFloorDump {
  identifier?: string
  polygon: Vector3[]
}

export interface RoomPlanDeviceDump {
  model?: string
  os_version?: string
  app_version?: string
  arkit_version?: string
}

/**
 * Default wall thickness when a RoomPlan wall dump carries no measured
 * `dimensions.depth_m`. Matches `bridge/scanToParametric.ts`'s
 * `DEFAULT_WALL_THICKNESS_M` and the L1 `Wall` default (Master-Spec §1.6).
 */
const DEFAULT_WALL_THICKNESS_M = 0.15

// ─────────────────────────────────────────────────────────────────────────────
// Conversion options
// ─────────────────────────────────────────────────────────────────────────────

export interface ConverterOptions {
  /** Used to populate canonical Node.created_at / updated_at if absent. */
  now?: () => string
  /** Used to derive `Project.id`, `Building.id`, etc. */
  newId?: () => string
  /** When true, run R12 wall-doubling collapse (default false in V1). */
  collapseWallDoublings?: boolean
}

/**
 * Conversion result: the canonical scene plus any non-fatal warnings
 * collected during host-wall matching, wall-doubling detection, etc.
 */
export interface ConverterResult {
  scene: RoomScene
  warnings: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a RoomPlan room dump into a canonical {@link RoomScene}.
 *
 * The function never throws: it surfaces every recoverable issue as a
 * `warnings[]` entry on the returned object. Hard failures (e.g. a wall
 * dump that doesn't carry either a transform OR start/end points) produce
 * walls with zero length; the validator will flag them downstream.
 *
 * The full Block-A → Canonical mapping (which builds a {@link RoomPlanRoomDump}
 * out of Block-A's `scans` + `scan_surfaces` + `scan_annotations`) lives in
 * `bridge/scanToParametric.ts` (Day 8 B13). This module assumes the input
 * is already in RoomPlan-shape.
 */
export function convertRoomPlanToCanonical(
  dump: RoomPlanRoomDump,
  options: ConverterOptions = {},
): ConverterResult {
  const now = options.now ?? (() => new Date().toISOString())
  const newId = options.newId ?? defaultNewId
  const warnings: string[] = []

  // Walls first — needed for host-wall matching of doors / windows / openings.
  const walls = dump.walls.map(w => convertWall(w, newId, now))

  // Wall-doubling collapse is opt-in for the TS mirror (the Swift converter
  // runs it natively; the TS path defers to V1.x for now per the task plan).
  // We surface the detection results as warnings either way.
  // The actual collapse logic + algorithm lives in `geometry/door-portal.ts`.
  // collapseWallDoublings is reserved for future use.
  void options.collapseWallDoublings

  // Match doors / openings / windows to their host walls.
  const hostCandidates: HostWallCandidate[] = walls.map(w => ({ id: w.id, geometry: w }))

  const doors = dump.doors.map(d => convertOpening(d, 'door', hostCandidates, newId, now, warnings))
  const openings = dump.openings.map(o =>
    convertOpening(o, 'opening', hostCandidates, newId, now, warnings),
  )
  const windows = dump.windows.map(w =>
    convertOpening(w, 'window', hostCandidates, newId, now, warnings),
  )

  // Attach openings to their host walls.
  for (const op of [...doors, ...openings, ...windows]) {
    const host = walls.find(w => w.id === op.host_wall_id)
    if (host) host.openings.push(op)
  }

  // Objects.
  const objects = dump.objects.map(o => convertObject(o, newId, now))

  // Floor (merge multiple RoomPlan floors into one canonical polygon).
  const floor = convertFloor(dump.floors ?? [], newId, now)

  // Ceiling — derived from walls' max-Y (V1 simplification).
  const ceilingHeight = computeCeilingHeight(walls)
  const ceiling = makeCeiling(floor.polygon, ceilingHeight, newId, now)

  // Bounding box from wall endpoints.
  const { boundsMin, boundsMax } = computeBounds(walls)

  const room: RoomScene = {
    id: dump.identifier,
    type: 'room',
    name: dump.identifier,
    parent_id: 'building',
    children_ids: [],
    transform: identityTransform(),
    source: 'roomplan',
    confidence: 1,
    variant_id: 'base_roomplan',
    created_at: dump.captured_at ?? now(),
    updated_at: now(),
    category: dumpCategoryToRoomCategory(dump.category),
    walls,
    floor,
    ceiling,
    free_objects: objects.filter(o => o.host === 'floor' || o.host === 'free'),
    pins: [],
    photos: [],
    notes: [],
    bounds_min: boundsMin,
    bounds_max: boundsMax,
    computed_area_m2: polygonAreaM2(floor.polygon),
    computed_volume_m3: polygonAreaM2(floor.polygon) * ceilingHeight,
  }

  // Attach wall-mounted + ceiling-mounted objects to their hosts.
  for (const obj of objects) {
    if (obj.host === 'wall' || obj.host === 'corner') {
      const host = walls.find(w => w.id === obj.host_id)
      host?.wall_mounted.push(obj)
    } else if (obj.host === 'ceiling') {
      ceiling.ceiling_mounted.push(obj)
    } else if (obj.host === 'floor') {
      floor.floor_mounted.push(obj)
    }
  }

  return { scene: room, warnings }
}

/** Re-export of {@link CURRENT_SCHEMA_VERSION} for converters' downstream use. */
export { CURRENT_SCHEMA_VERSION }

// ─────────────────────────────────────────────────────────────────────────────
// Walls / Openings / Objects / Floor / Ceiling
// ─────────────────────────────────────────────────────────────────────────────

function convertWall(
  dump: RoomPlanWallDump,
  _newId: () => string,
  now: () => string,
): Wall {
  // Extract start_point + end_point from either the explicit fields or by
  // decomposing the 4×4 transform + applying ±width/2 along the wall axis.
  const dimensions = dump.dimensions ?? { width_m: 0, height_m: 2.5 }
  const { start_point, end_point } = deriveWallEndpoints(dump, dimensions.width_m)
  const height_m = dimensions.height_m || 2.5
  // F12: use the measured wall depth as thickness when RoomPlan supplies it;
  // fall back to the 0.15 m default only when absent — mirrors the bridge's
  // `parsed.depthM ?? DEFAULT_WALL_THICKNESS_M`.
  const thickness_m =
    typeof dimensions.depth_m === 'number' &&
    Number.isFinite(dimensions.depth_m) &&
    dimensions.depth_m > 0
      ? dimensions.depth_m
      : DEFAULT_WALL_THICKNESS_M

  const wall: Wall = {
    id: dump.identifier,
    type: 'wall',
    parent_id: 'room',
    children_ids: [],
    transform: identityTransform(),
    source: 'roomplan',
    confidence: confidenceToNumber(dump.confidence),
    roomplan_uuid: dump.identifier,
    variant_id: 'base_roomplan',
    created_at: now(),
    updated_at: now(),
    start_point,
    end_point,
    height_m,
    thickness_m,
    base_height_m: 0,
    polygon_override: dump.polygon,
    openings: [],
    wall_mounted: [],
    is_exterior_wall: false,
    walkable_blocker: true,
    length_m: 0, // refreshed below
    normal: IDENTITY_VECTOR3,
  }
  wall.length_m = lengthCompute(wall)
  wall.normal = normalCompute(wall)
  return wall
}

function convertOpening(
  dump: RoomPlanOpeningDump,
  type: WallOpening['type'],
  hostCandidates: HostWallCandidate[],
  _newId: () => string,
  now: () => string,
  warnings: string[],
): WallOpening & { host_wall_id: string } {
  const centroid = dump.position ?? decomposeTransformToPosition(dump.transform)
  const match = findHostWall(centroid, hostCandidates)
  if (match.winner === null) {
    warnings.push(`opening ${dump.identifier} (${type}): no host wall found`)
  }
  if (match.warnings.length > 0) {
    warnings.push(...match.warnings.map(w => `${dump.identifier} (${type}): ${w}`))
  }
  const host = match.winner ?? hostCandidates[0]
  // Project the centroid back onto the host wall to derive offset_along_wall.
  const offsetAlong = offsetAlongHostWall(host, centroid, dump.dimensions.width_m)
  const offsetFromFloor = dump.offset_from_floor_m ?? (type === 'window' ? 0.9 : 0)
  const out: WallOpening & { host_wall_id: string } = {
    id: dump.identifier,
    type,
    parent_id: host?.id ?? 'room',
    children_ids: [],
    transform: identityTransform(),
    source: 'roomplan',
    confidence: confidenceToNumber(dump.confidence),
    roomplan_uuid: dump.identifier,
    variant_id: 'base_roomplan',
    created_at: now(),
    updated_at: now(),
    host_wall_id: host?.id ?? '',
    offset_along_wall_m: offsetAlong,
    offset_from_floor_m: offsetFromFloor,
    width_m: dump.dimensions.width_m,
    height_m: dump.dimensions.height_m,
    is_walkable_portal: type !== 'window',
  }
  if (type === 'door' && dump.swing_direction) {
    out.swing_direction = dump.swing_direction
  }
  if (type === 'window') out.sill_height_m = offsetFromFloor
  return out
}

function convertObject(
  dump: RoomPlanObjectDump,
  _newId: () => string,
  now: () => string,
): SpatialObject {
  const position = dump.position ?? decomposeTransformToPosition(dump.transform)
  // RoomPlan's category strings are lowercase; cast directly (validator will
  // surface unknown categories via downstream rule). Most categories collapse
  // onto our taxonomy 1:1.
  const category = (dump.category ?? 'generic_cuboid') as SpatialObject['category']
  return {
    id: dump.identifier,
    type: 'object',
    parent_id: 'room',
    children_ids: [],
    transform: { position, rotation: IDENTITY_QUATERNION, scale: ONE_VECTOR3 },
    source: 'roomplan',
    confidence: confidenceToNumber(dump.confidence),
    roomplan_uuid: dump.identifier,
    variant_id: 'base_roomplan',
    created_at: now(),
    updated_at: now(),
    category,
    dimensions: dump.dimensions,
    host: 'floor',
    host_id: 'floor',
  }
}

function convertFloor(
  dumps: RoomPlanFloorDump[],
  _newId: () => string,
  now: () => string,
): Floor {
  // V1: pick the largest floor polygon. Multi-floor merge is V1.x.
  let polygon: Vector3[] = []
  let bestArea = -Infinity
  for (const f of dumps) {
    const area = polygonAreaM2(f.polygon)
    if (area > bestArea) {
      bestArea = area
      polygon = f.polygon
    }
  }
  return {
    id: 'floor',
    type: 'floor',
    parent_id: 'room',
    children_ids: [],
    transform: identityTransform(),
    source: 'roomplan',
    confidence: 1,
    variant_id: 'base_roomplan',
    created_at: now(),
    updated_at: now(),
    polygon,
    walkable_surface: true,
    floor_mounted: [],
  }
}

function makeCeiling(
  floorPolygon: Vector3[],
  heightM: number,
  _newId: () => string,
  now: () => string,
): Ceiling {
  return {
    id: 'ceiling',
    type: 'ceiling',
    parent_id: 'room',
    children_ids: [],
    transform: identityTransform(),
    source: 'roomplan',
    confidence: 1,
    variant_id: 'base_roomplan',
    created_at: now(),
    updated_at: now(),
    polygon: floorPolygon.map(p => ({ x: p.x, y: heightM, z: p.z })),
    height_m: heightM,
    ceiling_mounted: [],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function identityTransform(): Transform {
  return {
    position: IDENTITY_VECTOR3,
    rotation: IDENTITY_QUATERNION,
    scale: ONE_VECTOR3,
  }
}

function defaultNewId(): string {
  return 'canon_' + Math.random().toString(36).slice(2, 10)
}

function confidenceToNumber(c?: 'low' | 'medium' | 'high'): number {
  switch (c) {
    case 'low':
      return 0.3
    case 'medium':
      return 0.6
    case 'high':
      return 0.9
    default:
      return 0.5
  }
}

function dumpCategoryToRoomCategory(c?: string): RoomScene['category'] {
  const lower = (c ?? '').toLowerCase()
  if (lower.includes('bath')) return 'bathroom'
  if (lower.includes('kitchen')) return 'kitchen'
  if (lower.includes('living')) return 'living'
  if (lower.includes('bedroom')) return 'bedroom'
  if (lower.includes('hall')) return 'hallway'
  if (lower.includes('office')) return 'office'
  if (lower.includes('storage')) return 'storage'
  return 'other'
}

function deriveWallEndpoints(
  dump: RoomPlanWallDump,
  widthM: number,
): { start_point: Vector3; end_point: Vector3 } {
  if (dump.start_point && dump.end_point) {
    return { start_point: dump.start_point, end_point: dump.end_point }
  }
  if (dump.transform && widthM > 0) {
    // Decompose transform → centroid. Walls' local +X axis is the wall direction.
    const { position, rotation } = decomposeTransform(dump.transform)
    const dir = quaternionRotateX(rotation)
    const half = widthM / 2
    return {
      start_point: { x: position.x - dir.x * half, y: position.y, z: position.z - dir.z * half },
      end_point: { x: position.x + dir.x * half, y: position.y, z: position.z + dir.z * half },
    }
  }
  return { start_point: IDENTITY_VECTOR3, end_point: IDENTITY_VECTOR3 }
}

function decomposeTransform(matrix: number[]): { position: Vector3; rotation: Quaternion } {
  if (matrix.length !== 16) return { position: IDENTITY_VECTOR3, rotation: IDENTITY_QUATERNION }
  const m = matrix as unknown as Parameters<typeof decomposeMatrix>[0]
  const { position, rotation } = decomposeMatrix(m)
  return { position, rotation }
}

function decomposeTransformToPosition(matrix?: number[]): Vector3 {
  if (!matrix || matrix.length !== 16) return IDENTITY_VECTOR3
  return decomposeTransform(matrix).position
}

function quaternionRotateX(q: Quaternion): Vector3 {
  // Apply quaternion to (1, 0, 0).
  const { x, y, z, w } = q
  return {
    x: 1 - 2 * (y * y + z * z),
    y: 2 * (x * y + w * z),
    z: 2 * (x * z - w * y),
  }
}

function offsetAlongHostWall(
  host: HostWallCandidate | undefined,
  centroid: Vector3,
  openingWidth: number,
): number {
  if (!host) return 0
  const start = host.geometry.start_point
  const end = host.geometry.end_point
  const dx = end.x - start.x
  const dz = end.z - start.z
  const len = Math.hypot(dx, dz)
  if (len < 1e-6) return 0
  const along = ((centroid.x - start.x) * dx + (centroid.z - start.z) * dz) / len
  // Centroid → left edge.
  return Math.max(0, along - openingWidth / 2)
}

function computeCeilingHeight(walls: Wall[]): number {
  if (walls.length === 0) return 2.5
  // Take the median wall height to reject outliers (RoomPlan's height
  // estimate is sometimes wrong on individual walls).
  const heights = walls.map(w => w.height_m).filter(h => h > 0).sort((a, b) => a - b)
  if (heights.length === 0) return 2.5
  const mid = Math.floor(heights.length / 2)
  return heights.length % 2 === 0 ? (heights[mid - 1] + heights[mid]) / 2 : heights[mid]
}

function computeBounds(walls: Wall[]): { boundsMin: Vector3; boundsMax: Vector3 } {
  if (walls.length === 0) {
    return { boundsMin: IDENTITY_VECTOR3, boundsMax: IDENTITY_VECTOR3 }
  }
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
  for (const w of walls) {
    minX = Math.min(minX, w.start_point.x, w.end_point.x)
    minZ = Math.min(minZ, w.start_point.z, w.end_point.z)
    maxX = Math.max(maxX, w.start_point.x, w.end_point.x)
    maxZ = Math.max(maxZ, w.start_point.z, w.end_point.z)
  }
  const maxHeight = Math.max(...walls.map(w => w.height_m))
  return {
    boundsMin: { x: minX, y: 0, z: minZ },
    boundsMax: { x: maxX, y: maxHeight, z: maxZ },
  }
}

function polygonAreaM2(polygon: Vector3[]): number {
  if (polygon.length < 3) return 0
  let area = 0
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]
    area += a.x * b.z - b.x * a.z
  }
  return Math.abs(area) / 2
}
