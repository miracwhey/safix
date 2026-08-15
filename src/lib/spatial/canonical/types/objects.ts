/**
 * Spatial · Canonical · Spatial Objects
 *
 * Furniture, fixtures, sanitary, appliances — any non-architectural element
 * that occupies space inside a room. Master-Spec §1.9, §1.11, §7.
 *
 * Distinguished from architectural elements (Wall/Floor/Ceiling/WallOpening)
 * because objects:
 *   - participate in collision but not in walkable-area definition (unless
 *     floor-mounted, in which case their footprint is subtracted),
 *   - have a `host` relationship that constrains where they can move,
 *   - have a `renovation_intent` field for variant-driven before/after views,
 *   - can be backed by a re-usable asset from the catalog (`asset_id`) or
 *     remain a generic cuboid placeholder produced directly by RoomPlan.
 */

import type { Node } from './scene-graph.ts'

/**
 * Categorical taxonomy of spatial objects, used by:
 *   - asset-picker filtering,
 *   - default-host inference (`CATEGORY_DEFAULT_HOST` below),
 *   - validator clearance thresholds,
 *   - BoM aggregation (Phase 5).
 *
 * Extend cautiously — every new category must come with a default-host entry
 * and (eventually) a catalog asset. `'generic_cuboid'` is the catch-all for
 * RoomPlan-detected objects we have not classified yet.
 */
export type ObjectCategory =
  // ── Sanitary ──────────────────────────────────────────────────────────
  | 'toilet'
  | 'sink'
  | 'bathtub'
  | 'shower'
  | 'bidet'
  | 'towel_rail'
  | 'mirror'
  | 'washing_machine'
  | 'toilet_paper_holder'
  // ── Kitchen fixtures ──────────────────────────────────────────────────
  | 'kitchen_sink'
  | 'cooktop'
  | 'oven'
  | 'refrigerator'
  | 'dishwasher'
  | 'range_hood'
  | 'kitchen_faucet'
  // ── HVAC / electrical ──────────────────────────────────────────────────
  | 'radiator'
  | 'electrical_outlet'
  | 'light_switch'
  | 'fuse_box'
  | 'lamp'
  // ── Furniture ─────────────────────────────────────────────────────────
  | 'sofa'
  | 'armchair'
  | 'bed'
  | 'wardrobe'
  | 'bookshelf'
  | 'table'
  | 'chair'
  | 'cabinet'
  | 'tv_cabinet'
  | 'plant'
  | 'curtains'
  | 'fireplace'
  | 'rug'
  // ── Structural sub-elements (Risk R13: columns are objects, not walls) ─
  | 'column'
  // ── Fallback ───────────────────────────────────────────────────────────
  | 'generic_cuboid'

/**
 * Where the object is anchored.
 *
 *   - 'floor'   : sits on the floor plane (toilets, bathtubs, sofas, ...)
 *   - 'wall'    : hangs off a wall (sinks, radiators, shelves, ...)
 *   - 'ceiling' : hangs from the ceiling (lamps, fans, ...)
 *   - 'corner'  : occupies a wall-wall corner (corner showers, ...)
 *   - 'free'    : floor-mounted but explicitly NOT snapped (free-standing furniture)
 *   - 'counter' : sits on the top surface of another object (a counter / vanity)
 *
 * `host_id` then identifies the specific Wall / Floor / Ceiling. For `corner`
 * the `host_id` references one of the two adjacent walls; the matcher derives
 * the partner wall from the room's wall list. For `counter` the `host_id`
 * references the host SpatialObject (the counter / vanity).
 */
export type ObjectHost = 'floor' | 'wall' | 'ceiling' | 'corner' | 'free' | 'counter'

/**
 * Renovation intent for variant-driven before/after views.
 *
 *   - 'keep'    : object stays unchanged in the renovated variant
 *   - 'replace' : object is swapped for a different asset
 *   - 'remove'  : object is removed entirely
 *   - 'add'     : object exists only in the renovated variant (not in base)
 */
export type RenovationIntent = 'keep' | 'replace' | 'remove' | 'add'

/**
 * A non-architectural element inside a room.
 *
 * Geometry is stored as canonical dimensions (axis-aligned bounding box in
 * the object's local frame). The world-space pose is derived from
 * `transform` + parent traversal. When `asset_id` is set, a renderer can swap
 * the cuboid for a real glb model; the cuboid dimensions still drive
 * collision and clearance regardless.
 */
