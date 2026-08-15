/**
 * Spatial · Canonical · Materials · MaterialLoader (Phase 1.5 · Block R5)
 *
 * Loads a PBR material set from the on-disk asset layout into a single
 * `MeshStandardMaterial`, shared and cached per slug.
 *
 * On-disk layout (verified · `public/spatial-assets/materials/`):
 *
 *   materials/<material-slug>/<acgId>_1K-JPG_<MapType>.jpg
 *
 *   - `<material-slug>` — the catalog slug, e.g. `floor-oak`.
 *   - `<acgId>` — the ambientCG asset id, e.g. `WoodFloor051`. This is the
 *     FILE prefix and is NOT the same string as the directory slug; it is
 *     read from `CatalogMaterial.acgId`.
 *   - `<MapType>` ∈ { Color, NormalGL, NormalDX, Roughness, AmbientOcclusion,
 *     Displacement, Metalness }. Only one resolution is shipped (`1K-JPG`).
 *
 * MapType → three.js texture slot:
 *   - Color            → `map`           (sRGB color space)
 *   - NormalGL         → `normalMap`     (OpenGL normals — three.js convention;
 *                                         NormalDX is the unused DirectX twin)
 *   - Roughness        → `roughnessMap`
 *   - AmbientOcclusion → `aoMap`         (needs a `uv2` channel — see adapters)
 *   - Metalness        → `metalnessMap`  (only present for metal materials)
 *   - Displacement     → intentionally NOT wired (vertex displacement needs a
 *                        tessellated mesh; flat wall/floor boxes would gain
 *                        nothing — deferred to a Phase-2 hardening pass)
 *
 * The pre-R5 implementation expected the legacy `poc-materials/<slug>/<res>/
 * albedo.jpg` layout, which no longer exists on disk. This file reconciles the
 * loader to the real layout above.
 *
 * Caching: each decoded `Texture` is shared through the reference-counted
 * `asset-cache` (OQ-13) keyed by its URL, so the same map used by two surfaces
 * — or two viewers — is fetched once. The assembled `MeshStandardMaterial` is
 * additionally memoised per slug so swapping the active wall material between
 * renders does not re-allocate the material wrapper.
 */

import {
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
  type Texture,
} from 'three'

import { acquireAsset, releaseAsset } from '../../../../../lib/spatial/canonical/cache/asset-cache.ts'
import { resolveSpatialAssetUrl } from '../../../../../lib/spatial/canonical/assets/assetBaseUrl.ts'
import { getCatalogMaterial } from '../../../../../lib/spatial/canonical/catalog/material-catalog.ts'
import type { CatalogMaterial } from '../../../../../lib/spatial/canonical/catalog/material-types.ts'

/** The single resolution shipped on disk. */
const RESOLUTION_TOKEN = '1K-JPG'

/** ambientCG MapType file tokens consumed by the renderer. */
type MapType = 'Color' | 'NormalGL' | 'Roughness' | 'AmbientOcclusion' | 'Metalness'

/**
 * Build the runtime URL of one PBR map.
 *
 *   `materials/<slug>/<acgId>_1K-JPG_<MapType>.jpg` resolved via
 *   `assetBaseUrl` to either `/spatial-assets/...` (dev) or the bucket
 *   public URL (prod).
 */
export function materialMapUrl(slug: string, acgId: string, map: MapType): string {
  return resolveSpatialAssetUrl(`materials/${slug}/${acgId}_${RESOLUTION_TOKEN}_${map}.jpg`)
}

const textureLoader = new TextureLoader()

/** Resolved per-slug material cache — avoids re-assembling the wrapper. */
const materialCache = new Map<string, MeshStandardMaterial>()

/**
 * Load one texture map through the shared asset-cache.
 *
 * A missing map (404 — e.g. metals have no AmbientOcclusion, mattes have no
 * Metalness) resolves to `undefined` so the caller can omit that slot without
 * a hard failure. `colorSpace` is only set for the base color map; data maps
 * (normal / roughness / ao / metalness) must stay in linear space.
 */
async function loadMap(url: string, colorSpace?: typeof SRGBColorSpace): Promise<Texture | undefined> {
  try {
    return await acquireAsset<Texture>(
      url,
      () =>
        new Promise<Texture>((resolve, reject) => {
          textureLoader.load(
            url,
            (tex) => resolve(tex),
            undefined,
            () => reject(new Error(`[spatial] material map not found: ${url}`)),
          )
        }),
      (tex) => tex.dispose(),
    ).then((tex) => {
      // Wrapping + color space are configured on the shared cache instance.
      // Both are idempotent, so concurrent acquirers setting them is harmless.
      tex.wrapS = RepeatWrapping
      tex.wrapT = RepeatWrapping
      if (colorSpace) tex.colorSpace = colorSpace
      return tex
    })
  } catch {
    // 404 / decode failure for an optional map — caller omits the slot.
    return undefined
  }
}

/** All texture-map URLs assembled for a catalog material — empty for procedural. */
function mapUrls(material: CatalogMaterial): Record<MapType, string> | null {
  if (material.procedural || !material.acgId) return null
  const id = material.acgId
  return {
    Color: materialMapUrl(material.slug, id, 'Color'),
    NormalGL: materialMapUrl(material.slug, id, 'NormalGL'),
    Roughness: materialMapUrl(material.slug, id, 'Roughness'),
    AmbientOcclusion: materialMapUrl(material.slug, id, 'AmbientOcclusion'),
    Metalness: materialMapUrl(material.slug, id, 'Metalness'),
  }
}

