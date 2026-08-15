/**
 * Spatial · V1.6.1 · Customer Beispiel-Räume (visual demo presets)
 *
 * Three pre-built `RoomScene` templates that drive the
 * Customer-side "Beispiel-Raum"-Picker → Viewer flow (Mockups 02 + 03 v3):
 *
 *   - **Bad** (`bath`)        — ~7 m² · Stand-WC · Standwaschbecken · Duschkabine
 *                                · Wandfliese Weiß · Feinsteinzeug Anthrazit
 *   - **Küche** (`kitchen`)   — ~13 m² · Einbau-Kühlschrank · Kochfeld · Backofen
 *                                · Eiche-Diele · Putz Creme
 *   - **Wohnen** (`living`)   — ~17 m² · 3-Sitzer-Sofa · Couchtisch · Esstisch
 *                                · Eiche-Diele · Leinen-Tapete
 *
 * The scenes are rendered by `<CanonicalSceneRoot>` (the existing parametric
 * renderer used by `/dev/spatial-poc` + the canonical Hub path). Walls, floor
 * and ceiling carry catalog `material_id`s; the room category drives the
 * default three-point lighting. Every furniture / fixture is a catalog
 * `SpatialObject` (`asset_id` ∈ existing `asset-catalog.ts`) so the
 * `ObjectAdapter` either renders the catalog GLB or the dimension-correct
 * placeholder box — never a fake-3D plate, never a missing draw.
 *
 * Asset-source decision (Option C · Hybrid Programmatic):
 *   1. Reuses the V1 catalog (36 CC0 assets · 15 GLB · 21 procedural) shipped
 *      via the existing pipeline — no new USDZ/GLB binaries land in this PR.
 *   2. Atmosphere is driven by catalog material slugs (`wall-tile-white`,
 *      `floor-oak`, etc.) already wired to ambientCG PBR maps.
 *   3. Bundle-cost is ~0 KB for runtime assets (procedural box + cached GLB
 *      via `glbObjectLoader` retain/release counter); the new file itself is
 *      pure data and tree-shakeable.
 *
 * Wording-Lock (binding):
 *   - "Beispiel-Raum" not "Demo" / "Tutorial" (Decisions D-5)
 *   - Hero card label "Empfohlen" reserved for the Bad-tile
 *   - No fabricated "Material planen" / "kostet X €" placeholders
 */

import type { Pin } from '../types/annotations.ts'
import type { Ceiling, Floor, Wall } from '../types/geometry.ts'
import type { SpatialObject } from '../types/objects.ts'
import {
  IDENTITY_QUATERNION,
  IDENTITY_VECTOR3,
  ONE_VECTOR3,
  type Vector3,
} from '../types/primitives.ts'
import type { RoomScene } from '../types/scene-graph.ts'

/** Identifier for one of the three example rooms (Mockup 02 v3). */
export type ExampleRoomKind = 'bath' | 'kitchen' | 'living'

/** Picker-facing metadata · keep these strings in sync with Mockup 02 v3. */
export interface ExampleRoomMeta {
  /** Stable URL/storage slug. Used for `?room=…` deep-link + persisted "seen" flag. */
  kind: ExampleRoomKind
  /** Picker title (e.g. "Bad · 6 m²"). */
  title: string
  /** Pre-eyebrow line (e.g. "Sanierung"). */
  tag: string
  /** Picker subtitle (e.g. "Dusche, WC, Waschtisch"). */
  subtitle: string
  /** Approx area shown in viewer chrome (rounded m²). */
  approxAreaM2: number
  /** "Empfohlen" badge — set only on the bath-hero tile per Mockup 02 v3. */
  recommended: boolean
  /** Hotspot count surfaced in the viewer hint chip (matches Mockup 02 + 03). */
  hotspots: number
  /** Estimated time the customer needs to explore the demo (Mockup 02 v3 meta-row). */
  durationLabel: string
}

/**
 * Three example rooms in fixed display order (Bad first = hero card).
 * Order is part of the contract — the picker hero/sub-card hierarchy
 * (Mockup 02 v3) is keyed off the array position.
 */
