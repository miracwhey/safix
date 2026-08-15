/**
 * Ü-01 · Card-Thumbnail wrapping `SpatialQuickCard` with viewport-gated mount.
 *
 * The Spatial Hub and the Pre-Sales list render dozens of cards above the
 * fold; mounting Google `<model-viewer>` for each one upfront would cost a
 * fresh WebGL context and a signed-URL round-trip per card. This component
 * defers both until the surrounding card actually scrolls into view, then
 * resolves the scan's USDZ / glTF storage paths and mounts the quick-card.
 *
 * Returns `null` (no fallback icon) when the scan has neither USDZ nor glTF
 * — the caller renders its own placeholder so the thumbnail slot never
 * collapses to an empty box.
 */

import { useMemo, type ReactElement } from 'react'
import { useScanConvertStatus } from '../../hooks/useScanConvertStatus'
import { useScanAssetUrl } from '../../hooks/useScanAssetUrl'
import { useInViewportOnce } from '../../hooks/useInViewportOnce'
import { SpatialQuickCard } from './SpatialQuickCard'

export interface SpatialThumbnailProps {
  /** Source scan whose assets back the thumbnail. */
  scanId: string | null
  /** Tailwind size class applied to both the wrapper + the SpatialQuickCard. */
  className?: string
  /** Optional fallback rendered when no scan / no asset exists. */
  fallback?: ReactElement | null
  /** Forwarded to the underlying `<model-viewer>` for accessibility tools. */
  alt?: string
}

export function SpatialThumbnail({
  scanId,
  className,
  fallback = null,
  alt,
}: SpatialThumbnailProps) {
  const { ref, visible } = useInViewportOnce<HTMLDivElement>()
  // Hooks must run unconditionally — pass null while invisible so neither the
  // scan_assets list query nor the signed-URL resolver fires before the card
  // enters the viewport.
  const liveScanId = visible ? scanId : null
  const { assets } = useScanConvertStatus(liveScanId)
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
