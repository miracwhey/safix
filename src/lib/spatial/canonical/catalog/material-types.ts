/**
 * Spatial · Canonical · Catalog · Material Types
 *
 * Catalog-row shape for the PBR-material registry — the typed projection of
 * one `spatial_materials` row. Pure data contracts: no three.js / React / DOM.
 */

/**
 * Which surface a material applies to — drives the Mockup-42 Category-Pills.
 * A material belongs to exactly one surface category.
 */
export type MaterialSurfaceCategory = 'wall' | 'floor' | 'counter' | 'metal' | 'decor'

/**
 * Physical material type — drives the Typ-Sektion grouping inside the picker
 * grid (Mockup 42 §3b) and the `spatial_materials.category` column.
 */
export type MaterialType =
  | 'paint'
  | 'plaster'
  | 'tile'
  | 'wood'
  | 'stone'
  | 'concrete'
  | 'brick'
  | 'metal'
  | 'fabric'
  | 'ceramic'
  | 'other'

/** PBR texture-set storage paths. Each is null when that map does not exist. */
export interface MaterialTextureSet {
  albedo: string | null
  normal: string | null
  roughness: string | null
  ao: string | null
  displacement: string | null
  metallic: string | null
}

/**
 * Typed projection of a `spatial_materials` row.
 */
export interface CatalogMaterial {
  slug: string
  displayName: string
  surfaceCategory: MaterialSurfaceCategory
  materialType: MaterialType
  /** Human-readable Typ-Sektion label for the picker's grouped grid. */
  section: string
  /** ambientCG asset id, or null for procedural materials (decor-mirror). */
  acgId: string | null
  /** True for non-textured procedural materials (mirror). */
  procedural: boolean
  /** PBR texture storage paths (all null for procedural materials). */
  textures: MaterialTextureSet
  /** Storage path of the 256×256 picker thumbnail. */
  thumbnailPath: string
  /** UV tile size in meters (may be non-square). */
  tileScale: { u: number; v: number }
  /** Constant roughness in [0,1] — used for procedural materials + fallback. */
  roughness: number
  /** Constant metalness in [0,1]. */
  metalness: number
  /** Solid-colour fallback hex used when textures fail to load. */
  fallbackColorHex: string
  /** SPDX license id (CC0-1.0 for the whole V1 catalog). */
  license: string
  /** Attribution string — null for CC0. */
  attribution: string | null
  /** Source vendor ('ambientcg'). */
  vendor: string
  /** Free-text search synonyms (DE + EN) for the picker search. */
  tags: string[]
  published: boolean
}
