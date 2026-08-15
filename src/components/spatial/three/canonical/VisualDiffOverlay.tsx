/**
 * Spatial · Canonical · Three · VisualDiffOverlay (Phase 2 · Block 2.12)
 *
 * L3 render component for the visual-diff mode. Given a list of pre-computed
 * {@link DiffMarker}s (added / removed / modified), it draws one translucent
 * coloured marker per changed node:
 *   - added    → green sphere
 *   - removed  → red sphere
 *   - modified → amber sphere
 *
 * Pure presentation — it consumes `markers` (built by the L1 `buildDiffMarkers`
 * helper) and reads no store, so it stays trivially testable under jsdom like
 * `ClearanceZoneOverlay`. The diff computation + the active/base variant
 * resolution live in the host (`EditModeViewerHost`), keeping this component
 * free of business logic.
 *
 * Toggle: `enabled` is prop-controlled. When `false` the component renders
 * `null`; the host mounts it unconditionally and flips the prop, so toggling
 * diff mode never remounts the renderer.
 */

import { type ReactElement } from 'react'

import type { DiffMarker } from '../../../../lib/spatial/canonical/overrides/diff-markers.ts'

export interface VisualDiffOverlayProps {
  /** Pre-placed diff markers (from `buildDiffMarkers`). */
  markers: ReadonlyArray<DiffMarker>
  /** Prop-controlled toggle — `false` renders nothing (diff mode off). */
  enabled?: boolean
  /** Marker sphere radius in metres. */
  radius?: number
}

/** Default marker radius — large enough to spot on a room-scale scene. */
const DEFAULT_RADIUS = 0.12
/** Marker fill opacity — translucent so it never hides the node it marks. */
const MARKER_OPACITY = 0.55

/**
 * Render every diff marker as a translucent sphere at its world anchor.
 * Returns `null` when disabled or when there are no markers.
 */
export function VisualDiffOverlay({
  markers,
  enabled = true,
  radius = DEFAULT_RADIUS,
}: VisualDiffOverlayProps): ReactElement | null {
  if (!enabled) return null
  if (markers.length === 0) return null

  return (
    <group name="visual-diff-overlay">
      {markers.map((marker) => (
        <mesh
          key={`${marker.kind}-${marker.node_id}`}
          name={`diff-marker-${marker.kind}-${marker.node_id}`}
          position={[marker.position.x, marker.position.y, marker.position.z]}
          renderOrder={999}
        >
          <sphereGeometry args={[radius, 16, 16]} />
          <meshBasicMaterial
            color={marker.color}
            transparent
            opacity={MARKER_OPACITY}
            depthTest={false}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  )
}
