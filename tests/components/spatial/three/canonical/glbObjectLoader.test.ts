/**
 * Tests for the Block R4 GLB loader path — `glbObjectLoader.ts`.
 *
 * Covers what `ObjectAdapter`'s `geometryKind === 'glb'` branch relies on:
 *   - the catalog `gltfStoragePath` → runtime URL mapping,
 *   - the Suspense contract: `readGlb` throws the in-flight promise while
 *     loading (→ generic-box fallback), returns the scene once resolved,
 *   - the error contract: a missing / corrupt GLB throws the error so the
 *     `ObjectErrorBoundary` renders the generic box,
 *   - the shared `asset-cache`: a model fetched by two adapters is decoded
 *     once and disposed only after the last release.
 *
 * The `MeshoptGLTFLoader` module is mocked — no real binary loading. A live
 * `WebGLRenderer` is likewise faked: the loader factory never touches it in
 * the mock, so a plain object stand-in is sufficient.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Group } from 'three'

import type { CatalogAsset } from '../../../../../src/lib/spatial/canonical/catalog/types.ts'
import { __resetAssetCache, getAssetCacheStats } from '../../../../../src/lib/spatial/canonical/cache/asset-cache.ts'

// ── Mock the GLTF loader factory — controllable per test ─────────────────────
const loadAsyncMock = vi.fn()
vi.mock('../../../../../src/components/spatial/three/loaders/MeshoptGLTFLoader.ts', () => ({
  makeSpatialGltfLoader: () => ({ loadAsync: loadAsyncMock }),
}))

import {
  resolveGlbUrl,
  retainGlb,
  releaseGlb,
  readGlb,
  hasGlbResource,
  __resetGlbResources,
} from '../../../../../src/components/spatial/three/canonical/loaders/glbObjectLoader.ts'

/** A fake WebGLRenderer — the mocked loader factory ignores it. */
const fakeRenderer = {} as never

/** Build a minimal catalog asset for URL-resolution tests. */
function asset(overrides: Partial<CatalogAsset>): CatalogAsset {
  return {
    slug: 'furn-sofa-3seater-fabric-grey',
    displayName: 'Sofa',
    category: 'furniture',
    objectCategory: 'sofa',
    geometryKind: 'glb',
    gltfStoragePath: 'spatial-assets/models/furn-sofa-3seater-fabric-grey.glb',
    thumbnailStoragePath: null,
    dimensions: { width_m: 2.1, depth_m: 0.92, height_m: 0.85 },
    pivot: 'bottom_center',
    snapRule: { target_host: 'floor', align_to_normal: false },
    polycountLod0: 12000,
    lodLevels: null,
    license: 'CC0-1.0',
    attribution: null,
    vendor: 'polyhaven',
    published: true,
    tags: [],
    ...overrides,
  }
}