export interface SpatialObject extends Node {
  type: 'object'

  /** Functional category (drives default-host, validator, BoM). */
  category: ObjectCategory
  /** Catalog asset reference · `undefined` means render as generic cuboid. */
  asset_id?: string

  /**
   * Optional catalog material override (`spatial_materials` slug). Mirrors
   * `Wall` / `Floor` / `Ceiling.material_id` — the variant-override stack can
   * shallow-merge this onto an object so a renovated variant re-finishes a
   * fixture (e.g. swap a chrome faucet to brass) without replacing the asset.
   * `undefined` keeps the object's catalog-default surface.
   */
  material_id?: string

  /** Axis-aligned dimensions in the object's local frame (always positive). */
  dimensions: {
    width_m: number
    depth_m: number
    height_m: number
  }

  // ── Host relationship ─────────────────────────────────────────────────
  /** Which surface category the object is anchored to. */
  host: ObjectHost
  /** ID of the specific Wall / Floor / Ceiling host node. */
  host_id: string

  // ── Wall-mounted positional fields (only meaningful when host === 'wall') ─
  /** Height of the object's bottom above the floor. */
  height_from_floor_m?: number
  /** Distance from host_wall.start_point along the wall direction. */
  offset_along_wall_m?: number
  /** Distance the object protrudes from the wall surface. */
  depth_from_wall_m?: number

  // ── Floor-mounted positional fields (only meaningful when host === 'floor') ─
  /** Rotation around world Y axis in degrees, [0, 360). */
  rotation_around_y_deg?: number

  // ── Counter-host field (only meaningful when this object IS a counter) ────
  /**
   * World-Y of this object's hostable TOP surface, for objects that act as a
   * counter / vanity (`CatalogAsset.isCounterHost`). Counter-hosted children
   * are snapped to this height by `resolveCounterSnap`. Defaults to
   * `transform.position.y + dimensions.height_m` when omitted.
   */
  counter_height_m?: number

  /** Variant-driven before/after intent — see `./variants.ts`. */
  renovation_intent?: RenovationIntent
}

/**
 * Default host per object category. Used by the bridge (Day 8 B13) when
 * Block-A's `scan_surfaces.kind === 'object'` does not carry host info,
 * and by the Phase-2 edit-system when the user drops a new asset onto the
 * scene without explicitly specifying a host.
 *
 * Frozen so consumers cannot accidentally mutate the table at run time.
 */
export const CATEGORY_DEFAULT_HOST: Readonly<Record<ObjectCategory, ObjectHost>> = Object.freeze({
  // ── Sanitary ─────────────────────────────────────────────────────────
  toilet: 'floor',
  sink: 'wall',
  bathtub: 'floor',
  shower: 'corner',
  bidet: 'floor',
  towel_rail: 'wall',
  mirror: 'wall',
  washing_machine: 'floor',
  toilet_paper_holder: 'wall',
  // ── Kitchen ──────────────────────────────────────────────────────────
  kitchen_sink: 'wall',
  cooktop: 'floor',
  oven: 'wall',
  refrigerator: 'floor',
  dishwasher: 'floor',
  range_hood: 'wall',
  kitchen_faucet: 'wall',
  // ── HVAC / electrical ────────────────────────────────────────────────
  radiator: 'wall',
  electrical_outlet: 'wall',
  light_switch: 'wall',
  fuse_box: 'wall',
  lamp: 'ceiling',
  // ── Furniture ────────────────────────────────────────────────────────
  sofa: 'floor',
  armchair: 'floor',
  bed: 'floor',
  wardrobe: 'floor',
  bookshelf: 'wall',
  table: 'floor',
  chair: 'floor',
  cabinet: 'wall',
  tv_cabinet: 'floor',
  plant: 'floor',
  curtains: 'wall',
  fireplace: 'floor',
  rug: 'floor',
  // ── Structural ───────────────────────────────────────────────────────
  column: 'floor',
  // ── Fallback ─────────────────────────────────────────────────────────
  generic_cuboid: 'floor',
})

