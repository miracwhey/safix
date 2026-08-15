/**
 * Spatial · Lane 2.5 · Stream B · Manual-Start presets
 *
 * Two ready-made `RoomScene` templates for the Privat-Tab empty-state CTAs:
 *
 *   - **Vorlage 2×2 m** — a 4-wall rectangle the user can resize via the
 *     DimensionInputSheet (B4). Default ceiling 2.5 m, wall thickness 15 cm.
 *   - **Leerer Raum** — zero walls; the user draws each wall with the
 *     Tap-to-Place tool (B5). Floor + ceiling start as degenerate empty
 *     polygons that the AddWallCommand (B3) fills in as walls land.
 *
 * Both presets are persisted via `spatial_create_manual_scene` (B0 RPC) so
 * the canonical pipeline (overrides, Hub-hydration, Hub thumbnails) treats
 * them like any roomplan scene from the moment they exist. The
 * `origin='manual'` flag on `spatial_scenes` tells the Detail screen to
 * default to Edit-Mode (B6) and lets the Hub badge them as "Manuell".
 */

import type { Ceiling, Floor, Wall } from '../types/geometry'
import {
  IDENTITY_QUATERNION,
  IDENTITY_VECTOR3,
  ONE_VECTOR3,
  type Vector3,
} from '../types/primitives'
import type { RoomScene } from '../types/scene-graph'

const NOW_PLACEHOLDER = '1970-01-01T00:00:00.000Z'

/**
 * Wall thickness used by both presets. Matches the `poc-bath-l-shaped` POC
 * fixture so editors that snap to wall normals see consistent geometry.
 */
const PRESET_WALL_THICKNESS_M = 0.15

/**
 * Default ceiling height for manual rooms. Mirrors typical German interior
 * heights (2.40-2.60 m) and matches the POC fixture so the existing R3
 * validator rule (`ceiling_implausible`) accepts the geometry as-is.
 */
const PRESET_CEILING_HEIGHT_M = 2.5

export interface BuildEmptyRoomPresetInput {
  /** Server-assigned scene id — used as the room's node id so referers stay stable. */
  roomNodeId: string
  /**
   * Floor-plate footprint in metres (X by Z). The 2×2 preset uses (2, 2);
   * the empty-canvas preset passes `null` here so the floor polygon stays
   * degenerate until the user draws walls.
   */
  footprintMeters: { widthM: number; depthM: number } | null
  /** Optional ceiling height override. Defaults to {@link PRESET_CEILING_HEIGHT_M}. */
  ceilingHeightM?: number
  /** ISO-8601 timestamp stamped onto every node. Defaults to `new Date().toISOString()`. */
  createdAt?: string
}

interface PresetMeta {
  /** What the `origin` column on spatial_scenes should be set to. */
  origin: 'manual' | 'example_room'
  /** Human-readable label for telemetry + Hub badge. */
  label: string
}

export const PRESET_EMPTY_ROOM_2X2: PresetMeta = {
  origin: 'manual',
  label: 'Vorlage 2×2 m',
}

export const PRESET_EMPTY_CANVAS: PresetMeta = {
  origin: 'manual',
  label: 'Leerer Raum',
}

/**
 * Build a `RoomScene` for the **Vorlage 2×2 m** preset — 4 walls forming
 * a closed square footprint, plus a matching floor + ceiling polygon. The
 * user can resize each wall via `ResizeWallCommand` once the scene is open
 * in Edit-Mode.
 */
export function buildEmptyRoom2x2Preset(
  input: BuildEmptyRoomPresetInput,
): RoomScene {
  return buildClosedRectangleRoom({
    ...input,
    footprintMeters: input.footprintMeters ?? { widthM: 2, depthM: 2 },
  })
}

/**
 * Build a `RoomScene` for the **Leerer Raum** preset — zero walls, a
 * degenerate (empty) floor/ceiling polygon. The user adds walls via the
 * Tap-to-Place tool; `AddWallCommand` / `DeleteWallCommand` re-derive the
 * floor + ceiling polygon from the wall ring on every edit (see
 * `rebuildFloorCeilingFromWalls`), so the polygon stays empty until the walls
 * close a single loop, then populates automatically.
 */
