/**
 * Spatial · Canonical · Bridge · Block-A Scan → Canonical RoomScene
 *
 * Day 8 B13. The single legal converter from Block-A's capture layer
 * (`src/lib/spatial/types.ts` · scans / scan_surfaces / scan_measurements /
 * scan_annotations) to the canonical parametric scene-graph.
 *
 * Conventions (binding · Plan §4 Day 8 + Hard-Review audit-mitigations):
 *
 *   1. **Wall surfaces → Wall**. width = `dimWVerified ?? dimWEstimated`,
 *      height = `dimHVerified ?? dimHEstimated`. start/end derived from the
 *      `transform` (centerpoint + rotationYRad → axis along surface-X).
 *      Default `thickness_m = 0.15` (matches L1 default; M27 audit-finding
 *      tracks reading from `transform.depth_m` when available).
 *
 *   2. **Floor + Ceiling**. polygon = rectangle inferred from wall start/end
 *      points (CCW). Ceiling = same polygon, lifted by ceiling height.
 *      area / ceiling-height from `ScanRoom`'s verified ?? estimated fields.
 *
 *   3. **Door / Window / Opening surfaces → WallOpening**. H28 audit-fix:
 *      wall-doubling collapse runs PRE host-matching (call
 *      `findOverlappingWalls`, skip the second-of-pair from host candidates).
 *      Then `findHostWall(centerPoint, walls)` derives `host_wall_id`.
 *      Populate `host_wall_confidence` from the matcher's `confidence`
 *      field (H17 audit-fix).
 *
 *   4. **Object surfaces → SpatialObject**. H27 audit-fix: NEVER hardcode
 *      `host: 'floor'`. Detection priority:
 *        (a) `transform.y` close to ceilingH → 'ceiling'
 *        (b) `transform.y` close to 0       → 'floor'
 *        (c) flush with a wall plane        → 'wall' + host_id from match
 *        (d) otherwise                      → 'free' (no host)
 *
 *   5. **Annotations → Pin / Photo / Note**. `anchorUv.surfaceExternalId` is
 *      resolved via a `BRIDGE_DEFAULTS` map (`scan_surface_external_id →
 *      canonical_node_id`) built once at bridge start. `anchorUv.uv: [u, v]`
 *      → canonical `{ u, v }`. Block-A unix-ms → canonical ISO-8601 via
 *      `unixMsToIso()` (XM-4). camelCase → snake_case at the boundary (XM-3).
 *
 *   6. **Wall-doubling collapse**. Default `collapseWallDoublings: true`;
 *      when `false`, emit one warning per detected pair (H28).
 *
 * Pure-function: no Supabase / network / DOM / three.js. Re-uses L1
 * helpers (`findHostWall`, `findOverlappingWalls`, `unixMsToIso`) — never
 * reimplements them.
 */

import {
  type Scan,
  type ScanAnnotation,
  type ScanMeasurement,
  type ScanRoom,
  type ScanSurface,
  type ScanTransform,
} from '../../types.ts'
import { unixMsToIso } from '../algebra/time.ts'
import {
  findHostWall,
  findOverlappingWalls,
  type HostWallCandidate,
} from '../geometry/door-portal.ts'
import {
  lengthCompute,
  normalCompute,
} from '../geometry/wall-geometry.ts'
import {
  inferFloorPolygonFromWalls,
  polygonAreaM2,
} from '../geometry/footprint.ts'
import type {
  AnchorSurfaceType,
  Note,
  Photo,
  Pin,
} from '../types/annotations.ts'
import type {
  Ceiling,
  Floor,
  Wall,
  WallOpening,
  WallOpeningType,
} from '../types/geometry.ts'
import type {
  ObjectHost,
  SpatialObject,
} from '../types/objects.ts'
import {
  IDENTITY_QUATERNION,
  IDENTITY_VECTOR3,
  ONE_VECTOR3,
  type Transform,
  type Vector3,
} from '../types/primitives.ts'
import type { RoomScene } from '../types/scene-graph.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Public input / output surface
// ─────────────────────────────────────────────────────────────────────────────