/** Microtask flush so a settled loader promise propagates into the record. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

beforeEach(() => {
  __resetGlbResources()
  __resetAssetCache()
  loadAsyncMock.mockReset()
})

afterEach(() => {
  __resetGlbResources()
  __resetAssetCache()
})

describe('resolveGlbUrl', () => {
  it('maps a GLB catalog asset to its public /spatial-assets URL', () => {
    expect(resolveGlbUrl(asset({}))).toBe(
      '/spatial-assets/models/furn-sofa-3seater-fabric-grey.glb',
    )
  })

  it('normalises a leading slash on the storage path', () => {
    expect(resolveGlbUrl(asset({ gltfStoragePath: '/spatial-assets/models/x.glb' }))).toBe(
      '/spatial-assets/models/x.glb',
    )
  })

  it('returns null for a procedural asset (no GLB)', () => {
    expect(resolveGlbUrl(asset({ geometryKind: 'procedural', gltfStoragePath: null }))).toBeNull()
  })

  it('returns null for a glb asset with a null storage path', () => {
    expect(resolveGlbUrl(asset({ gltfStoragePath: null }))).toBeNull()
  })
})

describe('readGlb · Suspense contract', () => {
  it('throws the in-flight promise while the GLB is loading', () => {
    let resolveLoad!: (v: unknown) => void
    loadAsyncMock.mockReturnValue(new Promise((res) => { resolveLoad = res }))

    retainGlb('/m/a.glb', fakeRenderer)
    let thrown: unknown
    try {
      readGlb('/m/a.glb')
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Promise)
    resolveLoad({ scene: new Group() })
  })

  it('returns the loaded scene once the GLB resolves', async () => {
    const scene = new Group()
    loadAsyncMock.mockResolvedValue({ scene })

    retainGlb('/m/b.glb', fakeRenderer)
    await flush()

    const loaded = readGlb('/m/b.glb')
    expect(loaded.scene).toBe(scene)
  })
})

describe('readGlb · error contract', () => {
  it('throws the load error when the GLB is missing / fails to decode', async () => {
    loadAsyncMock.mockRejectedValue(new Error('404 model not found'))

    retainGlb('/m/missing.glb', fakeRenderer)
    await flush()

    // A failed load drops the record so a remount retries — readGlb then
    // surfaces a synchronous error which the ObjectErrorBoundary catches.
    expect(() => readGlb('/m/missing.glb')).toThrow()
    expect(hasGlbResource('/m/missing.glb')).toBe(false)
  })

  it('treats a GLB that decodes without a scene as a load failure', async () => {
    loadAsyncMock.mockResolvedValue({ scene: undefined })

    retainGlb('/m/no-scene.glb', fakeRenderer)
    await flush()

    expect(() => readGlb('/m/no-scene.glb')).toThrow()
  })

  it('throws when readGlb is called with no active retainer', () => {
    expect(() => readGlb('/m/never-retained.glb')).toThrow(/without an active retainer/)
  })
})

describe('retain / release · shared asset-cache', () => {
  it('decodes the model once for two adapters sharing a URL', async () => {
    loadAsyncMock.mockResolvedValue({ scene: new Group() })

    retainGlb('/m/shared.glb', fakeRenderer)
    retainGlb('/m/shared.glb', fakeRenderer)
    await flush()

    expect(loadAsyncMock).toHaveBeenCalledTimes(1)
    expect(getAssetCacheStats().entryCount).toBe(1)
  })

  it('keeps the cache entry after the first release, disposes after the last', async () => {
    loadAsyncMock.mockResolvedValue({ scene: new Group() })

    retainGlb('/m/two.glb', fakeRenderer)
    retainGlb('/m/two.glb', fakeRenderer)
    await flush()

    releaseGlb('/m/two.glb')
    expect(getAssetCacheStats().entryCount).toBe(1)
    expect(hasGlbResource('/m/two.glb')).toBe(true)

    releaseGlb('/m/two.glb')
    expect(getAssetCacheStats().entryCount).toBe(0)
    expect(hasGlbResource('/m/two.glb')).toBe(false)
  })

  it('disposes the loaded GLB geometry + materials on the final release', async () => {
    const geometryDispose = vi.fn()
    const materialDispose = vi.fn()
    const scene = new Group()
    const mesh = {
      isMesh: true,
      geometry: { dispose: geometryDispose },
      material: { dispose: materialDispose },
    }
    // Stub traverse so the dispose walk visits our fake mesh.
    scene.traverse = ((cb: (o: unknown) => void) => {
      cb(scene)
      cb(mesh)
    }) as never
    loadAsyncMock.mockResolvedValue({ scene })

    retainGlb('/m/dispose.glb', fakeRenderer)
    await flush()
    readGlb('/m/dispose.glb')
    releaseGlb('/m/dispose.glb')

    expect(geometryDispose).toHaveBeenCalledTimes(1)
    expect(materialDispose).toHaveBeenCalledTimes(1)
  })

  it('release is a no-op for an unknown URL', () => {
    expect(() => releaseGlb('/m/never.glb')).not.toThrow()
  })

  it('a failed load evicts the cache entry so a retry starts clean', async () => {
    loadAsyncMock.mockRejectedValueOnce(new Error('transient'))
    retainGlb('/m/retry.glb', fakeRenderer)
    await flush()
    expect(getAssetCacheStats().entryCount).toBe(0)

    // Second attempt — fresh record, loader runs again.
    loadAsyncMock.mockResolvedValue({ scene: new Group() })
    retainGlb('/m/retry.glb', fakeRenderer)
    await flush()
    expect(loadAsyncMock).toHaveBeenCalledTimes(2)
    expect(readGlb('/m/retry.glb').scene).toBeInstanceOf(Group)
  })
})