export const EXAMPLE_ROOMS_META: readonly ExampleRoomMeta[] = Object.freeze([
  {
    kind: 'bath',
    title: 'Bad · 6 m²',
    tag: 'Sanierung',
    subtitle: 'Dusche, WC, Waschtisch',
    approxAreaM2: 6,
    recommended: true,
    hotspots: 3,
    durationLabel: '~ 30 Sek.',
  },
  {
    kind: 'kitchen',
    title: 'Küche · 13 m²',
    tag: 'Umbau',
    subtitle: 'Kochfeld, Backofen, Kühlschrank',
    approxAreaM2: 13,
    recommended: false,
    hotspots: 2,
    durationLabel: '~ 30 Sek.',
  },
  {
    kind: 'living',
    title: 'Wohnen · 17 m²',
    tag: 'Modernisierung',
    subtitle: 'Sofa, Couchtisch, Esstisch',
    approxAreaM2: 17,
    recommended: false,
    hotspots: 2,
    durationLabel: '~ 30 Sek.',
  },
])

/** Map kind → meta for callers that don't iterate the array. */
export const EXAMPLE_ROOMS_BY_KIND: Readonly<Record<ExampleRoomKind, ExampleRoomMeta>> =
  Object.freeze(
    EXAMPLE_ROOMS_META.reduce(
      (acc, m) => {
        acc[m.kind] = m
        return acc
      },
      {} as Record<ExampleRoomKind, ExampleRoomMeta>,
    ),
  )

/** Type-guard: is the input one of the supported example-room kinds? */
export function isExampleRoomKind(value: unknown): value is ExampleRoomKind {
  return value === 'bath' || value === 'kitchen' || value === 'living'
}

// ──────────────────────────────────────────────────────────────────────────
//  RoomScene builders
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build the `RoomScene` for the chosen example. Returned scenes are FROZEN-
 * BY-CONVENTION (the caller must not mutate any node in place; the renderer
 * never does). Each call returns a fresh object graph so React hooks treat
 * the scene as a stable reference per kind via memoization at the call site.
 */
