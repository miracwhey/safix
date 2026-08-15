/**
 * Media Private · Signed-URL Resolver for `media-private` bucket
 *
 * Hydration-aware wrapper around `supabase.storage.createSignedUrl()` for
 * objects in the `media-private` bucket. Mirrors the signed-URL caching
 * contract used by `useScanAssetUrl` (project-scans bucket) and
 * `resolveChatAttachmentUrl` (chat voice/attachments).
 *
 * Module-scoped cache keyed by `'media-private'|{path}` — two callers
 * resolving the same file_path share a single Storage round-trip, important
 * when the same evidence item is rendered in a list and a detail view
 * simultaneously.
 */

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../supabase'

export const MEDIA_PRIVATE_BUCKET = 'media-private'

const URL_TTL_SEC = 60 * 60
const REFRESH_MARGIN_MS = 60 * 1000

interface CachedUrl {
  url: string
  expiresAt: number
}

const cache = new Map<string, CachedUrl>()

export interface UseMediaPrivateUrlReturn {
  url: string | null
  isHydrated: boolean
  error: Error | null
  /** Drops the cached URL for this path and re-signs from Storage. Use after
   *  a 401/403 hitting the asset — long-lived screens can outlive the 1h
   *  signed-URL TTL. */
  refresh: () => void
}

export function useMediaPrivateUrl(filePath: string | null): UseMediaPrivateUrlReturn {
  const [url, setUrl] = useState<string | null>(null)
  const [isHydrated, setIsHydrated] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => {
    if (filePath) {
      const key = `${MEDIA_PRIVATE_BUCKET}|${filePath}`
      cache.delete(key)
    }
    setTick(t => t + 1)
  }, [filePath])

  useEffect(() => {
    let alive = true
    const load = async () => {
      if (!filePath) {
        if (alive) {
          setUrl(null)
          setError(null)
          setIsHydrated(true)
        }
        return
      }
      try {
        const fresh = await resolveMediaPrivateUrl(filePath)
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
  }, [filePath, tick])

  return { url, isHydrated, error, refresh }
}

/** Direct resolver — exposed so non-hook call sites (export, share) can
 *  hit the same cache without creating a React component. */
export async function resolveMediaPrivateUrl(filePath: string): Promise<string> {
  const key = `${MEDIA_PRIVATE_BUCKET}|${filePath}`
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expiresAt > now + REFRESH_MARGIN_MS) {
    return hit.url
  }
  const { data, error } = await supabase.storage
    .from(MEDIA_PRIVATE_BUCKET)
    .createSignedUrl(filePath, URL_TTL_SEC)
  if (error || !data?.signedUrl) {
    throw new Error(error?.message ?? 'failed to sign media private url')
  }
  cache.set(key, {
    url: data.signedUrl,
    expiresAt: now + URL_TTL_SEC * 1000,
  })
  return data.signedUrl
}

export function __resetMediaPrivateUrlCacheForTests(): void {
  cache.clear()
}