/**
 * Per-category default surface finish for the PLACEHOLDER render path only
 * (procedural silhouette / generic box / GLB load + error fallback). Replaces
 * the single hardcoded brown `#b6915c` so a scanned/asset-less fixture reads as
 * its real material family: white porcelain sanitary, stainless/chrome
 * appliances, wood furniture, fabric upholstery, etc.
 *
 * Triple (color + roughness + metalness): steel/chrome/glass read via a light
 * grey base + low metalness. metalness is deliberately kept LOW (≤0.25) even for
 * "metallic" fixtures: the placeholder path renders under diffuse-only lighting
 * (the scene mounts no envMap/IBL by default — CanonicalSceneRoot hdri defaults
 * null), and a high-metalness meshStandardMaterial with no envMap to reflect goes
 * near-black. So the grey base colour carries the steel read; do NOT raise these
 * back up unless a default IBL is added. Reaches ONLY `SurfaceMaterial`'s
 * default-tint branch; a resolved `material_id` and embedded GLB materials win by
 * construction and stay untouched. Colours from the design table (handover §3).
 */
export const CATEGORY_DEFAULT_MATERIAL: Readonly<
  Record<ObjectCategory, { color: string; roughness: number; metalness: number }>
> = Object.freeze({
  // ── Sanitary — porcelain / enamel / chrome / glass ───────────────────
  toilet: { color: '#e9edee', roughness: 0.35, metalness: 0.0 },
  sink: { color: '#e9edee', roughness: 0.35, metalness: 0.0 },
  bathtub: { color: '#eceff0', roughness: 0.3, metalness: 0.0 },
  shower: { color: '#cbd8dd', roughness: 0.12, metalness: 0.0 },
  bidet: { color: '#e9edee', roughness: 0.35, metalness: 0.0 },
  towel_rail: { color: '#c2c8cd', roughness: 0.35, metalness: 0.2 },
  mirror: { color: '#ccd3d7', roughness: 0.12, metalness: 0.15 },
  washing_machine: { color: '#e4e7e9', roughness: 0.4, metalness: 0.1 },
  toilet_paper_holder: { color: '#c2c8cd', roughness: 0.35, metalness: 0.2 },
  // ── Kitchen — brushed steel (low metalness: no IBL, see note above) ───
  kitchen_sink: { color: '#c6cbcf', roughness: 0.4, metalness: 0.2 },
  cooktop: { color: '#33363b', roughness: 0.25, metalness: 0.2 },
  oven: { color: '#5b6066', roughness: 0.45, metalness: 0.25 },
  refrigerator: { color: '#c6cbcf', roughness: 0.4, metalness: 0.15 },
  dishwasher: { color: '#c6cbcf', roughness: 0.4, metalness: 0.15 },
  range_hood: { color: '#c6cbcf', roughness: 0.4, metalness: 0.2 },
  kitchen_faucet: { color: '#c2c8cd', roughness: 0.35, metalness: 0.25 },
  // ── HVAC / electrical — painted metal / white plastic ────────────────
  radiator: { color: '#edf0f2', roughness: 0.45, metalness: 0.1 },
  electrical_outlet: { color: '#eef0f1', roughness: 0.6, metalness: 0.0 },
  light_switch: { color: '#eef0f1', roughness: 0.6, metalness: 0.0 },
  fuse_box: { color: '#d7dade', roughness: 0.6, metalness: 0.05 },
  lamp: { color: '#e7d8b8', roughness: 0.5, metalness: 0.2 },
  // ── Furniture — wood / fabric ────────────────────────────────────────
  sofa: { color: '#ab9f8d', roughness: 0.9, metalness: 0.0 },
  armchair: { color: '#ab9f8d', roughness: 0.9, metalness: 0.0 },
  bed: { color: '#c9c1b2', roughness: 0.9, metalness: 0.0 },
  wardrobe: { color: '#a8855b', roughness: 0.7, metalness: 0.0 },
  bookshelf: { color: '#a8855b', roughness: 0.7, metalness: 0.0 },
  table: { color: '#ad8b5e', roughness: 0.65, metalness: 0.0 },
  chair: { color: '#ad8b5e', roughness: 0.65, metalness: 0.0 },
  cabinet: { color: '#a8855b', roughness: 0.7, metalness: 0.0 },
  tv_cabinet: { color: '#8a6f4c', roughness: 0.6, metalness: 0.0 },
  plant: { color: '#5f7d50', roughness: 0.8, metalness: 0.0 },
  curtains: { color: '#d6cfc2', roughness: 0.9, metalness: 0.0 },
  fireplace: { color: '#6f6b64', roughness: 0.8, metalness: 0.0 },
  rug: { color: '#b3a695', roughness: 0.95, metalness: 0.0 },
  // ── Structural ───────────────────────────────────────────────────────
  column: { color: '#d3d0c8', roughness: 0.8, metalness: 0.0 },
  // ── Fallback ─────────────────────────────────────────────────────────
  generic_cuboid: { color: '#b8b2a8', roughness: 0.7, metalness: 0.05 },
})

