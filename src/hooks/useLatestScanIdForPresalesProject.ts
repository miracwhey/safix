/**
 * Resolve the most recent scan id rooted at a Pre-Sales project.
 *
 * Backs the Pre-Sales card thumbnails (Ü-01): the cards know their
 * `presalesProjectId` but not the scan that produced the captured assets, so
 * a separate fetch is required before the thumbnail can sign a USDZ / glTF
 * URL. The lookup runs on demand (per visible card) — `SpatialThumbnail`
 * passes `null` when the card is off-screen, so the underlying repo call
 * never fires for cards the user never scrolls into view.
 */

import { useEffect, useState } from 'react'
import { getSpatialRepository } from '../lib/spatial/repository/registry'

export function useLatestScanIdForPresalesProject(
  presalesProjectId: string | null,
): { scanId: string | null; isHydrated: boolean } {
  const [scanId, setScanId] = useState<string | null>(null)
  const [isHydrated, setIsHydrated] = useState(false)

  useEffect(() => {
    let alive = true
    if (!presalesProjectId) {
      setScanId(null)
      setIsHydrated(true)
      return
    }
    setIsHydrated(false)
    const load = async () => {
      try {
        const scans = await getSpatialRepository().listScansForPresalesProject(
          presalesProjectId,
        )
        if (!alive) return
        // Repos return newest-first; pick the head row.
        setScanId(scans[0]?.id ?? null)
      } catch {
        if (!alive) return
        setScanId(null)
      } finally {
        if (alive) setIsHydrated(true)
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [presalesProjectId])

  return { scanId, isHydrated }
}
