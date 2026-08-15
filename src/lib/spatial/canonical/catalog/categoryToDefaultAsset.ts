/**
 * Spatial · category → default catalog slug (scan render-fallback).
 *
 * Scan objects (native RoomPlan → Swift CanonicalConverter) carry a `category`
 * but no `asset_id`, so ObjectAdapter's GLB / procedural render branches never
 * fire and they fall through to the brown generic box. This pure map gives each
 * {@link ObjectCategory} a sensible default catalog slug so a scanned bathtub /
 * sink / fridge / … renders its real model (or silhouette) instead of a box.
 *
 * Resolution is REUSE-FIRST: an on-disk GLB slug where one exists, else an
 * EXISTING procedural-spec slug (correct silhouette, zero download — the
 * tradeoff being catalog dimensions instead of the scan AABB), else `null`
 * (accurate dimensioned generic box) for categories with no catalog asset.
 *
 * Used ONLY as a fallback — a set `object.asset_id` always wins by construction:
 *   `object.asset_id ?? categoryToDefaultAsset(object.category)`
 * so Example / Manual rooms (which carry asset_id) are byte-for-byte unchanged.
 *
 * Pure data (zero three.js / React / DOM) → L1/L2 safe, importable from the L3
 * ObjectAdapter and any future workflow. The category→slug rows are drift-locked
 * by `tests/.../categoryToDefaultAsset.test.ts` (each non-null slug must resolve
 * to a real catalog asset of the matching geometryKind).
 */
import type { ObjectCategory } from '../types/objects.ts'

/**
 * Reuse-first default slug per category. Comment marks the resolution source:
 * `glb` = on-disk GLB catalog entry · `procedural` = existing procedural spec ·
 * `null` = no category-indexed asset → accurate dimensioned box.
 */
const CATEGORY_DEFAULT_ASSET: Readonly<Record<ObjectCategory, string | null>> = Object.freeze({
  // ── Sanitary ─────────────────────────────────────────────────────────────
  toilet: 'sanitary-toilet-standard-floor', // glb
  sink: 'sanitary-sink-pedestal-classic', // glb
  bathtub: 'sanitary-bathtub-builtin-rectangle', // glb
  shower: 'sanitary-shower-enclosure-square', // procedural
  bidet: 'sanitary-bidet-floor-standing', // procedural
  towel_rail: 'sanitary-towel-rack', // glb
  mirror: 'furn-mirror-round-wall', // glb
  washing_machine: 'sanitary-washing-machine', // glb
  toilet_paper_holder: 'sanitary-toilet-paper-holder', // glb
  // ── Kitchen fixtures ──────────────────────────────────────────────────────
  kitchen_sink: 'kitchen-sink-undermount-double', // procedural
  cooktop: 'kitchen-stove-cooktop', // glb
  oven: 'kitchen-oven-standing', // glb
  refrigerator: 'kitchen-refrigerator-freestanding-tall', // glb
  dishwasher: 'kitchen-dishwasher-builtin-60cm', // procedural
  range_hood: 'kitchen-extractor-hood-wall-mounted', // procedural
  kitchen_faucet: 'kitchen-faucet-pullout-tall', // procedural
  // ── HVAC / electrical ─────────────────────────────────────────────────────
  radiator: 'arch-radiator-panel-typ22', // glb
  electrical_outlet: 'arch-outlet-schuko-de', // glb
  light_switch: 'arch-switch-rocker-55', // glb
  fuse_box: null, // no category-indexed asset (arch box is objectCategory:null) → box
  lamp: 'furn-light-ceiling-flush-mount', // glb
  // ── Furniture ─────────────────────────────────────────────────────────────
  sofa: 'furn-sofa-3seater-fabric-grey', // glb
  armchair: 'furn-armchair-fabric-rounded', // glb
  bed: 'furn-bed-double-frame-headboard', // glb
  wardrobe: 'furn-wardrobe-3door-tall', // glb
  bookshelf: 'furn-shelf-open-5tier-wood', // glb
  table: 'furn-dining-table-rectangle-6', // glb
  chair: 'furn-dining-chair-wood-fabric', // glb
  cabinet: 'furn-cabinet-tall-storage', // glb (wardrobe-tagged asset, borrowed)
  tv_cabinet: 'furn-tv-cabinet-lowboard', // glb
  plant: 'furn-plant-medium', // glb
  curtains: 'decor-curtains-double', // glb
  fireplace: 'decor-fireplace', // glb
  rug: 'decor-rug', // glb
  // ── Structural ─────────────────────────────────────────────────────────────
  column: null, // no catalog asset → dimensioned box
  // ── Fallback ───────────────────────────────────────────────────────────────
  generic_cuboid: null, // intentional box
})

/**
 * The default catalog slug for a scanned object's category, or `null` when no
 * catalog asset is indexed for it (→ accurate generic box). Reuse-first.
 */
export function categoryToDefaultAsset(category: ObjectCategory): string | null {
  return CATEGORY_DEFAULT_ASSET[category] ?? null
}