export function buildEmptyCanvasPreset(
  input: Omit<BuildEmptyRoomPresetInput, 'footprintMeters'>,
): RoomScene {
  const createdAt = input.createdAt ?? new Date().toISOString()
  const ceilingHeightM = input.ceilingHeightM ?? PRESET_CEILING_HEIGHT_M

  const emptyPolygon: Vector3[] = []

  const floor: Floor = {
    ...nodeBase(`${input.roomNodeId}__floor`, 'floor', input.roomNodeId, createdAt),
    polygon: emptyPolygon,
    walkable_surface: true,
    floor_mounted: [],
  }
  const ceiling: Ceiling = {
    ...nodeBase(`${input.roomNodeId}__ceiling`, 'ceiling', input.roomNodeId, createdAt),
    polygon: emptyPolygon,
    height_m: ceilingHeightM,
    ceiling_mounted: [],
  }

  return {
    ...nodeBase(input.roomNodeId, 'room', `${input.roomNodeId}__building`, createdAt),
    category: 'other',
    walls: [],
    floor,
    ceiling,
    free_objects: [],
    pins: [],
    photos: [],
    notes: [],
    bounds_min: { x: 0, y: 0, z: 0 },
    bounds_max: { x: 0, y: ceilingHeightM, z: 0 },
    computed_area_m2: 0,
    computed_volume_m3: 0,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────────

interface ClosedRectangleRoomInput {
  roomNodeId: string
  footprintMeters: { widthM: number; depthM: number }
  ceilingHeightM?: number
  createdAt?: string
}

function buildClosedRectangleRoom(input: ClosedRectangleRoomInput): RoomScene {
  const createdAt = input.createdAt ?? new Date().toISOString()
  const ceilingHeightM = input.ceilingHeightM ?? PRESET_CEILING_HEIGHT_M
  const { widthM, depthM } = input.footprintMeters
  if (widthM <= 0 || depthM <= 0) {
    throw new Error(
      `buildEmptyRoom2x2Preset: footprint must be positive (got ${widthM}×${depthM})`,
    )
  }

  // Footprint CCW (matches the POC fixture's winding so the validator's
  // polygon-area helper returns a positive value):
  //   (0,0) → (W,0) → (W,D) → (0,D) → close
  const ring: Vector3[] = [
    { x: 0, y: 0, z: 0 },
    { x: widthM, y: 0, z: 0 },
    { x: widthM, y: 0, z: depthM },
    { x: 0, y: 0, z: depthM },
  ]

  const floor: Floor = {
    ...nodeBase(`${input.roomNodeId}__floor`, 'floor', input.roomNodeId, createdAt),
    polygon: ring,
    walkable_surface: true,
    floor_mounted: [],
  }
  const ceiling: Ceiling = {
    ...nodeBase(`${input.roomNodeId}__ceiling`, 'ceiling', input.roomNodeId, createdAt),
    polygon: ring,
    height_m: ceilingHeightM,
    ceiling_mounted: [],
  }

  const walls: Wall[] = [
    buildWall(`${input.roomNodeId}__w_s`, input.roomNodeId, ring[0], ring[1], ceilingHeightM, createdAt),
    buildWall(`${input.roomNodeId}__w_e`, input.roomNodeId, ring[1], ring[2], ceilingHeightM, createdAt),
    buildWall(`${input.roomNodeId}__w_n`, input.roomNodeId, ring[2], ring[3], ceilingHeightM, createdAt),
    buildWall(`${input.roomNodeId}__w_w`, input.roomNodeId, ring[3], ring[0], ceilingHeightM, createdAt),
  ]

  return {
    ...nodeBase(input.roomNodeId, 'room', `${input.roomNodeId}__building`, createdAt),
    category: 'other',
    walls,
    floor,
    ceiling,
    free_objects: [],
    pins: [],
    photos: [],
    notes: [],
    bounds_min: { x: 0, y: 0, z: 0 },
    bounds_max: { x: widthM, y: ceilingHeightM, z: depthM },
    computed_area_m2: widthM * depthM,
    computed_volume_m3: widthM * depthM * ceilingHeightM,
  }
}

function buildWall(
  id: string,
  parentId: string,
  a: Vector3,
  b: Vector3,
  heightM: number,
  createdAt: string,
): Wall {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const length = Math.hypot(dx, dz)
  // Outward-facing 2D normal (rotated 90° clockwise around Y for a CCW ring).
  const normalX = length > 0 ? dz / length : 0
  const normalZ = length > 0 ? -dx / length : 0

  return {
    ...nodeBase(id, 'wall', parentId, createdAt),
    start_point: { ...a },
    end_point: { ...b },
    height_m: heightM,
    thickness_m: PRESET_WALL_THICKNESS_M,
    base_height_m: 0,
    openings: [],
    wall_mounted: [],
    is_exterior_wall: true,
    walkable_blocker: true,
    length_m: length,
    normal: { x: normalX, y: 0, z: normalZ },
  }
}

function nodeBase<T extends string>(
  id: string,
  type: T,
  parentId: string,
  createdAt: string,
) {
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
    created_at: createdAt,
    updated_at: createdAt,
  }
}

// Silences the "imported but not yet referenced" lint when tests stub the
// timestamp helper. NOW_PLACEHOLDER is a deliberate compile-time anchor.
void NOW_PLACEHOLDER
