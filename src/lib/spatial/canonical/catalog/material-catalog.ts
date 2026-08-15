/**
 * Spatial · Canonical · Catalog · Material Catalog
 *
 * The 32-entry V1 PBR-material catalog (material-curation.md · all ambientCG
 * IDs verified 2026-05-20). This TS constant is the source of truth: the
 * InMemory catalog repository serves it directly and the
 * `20260520120020_spatial_materials_seed.sql` migration mirrors it.
 *
 * Two orthogonal axes (Mockup 42):
 *   - `surfaceCategory` — which surface the material applies to. Drives the
 *     picker Category-Pills (Wand / Boden / Counter / Metall / Dekor).
 *   - `materialType` + `section` — the physical type, drives the Typ-Sektion
 *     grouping inside the grid (Mockup 42 §3b).
 *
 * `decor-mirror` is procedural — a `MeshPhysicalMaterial` (roughness ~0,
 * metalness 1, scene envMap), no texture download.
 *
 * Pure data: no three.js / React / DOM.
 */

import type { MaterialSurfaceCategory, MaterialType, CatalogMaterial } from './material-types.ts'

const CC0 = 'CC0-1.0'

interface MaterialInput {
  slug: string
  displayName: string
  surfaceCategory: MaterialSurfaceCategory
  materialType: MaterialType
  section: string
  /** ambientCG asset id, or null for procedural materials. */
  acgId: string | null
  tileU: number
  tileV: number
  /** Solid-colour fallback hex (used when textures fail to load). */
  hex: string
  tags: string[]
  roughness?: number
  metalness?: number
  procedural?: boolean
}

