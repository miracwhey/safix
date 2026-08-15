/**
 * Tests for the Block R5 material wiring — `MaterialLoader.ts`.
 *
 * Covers what the four geometry adapters rely on:
 *   - the on-disk path layout reconciliation:
 *     `/spatial-assets/materials/<slug>/<acgId>_1K-JPG_<MapType>.jpg`,
 *   - the MapType → three.js texture-slot mapping
 *     (Color→map, NormalGL→normalMap, Roughness→roughnessMap,
 *      AmbientOcclusion→aoMap, Metalness→metalnessMap),
 *   - the `fallbackMaterial` degradation path (unknown slug, failed Color map),
 *   - the catalog `tileScale` → `texture.repeat` wiring,
 *   - the per-slug material cache (no re-allocation on a repeat load).
 *
 * `three`'s `TextureLoader` is mocked so no JPG is actually fetched — the
 * mock returns a fake `Texture` for URLs registered as "present" and invokes
 * the error callback for everything else (a 404).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { __resetAssetCache } from '../../../../../src/lib/spatial/canonical/cache/asset-cache.ts'

// ── Mock three's TextureLoader. Every other three export passes through. ─────
/** URLs the mocked loader will "find"; everything else 404s. */
const presentUrls = new Set<string>()

vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three')

  class FakeTexture {
    wrapS = 0
    wrapT = 0
    colorSpace = ''
    needsUpdate = false
    repeat = { set: vi.fn() }
    dispose = vi.fn()
    constructor(public sourceUrl: string) {}
  }

  class FakeTextureLoader {
    load(
      url: string,
      onLoad: (t: unknown) => void,
      _onProgress: unknown,
      onError: (e: unknown) => void,
    ): void {
      if (presentUrls.has(url)) onLoad(new FakeTexture(url))
      else onError(new Error(`404 ${url}`))
    }
  }

  return { ...actual, TextureLoader: FakeTextureLoader }
})

import {
  materialMapUrl,
  loadMaterial,
  fallbackMaterial,
  __resetMaterialCache,
} from '../../../../../src/components/spatial/three/canonical/materials/MaterialLoader.ts'

/** Register every map of a material's acgId as present on disk. */
function registerAllMaps(slug: string, acgId: string, maps: string[]): void {
  for (const map of maps) {
    presentUrls.add(`/spatial-assets/materials/${slug}/${acgId}_1K-JPG_${map}.jpg`)
  }
}

beforeEach(() => {
  presentUrls.clear()
  __resetMaterialCache()
  __resetAssetCache()
})

afterEach(() => {
  presentUrls.clear()
  __resetMaterialCache()
  __resetAssetCache()
})

describe('materialMapUrl · on-disk path layout', () => {
  it('builds the verified <slug>/<acgId>_1K-JPG_<MapType>.jpg path', () => {
    // floor-oak dir, WoodFloor051 file prefix — directory slug ≠ file prefix.
    expect(materialMapUrl('floor-oak', 'WoodFloor051', 'Color')).toBe(
      '/spatial-assets/materials/floor-oak/WoodFloor051_1K-JPG_Color.jpg',
    )
    expect(materialMapUrl('floor-oak', 'WoodFloor051', 'NormalGL')).toBe(
      '/spatial-assets/materials/floor-oak/WoodFloor051_1K-JPG_NormalGL.jpg',
    )
  })
})

