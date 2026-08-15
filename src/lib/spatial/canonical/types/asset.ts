/**
 * Spatial · Canonical · Assets & Materials
 *
 * Master-Spec §7. Catalog-level definitions for 3D assets and materials that
 * SpatialObject instances reference via `asset_id` / `material_id`.
 *
 * Catalog data is curated centrally (Phase 1 Day 18-23) from CC0 sources
 * (Polyhaven + ambientCG + Sketchfab CC0) and persisted in the
 * `spatial_assets` / `spatial_materials` Postgres tables created by
 * migration `20260527000003_spatial_catalogs.sql` (Day 6 B3).
 *
 * V1 ships ~25-40 assets and ~30 materials; this type surface already
 * supports the V1.x expansion to a CC-BY / paid-license catalog by
 * extending `source_license`.
 */

import type { Vector3 } from './primitives.ts'
import type { ObjectCategory, ObjectHost } from './objects.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Asset
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pivot point of an asset, expressed as the offset between the model-space
 * origin and the snap reference point. The snap engine aligns the pivot
 * (not the model-space origin) onto the host surface.
 *
 *   - 'center'              : model-space origin == asset center
 *   - 'bottom_center'       : pivot at base of asset (floor-mounted default)
 *   - 'wall_back_center'    : pivot at the back face, centered horizontally
 *                             AND vertically. The snap engine places this
 *                             point on the wall surface at the asset's
 *                             `default_height_from_floor_m` (i.e. that height
 *                             is the asset's vertical CENTER, not its base).
 *   - 'ceiling_top_center'  : pivot at top-center face (ceiling-mounted default)
 *   - 'corner_back_left'    : pivot at the back-left corner (corner-mounted, e.g. corner shower)
 *   - 'custom'              : `offset` provides explicit offset from model-origin
 */
export type PivotType =
  | 'center'
  | 'bottom_center'
  | 'wall_back_center'
  | 'ceiling_top_center'
  | 'corner_back_left'
  | 'custom'

export interface Pivot {
  type: PivotType
  /** Only meaningful when `type === 'custom'`. */
  offset?: Vector3
}

/**
 * Auto-snap rules for an asset. The Phase-2 edit-system consults these
 * rules when the user drops an asset to decide:
 *   - which host surface to attach to,
 *   - what default height / clearance to enforce,
 *   - whether to align the asset's forward axis to the host's normal.
 */
export interface SnapRule {
  target_host: ObjectHost
  /** Default mounting height above the floor (e.g. 0.85 m for sinks). */
  default_height_from_floor_m?: number
  /** Rotate asset so its forward axis matches the host's outward normal. */
  align_to_normal: boolean
  /** Optional flag for corner-mounted assets (e.g. corner showers). */
  snap_to_corner?: boolean
  /** Minimum distance to nearest wall corner. */
  min_distance_to_corner_m?: number
  /** Minimum distance to nearest other object. */
  min_distance_to_other_objects_m?: number
}

/**
 * Clearance zone around an asset that should remain free for ergonomic
 * reasons (knee room in front of a WC, swing space for a door, ...).
 *
 * Validator §9.2 emits an `OBJECT_CLEARANCE_VIOLATED` warning when another
 * object intrudes into the clearance zone.
 */
export interface ClearanceZone {
  front_m: number
  sides_m: number
  above_m: number
}

/**
 * Level-of-detail variant of an asset's mesh + textures.
 *
 *   - level 0 : highest detail (used at close camera distance)
 *   - level 1 : reduced detail
 *   - level 2 : far-distance / mobile fallback
 *   - level 3 : silhouette / shadow-only
 *
 * `distance_m_max` is the max camera distance at which this LOD is used; the
 * renderer steps up to the next level when the camera moves further away.
 */
export interface LODLevel {
  level: 0 | 1 | 2 | 3
  glb_url: string
  poly_count: number
  distance_m_max: number
}

/**
 * License under which an asset / material was sourced. CC0 is the only V1
 * value; CC-BY support is included in the type-union for V1.x curation but
 * triggers an attribution-metadata requirement in the bridge.
 */
export type SourceLicense = 'CC0' | 'CC-BY' | 'custom'

/**
 * Catalog-level definition of a 3D asset. Instances in the scene-graph
 * reference an asset via `SpatialObject.asset_id`.
 *
 * Storage convention: glb + (optional) usdz + (optional) Draco-compressed
 * fallback live in Supabase Storage under
 * `spatial-assets/{catalog_id}/{file}.{ext}`. Thumbnails are public CDN
 * URLs for fast picker rendering.
 */
export interface Asset {
  id: string
  catalog_id: string
  display_name: string
  category: ObjectCategory
  thumbnail_url: string

  // ── 3D files ─────────────────────────────────────────────────────────
  /** Primary glb URL (used by web + iOS WebView). */
  glb_url: string
  /** USDZ variant for iOS-native Quick Look + RealityKit AR (V1.x). */
  usdz_url?: string
  /** Draco-compressed fallback for ultra-low-bandwidth clients. */
  drc_url?: string

  // ── Geometry ─────────────────────────────────────────────────────────
  /** Real-world dimensions in meters (axis-aligned in model-space). */
  dimensions: { width_m: number; depth_m: number; height_m: number }
  /** Tight bounding box in model-space. */
  bounding_box: { min: Vector3; max: Vector3 }

  // ── Placement ────────────────────────────────────────────────────────
  pivot: Pivot
  snap_rules: SnapRule[]
  clearance_zone?: ClearanceZone

  // ── Performance ──────────────────────────────────────────────────────
  lod_levels?: LODLevel[]
  poly_count_lod0?: number
  texture_size_max_px?: number

  // ── Provenance ───────────────────────────────────────────────────────
  source_license: SourceLicense
  source_url?: string
  /** Attribution string required by CC-BY assets · displayed in About-screen. */
  attribution?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Material
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Material categories aligned with ambientCG / Polyhaven taxonomy. Drives
 * picker filters and validator hints.
 */
export type MaterialCategory =
  | 'plaster'
  | 'tile'
  | 'wood'
  | 'concrete'
  | 'stone'
  | 'paint'
  | 'metal'
  | 'fabric'
  | 'other'

/**
 * Catalog-level PBR material. References from `Wall.material_id`,
 * `Floor.material_id`, `Ceiling.material_id`, and per-asset material slots.
 *
 * V1 supports diffuse + normal + roughness + (optional) AO maps; metalness
 * and emissive are available but rarely used outside specialty fixtures.
 */
export interface Material {
  id: string
  catalog_id: string
  display_name: string
  category: MaterialCategory

  /** Solid-colour fallback (hex) when the texture URL fails to load. */
  diffuse_color_hex?: string

  // ── PBR map URLs (KTX2 in production) ─────────────────────────────────
  texture_url?: string
  normal_map_url?: string
  roughness_map_url?: string
  ao_map_url?: string

  /** Constant roughness in [0, 1] when no map is provided. */
  roughness?: number
  /** Constant metalness in [0, 1] · typically 0 for non-metal surfaces. */
  metalness?: number
  /** Texture tile scale (1 = no tiling). */
  uv_scale?: number

  // ── Provenance ───────────────────────────────────────────────────────
  source_license: SourceLicense
  source_url?: string
  attribution?: string
  thumbnail_url?: string
}
