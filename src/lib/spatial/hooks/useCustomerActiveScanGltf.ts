/**
 * Spatial · V1.6 Phase 1b · useCustomerActiveScanGltf
 *
 * Resolves the signed glTF URL (plus optional USDZ storage path for the AR
 * Quick Look CTA) for the customer hub's currently active scan. Wraps two
 * lower-level pieces:
 *
 *   1. `spatialRepository.listScanAssets(scanId)` — pulls the rows the
 *      Customer-RLS lets through (HW-shared + Self-Scan).
 *   2. `resolveScanAssetUrl(storagePath)` — signs the glb path against the
 *      module-scoped TTL cache (shares the round-trip with
 *      `<SpatialViewer>`'s legacy callers).
 *
 * Race-safety: every `scanId` change cancels the prior load via `alive` so a
 * fast picker swap doesn't paint stale signed URLs into the viewer.
 *
 * Hydration discipline: `isHydrated` is reset to `false` on every scanId
 * change and only flips back to `true` once the load settles (success,
 * error, or empty-scan branch). Callers can mount a loading skeleton
 * inside the hub background without flickering.
 *
 * Direct import path (not via spatial workflow barrel) — see
 * `feedback_spatial_barrel_no_session_imports`.
 */

import { useEffect, useState } from 'react'

import { getSpatialRepository } from '../repository/registry'
import { resolveScanAssetUrl } from '../../../hooks/useScanAssetUrl'

export interface UseCustomerActiveScanGltfResult {
  /** Signed URL for the glb asset, or `null` while loading / when missing. */
  gltfUrl: string | null
  /** Storage path of the USDZ companion, surfaced for AR Quick Look CTAs. */
  usdzPath: string | null
  /** Flips true on the first settle so callers can guard against flicker. */
  isHydrated: boolean
  /** Error message from listing or signing; `null` while loading. */
  error: string | null
}

export function useCustomerActiveScanGltf(
  scanId: string | null,
): UseCustomerActiveScanGltfResult {
  const [gltfUrl, setGltfUrl] = useState<string | null>(null)
  const [usdzPath, setUsdzPath] = useState<string | null>(null)
  const [isHydrated, setIsHydrated] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      // `await Promise.resolve()` upfront pushes the loading-reset off the
      // synchronous render path (react-hooks/set-state-in-effect) so all
      // setState calls happen post-tick — both the reset and the resolve.
      await Promise.resolve()
      if (!alive) return
      setIsHydrated(false)
      setError(null)
      if (!scanId) {
        setGltfUrl(null)
        setUsdzPath(null)
        setIsHydrated(true)
        return
      }
      try {
        const repo = getSpatialRepository()
        const assets = await repo.listScanAssets(scanId)
        if (!alive) return
        const glb = assets.find(a => a.kind === 'gltf') ?? null
        const usdz = assets.find(a => a.kind === 'usdz') ?? null
        setUsdzPath(usdz?.storagePath ?? null)
        if (!glb) {
          // Scan is captured but glb conversion still pending — render the
          // gradient placeholder, not an error state.
          setGltfUrl(null)
          setIsHydrated(true)
          return
        }
        const url = await resolveScanAssetUrl(glb.storagePath)
        if (!alive) return
        setGltfUrl(url)
        setIsHydrated(true)
      } catch (err) {
        if (!alive) return
        setError(err instanceof Error ? err.message : String(err))
        setGltfUrl(null)
        setIsHydrated(true)
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [scanId])

  return { gltfUrl, usdzPath, isHydrated, error }
}
