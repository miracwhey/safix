/**
 * Spatial · Canonical · Catalog · Material Search
 *
 * Pure search + grouping helpers for the Material-Picker (Mockup 42 §3a / §3b).
 * No React, no DOM — the hook layer (`useMaterialSearch`) wraps these with
 * debouncing + state.
 *
 * Matching contract (Mockup 42 §3a · binding):
 *   - trimmed, case-insensitive
 *   - diacritic-insensitive ("weiss" === "weiß")
 *   - substring match against the display name AND the tag synonyms
 *   - empty query → the full list
 */

import type { CatalogMaterial } from './material-types.ts'

/**
 * Normalise a string for diacritic-insensitive comparison: lower-case, NFD
 * decompose, strip combining marks. "Weiß" → "weiss"-ish ("weiß" → "weiß"
 * has no combining mark on ß, so ß is also folded to "ss" explicitly).
 */
export function normalizeSearch(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
}

/** Whether a material matches a normalised query (name OR any tag). */
function materialMatches(material: CatalogMaterial, normalizedQuery: string): boolean {
  if (normalizeSearch(material.displayName).includes(normalizedQuery)) return true
  for (const tag of material.tags) {
    if (normalizeSearch(tag).includes(normalizedQuery)) return true
  }
  return false
}

/**
 * Filter materials by a free-text query. An empty / whitespace query returns
 * the input list unchanged (referentially — callers can rely on that).
 */
export function searchMaterials(
  materials: readonly CatalogMaterial[],
  query: string,
): CatalogMaterial[] {
  const normalized = normalizeSearch(query)
  if (normalized.length === 0) return materials.slice()
  return materials.filter((m) => materialMatches(m, normalized))
}

/** A Typ-Sektion bucket for the grouped browse grid (Mockup 42 §3b). */
export interface MaterialSection {
  section: string
  materials: CatalogMaterial[]
}

/**
 * Group materials into Typ-Sektionen, preserving first-seen section order
 * and the within-section catalog order. Drives the grouped browse grid.
 */
export function groupMaterialsBySection(
  materials: readonly CatalogMaterial[],
): MaterialSection[] {
  const order: string[] = []
  const buckets = new Map<string, CatalogMaterial[]>()
  for (const material of materials) {
    let bucket = buckets.get(material.section)
    if (!bucket) {
      bucket = []
      buckets.set(material.section, bucket)
      order.push(material.section)
    }
    bucket.push(material)
  }
  return order.map((section) => ({ section, materials: buckets.get(section)! }))
}
