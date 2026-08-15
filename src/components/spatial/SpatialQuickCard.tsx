/**
 * Spatial Core · Block E2 · `<model-viewer>` Quick-Card
 *
 * Lightweight USDZ + glb preview for list / card surfaces (D4: customer
 * job-card, provider scan-overview, dispute timeline). Uses Google's
 * `<model-viewer>` web-component because:
 *
 *   * 12 KB extra weight after first card — three.js + r3f would inflate
 *     the list-bundle by ~300 KB and dwarf the actual photo grid.
 *   * USDZ + AR Quick Look on iOS Safari natively (no bridge code).
 *   * Reveal-controls + auto-rotate without us shipping camera logic.
 *
 * D4 caveat: KTX2 textures on mobile have a known regression in
 * `<model-viewer>` — we pass `disable-pan` + always use the USDZ asset
 * for the iOS-AR path, and only fall back to glb when usdz is absent.
 */

import { lazy, Suspense } from 'react'

// Dynamic import isolates the model-viewer custom-element registration to
// users who actually open a card.
const ModelViewerInner = lazy(() => import('./SpatialQuickCardInner'))

export interface SpatialQuickCardProps {
  /** Glb URL — primary asset, supports auto-rotate orbit on every browser. */
  gltfUrl?: string
  /** USDZ URL — required for the iOS AR Quick Look "View in AR" CTA. */
  usdzUrl?: string
  alt?: string
  /** Tailwind size class — default keeps the card visually small. */
  className?: string
}

export function SpatialQuickCard(props: SpatialQuickCardProps) {
  return (
    <div
      className={
        'relative overflow-hidden rounded-lg bg-neutral-100 ' +
        (props.className ?? 'aspect-square w-full')
      }
    >
      <Suspense fallback={<QuickCardSkeleton />}>
        <ModelViewerInner {...props} />
      </Suspense>
    </div>
  )
}

function QuickCardSkeleton() {
  return (
    <div
      className="flex h-full w-full items-center justify-center"
      aria-busy="true"
    >
      <span className="text-xs text-neutral-500">3D</span>
    </div>
  )
}
