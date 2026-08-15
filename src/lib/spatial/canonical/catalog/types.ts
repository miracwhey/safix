/**
 * Spatial · Canonical · Catalog · Types
 *
 * Catalog-row shapes for the 3D asset registry. A {@link CatalogAsset} is the
 * typed, client-side projection of one `spatial_assets` row — the TS catalog
 * constant is the source of truth that the seed migration mirrors.
 *
 * Pure data contracts: no three.js / React / DOM.
 */

import type { PivotType, SnapRule, LODLevel } from '../types/asset.ts'
import type { ObjectCategory } from '../types/objects.ts'
import type { AssetCategory } from '../snap/asset-snap.ts'

/**
 * How an asset's mesh is obtained:
 *   - 'procedural' : built in L1 from box/cylinder primitives (Phase-1
 *     placeholder · no GLB file · `spatial_assets.geometry_kind = 'procedural'`)
 *   - 'glb'        : a downloaded CC0 GLB model in Storage.
 */
export type AssetGeometryKind = 'procedural' | 'glb'

/**
 * Typed projection of a `spatial_assets` row.
 *
 * `category` is the coarse picker grouping; `objectCategory` is the fine
 * scene-graph type (null for architectural openings — doors / windows — which
 * are `WallOpening` nodes, not `SpatialObject`s).
 */
export interface CatalogAsset {
  slug: string
  displayName: string
  category: AssetCategory
  objectCategory: ObjectCategory | null
  geometryKind: AssetGeometryKind
  /** Storage path of the LOD0 GLB; null for procedural placeholders. */
  gltfStoragePath: string | null
  /** Storage path of the picker thumbnail; null when none exists yet. */
  thumbnailStoragePath: string | null
  /** Real-world bounding-box dimensions in meters. */
  dimensions: { width_m: number; depth_m: number; height_m: number }
  pivot: PivotType
  /** Default placement rule consulted by the Phase-2 edit-system. */
  snapRule: SnapRule
  /** LOD0 triangle budget — procedural placeholders report their real count. */
  polycountLod0: number
  /** 3-entry LOD profile for GLB assets; null for procedural placeholders. */
  lodLevels: LODLevel[] | null
  /** SPDX license id (CC0-1.0 for the whole V1 catalog). */
  license: string
  /** Attribution string — null for CC0. */
  attribution: string | null
  /** Source vendor: 'procedural' | 'polyhaven' | 'poly.pizza' | 'ambientcg' | 'sketchfab'. */
  vendor: string
  /** Canonical source URL (provenance · `LICENSES.md`); null for procedural assets. */
  sourceUrl: string | null
  /** True when this asset can host other objects on its top surface (counter / vanity). */
  isCounterHost: boolean
  published: boolean
  /** Free-text search synonyms (DE + EN) for the Phase-2 asset picker. */
  tags: string[]
}
