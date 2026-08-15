/**
 * Spatial · Canonical · Adapters · OpeningAdapter (Day 11 spike)
 *
 * Day 11 ships a non-CSG placeholder: the opening is painted as a flat
 * rectangle flush with the wall surface (slightly forward of the host
 * wall's outer face so z-fighting is avoided). Doors get a dark frame
 * tone; windows get a translucent blue tone.
 *
 * OD-3 (Day 11 build): CSG pre-bake via three-bvh-csg is reserved for
 * Phase 0c (Day 12+) when the visual gap demands it. Pre-baking on every
 * Wall+Opening combo at runtime is too slow for the mobile target; we
 * either pre-compute at bridge time or accept the flush-rect aesthetic
 * for V1 and revisit in Phase 1.
 *
 * The adapter is rendered as a CHILD of <WallAdapter>'s group, so the
 * local coordinate frame already aligns the wall's centerline along
 * +X. Local +Z points to the room-interior wall face (OQ-15: verified
 * against WallAdapter's -angle Y-rotation — local +Z maps to the
 * negated outward normal, i.e. inward). The opening plane is placed
 * 2mm into the room so its front face is visible to the interior camera.
 */

import { type ReactElement } from 'react'

import type { WallOpening } from '../../../../../lib/spatial/canonical/types/geometry.ts'
import { enableSubtreePick } from '../pickLayer'

/**
 * How the opening is realised in the wall:
 *   - `'decal'` — flush rectangle painted on the wall surface (Day-11 spike,
 *     the default; the wall mesh is solid).
 *   - `'csg'`   — the wall geometry already carries a real boolean hole
 *     (A-3 `wallCSGGeometry`); the adapter then renders nothing here, the
 *     hole + reveal live in the wall body itself.
 */
export type OpeningRenderMode = 'decal' | 'csg'

interface OpeningAdapterProps {
  opening: WallOpening
  wallLength: number
  wallHeight: number
  wallThickness: number
  /** Defaults to `'decal'` — the solid-wall flush-rectangle placeholder. */
  mode?: OpeningRenderMode
}

export function OpeningAdapter({
  opening,
  wallLength,
  wallHeight,
  wallThickness,
  mode = 'decal',
}: OpeningAdapterProps): ReactElement | null {
  // CSG mode: the real hole is baked into the wall body — nothing to paint.
  if (mode === 'csg') return null

  // Local-X spans the wall centerline (length); local-Y is up; local-Z is
  // the wall normal direction (positive = room-interior face — see header).
  const centerX = -wallLength / 2 + opening.offset_along_wall_m + opening.width_m / 2
  const centerY = -wallHeight / 2 + opening.offset_from_floor_m + opening.height_m / 2
  const surfaceOffset = wallThickness / 2 + 0.002 // 2mm in front to avoid z-fighting

  const isWindow = opening.type === 'window'
  const color = isWindow ? '#7faaff' : '#3a3026'
  const transparent = isWindow
  const opacity = isWindow ? 0.45 : 1

  return (
    <group
      ref={(g) => {
        if (g) enableSubtreePick(g)
      }}
      position={[centerX, centerY, surfaceOffset]}
      name={`opening-${opening.id}`}
    >
      <mesh>
        <planeGeometry args={[opening.width_m, opening.height_m]} />
        <meshStandardMaterial
          color={color}
          roughness={isWindow ? 0.05 : 0.6}
          metalness={isWindow ? 0.1 : 0}
          transparent={transparent}
          opacity={opacity}
        />
      </mesh>
    </group>
  )
}