/**
 * Apply the catalog tile scale to every map of an assembled material.
 *
 * `tileScale` is in meters per tile (may be non-square — e.g. plank floors).
 * `repeat` is set on each texture so the picker preview matches the in-scene
 * tiling; surfaces still own their own `uv2` for AO (see adapters).
 */
function applyTileScale(material: MeshStandardMaterial, tile: { u: number; v: number }): void {
  for (const tex of [material.map, material.normalMap, material.roughnessMap, material.aoMap, material.metalnessMap]) {
    if (!tex) continue
    tex.wrapS = RepeatWrapping
    tex.wrapT = RepeatWrapping
    tex.repeat.set(1 / tile.u, 1 / tile.v)
    tex.needsUpdate = true
  }
}

/**
 * Load the PBR material set for a catalog slug into a `MeshStandardMaterial`.
 *
 * Resolution order:
 *   - unknown slug → `fallbackMaterial(slug)` (deterministic hash color).
 *   - procedural material (e.g. `decor-mirror`) → a textureless metal/roughness
 *     material straight from the catalog constants.
 *   - textured material → load every available map; a material whose Color map
 *     fails to load falls back to the hash color so the surface never renders
 *     untextured-and-wrong.
 *
 * The assembled material is cached per slug; the second call returns the same
 * reference. `tileScale` is applied so the in-scene tiling matches the catalog.
 */
export async function loadMaterial(slug: string): Promise<MeshStandardMaterial> {
  const cached = materialCache.get(slug)
  if (cached) return cached

  const catalog = getCatalogMaterial(slug)
  if (!catalog) {
    // Unknown slug — never throw into a render; degrade to the hash color.
    const fb = fallbackMaterial(slug)
    materialCache.set(slug, fb)
    return fb
  }

  // Procedural materials carry no texture set (mirror = MeshStandardMaterial
  // with high metalness + the scene envMap doing the reflection).
  const urls = mapUrls(catalog)
  if (!urls) {
    const procedural = new MeshStandardMaterial({
      color: catalog.fallbackColorHex,
      roughness: catalog.roughness,
      metalness: catalog.metalness,
    })
    procedural.name = `${slug}@procedural`
    materialCache.set(slug, procedural)
    return procedural
  }

  const [color, normal, roughness, ao, metalness] = await Promise.all([
    loadMap(urls.Color, SRGBColorSpace),
    loadMap(urls.NormalGL),
    loadMap(urls.Roughness),
    loadMap(urls.AmbientOcclusion),
    loadMap(urls.Metalness),
  ])

  // A material whose base color map could not be fetched is treated as a
  // load failure — render the deterministic fallback rather than a flat,
  // mis-coloured surface that looks like a bug.
  if (!color) {
    // Release any sibling maps that DID load so their cache refs do not leak.
    for (const [tex, url] of [
      [normal, urls.NormalGL],
      [roughness, urls.Roughness],
      [ao, urls.AmbientOcclusion],
      [metalness, urls.Metalness],
    ] as const) {
      if (tex) releaseAsset(url)
    }
    const fb = fallbackMaterial(slug)
    materialCache.set(slug, fb)
    return fb
  }

  // Only assign map slots that actually loaded. Passing an explicit
  // `undefined` to the `MeshStandardMaterial` constructor makes three.js log
  // a "parameter has value of undefined" warning per missing slot.
  const material = new MeshStandardMaterial({
    map: color,
    // With a roughness/metalness map present, the scalar acts as a multiplier
    // — keep it at 1 so the map drives the value. Without a map, fall back to
    // the catalog constants.
    roughness: roughness ? 1 : catalog.roughness,
    metalness: metalness ? 1 : catalog.metalness,
  })
  if (normal) material.normalMap = normal
  if (roughness) material.roughnessMap = roughness
  if (ao) material.aoMap = ao
  if (metalness) material.metalnessMap = metalness
  material.name = slug
  applyTileScale(material, catalog.tileScale)

  materialCache.set(slug, material)
  return material
}

/**
 * Synchronous fallback used by adapters before `loadMaterial` resolves, for an
 * unknown slug, or when texture loading fails.
 *
 * The color is the catalog `fallbackColorHex` when the slug is known (so the
 * placeholder reads as the right neutral tone) and a deterministic hash color
 * otherwise.
 */
export function fallbackMaterial(slug: string): MeshStandardMaterial {
  const catalog = getCatalogMaterial(slug)
  const m = new MeshStandardMaterial({
    color: catalog?.fallbackColorHex ?? hashColor(slug),
    roughness: catalog?.roughness ?? 0.85,
    metalness: catalog?.metalness ?? 0,
  })
  m.name = `${slug}@fallback`
  return m
}

function hashColor(slug: string): number {
  let h = 0
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0
  // Map into a muted-warm palette so fallbacks read as "neutral material".
  return 0x808080 + (h & 0x1f1f1f)
}

/**
 * Test-only — drop the per-slug material cache. Production code never calls
 * this; the asset-cache underneath bounds GPU texture memory.
 */
export function __resetMaterialCache(): void {
  materialCache.clear()
}
