/**
 * Spatial · Customer · Asset-Picker model (V1.6.1 Möbel-Place-Flow Phase 3)
 *
 * Pure view-model for the furniture/fixture picker: category pills, sub-section
 * grouping by ObjectCategory, thumbnail-URL + dimension formatting. No React /
 * three.js — keeps the sheet component thin and this unit-testable.
 *
 * The catalog is the in-memory frozen constant (`getCatalogAssetsByCategory`),
 * so grouping is synchronous — no loading/error states needed.
 */

import { getCatalogAssetsByCategory } from '../../../lib/spatial/canonical/catalog/asset-catalog.ts'
import { resolveSpatialAssetUrl } from '../../../lib/spatial/canonical/assets/assetBaseUrl.ts'
import type { CatalogAsset } from '../../../lib/spatial/canonical/catalog/types.ts'
import type { AssetCategory } from '../../../lib/spatial/canonical/snap/asset-snap.ts'
import type { ObjectCategory } from '../../../lib/spatial/canonical/types/objects.ts'

export interface AssetPickerPill {
  id: AssetCategory
  label: string
}

/** Picker tabs — Möbel first (the primary use-case), then fixtures. */
export const ASSET_PICKER_PILLS: readonly AssetPickerPill[] = Object.freeze([
  { id: 'furniture', label: 'Möbel' },
  { id: 'sanitary', label: 'Sanitär' },
  { id: 'kitchen', label: 'Küche' },
  { id: 'architecture', label: 'Architektur' },
])

/** Ordered sub-sections within a category, grouped by fine ObjectCategory. */
interface SubSectionDef {
  label: string
  categories: readonly ObjectCategory[]
}

const SUBSECTIONS: readonly SubSectionDef[] = Object.freeze([
  { label: 'Sitzen', categories: ['sofa', 'armchair', 'chair'] },
  { label: 'Tische', categories: ['table'] },
  { label: 'Schlafen', categories: ['bed'] },
  { label: 'Aufbewahrung', categories: ['wardrobe', 'cabinet', 'bookshelf', 'tv_cabinet'] },
  { label: 'Licht & Deko', categories: ['lamp', 'plant', 'rug', 'curtains', 'fireplace', 'mirror'] },
  { label: 'Bad', categories: ['toilet', 'sink', 'bathtub', 'shower', 'bidet', 'towel_rail', 'washing_machine', 'toilet_paper_holder'] },
  { label: 'Küche', categories: ['kitchen_sink', 'cooktop', 'oven', 'refrigerator', 'dishwasher', 'range_hood', 'kitchen_faucet'] },
  { label: 'Technik', categories: ['radiator', 'electrical_outlet', 'light_switch'] },
])

export interface AssetSection {
  label: string
  assets: CatalogAsset[]
}

/**
 * Published, placeable assets for a category, grouped into ordered sub-sections.
 * Assets with no `objectCategory` (doors/windows = WallOpening nodes) are
 * excluded — they are not SpatialObjects and cannot be placed via this picker.
 */
export function buildAssetSections(category: AssetCategory): AssetSection[] {
  const assets = getCatalogAssetsByCategory(category).filter(
    (a) => a.published && a.objectCategory != null,
  )
  const sections: AssetSection[] = []
  const used = new Set<string>()

  for (const def of SUBSECTIONS) {
    const inSection = assets.filter(
      (a) => a.objectCategory != null && def.categories.includes(a.objectCategory),
    )
    if (inSection.length > 0) {
      sections.push({ label: def.label, assets: inSection })
      for (const a of inSection) used.add(a.slug)
    }
  }

  const rest = assets.filter((a) => !used.has(a.slug))
  if (rest.length > 0) sections.push({ label: 'Weitere', assets: rest })

  return sections
}

/** Picker thumbnail URL, or null when the asset has no rendered thumbnail yet. */
export function assetThumbnailUrl(asset: CatalogAsset): string | null {
  return asset.thumbnailStoragePath ? resolveSpatialAssetUrl(asset.thumbnailStoragePath) : null
}

/** German "B × T" footprint label, e.g. "2,1 × 0,9 m". Trailing zeros trimmed. */
export function formatAssetFootprint(asset: CatalogAsset): string {
  const fmt = (n: number): string =>
    n
      .toFixed(2)
      .replace(/0+$/, '')
      .replace(/\.$/, '')
      .replace('.', ',')
  return `${fmt(asset.dimensions.width_m)} × ${fmt(asset.dimensions.depth_m)} m`
}