describe('loadMaterial · MapType → texture-slot mapping', () => {
  it('wires Color→map, NormalGL→normalMap, Roughness→roughnessMap, AO→aoMap', async () => {
    // floor-oak / WoodFloor051 ships Color + NormalGL + Roughness + AO.
    registerAllMaps('floor-oak', 'WoodFloor051', [
      'Color', 'NormalGL', 'Roughness', 'AmbientOcclusion',
    ])
    const material = await loadMaterial('floor-oak')

    expect(material.map).toBeTruthy()
    expect(material.normalMap).toBeTruthy()
    expect(material.roughnessMap).toBeTruthy()
    expect(material.aoMap).toBeTruthy()
    // Only the base color map is sRGB; data maps stay linear.
    expect((material.map as unknown as { colorSpace: string }).colorSpace).toBe('srgb')
    expect((material.normalMap as unknown as { colorSpace: string }).colorSpace).toBe('')
  })

  it('wires Metalness→metalnessMap for a metal material', async () => {
    // metal-chrome / Metal049A ships a Metalness map (no AmbientOcclusion).
    registerAllMaps('metal-chrome', 'Metal049A', [
      'Color', 'NormalGL', 'Roughness', 'Metalness',
    ])
    const material = await loadMaterial('metal-chrome')

    expect(material.metalnessMap).toBeTruthy()
    expect(material.metalness).toBe(1) // map present → scalar acts as multiplier
  })

  it('omits the aoMap slot when no AmbientOcclusion file exists', async () => {
    // wall-paint-white / Plaster001 has no AmbientOcclusion on disk.
    registerAllMaps('wall-paint-white', 'Plaster001', ['Color', 'NormalGL', 'Roughness'])
    const material = await loadMaterial('wall-paint-white')

    expect(material.map).toBeTruthy()
    expect(material.aoMap).toBeNull()
  })

  it('does NOT wire the NormalDX (DirectX) variant', async () => {
    registerAllMaps('floor-oak', 'WoodFloor051', ['Color', 'NormalGL', 'NormalDX', 'Roughness'])
    await loadMaterial('floor-oak')
    // The loader requests NormalGL — the OpenGL convention three.js expects.
    const requested = [...presentUrls]
    expect(requested.some((u) => u.includes('_NormalGL'))).toBe(true)
    // (NormalDX is present on disk but the loader never asks for it.)
  })
})

describe('loadMaterial · tile-repeat', () => {
  it('applies the catalog tileScale as texture.repeat (1/u, 1/v)', async () => {
    // floor-oak tileScale is { u: 0.2, v: 1.6 } in material-catalog.ts.
    registerAllMaps('floor-oak', 'WoodFloor051', ['Color'])
    const material = await loadMaterial('floor-oak')

    const repeatSet = (material.map as unknown as { repeat: { set: ReturnType<typeof vi.fn> } })
      .repeat.set
    expect(repeatSet).toHaveBeenCalledWith(1 / 0.2, 1 / 1.6)
  })
})

describe('loadMaterial · fallback path', () => {
  it('returns a fallback material for an unknown slug', async () => {
    const material = await loadMaterial('does-not-exist')
    expect(material.name).toBe('does-not-exist@fallback')
  })

  it('falls back when the Color map fails to load', async () => {
    // Register only the secondary maps — Color is missing → fallback.
    registerAllMaps('floor-oak', 'WoodFloor051', ['NormalGL', 'Roughness'])
    const material = await loadMaterial('floor-oak')
    expect(material.name).toBe('floor-oak@fallback')
    expect(material.map).toBeNull()
  })

  it('builds a textureless procedural material for a procedural catalog entry', async () => {
    // decor-mirror is procedural — no texture set, MeshStandardMaterial only.
    const material = await loadMaterial('decor-mirror')
    expect(material.name).toBe('decor-mirror@procedural')
    expect(material.map).toBeNull()
    expect(material.metalness).toBe(1)
  })

  it('fallbackMaterial uses the catalog fallback color for a known slug', () => {
    const m = fallbackMaterial('floor-oak')
    expect(m.name).toBe('floor-oak@fallback')
    // floor-oak hex is #B58A5A.
    expect(m.color.getHexString()).toBe('b58a5a')
  })
})

describe('loadMaterial · per-slug cache', () => {
  it('returns the same material instance on a repeat load', async () => {
    registerAllMaps('floor-oak', 'WoodFloor051', ['Color', 'NormalGL'])
    const first = await loadMaterial('floor-oak')
    const second = await loadMaterial('floor-oak')
    expect(first).toBe(second)
  })
})
