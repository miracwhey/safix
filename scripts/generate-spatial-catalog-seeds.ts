/**
 * Generate the Spatial catalog seed migrations from the TS catalog.
 *
 * The TS catalog (`src/lib/spatial/canonical/catalog/`) is the single source
 * of truth; this script emits the two seed SQL files so they can never drift:
 *   - supabase/migrations/20260520120020_spatial_materials_seed.sql  (32 rows)
 *   - supabase/migrations/20260520120021_spatial_assets_seed.sql     (36 rows)
 *
 * Re-run after any catalog edit:
 *   npx tsx scripts/generate-spatial-catalog-seeds.ts
 *
 * Both seeds upsert on `slug` (ON CONFLICT DO UPDATE) so they are idempotent.
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { MATERIAL_CATALOG } from '../src/lib/spatial/canonical/catalog/material-catalog.ts'
import { ASSET_CATALOG } from '../src/lib/spatial/canonical/catalog/asset-catalog.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(HERE, '..', 'supabase', 'migrations')

// ── SQL literal helpers ───────────────────────────────────────────────────────

function sqlStr(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'NULL'
  return `'${value.replace(/'/g, "''")}'`
}

function sqlNum(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(value) ? 'NULL' : String(value)
}

function sqlBool(value: boolean): string {
  return value ? 'true' : 'false'
}

function sqlTextArray(values: readonly string[]): string {
  if (values.length === 0) return `'{}'::text[]`
  return `ARRAY[${values.map((v) => sqlStr(v)).join(', ')}]::text[]`
}

function sqlJsonb(value: unknown): string {
  return `${sqlStr(JSON.stringify(value))}::jsonb`
}

/** Build a multi-row INSERT … ON CONFLICT (slug) DO UPDATE upsert. */
function buildUpsert(table: string, columns: string[], rows: string[][]): string {
  const updates = columns
    .filter((c) => c !== 'slug')
    .map((c) => `  ${c} = EXCLUDED.${c}`)
    .join(',\n')
  const valueLines = rows.map((r) => `  (${r.join(', ')})`).join(',\n')
  return (
    `INSERT INTO public.${table} (\n  ${columns.join(', ')}\n) VALUES\n${valueLines}\n` +
    `ON CONFLICT (slug) DO UPDATE SET\n${updates},\n  updated_at = now();\n`
  )
}

// ── Materials ─────────────────────────────────────────────────────────────────

const MATERIAL_COLUMNS = [
  'slug', 'display_name', 'category', 'surface_category', 'section',
  'albedo_path', 'normal_path', 'roughness_path', 'metallic_path', 'ao_path',
  'displacement_path', 'tile_scale_u_m', 'tile_scale_v_m', 'tags', 'is_procedural',
  'license', 'attribution', 'vendor', 'published', 'metadata',
]

const materialRows = MATERIAL_CATALOG.map((m) => [
  sqlStr(m.slug),
  sqlStr(m.displayName),
  sqlStr(m.materialType),
  sqlStr(m.surfaceCategory),
  sqlStr(m.section),
  sqlStr(m.textures.albedo),
  sqlStr(m.textures.normal),
  sqlStr(m.textures.roughness),
  sqlStr(m.textures.metallic),
  sqlStr(m.textures.ao),
  sqlStr(m.textures.displacement),
  sqlNum(m.tileScale.u),
  sqlNum(m.tileScale.v),
  sqlTextArray(m.tags),
  sqlBool(m.procedural),
  sqlStr(m.license),
  sqlStr(m.attribution),
  sqlStr(m.vendor),
  sqlBool(m.published),
  sqlJsonb({
    acg_id: m.acgId,
    roughness: m.roughness,
    metalness: m.metalness,
    fallback_color_hex: m.fallbackColorHex,
    thumbnail_path: m.thumbnailPath,
  }),
])

const materialsSql = `-- Spatial Canonical · Phase 1 · Material catalog seed (Day 20)
--
-- 32 verified ambientCG CC0 PBR materials (spatial-v1-material-curation.md).
-- GENERATED FILE — do not hand-edit. Regenerate after catalog changes:
--   npx tsx scripts/generate-spatial-catalog-seeds.ts
--
-- Source of truth: src/lib/spatial/canonical/catalog/material-catalog.ts
-- Pairs with schema migration 20260520120012_spatial_catalog_phase1_columns.sql.
-- Idempotent: upserts on slug. Texture paths point at Supabase Storage; the
-- binaries are fetched separately (see scripts/download-spatial-assets.sh).

${buildUpsert('spatial_materials', MATERIAL_COLUMNS, materialRows)}`

// ── Assets ────────────────────────────────────────────────────────────────────

const ASSET_COLUMNS = [
  'slug', 'display_name', 'category', 'object_category', 'geometry_kind',
  'gltf_storage_path', 'thumbnail_storage_path', 'tags',
  'license', 'attribution', 'vendor', 'published', 'metadata',
]

const assetRows = ASSET_CATALOG.map((a) => [
  sqlStr(a.slug),
  sqlStr(a.displayName),
  sqlStr(a.category),
  sqlStr(a.objectCategory),
  sqlStr(a.geometryKind),
  sqlStr(a.gltfStoragePath),
  sqlStr(a.thumbnailStoragePath),
  sqlTextArray(a.tags),
  sqlStr(a.license),
  sqlStr(a.attribution),
  sqlStr(a.vendor),
  sqlBool(a.published),
  sqlJsonb({
    dimensions: a.dimensions,
    pivot: a.pivot,
    snap_rule: a.snapRule,
    polycount_lod0: a.polycountLod0,
    lod_levels: a.lodLevels,
  }),
])

const assetsSql = `-- Spatial Canonical · Phase 1 · Asset catalog seed (Day 19)
--
-- 36 V1 catalog assets (asset-source-map.md · 10 sanitary + 8 kitchen +
-- 8 architecture + 10 furniture). GENERATED FILE — do not hand-edit.
-- Regenerate after catalog changes:
--   npx tsx scripts/generate-spatial-catalog-seeds.ts
--
-- Source of truth: src/lib/spatial/canonical/catalog/asset-catalog.ts
-- Pairs with schema migration 20260520120012_spatial_catalog_phase1_columns.sql.
-- geometry_kind='procedural' rows (26) have NULL gltf_storage_path — their mesh
-- is built in L1 (procedural-assets.ts). geometry_kind='glb' rows (10 furniture)
-- reference real Polyhaven CC0 GLB binaries fetched via the asset manifest.
-- Idempotent: upserts on slug.

${buildUpsert('spatial_assets', ASSET_COLUMNS, assetRows)}`

// ── Emit ──────────────────────────────────────────────────────────────────────

const materialsPath = join(MIGRATIONS, '20260520120020_spatial_materials_seed.sql')
const assetsPath = join(MIGRATIONS, '20260520120021_spatial_assets_seed.sql')

writeFileSync(materialsPath, materialsSql)
writeFileSync(assetsPath, assetsSql)

console.log(`✓ ${materialRows.length} materials → ${materialsPath}`)
console.log(`✓ ${assetRows.length} assets    → ${assetsPath}`)
