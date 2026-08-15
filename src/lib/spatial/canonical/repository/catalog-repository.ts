/**
 * Spatial · Canonical · Repository · Catalog Repository
 *
 * Read-only data source for the 3D asset + PBR material catalogs. Mirrors the
 * `SpatialSceneRepository` pattern: an InMemory implementation (the frozen TS
 * catalog constants) and a Supabase implementation (`spatial_assets` /
 * `spatial_materials`), switched by `VITE_DATA_SOURCE`.
 *
 * Phase 1 runs on InMemory (handover §6) — the catalog tables are not seeded
 * on prod until Phase 5. The Supabase implementation therefore degrades
 * gracefully: a query error or an empty table yields an empty list rather
 * than throwing into the picker UI.
 *
 * This module is intentionally NOT re-exported from `canonical/index.ts` — it
 * imports the Supabase client, which the L1 barrel keeps out (same reason the
 * scene repositories live outside the barrel).
 */

import { supabase } from '../../../supabase'
import type { CatalogAsset } from '../catalog/types.ts'
import type { CatalogMaterial, MaterialTextureSet } from '../catalog/material-types.ts'
import { ASSET_CATALOG } from '../catalog/asset-catalog.ts'
import { MATERIAL_CATALOG } from '../catalog/material-catalog.ts'

/** Read-only catalog access. */
export interface SpatialCatalogRepository {
  /** All published PBR materials. */
  listMaterials(): Promise<CatalogMaterial[]>
  /** All published 3D assets. */
  listAssets(): Promise<CatalogAsset[]>
}

// ─────────────────────────────────────────────────────────────────────────────
// InMemory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serves the frozen TS catalogs. Returns defensive copies so a consumer that
 * mutates a list cannot corrupt the shared registry.
 */
export class InMemorySpatialCatalogRepository implements SpatialCatalogRepository {
  async listMaterials(): Promise<CatalogMaterial[]> {
    return MATERIAL_CATALOG.filter((m) => m.published).map((m) => ({ ...m }))
  }

