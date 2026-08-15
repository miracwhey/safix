/**
 * Pre-Sales card thumbnail (Ü-01) — resolves a `presalesProjectId` to the
 * latest scan and renders the `SpatialQuickCard` once the card scrolls into
 * view. A single `useInViewportOnce` ref gates BOTH async steps (scan-id
 * lookup AND signed-URL fetch) so a Pre-Sales list with dozens of cards
 * fires zero network requests until the user actually scrolls them in.
 */

import { useMemo, type ReactElement } from 'react'
import { useScanConvertStatus } from '../../hooks/useScanConvertStatus'
import { useScanAssetUrl } from '../../hooks/useScanAssetUrl'
import { useInViewportOnce } from '../../hooks/useInViewportOnce'
import { useLatestScanIdForPresalesProject } from '../../hooks/useLatestScanIdForPresalesProject'
import { SpatialQuickCard } from './SpatialQuickCard'

export interface PresalesProjectThumbnailProps {
  presalesProjectId: string | null
  className?: string
  fallback?: ReactElement | null
  alt?: string
}

export function PresalesProjectThumbnail({
  presalesProjectId,
  className,
  fallback = null,
  alt,
}: PresalesProjectThumbnailProps) {
  const { ref, visible } = useInViewportOnce<HTMLDivElement>()
  // Hooks must run unconditionally — feeding `null` while off-screen keeps
  // their internal effects in the no-op branch.
  const liveProjectId = visible ? presalesProjectId : null
  const { scanId } = useLatestScanIdForPresalesProject(liveProjectId)
  const { assets } = useScanConvertStatus(scanId)
  const usdzPath = useMemo(
    () => assets.find((a) => a.kind === 'usdz')?.storagePath ?? null,
    [assets],
  )
  const gltfPath = useMemo(
    () => assets.find((a) => a.kind === 'gltf')?.storagePath ?? null,
    [assets],
  )
  const { url: usdzUrl } = useScanAssetUrl(usdzPath)
  const { url: gltfUrl } = useScanAssetUrl(gltfPath)

  const hasAsset = visible && (usdzUrl || gltfUrl)

  return (
    <div ref={ref} className={className}>
      {hasAsset ? (
        <SpatialQuickCard
          gltfUrl={gltfUrl ?? undefined}
          usdzUrl={usdzUrl ?? undefined}
          alt={alt}
          className="h-full w-full"
        />
      ) : (
        fallback
      )}
    </div>
  )
}
