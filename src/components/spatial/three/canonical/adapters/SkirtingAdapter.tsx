/**
 * Spatial · Canonical · Adapters · SkirtingAdapter (Zwischen-Latte · A-2)
 *
 * Renders the procedural skirting board (Fußleiste) for a room — default-on
 * (corners-edges-design §3.2). The Wall↔floor join is the most prominent
 * edge in walk mode; a bare butt-edge reads as "unfinished", and the skirting
 * also masks small scan gaps along the floor line.
 *
 * Each run follows a wall's MITERED inner edge (`buildSkirtingPath`), so the
 * runs already meet at the corners. Runs are extended by their own depth at
 * each end so adjacent boards overlap rather than leaving a corner sliver —
 * the boards are opaque, the overlap is invisible (the same trick the wall
 * T-junctions use).
 *
 * V1 ships a plain rectangular board; the chamfered-top swept profile is a
 * V1.x polish item.
 */

import { type ReactElement } from 'react'

import type { Wall } from '../../../../../lib/spatial/canonical/types/geometry.ts'
import type { WallJoinGraph } from '../../../../../lib/spatial/canonical/geometry/wall-joins.ts'
import { buildSkirtingPath } from '../../../../../lib/spatial/canonical/geometry/wall-profile.ts'
import { innerNormalCompute } from '../../../../../lib/spatial/canonical/geometry/wall-geometry.ts'

interface SkirtingAdapterProps {
  walls: ReadonlyArray<Wall>
  joinGraph: WallJoinGraph
}

export function SkirtingAdapter({ walls, joinGraph }: SkirtingAdapterProps): ReactElement {
  const wallsById = new Map(walls.map((w) => [w.id, w]))
  const segments = buildSkirtingPath(walls as Wall[], joinGraph)

  return (
    <group name="room-skirting">
      {segments.map((seg) => {
        const wall = wallsById.get(seg.wall_id)
        if (!wall) return null

        const [a, b] = seg.path
        const length = Math.hypot(b.x - a.x, b.z - a.z)
        if (length < 1e-6) return null

        const depth = Math.max(...seg.profile.map((p) => p.x))
        const height = Math.max(...seg.profile.map((p) => p.y))
        const angle = Math.atan2(b.z - a.z, b.x - a.x)

        // Inner normal points from the wall face into the room — the board
        // sits against the inner edge and protrudes inward by `depth`.
        const inner = innerNormalCompute(wall)
        const midX = (a.x + b.x) / 2 + inner.x * (depth / 2)
        const midZ = (a.z + b.z) / 2 + inner.z * (depth / 2)
        const midY = a.y + height / 2

        return (
          <mesh
            key={seg.wall_id}
            name={`skirting-${seg.wall_id}`}
            position={[midX, midY, midZ]}
            rotation={[0, -angle, 0]}
            castShadow
            receiveShadow
          >
            {/* Extended by `depth` at each end so corner runs overlap, gap-free. */}
            <boxGeometry args={[length + depth * 2, height, depth]} />
            <meshStandardMaterial color="#e8e6e0" roughness={0.8} metalness={0} />
          </mesh>
        )
      })}
    </group>
  )
}