  async listAssets(): Promise<CatalogAsset[]> {
    return ASSET_CATALOG.filter((a) => a.published).map((a) => ({ ...a }))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase
// ─────────────────────────────────────────────────────────────────────────────

/** Raw `spatial_materials` row shape (post-20260520120012 migration). */
interface MaterialRow {
  slug: string
  display_name: string
  category: string
  surface_category: string | null
  section: string | null
  albedo_path: string | null
  normal_path: string | null
  roughness_path: string | null
  metallic_path: string | null
  ao_path: string | null
  displacement_path: string | null
  tile_scale_u_m: number | null
  tile_scale_v_m: number | null
  tags: string[] | null
  is_procedural: boolean
  license: string
  attribution: string | null
  vendor: string | null
  published: boolean
  metadata: Record<string, unknown> | null
}

/** Raw `spatial_assets` row shape (post-20260520120044 migration). */
interface AssetRow {
  slug: string
  display_name: string
  category: string
  object_category: string | null
  geometry_kind: string
  gltf_storage_path: string | null
  thumbnail_storage_path: string | null
  tags: string[] | null
  license: string
  attribution: string | null
  vendor: string | null
  is_counter_host: boolean | null
  published: boolean
  metadata: Record<string, unknown> | null
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && !Number.isNaN(value) ? value : fallback
}

function mapMaterialRow(row: MaterialRow): CatalogMaterial {
  const meta = row.metadata ?? {}
  const textures: MaterialTextureSet = {
    albedo: row.albedo_path,
    normal: row.normal_path,
    roughness: row.roughness_path,
    ao: row.ao_path,
    displacement: row.displacement_path,
    metallic: row.metallic_path,
  }
  return {
    slug: row.slug,
    displayName: row.display_name,
    surfaceCategory: (row.surface_category ?? 'wall') as CatalogMaterial['surfaceCategory'],
    materialType: row.category as CatalogMaterial['materialType'],
    section: row.section ?? 'Sonstige',
    acgId: typeof meta.acg_id === 'string' ? meta.acg_id : null,
    procedural: row.is_procedural,
    textures,
    thumbnailPath:
      typeof meta.thumbnail_path === 'string'
        ? meta.thumbnail_path
        : `spatial-assets/materials/thumbnails/${row.slug}.jpg`,
    tileScale: { u: num(row.tile_scale_u_m, 1), v: num(row.tile_scale_v_m, 1) },
    roughness: num(meta.roughness, 0.9),
    metalness: num(meta.metalness, 0),
    fallbackColorHex: typeof meta.fallback_color_hex === 'string' ? meta.fallback_color_hex : '#CCCCCC',
    license: row.license,
    attribution: row.attribution,
    vendor: row.vendor ?? 'ambientcg',
    tags: row.tags ?? [],
    published: row.published,
  }
}

function mapAssetRow(row: AssetRow): CatalogAsset {
  const meta = row.metadata ?? {}
  const dims = (meta.dimensions ?? {}) as Record<string, unknown>
  return {
    slug: row.slug,
    displayName: row.display_name,
    category: row.category as CatalogAsset['category'],
    objectCategory: (row.object_category ?? null) as CatalogAsset['objectCategory'],
    geometryKind: row.geometry_kind === 'procedural' ? 'procedural' : 'glb',
    gltfStoragePath: row.gltf_storage_path,
    thumbnailStoragePath: row.thumbnail_storage_path,
    dimensions: {
      width_m: num(dims.width_m, 0.5),
      depth_m: num(dims.depth_m, 0.5),
      height_m: num(dims.height_m, 0.5),
    },
    pivot: (meta.pivot ?? 'bottom_center') as CatalogAsset['pivot'],
    snapRule: (meta.snap_rule ?? { target_host: 'floor', align_to_normal: false }) as CatalogAsset['snapRule'],
    polycountLod0: num(meta.polycount_lod0, 0),
    lodLevels: (meta.lod_levels ?? null) as CatalogAsset['lodLevels'],
    license: row.license,
    attribution: row.attribution,
    vendor: row.vendor ?? 'polyhaven',
    sourceUrl: typeof meta.source_url === 'string' ? meta.source_url : null,
    isCounterHost: row.is_counter_host ?? false,
    published: row.published,
    tags: row.tags ?? [],
  }
}

/**
 * Reads the published catalog rows from Postgres.
 *
 * A transport / query error is THROWN, not swallowed — the graceful-
 * degradation layer is the `useMaterialCatalog` hook, which catches the
 * rejection and renders Mockup 42 State E (inline retry) or State F (offline
 * cache). A repository that silently returned `[]` would make those states
 * unreachable and show the user a blank grid instead. An empty table is a
 * legitimate empty result (Phase 1: catalogs are not seeded on prod) and
 * resolves normally.
 */
export class SupabaseSpatialCatalogRepository implements SpatialCatalogRepository {
  async listMaterials(): Promise<CatalogMaterial[]> {
    const { data, error } = await supabase
      .from('spatial_materials')
      .select(
        'slug, display_name, category, surface_category, section, albedo_path, normal_path, ' +
          'roughness_path, metallic_path, ao_path, displacement_path, tile_scale_u_m, ' +
          'tile_scale_v_m, tags, is_procedural, license, attribution, vendor, published, metadata',
      )
      .eq('published', true)
    if (error) {
      throw new Error(`spatial_materials fetch failed: ${error.message}`)
    }
    return (data as unknown as MaterialRow[] | null)?.map(mapMaterialRow) ?? []
  }

  async listAssets(): Promise<CatalogAsset[]> {
    const { data, error } = await supabase
      .from('spatial_assets')
      .select(
        'slug, display_name, category, object_category, geometry_kind, gltf_storage_path, ' +
          'thumbnail_storage_path, tags, license, attribution, vendor, is_counter_host, published, metadata',
      )
      .eq('published', true)
    if (error) {
      throw new Error(`spatial_assets fetch failed: ${error.message}`)
    }
    return (data as unknown as AssetRow[] | null)?.map(mapAssetRow) ?? []
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

export type SpatialCatalogDataSource = 'in-memory' | 'supabase'

let _instance: SpatialCatalogRepository | null = null
let _kind: SpatialCatalogDataSource | null = null

function resolveDataSource(): SpatialCatalogDataSource {
  const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env
  return env?.VITE_DATA_SOURCE === 'supabase' ? 'supabase' : 'in-memory'
}

/** Singleton catalog repository for the active data source. */
export function getSpatialCatalogRepository(
  kindOverride?: SpatialCatalogDataSource,
): SpatialCatalogRepository {
  const kind = kindOverride ?? resolveDataSource()
  if (_instance && _kind === kind) return _instance
  _instance = kind === 'supabase'
    ? new SupabaseSpatialCatalogRepository()
    : new InMemorySpatialCatalogRepository()
  _kind = kind
  return _instance
}

/** Reset the singleton — test helper. */
export function resetSpatialCatalogRepository(): void {
  _instance = null
  _kind = null
}
