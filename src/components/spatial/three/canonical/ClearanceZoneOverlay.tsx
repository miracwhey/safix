/**
 * Spatial · Canonical · Three · ClearanceZoneOverlay (Phase 2 · Block 2.8)
 *
 * L3 render component that draws the ergonomic clearance zone of a SELECTED
 * SpatialObject as a half-transparent volume. Used in the edit-mode so the
 * user sees the free space a fixture needs (knee room at a WC, approach space
 * at a sink) while dragging neighbours around.
 *
 * Data flow:
 *   - the zone extents come from the L1 `deriveClearanceZone()` helper
 *     (`canonical/snap/clearance-zone.ts`) — explicit per-asset `ClearanceZone`,
 *     else the asset's `SnapRule.min_distance_*`, else a category default.
 *   - the asset metadata (catalog `snapRule`) is read from `getCatalogAsset`.
 *
 * Geometry: a single translucent `<Box>` sized
 *   width  = object.width  + 2·sides_m
 *   depth  = object.depth  + front_m   (clearance extends forward only)
 *   height = object.height + above_m
 * positioned so the object stays flush at the back, the clearance margin sits
 * in front, and the box is rotated to match the object's Y-rotation so the
 * "front" follows the fixture's facing direction.
 *
 * Toggle: the parent passes `enabled` (prop-controlled). When `false` the
 * component renders `null` — the renderer mounts it unconditionally in
 * edit-mode and flips the prop.
 *
 * Layer: L3 — React + three.js. Pure presentation; reads no store directly so
 * it stays trivially testable.
 */

import { useMemo, type ReactElement } from 'react'

import type { SpatialObject } from '../../../../lib/spatial/canonical/types/objects.ts'
import { getCatalogAsset } from '../../../../lib/spatial/canonical/catalog/asset-catalog.ts'
import {
  deriveClearanceZone,
  clearanceZoneHasExtent,
} from '../../../../lib/spatial/canonical/snap/clearance-zone.ts'
import { toEuler } from '../../../../lib/spatial/canonical/algebra/quaternion.ts'

/** Default tint of the clearance volume — brand-amber, low alpha. */
const DEFAULT_ZONE_COLOR = '#f5a623'
const DEFAULT_ZONE_OPACITY = 0.22

export interface ClearanceZoneOverlayProps {
  /** The selected object whose clearance zone is shown. */
  object: SpatialObject
  /** Prop-controlled toggle — `false` renders nothing (edit-mode off). */
  enabled?: boolean
  /** Override the zone tint. */
  color?: string
  /** Override the zone opacity (0..1). */
  opacity?: number
}

/**
 * Render the clearance zone of `object` as a translucent box. Returns `null`
 * when disabled or when the derived zone has no extent (e.g. a ceiling lamp).
 */
export function ClearanceZoneOverlay({
  object,
  enabled = true,
  color = DEFAULT_ZONE_COLOR,
  opacity = DEFAULT_ZONE_OPACITY,
}: ClearanceZoneOverlayProps): ReactElement | null {
  const zone = useMemo(() => {
    const asset = getCatalogAsset(object.asset_id ?? '')
    return deriveClearanceZone(object.category, undefined, asset?.snapRule)
  }, [object.asset_id, object.category])

  const dims = object.dimensions
  const w = dims?.width_m ?? 0.4
  const h = dims?.height_m ?? 0.4
  const d = dims?.depth_m ?? 0.4

  // Box dimensions: the object plus its clearance margins.
  const boxW = w + 2 * zone.sides_m
  const boxD = d + zone.front_m
  const boxH = h + zone.above_m

  // The clearance margin extends FORWARD only — the box centre is shifted by
  // half the front clearance so the object stays flush at the box's back.
  const forwardShift = zone.front_m / 2

  // Match the object's Y-rotation so "forward" follows the fixture's facing.
  const yRotation = useMemo(() => {
    const rot = object.transform?.rotation
    if (!rot) return 0
    return toEuler(rot).y
  }, [object.transform?.rotation])

  const px = object.transform?.position?.x ?? 0
  const py = object.transform?.position?.y ?? 0
  const pz = object.transform?.position?.z ?? 0

  if (!enabled) return null
  if (!clearanceZoneHasExtent(zone)) return null

  return (
    <group
      name={`clearance-zone-${object.id}`}
      position={[px, py + boxH / 2, pz]}
      rotation={[0, yRotation, 0]}
    >
      <mesh position={[0, 0, forwardShift]}>
        <boxGeometry args={[boxW, boxH, boxD]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={opacity}
          depthWrite={false}
        />
      </mesh>
    </group>
  )
}