export function buildExampleRoom(kind: ExampleRoomKind): RoomScene {
  switch (kind) {
    case 'bath':
      return buildBathExample()
    case 'kitchen':
      return buildKitchenExample()
    case 'living':
      return buildLivingExample()
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  Bad (bath) — ~7 m² · tiled walls + dark porcelain floor
// ──────────────────────────────────────────────────────────────────────────

function buildBathExample(): RoomScene {
  const id = 'example-room-bath'
  const W = 2.2 // X
  const D = 3.2 // Z
  const H = 2.6
  const ring = ccwRing(W, D)

  // Toilet — back wall, off-centre. Wall-host so it snaps to the inner face.
  const toilet: SpatialObject = mkObject({
    id: `${id}__obj_toilet`,
    parentId: id,
    asset: 'sanitary-toilet-standard-floor',
    category: 'toilet',
    host: 'wall',
    hostId: `${id}__w_n`,
    position: { x: W * 0.7, y: 0, z: D - 0.4 },
    rotationY: 180,
    dims: { width_m: 0.37, depth_m: 0.7, height_m: 0.63 },
  })

  // Pedestal sink — left wall.
  const sink: SpatialObject = mkObject({
    id: `${id}__obj_sink`,
    parentId: id,
    asset: 'sanitary-sink-pedestal-classic',
    category: 'sink',
    host: 'wall',
    hostId: `${id}__w_w`,
    position: { x: 0.3, y: 0, z: D * 0.45 },
    rotationY: 90,
    dims: { width_m: 0.5, depth_m: 0.42, height_m: 0.91 },
  })

  // Shower enclosure — corner near front. Floor-host (corner snap deferred).
  const shower: SpatialObject = mkObject({
    id: `${id}__obj_shower`,
    parentId: id,
    asset: 'sanitary-shower-enclosure-square',
    category: 'shower',
    host: 'floor',
    hostId: `${id}__floor`,
    position: { x: W - 0.6, y: 0, z: 0.6 },
    rotationY: 0,
    dims: { width_m: 1.0, depth_m: 1.0, height_m: 2.0 },
  })

  // Round wall mirror above the sink.
  const mirror: SpatialObject = mkObject({
    id: `${id}__obj_mirror`,
    parentId: id,
    asset: 'furn-mirror-round-wall',
    category: 'mirror',
    host: 'wall',
    hostId: `${id}__w_w`,
    position: { x: 0.05, y: 1.5, z: D * 0.45 },
    rotationY: 90,
    dims: { width_m: 0.6, depth_m: 0.05, height_m: 0.6 },
    heightFromFloorM: 1.2,
  })

  return buildRectRoomScene({
    id,
    name: 'Beispiel-Bad',
    category: 'bathroom',
    width: W,
    depth: D,
    height: H,
    ring,
    wallMaterial: 'wall-tile-white',
    floorMaterial: 'floor-tile-anthracite',
    ceilingMaterial: null,
    objects: [toilet, sink, shower, mirror],
    pins: [
      mkInfoPin(id, `${id}__w_n`, 0.7, 0.5),
      mkInfoPin(id, `${id}__w_w`, 0.5, 0.6),
      mkInfoPin(id, `${id}__floor`, 0.7, 0.3),
    ],
  })
}

// ──────────────────────────────────────────────────────────────────────────
//  Küche (kitchen) — ~13 m² · oak floor + warm-cream plaster walls
// ──────────────────────────────────────────────────────────────────────────

function buildKitchenExample(): RoomScene {
  const id = 'example-room-kitchen'
  const W = 3.4
  const D = 3.8
  const H = 2.6
  const ring = ccwRing(W, D)

  const fridge: SpatialObject = mkObject({
    id: `${id}__obj_fridge`,
    parentId: id,
    asset: 'kitchen-refrigerator-freestanding-tall',
    category: 'refrigerator',
    host: 'floor',
    hostId: `${id}__floor`,
    position: { x: 0.35, y: 0, z: D - 0.4 },
    rotationY: 0,
    dims: { width_m: 0.65, depth_m: 0.7, height_m: 1.85 },
  })

  const cooktop: SpatialObject = mkObject({
    id: `${id}__obj_cooktop`,
    parentId: id,
    asset: 'kitchen-stove-induction-60cm',
    category: 'cooktop',
    host: 'floor',
    hostId: `${id}__floor`,
    position: { x: W * 0.5, y: 0, z: D - 0.35 },
    rotationY: 0,
    dims: { width_m: 0.6, depth_m: 0.6, height_m: 0.9 },
  })

  const oven: SpatialObject = mkObject({
    id: `${id}__obj_oven`,
    parentId: id,
    asset: 'kitchen-oven-builtin-60cm',
    category: 'oven',
    host: 'wall',
    hostId: `${id}__w_n`,
    position: { x: W * 0.5 + 0.7, y: 0, z: D - 0.4 },
    rotationY: 180,
    dims: { width_m: 0.6, depth_m: 0.6, height_m: 0.6 },
    heightFromFloorM: 0.85,
  })

  // Dining table + 2 chairs · matches the "Küche · 13 m²" sub-card meta.
  const diningTable: SpatialObject = mkObject({
    id: `${id}__obj_dining_table`,
    parentId: id,
    asset: 'furn-dining-table-rectangle-6',
    category: 'table',
    host: 'floor',
    hostId: `${id}__floor`,
    position: { x: W * 0.5, y: 0, z: D * 0.35 },
    rotationY: 0,
    dims: { width_m: 1.6, depth_m: 0.9, height_m: 0.75 },
  })

  return buildRectRoomScene({
    id,
    name: 'Beispiel-Küche',
    category: 'kitchen',
    width: W,
    depth: D,
    height: H,
    ring,
    wallMaterial: 'wall-plaster-creme',
    floorMaterial: 'floor-oak',
    ceilingMaterial: null,
    objects: [fridge, cooktop, oven, diningTable],
    pins: [
      mkInfoPin(id, `${id}__w_n`, 0.5, 0.55),
      mkInfoPin(id, `${id}__floor`, 0.5, 0.4),
    ],
  })
}

// ──────────────────────────────────────────────────────────────────────────
//  Wohnen (living) — ~17 m² · oak parquet + linen wall
// ──────────────────────────────────────────────────────────────────────────

function buildLivingExample(): RoomScene {
  const id = 'example-room-living'
  const W = 3.8
  const D = 4.5
  const H = 2.6
  const ring = ccwRing(W, D)

  const sofa: SpatialObject = mkObject({
    id: `${id}__obj_sofa`,
    parentId: id,
    asset: 'furn-sofa-3seater-fabric-grey',
    category: 'sofa',
    host: 'floor',
    hostId: `${id}__floor`,
    position: { x: W * 0.5, y: 0, z: 0.6 },
    rotationY: 180,
    dims: { width_m: 2.1, depth_m: 0.9, height_m: 0.85 },
  })

  const coffeeTable: SpatialObject = mkObject({
    id: `${id}__obj_coffee_table`,
    parentId: id,
    asset: 'furn-coffee-table-round-wood',
    category: 'table',
    host: 'floor',
    hostId: `${id}__floor`,
    position: { x: W * 0.5, y: 0, z: 1.7 },
    rotationY: 0,
    dims: { width_m: 0.9, depth_m: 0.9, height_m: 0.42 },
  })

  const armchair: SpatialObject = mkObject({
    id: `${id}__obj_armchair`,
    parentId: id,
    asset: 'furn-armchair-fabric-rounded',
    category: 'armchair',
    host: 'floor',
    hostId: `${id}__floor`,
    position: { x: W - 0.6, y: 0, z: 1.7 },
    rotationY: 270,
    dims: { width_m: 0.9, depth_m: 0.9, height_m: 0.85 },
  })

  const shelf: SpatialObject = mkObject({
    id: `${id}__obj_shelf`,
    parentId: id,
    asset: 'furn-shelf-open-5tier-wood',
    category: 'bookshelf',
    host: 'wall',
    hostId: `${id}__w_n`,
    position: { x: W * 0.7, y: 0, z: D - 0.25 },
    rotationY: 180,
    dims: { width_m: 1.0, depth_m: 0.35, height_m: 1.9 },
    heightFromFloorM: 0,
  })

  return buildRectRoomScene({
    id,
    name: 'Beispiel-Wohnen',
    category: 'living',
    width: W,
    depth: D,
    height: H,
    ring,
    wallMaterial: 'wall-linen',
    floorMaterial: 'floor-oak',
    ceilingMaterial: null,
    objects: [sofa, coffeeTable, armchair, shelf],
    pins: [
      mkInfoPin(id, `${id}__floor`, 0.5, 0.4),
      mkInfoPin(id, `${id}__w_n`, 0.7, 0.4),
    ],
  })
}

// ──────────────────────────────────────────────────────────────────────────
//  Builders (private helpers)
// ──────────────────────────────────────────────────────────────────────────

const NOW = '2026-05-27T00:00:00.000Z'

interface BuildRectInput {
  id: string
  name: string
  category: RoomScene['category']
  width: number
  depth: number
  height: number
  ring: Vector3[]
  wallMaterial: string | null
  floorMaterial: string | null
  ceilingMaterial: string | null
  objects: SpatialObject[]
  pins: Pin[]
}

/**
 * Build a closed-rectangle `RoomScene` from a CCW footprint + per-surface
 * material overrides. Mirrors `presetEmptyRoom.buildEmptyRoom2x2Preset`'s
 * topology so wall-join + skirting math stays consistent; the difference
 * here is that the four walls + floor + ceiling carry catalog `material_id`s
 * so the renderer paints surfaces with PBR materials instead of plain tints.
 */
function buildRectRoomScene(input: BuildRectInput): RoomScene {
  const { id, name, ring, height } = input
  const wallS = mkWall(`${id}__w_s`, id, ring[0]!, ring[1]!, height, input.wallMaterial)
  const wallE = mkWall(`${id}__w_e`, id, ring[1]!, ring[2]!, height, input.wallMaterial)
  const wallN = mkWall(`${id}__w_n`, id, ring[2]!, ring[3]!, height, input.wallMaterial)
  const wallW = mkWall(`${id}__w_w`, id, ring[3]!, ring[0]!, height, input.wallMaterial)
  const walls: Wall[] = [wallS, wallE, wallN, wallW]

  const floor: Floor = {
    ...nodeBase(`${id}__floor`, 'floor', id),
    polygon: ring,
    walkable_surface: true,
    floor_mounted: input.objects.filter(obj => obj.host === 'floor' && obj.host_id === `${id}__floor`),
    material_id: input.floorMaterial ?? undefined,
  }
  const ceiling: Ceiling = {
    ...nodeBase(`${id}__ceiling`, 'ceiling', id),
    polygon: ring,
    height_m: height,
    ceiling_mounted: [],
    material_id: input.ceilingMaterial ?? undefined,
  }

  // Distribute wall-mounted objects onto their host wall arrays. The renderer
  // expects `Wall.wall_mounted` (not `RoomScene.free_objects`) when host='wall',
  // so the bridge step happens here at build time.
  for (const obj of input.objects) {
    if (obj.host !== 'wall') continue
    const target = walls.find(w => w.id === obj.host_id)
    if (target) target.wall_mounted.push(obj)
  }

  // The remaining objects (host='floor' on the floor itself, host='free')
  // ride RoomScene.free_objects so they render via ObjectAdapter directly.
  // floor_mounted is the source of truth for floor-anchored furniture; the
  // adapter for those is mounted by the FloorAdapter, not the renderer.
  const freeObjects = input.objects.filter(obj => obj.host === 'free')

  return {
    ...nodeBase(id, 'room', `${id}__building`),
    name,
    category: input.category,
    walls,
    floor,
    ceiling,
    free_objects: freeObjects,
    pins: input.pins,
    photos: [],
    notes: [],
    bounds_min: { x: 0, y: 0, z: 0 },
    bounds_max: { x: input.width, y: height, z: input.depth },
    computed_area_m2: round2(input.width * input.depth),
    computed_volume_m3: round2(input.width * input.depth * height),
  }
}

const PRESET_WALL_THICKNESS_M = 0.15

function mkWall(
  id: string,
  parentId: string,
  start: Vector3,
  end: Vector3,
  heightM: number,
  materialId: string | null,
): Wall {
  const dx = end.x - start.x
  const dz = end.z - start.z
  const length = Math.hypot(dx, dz)
  // Outward-facing 2D normal for a CCW ring (right-hand-perpendicular).
  const normalX = length > 0 ? dz / length : 0
  const normalZ = length > 0 ? -dx / length : 0
  return {
    ...nodeBase(id, 'wall', parentId),
    start_point: { ...start },
    end_point: { ...end },
    height_m: heightM,
    thickness_m: PRESET_WALL_THICKNESS_M,
    base_height_m: 0,
    openings: [],
    wall_mounted: [],
    is_exterior_wall: true,
    walkable_blocker: true,
    length_m: length,
    normal: { x: normalX, y: 0, z: normalZ },
    material_id: materialId ?? undefined,
  }
}

interface MkObjectInput {
  id: string
  parentId: string
  asset: string
  category: SpatialObject['category']
  host: SpatialObject['host']
  hostId: string
  position: Vector3
  rotationY: number
  dims: SpatialObject['dimensions']
  heightFromFloorM?: number
}

function mkObject(input: MkObjectInput): SpatialObject {
  return {
    ...nodeBase(input.id, 'object', input.parentId),
    category: input.category,
    asset_id: input.asset,
    dimensions: input.dims,
    host: input.host,
    host_id: input.hostId,
    height_from_floor_m: input.heightFromFloorM,
    rotation_around_y_deg: input.rotationY,
    transform: {
      position: { ...input.position },
      rotation: IDENTITY_QUATERNION,
      scale: ONE_VECTOR3,
    },
  }
}

function mkInfoPin(
  roomId: string,
  surfaceId: string,
  u: number,
  v: number,
): Pin {
  return {
    ...nodeBase(`${roomId}__pin_${surfaceId}_${pinUid(u, v)}`, 'pin', roomId),
    pin_type: 'note',
    anchor_surface_id: surfaceId,
    anchor_surface_type: surfaceId.endsWith('floor') ? 'floor' : 'wall',
    anchor_uv: { u, v },
    anchor_offset_normal_m: 0.01,
    linked_photo_ids: [],
    linked_note_ids: [],
    linked_task_ids: [],
  }
}

function pinUid(u: number, v: number): string {
  return `${Math.round(u * 100)}_${Math.round(v * 100)}`
}

function nodeBase<T extends string>(id: string, type: T, parentId: string) {
  return {
    id,
    type,
    parent_id: parentId,
    children_ids: [] as string[],
    variant_id: 'base_roomplan' as const,
    source: 'manual' as const,
    confidence: 1,
    transform: {
      position: IDENTITY_VECTOR3,
      rotation: IDENTITY_QUATERNION,
      scale: ONE_VECTOR3,
    },
    created_at: NOW,
    updated_at: NOW,
  }
}

function ccwRing(width: number, depth: number): Vector3[] {
  // CCW footprint: (0,0) → (W,0) → (W,D) → (0,D) → close
  return [
    { x: 0, y: 0, z: 0 },
    { x: width, y: 0, z: 0 },
    { x: width, y: 0, z: depth },
    { x: 0, y: 0, z: depth },
  ]
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