/**
 * Per-category uniform-scale limits (V1.6.1 Gesten-Rework). Replaces the single
 * global `[0.5, 2.0]` clamp: scaling is only sensible inside each object's real-
 * world variation. `{ min: 1, max: 1 }` = LOCKED (standardised parts that have a
 * fixed real size — outlets, switches, faucets, paper holders — never scale).
 *
 * Values are uniform scale factors (1 = catalog default). They drive both the
 * pinch clamp (`setFurnitureScale`) and the Action-Bar `−/+` button enablement
 * (`canScaleDown/Up` hide entirely when `min === max`). Tune freely — these are
 * deliberate starter ranges grouped by real-world size variance.
 *
 * NOTE: non-uniform (per-axis) stretch for flat/parametric items (rug, curtains,
 * generic_cuboid) is DEFERRED — they currently use a wider UNIFORM range so a
 * runner-shaped rug is still reachable proportionally. See plan doc.
 */
export const DEFAULT_SCALE_LIMITS: Readonly<{ min: number; max: number }> = Object.freeze({
  min: 0.5,
  max: 2.0,
})

export const SCALE_LIMITS: Readonly<Record<ObjectCategory, { min: number; max: number }>> =
  Object.freeze({
    // GESPERRT — fixe Norm-Bauteile, nie skalieren.
    electrical_outlet: { min: 1, max: 1 },
    light_switch: { min: 1, max: 1 },
    fuse_box: { min: 1, max: 1 },
    kitchen_faucet: { min: 1, max: 1 },
    toilet_paper_holder: { min: 1, max: 1 },
    // ENG ±15% — Geräte/Sanitär mit Normmaß, nur leichte Variation.
    toilet: { min: 0.85, max: 1.15 },
    sink: { min: 0.85, max: 1.15 },
    bathtub: { min: 0.85, max: 1.15 },
    shower: { min: 0.85, max: 1.15 },
    bidet: { min: 0.85, max: 1.15 },
    washing_machine: { min: 0.85, max: 1.15 },
    kitchen_sink: { min: 0.85, max: 1.15 },
    cooktop: { min: 0.85, max: 1.15 },
    oven: { min: 0.85, max: 1.15 },
    refrigerator: { min: 0.85, max: 1.15 },
    dishwasher: { min: 0.85, max: 1.15 },
    range_hood: { min: 0.85, max: 1.15 },
    radiator: { min: 0.85, max: 1.15 },
    // MITTEL ±25% — Möbel mit Variation.
    towel_rail: { min: 0.75, max: 1.25 },
    mirror: { min: 0.75, max: 1.25 },
    armchair: { min: 0.75, max: 1.25 },
    wardrobe: { min: 0.75, max: 1.25 },
    bookshelf: { min: 0.75, max: 1.25 },
    table: { min: 0.75, max: 1.25 },
    chair: { min: 0.75, max: 1.25 },
    cabinet: { min: 0.75, max: 1.25 },
    tv_cabinet: { min: 0.75, max: 1.25 },
    fireplace: { min: 0.75, max: 1.25 },
    column: { min: 0.75, max: 1.25 },
    // WEIT ±40% — stark variabel.
    lamp: { min: 0.6, max: 1.4 },
    sofa: { min: 0.6, max: 1.4 },
    bed: { min: 0.6, max: 1.4 },
    plant: { min: 0.6, max: 1.4 },
    // ACHSEN-FREI (per-Achse-Stretch deferred → vorerst weiter UNIFORM).
    rug: { min: 0.5, max: 1.6 },
    curtains: { min: 0.5, max: 1.6 },
    // Catch-all (RoomPlan-unklassifiziert) behält die weite Default-Spanne.
    generic_cuboid: { min: 0.5, max: 2.0 },
  })

/** Scale limits for a category, falling back to the global default. */
export function scaleLimitsForCategory(
  category: ObjectCategory,
): { min: number; max: number } {
  return SCALE_LIMITS[category] ?? DEFAULT_SCALE_LIMITS
}
