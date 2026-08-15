/**
 * Spatial · Canonical · Loaders · GLB Object Loader (Phase 1.5 · Block R4)
 *
 * The canonical GLB-loading path for `ObjectAdapter`. Block R2 stubbed the
 * `geometryKind === 'glb'` branch with a dimensioned `buildGenericBox`; R4
 * wires the real model behind the shared, reference-counted `asset-cache`.
 *
 * Responsibilities:
 *   - resolve a `CatalogAsset` to its runtime GLB URL,
 *   - load the GLB through `MeshoptGLTFLoader` (Meshopt + KTX2 decoders),
 *   - go through `asset-cache.acquireAsset` / `releaseAsset` so the same
 *     model fetched by two viewers (Hub thumbnail + open detail-sheet) is
 *     decoded once and disposed exactly when the last holder unmounts,
 *   - expose a tiny Suspense-compatible resource reader so `ObjectAdapter`
 *     can render the generic-box placeholder as the Suspense fallback while
 *     the binary is in flight, and the `ObjectErrorBoundary` fallback when
 *     the GLB is missing / corrupt.
 *
 * GPU lifetime: the `asset-cache` `dispose` closure walks the cached `Group`
 * and frees every geometry + material + texture once the ref count hits zero.
 * Each `ObjectAdapter` instance renders a **clone** of the cached scene so a
 * per-instance transform never mutates the shared template; clones share the
 * cached `BufferGeometry` / `Material` references and must NOT be disposed by
 * the adapter — the cache owns the originals.
 *
 * Reference model — exactly one cache reference per URL is held while at
 * least one adapter is reading it:
 *   - `retainGlb(url)` from an adapter mount effect: first retainer triggers
 *     `acquireAsset`; later retainers just bump a local counter.
 *   - `releaseGlb(url)` from the matching cleanup: last release triggers
 *     `releaseAsset`, which disposes the GPU resources.
 * This keeps the Suspense resource record and the `asset-cache` entry in
 * lock-step, so a model is decoded once and evicted the instant the last
 * `<GltfObject>` for it unmounts.
 *
 * This module needs a live `WebGLRenderer` (the KTX2 transcoder binds to it),
 * so unlike `asset-cache` it is an L3 renderer-adapter file, not L1.
 */

import { Group, type Material, type Mesh, type Object3D, type WebGLRenderer } from 'three'

import { acquireAsset, releaseAsset } from '../../../../../lib/spatial/canonical/cache/asset-cache.ts'
import { resolveSpatialAssetUrl } from '../../../../../lib/spatial/canonical/assets/assetBaseUrl.ts'
import type { CatalogAsset } from '../../../../../lib/spatial/canonical/catalog/types.ts'
import { makeSpatialGltfLoader } from '../../loaders/MeshoptGLTFLoader.ts'

/**
 * Runtime URL of a catalog asset's LOD0 GLB.
 *
 * The catalog stores `gltfStoragePath` as a Storage-relative path
 * (`spatial-assets/models/<slug>.glb`). At runtime the `public/` folder is
 * served at the web root, so the binary is reachable at `/<path>`. A leading
 * slash is normalised in case the path already carries one.
 *
 * Returns `null` when the asset is procedural (no GLB) — the caller then
 * keeps the procedural / generic-box path.
 */
export function resolveGlbUrl(asset: CatalogAsset): string | null {
  if (asset.geometryKind !== 'glb' || !asset.gltfStoragePath) return null
  return resolveSpatialAssetUrl(asset.gltfStoragePath)
}

/** A loaded GLB template — the shared scene graph held by the cache. */
export interface LoadedGlb {
  /** The decoded scene graph. Adapters render a `.clone()` of this. */
  scene: Group
}

/**
 * Walk a GLB scene graph and dispose every GPU-backed resource.
 *
 * three.js never GCs GPU memory via the JS heap — geometries, materials and
 * every attached texture slot must be released explicitly. Mirrors the
 * `disposeSceneGraph` walk in the legacy `Scene.tsx` so a GLB freed here
 * leaves no orphaned VRAM after the last viewer unmounts.
 */
function disposeGlb(loaded: LoadedGlb): void {
  const seenTextures = new WeakSet<object>()
  const disposeTexture = (tex: unknown): void => {
    if (!tex || typeof tex !== 'object' || seenTextures.has(tex as object)) return
    seenTextures.add(tex as object)
    const fn = (tex as { dispose?: () => void }).dispose
    if (typeof fn === 'function') fn.call(tex)
  }
  const disposeMaterial = (mat: Material): void => {
    const record = mat as unknown as Record<string, unknown>
    // Every standard glTF + KTX2 texture slot.
    const slots = [
      'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
      'emissiveMap', 'bumpMap', 'displacementMap', 'alphaMap', 'lightMap',
      'envMap', 'specularMap', 'clearcoatMap', 'clearcoatNormalMap',
      'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap',
      'transmissionMap', 'thicknessMap', 'iridescenceMap',
      'iridescenceThicknessMap', 'anisotropyMap',
    ]
    for (const slot of slots) disposeTexture(record[slot])
    mat.dispose?.()
  }
  loaded.scene.traverse((obj: Object3D) => {
    const mesh = obj as Mesh
    if (!mesh.isMesh) return
    mesh.geometry?.dispose?.()
    const material = mesh.material as Material | Material[] | undefined
    if (Array.isArray(material)) material.forEach(disposeMaterial)
    else if (material) disposeMaterial(material)
  })
}

