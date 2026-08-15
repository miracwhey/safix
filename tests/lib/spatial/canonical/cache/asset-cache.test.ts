/**
 * Tests for cache/asset-cache.ts (OQ-13 · shared refCount cache).
 *
 * Covers the Test-DoD from the findings addendum:
 *   - Mount viewer A + viewer B on the same URL → ONE loader run.
 *   - Unmount A → cache stays. Unmount B → cache disposed.
 * Plus the concurrency hardening over the naive skeleton: in-flight dedup,
 * release-while-loading, revival, and rejected-loader eviction.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
  acquireAsset,
  releaseAsset,
  getAssetCacheStats,
  isAssetCached,
  __resetAssetCache,
} from '../../../../../src/lib/spatial/canonical/cache/asset-cache.ts'

/** Deferred promise helper — lets a test control when a loader settles. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  __resetAssetCache()
})

describe('asset-cache · acquire / release', () => {
  it('runs the loader once for two viewers sharing a URL', async () => {
    const loader = vi.fn(() => Promise.resolve({ id: 'tex' }))
    const dispose = vi.fn()

    const a = await acquireAsset('url-1', loader, dispose)
    const b = await acquireAsset('url-1', loader, dispose)

    expect(loader).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(getAssetCacheStats()).toMatchObject({ entryCount: 1, totalRefs: 2 })
  })

  it('keeps the entry after the first unmount, disposes after the last', async () => {
    const resource = { id: 'tex' }
    const loader = () => Promise.resolve(resource)
    const dispose = vi.fn()

    await acquireAsset('url-1', loader, dispose)
    await acquireAsset('url-1', loader, dispose)

    releaseAsset('url-1') // viewer A unmounts
    expect(dispose).not.toHaveBeenCalled()
    expect(isAssetCached('url-1')).toBe(true)

    releaseAsset('url-1') // viewer B unmounts
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledWith(resource)
    expect(isAssetCached('url-1')).toBe(false)
  })

  it('dedups concurrent acquires before the loader settles', async () => {
    const d = deferred<{ id: string }>()
    const loader = vi.fn(() => d.promise)
    const dispose = vi.fn()

    const p1 = acquireAsset('url-1', loader, dispose)
    const p2 = acquireAsset('url-1', loader, dispose)
    expect(loader).toHaveBeenCalledTimes(1)

    d.resolve({ id: 'tex' })
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(r2)
    expect(getAssetCacheStats().totalRefs).toBe(2)
  })

  it('disposes once the loader settles if released while in flight', async () => {
    const d = deferred<{ id: string }>()
    const dispose = vi.fn()

    const p = acquireAsset('url-1', () => d.promise, dispose)
    releaseAsset('url-1') // released before load completes
    expect(dispose).not.toHaveBeenCalled()

    d.resolve({ id: 'tex' })
    await p
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(isAssetCached('url-1')).toBe(false)
  })

  it('revives an entry acquired again before its in-flight loader settles', async () => {
    const d = deferred<{ id: string }>()
    const dispose = vi.fn()

    const p1 = acquireAsset('url-1', () => d.promise, dispose)
    releaseAsset('url-1') // count → 0, teardown pending
    const p2 = acquireAsset('url-1', () => d.promise, dispose) // revive

    d.resolve({ id: 'tex' })
    await Promise.all([p1, p2])

    expect(dispose).not.toHaveBeenCalled()
    expect(isAssetCached('url-1')).toBe(true)
    expect(getAssetCacheStats().totalRefs).toBe(1)
  })

  it('evicts the entry when the loader rejects so the next acquire retries', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('network')))
    const dispose = vi.fn()

    await expect(acquireAsset('url-1', failing, dispose)).rejects.toThrow('network')
    expect(isAssetCached('url-1')).toBe(false)

    const ok = vi.fn(() => Promise.resolve({ id: 'tex' }))
    await acquireAsset('url-1', ok, dispose)
    expect(ok).toHaveBeenCalledTimes(1)
    expect(isAssetCached('url-1')).toBe(true)
  })

  it('treats releaseAsset on an unknown URL as a no-op', () => {
    expect(() => releaseAsset('never-acquired')).not.toThrow()
    expect(getAssetCacheStats().entryCount).toBe(0)
  })

  it('does not let the ref count go negative on over-release', async () => {
    const dispose = vi.fn()
    await acquireAsset('url-1', () => Promise.resolve({ id: 'tex' }), dispose)
    releaseAsset('url-1')
    releaseAsset('url-1') // stray extra release
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(getAssetCacheStats().entryCount).toBe(0)
  })
})
