/**
 * Spatial Core · Block E2 · Signed-URL Resolver for `scan_assets`
 *
 * Hydration-aware wrapper around `supabase.storage.createSignedUrl()` for
 * objects in the `project-scans` bucket. Mirrors the shared signed-URL
 * caching contract already used by chat voice notes
 * (`resolveChatAttachmentUrl`) but scoped to a single hook for screens that
 * only need one URL at a time.
 *
 * The cache is intentionally module-scoped so two callers asking for the
 * same `(scanId, kind)` pair share a single Storage round-trip — important
 * when `<SpatialViewer>` (glb) and `<SpatialQuickCard>` (usdz) sit on the
 * same screen.
 */

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const BUCKET = 'project-scans'
const URL_TTL_SEC = 60 * 60
const REFRESH_MARGIN_MS = 60 * 1000

interface CachedUrl {
  url: string
  expiresAt: number
}

const cache = new Map<string, CachedUrl>()

export interface UseScanAssetUrlReturn {
  url: string | null
  isHydrated: boolean
  error: Error | null
  /** Drops the cached URL for this path and re-signs from Storage. Use after
   *  a 401/403 hitting the model fetch — long-lived screens can outlive the
   *  1h signed-URL TTL. */
  refresh: () => void
}

export function useScanAssetUrl(storagePath: string | null): UseScanAssetUrlReturn {
  const [url, setUrl] = useState<string | null>(null)
  const [isHydrated, setIsHydrated] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => {
    if (storagePath) {
      const key = `${BUCKET}|${storagePath}`
      cache.delete(key)
    }
    setTick(t => t + 1)
  }, [storagePath])

  useEffect(() => {
    let alive = true
    const load = async () => {
      if (!storagePath) {
        if (alive) {
          setUrl(null)
          setError(null)
          setIsHydrated(true)
        }
        return
      }
      try {
        const fresh = await resolveScanAssetUrl(storagePath)
        if (!alive) return
        setUrl(fresh)
        setError(null)
      } catch (err) {
        if (!alive) return
        setError(err instanceof Error ? err : new Error(String(err)))
        setUrl(null)
      } finally {
        if (alive) setIsHydrated(true)
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [storagePath, tick])

  return { url, isHydrated, error, refresh }
}

/** Direct resolver — exposed so non-hook call sites (PDF export, share) can
 *  hit the same cache. */
export async function resolveScanAssetUrl(storagePath: string): Promise<string> {
  const key = `${BUCKET}|${storagePath}`
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expiresAt > now + REFRESH_MARGIN_MS) {
    return hit.url
  }
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, URL_TTL_SEC)
  if (error || !data?.signedUrl) {
    throw new Error(error?.message ?? 'failed to sign scan asset url')
  }
  cache.set(key, {
    url: data.signedUrl,
    expiresAt: now + URL_TTL_SEC * 1000,
  })
  return data.signedUrl
}

export function __resetScanAssetUrlCacheForTests(): void {
  cache.clear()
}
