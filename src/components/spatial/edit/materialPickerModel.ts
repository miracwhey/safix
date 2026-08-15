/**
 * Spatial · Edit · Material-Picker shared model
 *
 * Pure presentation helpers shared by the Material-Picker components
 * (Mockup 42). No React — keeps the components themselves thin.
 */

import type { CatalogMaterial, MaterialSurfaceCategory } from '../../../lib/spatial/canonical/catalog/material-types.ts'
import { resolveSpatialAssetUrl } from '../../../lib/spatial/canonical/assets/assetBaseUrl'

/**
 * Surface type reported by the 3D viewer when a surface is tapped. `decor`
 * covers decorative objects (upholstery / ceramic / mirror surfaces) so the
 * Dekor materials are reachable — without it the Dekor pill is dead.
 */
export type SurfaceType = 'wall' | 'floor' | 'counter' | 'ceiling' | 'fixture' | 'decor'

/** The 5 Category-Pills in display order (Mockup 42 §3). */
export const CATEGORY_PILLS: ReadonlyArray<{ id: MaterialSurfaceCategory; label: string }> =
  Object.freeze([
    { id: 'wall', label: 'Wand' },
    { id: 'floor', label: 'Boden' },
    { id: 'counter', label: 'Counter' },
    { id: 'metal', label: 'Metall' },
    { id: 'decor', label: 'Dekor' },
  ])

/**
 * The material category a tapped surface accepts. A wall only takes wall
 * materials, a floor only floor materials — the picker enables exactly this
 * one pill and disables the rest (Mockup 42 §3a).
 */
export function surfaceTypeToCategory(type: SurfaceType): MaterialSurfaceCategory {
  switch (type) {
    case 'wall':
      return 'wall'
    case 'floor':
      return 'floor'
    case 'counter':
      return 'counter'
    case 'ceiling':
      return 'wall'
    case 'fixture':
      return 'metal'
    case 'decor':
      return 'decor'
  }
}

/** Public URL of a material's 256×256 picker thumbnail. */
export function materialThumbnailUrl(material: CatalogMaterial): string {
  return resolveSpatialAssetUrl(material.thumbnailPath)
}

/** Short "finish" descriptor shown under the material name on a card. */
export function materialFinishLabel(material: CatalogMaterial): string {
  return material.section
}
