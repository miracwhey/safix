/**
 * Spatial · Canonical · Cameras · ARCompareController (Day 16 stub)
 *
 * V1.x placeholder. The AR-compare mode pairs a captured camera pose
 * (from the iOS RealityKit session) with the canonical RoomScene so the
 * customer can hold their device up and see the proposed change overlaid
 * on the real space. Web build mounts an empty <group> + a banner.
 *
 * Day-16 build only ships the API contract + visual stub; the RealityKit
 * pose stream lands in V1.x via a dedicated CapacitorPlugin event.
 */

import type { ReactElement } from 'react'

export interface ARCompareControllerProps {
  /** Optional banner text replacing the default coming-soon message. */
  bannerText?: string
}

export function ARCompareController({
  bannerText = 'AR compare mode lands in V1.x',
}: ARCompareControllerProps): ReactElement {
  return (
    <group name="ar-compare-stub">
      {/* No camera mutation in the stub — the OrbitControls of the
          parent <CanonicalSceneRoot> stays in charge. */}
      <mesh position={[0, 3.5, 0]}>
        <planeGeometry args={[6, 0.6]} />
        <meshBasicMaterial color="#1d1d20" opacity={0.85} transparent />
      </mesh>
      {/* Banner text is rendered by the host page (HTML overlay). The
          component only exposes the marker plane so the user can see
          *something* in the canvas — and the bannerText prop is reserved
          for the HTML overlay's accessibility label. */}
      <group name="ar-compare-banner" userData={{ bannerText }} />
    </group>
  )
}