export interface ScanToParametricInput {
  scan: Scan
  rooms: ScanRoom[]
  surfaces: ScanSurface[]
  measurements: ScanMeasurement[]
  annotations: ScanAnnotation[]
  options?: {
    /** Default `true`. When `false`, emit a warning per detected pair. */
    collapseWallDoublings?: boolean
    /** Optional override for `Project.fixup_project_id`. Defaults to `scan.projectId`. */
    fixupProjectId?: string | null
    /** Optional override for `Project.fixup_job_id`. Defaults to `scan.jobId`. */
    fixupJobId?: string | null
  }
}

export interface ScanToParametricResult {
  scene: RoomScene
  /** Bridge-emitted diagnostics (host-wall ambiguity, wall-doubling, …). */
  warnings: string[]
  /** Map from `scan_surface_external_id → canonical_node_id` for downstream re-resolves. */
  bridgeDefaults: BridgeDefaults
}

export interface BridgeDefaults {
  surfaceExternalIdToNodeId: Record<string, string>
}

// ─────────────────────────────────────────────────────────────────────────────
// Tunables (kept local to the bridge — these are bridge-mapping policy, not
// L1 geometry constants)
// ─────────────────────────────────────────────────────────────────────────────

/** Default wall thickness when Block-A does not supply one (M27). */
const DEFAULT_WALL_THICKNESS_M = 0.15

/** Default ceiling height when ScanRoom doesn't supply one. */
const DEFAULT_CEILING_HEIGHT_M = 2.5

/**
 * Tolerance for detecting that an object's `transform.y` is "close to" the
 * floor plane (host: 'floor') or the ceiling plane (host: 'ceiling').
 * 5 cm chosen so RoomPlan noise doesn't push a floor-anchored toilet up to
 * the wall classification, but a wall-mounted radiator at y ≈ 0.7 m stays
 * out of the floor bucket.
 */
const HOST_PLANE_TOLERANCE_M = 0.05

/**
 * Maximum perpendicular distance from an object's footprint to a wall plane
 * for the object to be classified as `host: 'wall'`. 15 cm allows for a
 * sink protruding from its host wall while excluding furniture that just
 * happens to sit next to a wall.
 */
const HOST_WALL_FLUSH_TOLERANCE_M = 0.15

/** Default confidence emitted into canonical nodes when Block-A has none. */
const DEFAULT_CONFIDENCE = 0.6

// ─────────────────────────────────────────────────────────────────────────────
// Internal transform-parsing
//
// Block-A's `transform` is opaque `Record<string, unknown>`. The bridge
// reads two well-known shapes:
//   - `{ position: {x,y,z}, rotationYRad?: number, depthM?: number }`
//     (the canonical Block-A capture shape used by the plugin)
//   - `{ x, y, z, rotationYRad?, depthM? }`  (flat-position legacy shape)
// Both are accepted; everything else falls back to identity at origin.
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedTransform {
  position: Vector3
  /** Rotation around the world Y axis in radians (0 = surface +X axis aligned with world +X). */
  rotationYRad: number
  /** Optional explicit wall thickness (M27 follow-up). */
  depthM?: number
}

function parseScanTransform(t: ScanTransform | null): ParsedTransform {
  if (!t || typeof t !== 'object') {
    return { position: { ...IDENTITY_VECTOR3 }, rotationYRad: 0 }
  }
  const rec = t as Record<string, unknown>

  // Shape A: nested position blob.
  const pos = rec.position
  if (pos && typeof pos === 'object') {
    const p = pos as { x?: unknown; y?: unknown; z?: unknown }
    return {
      position: {
        x: numOrZero(p.x),
        y: numOrZero(p.y),
        z: numOrZero(p.z),
      },
      rotationYRad: numOrZero(rec.rotationYRad),
      depthM: optionalNum(rec.depthM),
    }
  }
  // Shape B: flat-position legacy.
  return {
    position: {
      x: numOrZero(rec.x),
      y: numOrZero(rec.y),
      z: numOrZero(rec.z),
    },
    rotationYRad: numOrZero(rec.rotationYRad),
    depthM: optionalNum(rec.depthM),
  }
}

function numOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function optionalNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * camelCase → snake_case for free-form keys at the bridge boundary (XM-3).
 * Used only for opaque payload bodies; the canonical TS interfaces are
 * already snake_case so structural fields don't go through this helper.
 */