function buildMaterial(input: MaterialInput): CatalogMaterial {
  const isMetal = input.surfaceCategory === 'metal'
  const procedural = input.procedural ?? false
  const base = `spatial-assets/materials/${input.slug}`
  return {
    slug: input.slug,
    displayName: input.displayName,
    surfaceCategory: input.surfaceCategory,
    materialType: input.materialType,
    section: input.section,
    acgId: input.acgId,
    procedural,
    textures: procedural
      ? { albedo: null, normal: null, roughness: null, ao: null, displacement: null, metallic: null }
      : {
          albedo: `${base}/albedo.ktx2`,
          normal: `${base}/normal.ktx2`,
          roughness: `${base}/roughness.ktx2`,
          ao: `${base}/ao.ktx2`,
          displacement: `${base}/displacement.ktx2`,
          metallic: isMetal ? `${base}/metallic.ktx2` : null,
        },
    thumbnailPath: `spatial-assets/materials/thumbnails/${input.slug}.jpg`,
    tileScale: { u: input.tileU, v: input.tileV },
    roughness: input.roughness ?? (isMetal ? 0.35 : 0.9),
    metalness: input.metalness ?? (isMetal ? 1 : 0),
    fallbackColorHex: input.hex,
    license: CC0,
    attribution: null,
    vendor: 'ambientcg',
    tags: input.tags,
    published: true,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wand · 10
// ─────────────────────────────────────────────────────────────────────────────

const WALL: CatalogMaterial[] = [
  buildMaterial({ slug: 'wall-paint-white', displayName: 'Paint White', surfaceCategory: 'wall', materialType: 'paint', section: 'Farbe & Putz', acgId: 'Plaster001', tileU: 4, tileV: 4, hex: '#F2F1ED', tags: ['weiß', 'white', 'farbe', 'paint', 'matt'] }),
  buildMaterial({ slug: 'wall-plaster-creme', displayName: 'Putz Creme', surfaceCategory: 'wall', materialType: 'plaster', section: 'Farbe & Putz', acgId: 'Plaster002', tileU: 4, tileV: 4, hex: '#E8E0D2', tags: ['creme', 'cream', 'putz', 'plaster', 'beige'] }),
  buildMaterial({ slug: 'wall-plaster-struktur', displayName: 'Putz Struktur', surfaceCategory: 'wall', materialType: 'plaster', section: 'Farbe & Putz', acgId: 'Plaster003', tileU: 3, tileV: 3, hex: '#DAD4C8', tags: ['struktur', 'textured', 'putz', 'plaster', 'rau'] }),
  buildMaterial({ slug: 'wall-tile-white', displayName: 'Wandfliese Weiß', surfaceCategory: 'wall', materialType: 'tile', section: 'Fliesen', acgId: 'Tiles036', tileU: 0.3, tileV: 0.3, hex: '#F4F4F2', tags: ['fliese', 'weiß', 'white', 'tile', 'glanz', 'glossy', 'keramik'] }),
  buildMaterial({ slug: 'wall-tile-grey', displayName: 'Fliese Grau', surfaceCategory: 'wall', materialType: 'tile', section: 'Fliesen', acgId: 'Tiles040', tileU: 0.3, tileV: 0.3, hex: '#B8B9BA', tags: ['fliese', 'grau', 'grey', 'gray', 'tile'] }),
  buildMaterial({ slug: 'wall-marble', displayName: 'Marmor-Optik', surfaceCategory: 'wall', materialType: 'stone', section: 'Fliesen', acgId: 'Marble012', tileU: 1.2, tileV: 0.6, hex: '#E7E6E3', tags: ['marmor', 'marble', 'stein', 'stone', 'edel'] }),
  buildMaterial({ slug: 'wall-oak', displayName: 'Eiche Vertäfelung', surfaceCategory: 'wall', materialType: 'wood', section: 'Holz & Tapete', acgId: 'Wood049', tileU: 0.2, tileV: 2.4, hex: '#B68F5E', tags: ['eiche', 'oak', 'holz', 'wood', 'vertäfelung'] }),
  buildMaterial({ slug: 'wall-linen', displayName: 'Leinen-Tapete', surfaceCategory: 'wall', materialType: 'fabric', section: 'Holz & Tapete', acgId: 'Fabric062', tileU: 1.0, tileV: 1.4, hex: '#D8CFC0', tags: ['leinen', 'linen', 'tapete', 'wallpaper', 'stoff'] }),
  buildMaterial({ slug: 'wall-concrete', displayName: 'Sichtbeton', surfaceCategory: 'wall', materialType: 'concrete', section: 'Beton & Ziegel', acgId: 'Concrete034', tileU: 3, tileV: 3, hex: '#9C9B98', tags: ['beton', 'concrete', 'sichtbeton', 'grau', 'industrial'] }),
  buildMaterial({ slug: 'wall-brick-white', displayName: 'Ziegel Weiß', surfaceCategory: 'wall', materialType: 'brick', section: 'Beton & Ziegel', acgId: 'Bricks060', tileU: 2, tileV: 1.5, hex: '#E4E1DB', tags: ['ziegel', 'brick', 'mauer', 'weiß', 'white'] }),
]

// ─────────────────────────────────────────────────────────────────────────────
// Boden · 8
// ─────────────────────────────────────────────────────────────────────────────

const FLOOR: CatalogMaterial[] = [
  buildMaterial({ slug: 'floor-oak', displayName: 'Eiche Diele', surfaceCategory: 'floor', materialType: 'wood', section: 'Holz', acgId: 'WoodFloor051', tileU: 0.2, tileV: 1.6, hex: '#B58A5A', tags: ['eiche', 'oak', 'holz', 'wood', 'diele', 'parkett'] }),
  buildMaterial({ slug: 'floor-walnut', displayName: 'Walnuss Rustikal', surfaceCategory: 'floor', materialType: 'wood', section: 'Holz', acgId: 'WoodFloor043', tileU: 0.18, tileV: 1.4, hex: '#6E4A30', tags: ['walnuss', 'walnut', 'holz', 'wood', 'rustikal'] }),
  buildMaterial({ slug: 'floor-tile-anthracite', displayName: 'Feinsteinzeug Anthrazit', surfaceCategory: 'floor', materialType: 'tile', section: 'Fliesen & Stein', acgId: 'Tiles052', tileU: 0.6, tileV: 0.6, hex: '#3C3D3F', tags: ['fliese', 'feinsteinzeug', 'anthrazit', 'tile', 'dunkel'] }),
  buildMaterial({ slug: 'floor-natural-stone', displayName: 'Naturstein-Boden', surfaceCategory: 'floor', materialType: 'stone', section: 'Fliesen & Stein', acgId: 'Tiles093', tileU: 0.5, tileV: 0.5, hex: '#A9A296', tags: ['naturstein', 'stone', 'stein', 'boden'] }),
  buildMaterial({ slug: 'floor-marble', displayName: 'Marmorboden', surfaceCategory: 'floor', materialType: 'stone', section: 'Fliesen & Stein', acgId: 'Marble020', tileU: 0.8, tileV: 0.8, hex: '#E5E3DF', tags: ['marmor', 'marble', 'stein', 'stone', 'boden'] }),
  buildMaterial({ slug: 'floor-slate', displayName: 'Schiefer', surfaceCategory: 'floor', materialType: 'stone', section: 'Fliesen & Stein', acgId: 'Rock035', tileU: 0.4, tileV: 0.4, hex: '#4A4B4D', tags: ['schiefer', 'slate', 'stein', 'stone', 'dunkel'] }),
  buildMaterial({ slug: 'floor-carpet-grey', displayName: 'Teppich Grau', surfaceCategory: 'floor', materialType: 'fabric', section: 'Teppich & Weich', acgId: 'Carpet003', tileU: 4, tileV: 4, hex: '#8E8E8C', tags: ['teppich', 'carpet', 'grau', 'grey', 'weich'] }),
  buildMaterial({ slug: 'floor-concrete-screed', displayName: 'Estrich Beton', surfaceCategory: 'floor', materialType: 'concrete', section: 'Beton & Estrich', acgId: 'Concrete031', tileU: 4, tileV: 4, hex: '#959492', tags: ['estrich', 'beton', 'concrete', 'screed', 'industrial'] }),
]

// ─────────────────────────────────────────────────────────────────────────────
// Counter · 6
// ─────────────────────────────────────────────────────────────────────────────

const COUNTER: CatalogMaterial[] = [
  buildMaterial({ slug: 'counter-marble-beige', displayName: 'Marmor Beige', surfaceCategory: 'counter', materialType: 'stone', section: 'Naturstein', acgId: 'Marble014', tileU: 2.5, tileV: 0.65, hex: '#E3DACA', tags: ['marmor', 'marble', 'beige', 'stein', 'arbeitsplatte'] }),
  buildMaterial({ slug: 'counter-granite-dark', displayName: 'Granit Dunkel', surfaceCategory: 'counter', materialType: 'stone', section: 'Naturstein', acgId: 'Rock041', tileU: 2.5, tileV: 0.65, hex: '#37373A', tags: ['granit', 'granite', 'dunkel', 'stein', 'arbeitsplatte'] }),
  buildMaterial({ slug: 'counter-quartz-white', displayName: 'Quarz Weiß', surfaceCategory: 'counter', materialType: 'stone', section: 'Beton & Quarz', acgId: 'Marble021', tileU: 2.5, tileV: 0.65, hex: '#EEEDEA', tags: ['quarz', 'quartz', 'weiß', 'white', 'arbeitsplatte'] }),
  buildMaterial({ slug: 'counter-wood-walnut', displayName: 'Holz Walnuss', surfaceCategory: 'counter', materialType: 'wood', section: 'Holz', acgId: 'Wood051', tileU: 2.5, tileV: 0.6, hex: '#7A553A', tags: ['holz', 'wood', 'walnuss', 'walnut', 'arbeitsplatte'] }),
  buildMaterial({ slug: 'counter-concrete-light', displayName: 'Beton Hell', surfaceCategory: 'counter', materialType: 'concrete', section: 'Beton & Quarz', acgId: 'Concrete046', tileU: 2.5, tileV: 0.65, hex: '#BDBBB6', tags: ['beton', 'concrete', 'hell', 'light', 'arbeitsplatte'] }),
  buildMaterial({ slug: 'counter-concrete-dark', displayName: 'Beton Anthrazit', surfaceCategory: 'counter', materialType: 'concrete', section: 'Beton & Quarz', acgId: 'Concrete031', tileU: 2.5, tileV: 0.65, hex: '#54534F', tags: ['beton', 'concrete', 'anthrazit', 'dark', 'arbeitsplatte'] }),
]

// ─────────────────────────────────────────────────────────────────────────────
// Metall · 4
// ─────────────────────────────────────────────────────────────────────────────

const METAL: CatalogMaterial[] = [
  buildMaterial({ slug: 'metal-chrome', displayName: 'Chrom Poliert', surfaceCategory: 'metal', materialType: 'metal', section: 'Metall', acgId: 'Metal049A', tileU: 0.05, tileV: 0.05, hex: '#D6D8DB', roughness: 0.08, tags: ['chrom', 'chrome', 'metall', 'metal', 'poliert', 'glanz'] }),
  buildMaterial({ slug: 'metal-steel-brushed', displayName: 'Edelstahl Gebürstet', surfaceCategory: 'metal', materialType: 'metal', section: 'Metall', acgId: 'Metal032', tileU: 0.2, tileV: 0.2, hex: '#A7A9AC', roughness: 0.4, tags: ['edelstahl', 'stahl', 'steel', 'gebürstet', 'brushed', 'metall'] }),
  buildMaterial({ slug: 'metal-brass', displayName: 'Messing', surfaceCategory: 'metal', materialType: 'metal', section: 'Metall', acgId: 'Metal034', tileU: 0.05, tileV: 0.05, hex: '#C9A86A', roughness: 0.25, tags: ['messing', 'brass', 'gold', 'metall', 'metal'] }),
  buildMaterial({ slug: 'metal-black-matte', displayName: 'Schwarz Matt', surfaceCategory: 'metal', materialType: 'metal', section: 'Metall', acgId: 'Metal046A', tileU: 0.1, tileV: 0.1, hex: '#2A2A2C', roughness: 0.6, tags: ['schwarz', 'black', 'matt', 'matte', 'metall', 'metal'] }),
]

// ─────────────────────────────────────────────────────────────────────────────
// Dekor · 4
// ─────────────────────────────────────────────────────────────────────────────

const DECOR: CatalogMaterial[] = [
  buildMaterial({ slug: 'decor-linen', displayName: 'Leinen Stoff', surfaceCategory: 'decor', materialType: 'fabric', section: 'Stoff & Leder', acgId: 'Fabric061', tileU: 1.2, tileV: 1.2, hex: '#CFC6B4', tags: ['leinen', 'linen', 'stoff', 'fabric', 'textil'] }),
  buildMaterial({ slug: 'decor-leather-brown', displayName: 'Leder Braun', surfaceCategory: 'decor', materialType: 'fabric', section: 'Stoff & Leder', acgId: 'Leather037', tileU: 0.8, tileV: 0.8, hex: '#6B4528', tags: ['leder', 'leather', 'braun', 'brown', 'stoff'] }),
  buildMaterial({ slug: 'decor-ceramic-white', displayName: 'Keramik Weiß', surfaceCategory: 'decor', materialType: 'ceramic', section: 'Keramik & Glas', acgId: 'Tiles107', tileU: 0.4, tileV: 0.4, hex: '#F0EFEC', roughness: 0.3, tags: ['keramik', 'ceramic', 'weiß', 'white', 'glanz'] }),
  buildMaterial({ slug: 'decor-mirror', displayName: 'Spiegel', surfaceCategory: 'decor', materialType: 'other', section: 'Keramik & Glas', acgId: null, tileU: 1, tileV: 1, hex: '#C8D0D6', roughness: 0.05, metalness: 1, procedural: true, tags: ['spiegel', 'mirror', 'glas', 'glass', 'reflexion'] }),
]

/**
 * The full V1 material catalog — 32 entries. Frozen so consumers cannot
 * mutate the shared registry at run time.
 */
export const MATERIAL_CATALOG: readonly CatalogMaterial[] = Object.freeze([
  ...WALL,
  ...FLOOR,
  ...COUNTER,
  ...METAL,
  ...DECOR,
])

/** Lookup index by slug. */
const MATERIAL_BY_SLUG: ReadonlyMap<string, CatalogMaterial> = new Map(
  MATERIAL_CATALOG.map((m) => [m.slug, m]),
)

/** Find a catalog material by slug, or `undefined`. */
export function getCatalogMaterial(slug: string): CatalogMaterial | undefined {
  return MATERIAL_BY_SLUG.get(slug)
}

/** All published materials for a surface category (the picker Category-Pill). */
export function getCatalogMaterialsBySurface(surface: MaterialSurfaceCategory): CatalogMaterial[] {
  return MATERIAL_CATALOG.filter((m) => m.surfaceCategory === surface && m.published)
}
