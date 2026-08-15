/**
 * Spatial · Canonical · Cache · Shared Asset Cache (OQ-13)
 *
 * Module-scope, reference-counted cache for heavy GPU resources — GLB asset
 * meshes, KTX2 material textures and HDRI environment maps — shared across
 * every viewer instance that mounts in the same JS context.
 *
 * Why shared + refCount (OQ-13 decision · `spatial-v1-day-1-17-hard-review-findings.md`):
 *   - The legacy `SpatialViewer` and the canonical `CanonicalSceneRoot` can be
 *     mounted at the same time (Hub thumbnail + open detail-sheet). Loading the
 *     same 8 MB texture twice wastes GPU memory; an HDRI EXR (~10-25 MB) makes
 *     the waste worse.
 *   - three.js disposal needs active ref-tracking: without it a shared cache
 *     produces dispose-races — viewer A unmounts and disposes a texture that
 *     viewer B is still rendering, leaving B with a black mesh.
 *
 * Lifetime contract (binding · strict refCount):
 *   - `acquireAsset` resolves the resource and increments the ref count.
 *   - `releaseAsset` decrements; the resource is disposed and evicted the
 *     instant the count reaches zero. There is no warm-after-last-release
 *     cache — that is a deliberate Phase-2 deferral (LRU eviction) so V1 keeps
 *     GPU memory bounded by what is actually on screen.
 *
 * Concurrency:
 *   - Concurrent `acquireAsset` calls for the same URL share ONE in-flight
 *     loader promise (the naive findings skeleton re-fetched here — fixed).
 *   - A `releaseAsset` that drops the count to zero while the loader is still
 *     in flight defers disposal until the resource exists; a later
 *     `acquireAsset` before the loader settles revives the entry.
 *   - A rejected loader evicts the entry so the next `acquireAsset` retries.
 *
 * This module is part of the L1 pure-logic foundation: it has zero three.js,
 * React or DOM imports. Callers inject the concrete `loader` / `dispose`
 * closures, keeping the cache renderer-agnostic and unit-testable.
 */

/**
 * Internal cache record. `dispose` is only meaningful once `loaded` is true;
 * before that, `pendingDispose` records that the entry should be torn down as
 * soon as the loader settles.
 */
interface CacheEntry {
  /** Shared in-flight (then settled) loader promise — dedups concurrent acquires. */
  readonly promise: Promise<unknown>
  /** Live reference count. The entry is evicted when this reaches zero. */
  refs: number
  /** True once the loader resolved and `dispose` is callable. */
  loaded: boolean
  /** Set when the count hit zero before the loader settled. */
  pendingDispose: boolean
  /** Bound teardown — `() => dispose(resource)`. No-op until `loaded`. */
  dispose: () => void
}

const assetCache = new Map<string, CacheEntry>()

/**
 * Acquire a shared asset by URL, incrementing its reference count.
 *
 * The first caller for a URL runs `loader()`; concurrent and subsequent
 * callers share the same promise. `dispose` is invoked exactly once, when the
 * last holder calls {@link releaseAsset}.
 *
 * Every successful `acquireAsset` MUST be paired with exactly one
 * `releaseAsset(url)` — typically in a React effect cleanup.
 *
 * @param url     Stable cache key (the resource URL).
 * @param loader  Produces the resource. Run at most once per cache lifetime.
 * @param dispose Frees the resource (e.g. `texture.dispose()`).
 */
export function acquireAsset<T>(
  url: string,
  loader: () => Promise<T>,
  dispose: (resource: T) => void,
): Promise<T> {
  const existing = assetCache.get(url)
  if (existing) {
    existing.refs++
    // A release may have scheduled teardown while the loader was in flight;
    // a fresh acquire cancels it — the resource is wanted again.
    existing.pendingDispose = false
    return existing.promise as Promise<T>
  }

  const promise = loader().then(
    (resource) => {
      const entry = assetCache.get(url)
      // Entry can only be missing if it was already disposed+evicted, which
      // cannot happen before `loaded` flips — defensive guard regardless.
      if (entry) {
        entry.loaded = true
        entry.dispose = () => dispose(resource)
        if (entry.refs <= 0 || entry.pendingDispose) {
          entry.dispose()
          assetCache.delete(url)
        }
      }
      return resource
    },
    (error: unknown) => {
      // Failed load: evict so the next acquire retries with a clean slate.
      assetCache.delete(url)
      throw error
    },
  )

  assetCache.set(url, {
    promise,
    refs: 1,
    loaded: false,
    pendingDispose: false,
    dispose: () => {},
  })

  return promise as Promise<T>
}

/**
 * Release one reference to a shared asset.
 *
 * When the reference count reaches zero the resource is disposed and evicted.
 * If the loader is still in flight the teardown is deferred until it settles
 * (or cancelled if a new {@link acquireAsset} arrives first).
 *
 * Safe to call with an unknown URL (no-op) — simplifies effect cleanups that
 * run after a failed load already evicted the entry.
 */
export function releaseAsset(url: string): void {
  const entry = assetCache.get(url)
  if (!entry) return

  entry.refs--
  if (entry.refs > 0) return

  if (entry.loaded) {
    entry.dispose()
    assetCache.delete(url)
  } else {
    // Loader still running — dispose the moment it resolves.
    entry.pendingDispose = true
  }
}

/**
 * Inspect cache state. Intended for telemetry (`catalog cache-hit` metric in
 * Mockup 42 §8) and for test assertions — not part of the render path.
 */
export function getAssetCacheStats(): {
  entryCount: number
  totalRefs: number
  urls: string[]
} {
  let totalRefs = 0
  // A live entry always has refs ≥ 1 — it is evicted the instant refs hits 0,
  // so no clamp is needed.
  for (const entry of assetCache.values()) totalRefs += entry.refs
  return {
    entryCount: assetCache.size,
    totalRefs,
    urls: [...assetCache.keys()],
  }
}

/**
 * Whether a URL currently has a live cache entry (loaded or in flight).
 */
export function isAssetCached(url: string): boolean {
  return assetCache.has(url)
}

/**
 * Force-dispose and clear the entire cache. Test-only escape hatch — calling
 * this while viewers are mounted would black-out their meshes.
 */
export function __resetAssetCache(): void {
  for (const entry of assetCache.values()) {
    if (entry.loaded) entry.dispose()
  }
  assetCache.clear()
}