function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, ch => `_${ch.toLowerCase()}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a Block-A scan dump into a canonical {@link RoomScene}.
 *
 * Pure-function; never throws on recoverable issues — surfaces them as
 * `warnings[]` instead so downstream UI / validator can react. Hard input
 * errors (unparseable transform, missing room) produce degenerate-but-valid
 * output (zero-length walls, empty floor polygon) so the validator can flag
 * them with the existing `ROOM_*` / `WALL_*` codes.
 */
export function scanToParametric(input: ScanToParametricInput): ScanToParametricResult {
  const warnings: string[] = []
  const surfaceExternalIdToNodeId: Record<string, string> = {}

  // ── V1 simplification: take the first room (typically the only one).
  //    Multi-room scans are rare in V1 (single-room RoomPlan capture) but
  //    do exist (e.g. provider re-captures a smaller anteroom alongside the
  //    primary). Emit a warning so callers can surface the dropped rooms
  //    instead of silently losing them; Phase 1+ extends the bridge to
  //    multi-room aggregation. ───────────────────────────────────────────
  const room = input.rooms[0]
  if (!room) {
    warnings.push('SCAN_NO_ROOMS: scan has no rooms; emitting empty scene')
  } else if (input.rooms.length > 1) {
    const droppedIds = input.rooms.slice(1).map(r => r.id).join(',')
    warnings.push(
      `SCAN_MULTI_ROOM_DROPPED: ${input.rooms.length - 1} additional room(s) ignored — V1 emits a single room. Dropped: ${droppedIds}`,
    )
  }

  // ── Sort surfaces by kind for deterministic iteration. ───────────────────
  const wallSurfaces = input.surfaces.filter(s => s.kind === 'wall')
  const openingSurfaces = input.surfaces.filter(
    s => s.kind === 'door' || s.kind === 'window' || s.kind === 'opening',
  )
  const objectSurfaces = input.surfaces.filter(s => s.kind === 'object')

  // ── 1) Build walls. Each scan-surface keeps the same id on the canonical
  //       side so anchor-resolution stays a flat lookup. ───────────────────
  const collapseWallDoublings = input.options?.collapseWallDoublings ?? true
  const ceilingHeightM = ceilingHeightFromRoom(room)

  let walls: Wall[] = wallSurfaces.map(s => {
    const id = canonicalIdForSurface(s)
    surfaceExternalIdToNodeId[s.surfaceExternalId] = id
    return buildWall(s, input.scan)
  })

  // ── 2) Wall-doubling detection. PRE host-matching (H28). ─────────────────
  const overlapPairs = findOverlappingWalls(
    walls.map(w => ({ id: w.id, geometry: w })),
  )
  const collapsedWallIds = new Set<string>()
  if (overlapPairs.length > 0) {
    if (collapseWallDoublings) {
      // Keep the first-of-pair, drop the second.
      for (const pair of overlapPairs) {
        collapsedWallIds.add(pair.b.id)
        warnings.push(
          `WALL_DOUBLING_COLLAPSED: wall ${pair.b.id} merged into ${pair.a.id} (perp=${pair.perpDistance_m.toFixed(3)} m, overlap=${pair.lengthOverlapRatio.toFixed(2)})`,
        )
      }
    } else {
      for (const pair of overlapPairs) {
        warnings.push(
          `WALL_DOUBLING_DETECTED: walls ${pair.a.id} and ${pair.b.id} look like a single thicker wall (perp=${pair.perpDistance_m.toFixed(3)} m, overlap=${pair.lengthOverlapRatio.toFixed(2)})`,
        )
      }
    }
  }
  if (collapsedWallIds.size > 0) {
    // Drop collapsed walls from the canonical wall list. The
    // surfaceExternalIdToNodeId map keeps their entry so annotation lookups
    // by the collapsed surface's external-id still resolve to a node-id
    // present in the scene (the surviving wall of the pair).
    const collapsedExternalToSurvivor: Record<string, string> = {}
    for (const pair of overlapPairs) {
      const survivorId = collapsedWallIds.has(pair.a.id) ? pair.b.id : pair.a.id
      const collapsedSurface = wallSurfaces.find(s => canonicalIdForSurface(s) === pair.b.id)
      if (collapsedSurface) {
        collapsedExternalToSurvivor[collapsedSurface.surfaceExternalId] = survivorId
      }
    }
    for (const [ext, survivor] of Object.entries(collapsedExternalToSurvivor)) {
      surfaceExternalIdToNodeId[ext] = survivor
    }
    walls = walls.filter(w => !collapsedWallIds.has(w.id))
  }

  // ── 3) Build floor + ceiling. ────────────────────────────────────────────
  const floorPolygon = inferFloorPolygonFromWalls(walls)
  if (walls.length > 0 && floorPolygon.length === 0) {
    warnings.push(
      'FLOOR_POLYGON_NOT_CLOSED: walls do not stitch into a single closed ring — emitting empty floor polygon (area falls back to ScanRoom)',
    )
  }
  const floorId = `floor_${room?.id ?? 'room'}`
  const ceilingId = `ceiling_${room?.id ?? 'room'}`
  const floor: Floor = buildFloor(floorId, floorPolygon, input.scan)
  const ceiling: Ceiling = buildCeiling(ceilingId, floorPolygon, ceilingHeightM, input.scan)

  // ── 4) Build openings. ───────────────────────────────────────────────────
  const hostCandidates: HostWallCandidate[] = walls.map(w => ({ id: w.id, geometry: w }))
  const openings: WallOpening[] = []
  for (const s of openingSurfaces) {
    const id = canonicalIdForSurface(s)
    surfaceExternalIdToNodeId[s.surfaceExternalId] = id
    const opening = buildWallOpening(s, hostCandidates, input.scan, warnings)
    openings.push(opening)
    const host = walls.find(w => w.id === opening.host_wall_id)
    host?.openings.push(opening)
  }

  // ── 5) Build objects. H27 audit-fix: detect host (do NOT hardcode). ──────
  const freeObjects: SpatialObject[] = []
  for (const s of objectSurfaces) {
    const id = canonicalIdForSurface(s)
    surfaceExternalIdToNodeId[s.surfaceExternalId] = id
    const { obj, hostInfo } = buildObject(
      s,
      walls,
      floor,
      ceiling,
      ceilingHeightM,
      input.scan,
      warnings,
    )
    if (hostInfo.host === 'wall' || hostInfo.host === 'corner') {
      const host = walls.find(w => w.id === obj.host_id)
      host?.wall_mounted.push(obj)
    } else if (hostInfo.host === 'ceiling') {
      ceiling.ceiling_mounted.push(obj)
    } else if (hostInfo.host === 'floor') {
      floor.floor_mounted.push(obj)
    } else {
      // 'free' — not anchored, goes into room.free_objects.
      freeObjects.push(obj)
    }
  }

  // ── 6) Build annotations. ────────────────────────────────────────────────
  const pins: Pin[] = []
  const photos: Photo[] = []
  const notes: Note[] = []
  for (const a of input.annotations) {
    const built = buildAnnotation(
      a,
      surfaceExternalIdToNodeId,
      input.surfaces,
      walls,
      floor,
      ceiling,
      warnings,
    )
    if (built === null) continue
    if (built.type === 'pin') pins.push(built)
    else if (built.type === 'photo') photos.push(built)
    else notes.push(built)
  }

  // ── 7) Bounds + computed area + volume. ──────────────────────────────────
  const bounds = computeRoomBounds(walls, ceilingHeightM)
  const area = polygonAreaM2(floorPolygon)
  void input.measurements // measurements feed dimWVerified/dimHVerified on surfaces

  // V1 simplification: pull the verified ?? estimated area from ScanRoom
  // when wall-derived polygon area is degenerate (e.g. no walls).
  const computedArea =
    area > 0
      ? area
      : (room?.areaM2Verified ?? room?.areaM2Estimated ?? 0)
  const computedVolume = computedArea * ceilingHeightM

  // ── 8) Compose the RoomScene. ────────────────────────────────────────────
  const createdAtIso = unixMsToIso(input.scan.scanStartedAt ?? input.scan.createdAt)
  const updatedAtIso = unixMsToIso(input.scan.updatedAt)
  const scene: RoomScene = {
    id: room?.id ?? `room_${input.scan.id}`,
    type: 'room',
    name: room?.name ?? undefined,
    parent_id: 'building',
    children_ids: [],
    transform: identityTransform(),
    source: 'roomplan',
    confidence: 1,
    variant_id: 'base_roomplan',
    created_at: createdAtIso,
    updated_at: updatedAtIso,
    category: 'other',
    walls,
    floor,
    ceiling,
    free_objects: freeObjects,
    pins,
    photos,
    notes,
    bounds_min: bounds.min,
    bounds_max: bounds.max,
    computed_area_m2: computedArea,
    computed_volume_m3: computedVolume,
  }

  // Acknowledge un-used options (kept on the signature for downstream
  // composers).
  void input.options?.fixupProjectId
  void input.options?.fixupJobId

  return {
    scene,
    warnings,
    bridgeDefaults: { surfaceExternalIdToNodeId },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wall builder
// ─────────────────────────────────────────────────────────────────────────────

function buildWall(s: ScanSurface, _scan: Scan): Wall {
  const widthM = s.dimWVerified ?? s.dimWEstimated ?? 0
  const heightM = s.dimHVerified ?? s.dimHEstimated ?? 2.5
  const parsed = parseScanTransform(s.transform)

  // Centerpoint at parsed.position; wall axis is the local +X direction
  // rotated by rotationYRad around world Y. start/end = center ± (width/2)*axis.
  const cos = Math.cos(parsed.rotationYRad)
  const sin = Math.sin(parsed.rotationYRad)
  // Local +X under rotation around Y: (cos, 0, -sin) on the XZ plane.
  const axisX = cos
  const axisZ = -sin
  const half = widthM / 2

  const start_point: Vector3 = {
    x: parsed.position.x - axisX * half,
    y: parsed.position.y,
    z: parsed.position.z - axisZ * half,
  }
  const end_point: Vector3 = {
    x: parsed.position.x + axisX * half,
    y: parsed.position.y,
    z: parsed.position.z + axisZ * half,
  }

  const thicknessM = parsed.depthM ?? DEFAULT_WALL_THICKNESS_M

  const wall: Wall = {
    id: canonicalIdForSurface(s),
    type: 'wall',
    name: s.surfaceExternalId,
    parent_id: 'room',
    children_ids: [],
    transform: identityTransform(),
    source: 'roomplan',
    confidence: s.confidence ?? DEFAULT_CONFIDENCE,
    roomplan_uuid: s.surfaceExternalId,
    variant_id: 'base_roomplan',
    created_at: unixMsToIso(s.createdAt),
    updated_at: unixMsToIso(s.updatedAt),
    start_point,
    end_point,
    height_m: heightM,
    thickness_m: thicknessM,
    base_height_m: 0,
    openings: [],
    wall_mounted: [],
    is_exterior_wall: false,
    walkable_blocker: true,
    length_m: 0,
    normal: IDENTITY_VECTOR3,
  }
  wall.length_m = lengthCompute(wall)
  wall.normal = normalCompute(wall)
  return wall
}

// ─────────────────────────────────────────────────────────────────────────────
// Floor + ceiling builders
// ─────────────────────────────────────────────────────────────────────────────

function buildFloor(id: string, polygon: Vector3[], scan: Scan): Floor {
  return {
    id,
    type: 'floor',
    parent_id: 'room',
    children_ids: [],
    transform: identityTransform(),
    source: 'roomplan',
    confidence: 1,
    variant_id: 'base_roomplan',
    created_at: unixMsToIso(scan.scanStartedAt ?? scan.createdAt),
    updated_at: unixMsToIso(scan.updatedAt),
    polygon,
    walkable_surface: true,
    floor_mounted: [],
  }
}

function buildCeiling(
  id: string,
  floorPolygon: Vector3[],
  heightM: number,
  scan: Scan,
): Ceiling {
  return {
    id,
    type: 'ceiling',
    parent_id: 'room',
    children_ids: [],
    transform: identityTransform(),
    source: 'roomplan',
    confidence: 1,
    variant_id: 'base_roomplan',
    created_at: unixMsToIso(scan.scanStartedAt ?? scan.createdAt),
    updated_at: unixMsToIso(scan.updatedAt),
    polygon: floorPolygon.map(p => ({ x: p.x, y: heightM, z: p.z })),
    height_m: heightM,
    ceiling_mounted: [],
  }
}

function ceilingHeightFromRoom(room: ScanRoom | undefined): number {
  if (!room) return DEFAULT_CEILING_HEIGHT_M
  return room.ceilingHVerified ?? room.ceilingHEstimated ?? DEFAULT_CEILING_HEIGHT_M
}

// inferFloorPolygonFromWalls / signedShoelaceArea / polygonAreaM2 now live in
// ../geometry/footprint.ts (the canonical geometry layer) so the scan-ingest
// path here and the manual footprint-edit path share one implementation.
// They are imported at the top of this file.

function computeRoomBounds(walls: Wall[], ceilingHeightM: number): { min: Vector3; max: Vector3 } {
  if (walls.length === 0) {
    return { min: { ...IDENTITY_VECTOR3 }, max: { ...IDENTITY_VECTOR3 } }
  }
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
  for (const w of walls) {
    minX = Math.min(minX, w.start_point.x, w.end_point.x)
    minZ = Math.min(minZ, w.start_point.z, w.end_point.z)
    maxX = Math.max(maxX, w.start_point.x, w.end_point.x)
    maxZ = Math.max(maxZ, w.start_point.z, w.end_point.z)
  }
  return {
    min: { x: minX, y: 0, z: minZ },
    max: { x: maxX, y: ceilingHeightM, z: maxZ },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Opening builder
// ─────────────────────────────────────────────────────────────────────────────

function buildWallOpening(
  s: ScanSurface,
  hostCandidates: HostWallCandidate[],
  _scan: Scan,
  warnings: string[],
): WallOpening {
  const widthM = s.dimWVerified ?? s.dimWEstimated ?? 0
  const heightM = s.dimHVerified ?? s.dimHEstimated ?? 2
  const parsed = parseScanTransform(s.transform)
  const type: WallOpeningType =
    s.kind === 'door' ? 'door' : s.kind === 'window' ? 'window' : 'opening'

  const match = findHostWall(parsed.position, hostCandidates)
  if (match.winner === null) {
    warnings.push(`OPENING_HOST_NOT_FOUND: ${s.surfaceExternalId} (${type}) — no wall within tolerance`)
  }
  if (match.warnings.length > 0) {
    warnings.push(...match.warnings.map(w => `${s.surfaceExternalId} (${type}): ${w}`))
  }

  const host = match.winner ?? hostCandidates[0]
  const offsetAlong = offsetAlongHostWall(host, parsed.position, widthM)
  const offsetFromFloor = Math.max(0, parsed.position.y - heightM / 2)

  const opening: WallOpening = {
    id: canonicalIdForSurface(s),
    type,
    name: s.surfaceExternalId,
    parent_id: host?.id ?? 'room',
    children_ids: [],
    transform: identityTransform(),
    source: 'roomplan',
    confidence: s.confidence ?? DEFAULT_CONFIDENCE,
    roomplan_uuid: s.surfaceExternalId,
    variant_id: 'base_roomplan',
    created_at: unixMsToIso(s.createdAt),
    updated_at: unixMsToIso(s.updatedAt),
    host_wall_id: host?.id ?? '',
    offset_along_wall_m: offsetAlong,
    offset_from_floor_m: type === 'door' || type === 'opening' ? 0 : offsetFromFloor,
    width_m: widthM,
    height_m: heightM,
    is_walkable_portal: type !== 'window',
    host_wall_confidence: match.confidence,
  }
  if (type === 'window') opening.sill_height_m = offsetFromFloor
  return opening
}

function offsetAlongHostWall(
  host: HostWallCandidate | undefined,
  centroid: Vector3,
  openingWidthM: number,
): number {
  if (!host) return 0
  const start = host.geometry.start_point
  const end = host.geometry.end_point
  const dx = end.x - start.x
  const dz = end.z - start.z
  const len = Math.hypot(dx, dz)
  if (len < 1e-6) return 0
  const along = ((centroid.x - start.x) * dx + (centroid.z - start.z) * dz) / len
  return Math.max(0, along - openingWidthM / 2)
}

// ─────────────────────────────────────────────────────────────────────────────
// Object builder — H27 audit-fix (host detection, not hardcoded 'floor')
// ─────────────────────────────────────────────────────────────────────────────

interface HostDetectionResult {
  host: ObjectHost
  host_id: string
  host_wall_confidence?: number
}

function detectObjectHost(
  _s: ScanSurface,
  parsed: ParsedTransform,
  walls: Wall[],
  floor: Floor,
  ceiling: Ceiling,
  ceilingHeightM: number,
): HostDetectionResult {
  const y = parsed.position.y

  // (a) Close to ceiling plane?
  if (Math.abs(y - ceilingHeightM) <= HOST_PLANE_TOLERANCE_M) {
    return { host: 'ceiling', host_id: ceiling.id }
  }

  // (c) Flush with a wall plane? Run host-wall matching with a slightly
  //     wider tolerance than the door matcher (objects can protrude further).
  //     H27 binding: we check this BEFORE the floor classification so wall-
  //     mounted radiators at y ≈ 0.7 m don't get bucketed as floor.
  const wallMatch = findHostWall(parsed.position, walls.map(w => ({ id: w.id, geometry: w })), {
    max_distance_m: HOST_WALL_FLUSH_TOLERANCE_M,
    ambiguity_tolerance_m: 0.05,
    along_tolerance_m: 0.1,
  })
  if (wallMatch.winner !== null) {
    return {
      host: 'wall',
      host_id: wallMatch.winner.id,
      host_wall_confidence: wallMatch.confidence,
    }
  }

  // (b) Close to floor plane?
  if (Math.abs(y) <= HOST_PLANE_TOLERANCE_M) {
    return { host: 'floor', host_id: floor.id }
  }

  // (d) Otherwise — free-standing.
  return { host: 'free', host_id: '' }
}

function buildObject(
  s: ScanSurface,
  walls: Wall[],
  floor: Floor,
  ceiling: Ceiling,
  ceilingHeightM: number,
  _scan: Scan,
  warnings: string[],
): { obj: SpatialObject; hostInfo: HostDetectionResult } {
  const widthM = s.dimWVerified ?? s.dimWEstimated ?? 0.5
  const heightM = s.dimHVerified ?? s.dimHEstimated ?? 0.5
  const depthM = 0.5 // ScanSurface doesn't carry depth in V1; default cuboid.
  const parsed = parseScanTransform(s.transform)
  const hostInfo = detectObjectHost(s, parsed, walls, floor, ceiling, ceilingHeightM)

  if (hostInfo.host === 'free') {
    warnings.push(
      `OBJECT_HOST_FREE: ${s.surfaceExternalId} could not be attached to floor/wall/ceiling — emitting as free-standing`,
    )
  }

  const obj: SpatialObject = {
    id: canonicalIdForSurface(s),
    type: 'object',
    name: s.surfaceExternalId,
    parent_id: hostInfo.host_id || 'room',
    children_ids: [],
    transform: {
      position: parsed.position,
      rotation: IDENTITY_QUATERNION, // V1: rotationYRad encoded into transform only
      scale: ONE_VECTOR3,
    },
    source: 'roomplan',
    confidence: s.confidence ?? DEFAULT_CONFIDENCE,
    roomplan_uuid: s.surfaceExternalId,
    variant_id: 'base_roomplan',
    created_at: unixMsToIso(s.createdAt),
    updated_at: unixMsToIso(s.updatedAt),
    category: 'generic_cuboid',
    dimensions: { width_m: widthM, depth_m: depthM, height_m: heightM },
    host: hostInfo.host,
    host_id: hostInfo.host_id,
  }
  if (hostInfo.host === 'floor') {
    obj.rotation_around_y_deg = (parsed.rotationYRad * 180) / Math.PI
  } else if (hostInfo.host === 'wall') {
    obj.height_from_floor_m = parsed.position.y - heightM / 2
  }

  return { obj, hostInfo }
}

// ─────────────────────────────────────────────────────────────────────────────
// Annotation builder
// ─────────────────────────────────────────────────────────────────────────────

function buildAnnotation(
  a: ScanAnnotation,
  externalToNodeId: Record<string, string>,
  surfaces: ScanSurface[],
  walls: Wall[],
  floor: Floor,
  ceiling: Ceiling,
  warnings: string[],
): Pin | Photo | Note | null {
  const createdAt = unixMsToIso(a.createdAt)
  const updatedAt = unixMsToIso(a.updatedAt)

  // ── Resolve anchor (if present). ─────────────────────────────────────────
  let anchorSurfaceId: string | undefined
  let anchorSurfaceType: AnchorSurfaceType | undefined
  let anchorUv: { u: number; v: number } | undefined
  if (a.anchorUv) {
    const resolved = externalToNodeId[a.anchorUv.surfaceExternalId]
    if (!resolved) {
      warnings.push(
        `ANNOTATION_ANCHOR_UNRESOLVED: annotation ${a.id} references unknown surface ${a.anchorUv.surfaceExternalId}`,
      )
    } else {
      anchorSurfaceId = resolved
      anchorSurfaceType = resolveAnchorSurfaceType(
        resolved,
        surfaces,
        walls,
        floor,
        ceiling,
      )
      anchorUv = { u: clamp01(a.anchorUv.uv[0]), v: clamp01(a.anchorUv.uv[1]) }
    }
  }

  // ── Map ScanAnnotationKind → canonical node type. ────────────────────────
  if (a.kind === 'photo') {
    const photo: Photo = {
      id: a.id,
      type: 'photo',
      parent_id: anchorSurfaceId ?? 'room',
      children_ids: [],
      transform: identityTransform(),
      source: 'roomplan',
      confidence: anchorConfidenceToNumber(a.confidence),
      variant_id: 'base_roomplan',
      created_at: createdAt,
      updated_at: updatedAt,
      url: a.photoAssetId ?? '',
      thumb_url: a.photoAssetId ?? '',
      captured_at: createdAt,
    }
    if (anchorSurfaceId && anchorSurfaceType && anchorUv) {
      photo.anchor_surface_id = anchorSurfaceId
      photo.anchor_surface_type = anchorSurfaceType
      photo.anchor_uv = anchorUv
    }
    return photo
  }

  if (a.kind === 'note') {
    const note: Note = {
      id: a.id,
      type: 'note',
      parent_id: anchorSurfaceId ?? 'room',
      children_ids: [],
      transform: identityTransform(),
      source: 'roomplan',
      confidence: anchorConfidenceToNumber(a.confidence),
      variant_id: 'base_roomplan',
      created_at: createdAt,
      updated_at: updatedAt,
      body: a.note ?? '',
    }
    if (anchorSurfaceId && anchorSurfaceType && anchorUv) {
      note.anchor_surface_id = anchorSurfaceId
      note.anchor_surface_type = anchorSurfaceType
      note.anchor_uv = anchorUv
    }
    return note
  }

  // All other ScanAnnotationKind values (damage, measurement_ref,
  // gewerk_marker) map to a canonical Pin. Pins REQUIRE an anchor — if
  // unresolved we drop them with a warning.
  if (!anchorSurfaceId || !anchorSurfaceType || !anchorUv) {
    warnings.push(
      `PIN_NO_ANCHOR: annotation ${a.id} (${a.kind}) cannot become a canonical pin without a resolvable anchor`,
    )
    return null
  }

  const pinType: Pin['pin_type'] =
    a.kind === 'damage' ? 'damage' : a.kind === 'measurement_ref' ? 'measurement' : 'note'
  const pin: Pin = {
    id: a.id,
    type: 'pin',
    parent_id: anchorSurfaceId,
    children_ids: [],
    transform: identityTransform(),
    source: 'roomplan',
    confidence: anchorConfidenceToNumber(a.confidence),
    variant_id: 'base_roomplan',
    created_at: createdAt,
    updated_at: updatedAt,
    pin_type: pinType,
    anchor_surface_id: anchorSurfaceId,
    anchor_surface_type: anchorSurfaceType,
    anchor_uv: anchorUv,
    anchor_offset_normal_m: 0.01,
    title: a.note ?? undefined,
    linked_photo_ids: a.photoAssetId ? [a.photoAssetId] : [],
    linked_note_ids: [],
    linked_task_ids: [],
  }
  return pin
}

function resolveAnchorSurfaceType(
  canonicalId: string,
  _surfaces: ScanSurface[],
  walls: Wall[],
  floor: Floor,
  ceiling: Ceiling,
): AnchorSurfaceType {
  if (walls.some(w => w.id === canonicalId)) return 'wall'
  if (floor.id === canonicalId) return 'floor'
  if (ceiling.id === canonicalId) return 'ceiling'
  return 'object'
}

function anchorConfidenceToNumber(c: ScanAnnotation['confidence']): number {
  switch (c) {
    case 'high':
      return 0.9
    case 'medium':
      return 0.6
    case 'low':
      return 0.3
    case 'lost':
      return 0
    default:
      return DEFAULT_CONFIDENCE
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function canonicalIdForSurface(s: ScanSurface): string {
  // Surface ids are stable Block-A uuids; reuse them on the canonical side
  // so anchor-resolution is a flat lookup.
  return s.id
}

function identityTransform(): Transform {
  return {
    position: { ...IDENTITY_VECTOR3 },
    rotation: { ...IDENTITY_QUATERNION },
    scale: { ...ONE_VECTOR3 },
  }
}

// Surface camelToSnake at the module surface so the boundary helper is
// callable from sibling files (kept un-default-exported to discourage drift
// inside the canonical/* tree, which is already snake_case).
export { camelToSnake }