/**
 * Internal Suspense resource record. One per URL, shared by every
 * `<GltfObject>` reading that model.
 *
 *   - `status` drives the synchronous Suspense read.
 *   - `retainers` is the live adapter count — the cache reference is held
 *     while this is > 0 and released the instant it reaches 0.
 */
interface GlbResource {
  status: 'pending' | 'success' | 'error'
  promise: Promise<void>
  value?: LoadedGlb
  error?: unknown
  retainers: number
}

const glbResources = new Map<string, GlbResource>()

/**
 * Acquire — or revive — the Suspense resource for a GLB URL, incrementing its
 * retainer count. Call from an `ObjectAdapter` mount effect; pair with exactly
 * one {@link releaseGlb}.
 *
 * The first retainer kicks off `asset-cache.acquireAsset`, which runs the
 * `MeshoptGLTFLoader`. Concurrent retainers share the in-flight promise.
 */
export function retainGlb(url: string, renderer: WebGLRenderer): void {
  const existing = glbResources.get(url)
  if (existing) {
    existing.retainers++
    return
  }
  const record: GlbResource = {
    status: 'pending',
    promise: Promise.resolve(),
    retainers: 1,
  }
  record.promise = acquireAsset<LoadedGlb>(
    url,
    async () => {
      const loader = makeSpatialGltfLoader(renderer)
      const gltf = await loader.loadAsync(url)
      const scene = gltf.scene as Group
      // Defensive: a GLB that decoded but carries no scene graph is treated
      // as a load failure so the ErrorBoundary path renders the placeholder.
      if (!scene) throw new Error(`[spatial] GLB ${url} decoded without a scene`)
      return { scene }
    },
    disposeGlb,
  ).then(
    (value) => {
      // A release that dropped retainers to 0 while the loader was in flight
      // already called releaseAsset — do not adopt a value nobody wants.
      if (record.retainers <= 0) return
      record.status = 'success'
      record.value = value
    },
    (error: unknown) => {
      record.status = 'error'
      record.error = error
      // Drop the failed record so a remount retries the fetch instead of
      // re-throwing a stale error forever. The cache already evicted on
      // rejection, so no releaseAsset is owed here.
      glbResources.delete(url)
    },
  )
  glbResources.set(url, record)
}

/**
 * Release one retainer of a GLB URL. The last release evicts the Suspense
 * record and calls `asset-cache.releaseAsset`, disposing the GPU resources.
 *
 * Safe to call for an unknown URL (no-op) — a failed load already removed the
 * record, so a cleanup effect running afterwards is harmless.
 */
export function releaseGlb(url: string): void {
  const record = glbResources.get(url)
  if (!record) {
    // The record was already dropped by a failed load; the cache evicted
    // itself on rejection, so there is nothing left to release.
    return
  }
  record.retainers--
  if (record.retainers > 0) return
  glbResources.delete(url)
  // Matches the acquireAsset issued by the first retainer. If the loader is
  // still in flight, the cache defers disposal until it settles.
  releaseAsset(url)
}

/**
 * Suspense resource read.
 *
 * `ObjectAdapter` cannot `await` inside render, so the GLB load is exposed as
 * a synchronous read that either returns the resource, throws the in-flight
 * promise (Suspense shows the generic-box fallback), or throws the load error
 * (the `ObjectErrorBoundary` shows the generic-box fallback).
 *
 * The caller MUST have an active retainer for `url` (via {@link retainGlb})
 * before reading — the read does not itself retain.
 */
export function readGlb(url: string): LoadedGlb {
  const resource = glbResources.get(url)
  if (!resource) {
    // No retainer ran yet (or the load failed and was evicted). Surface a
    // synchronous error so the ErrorBoundary renders the placeholder rather
    // than the component hanging on a never-resolving Suspense throw.
    throw new Error(`[spatial] readGlb(${url}) called without an active retainer`)
  }
  if (resource.status === 'success' && resource.value) return resource.value
  if (resource.status === 'error') throw resource.error
  throw resource.promise
}

/** Whether a GLB URL currently has a live Suspense resource record. */
export function hasGlbResource(url: string): boolean {
  return glbResources.has(url)
}

/**
 * Test-only — drop every cached Suspense record. Production code never calls
 * this; the retainer count is what bounds GPU memory at runtime.
 */
export function __resetGlbResources(): void {
  glbResources.clear()
}
