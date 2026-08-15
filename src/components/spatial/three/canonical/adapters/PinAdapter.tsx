/**
 * Spatial · Canonical · Adapters · PinAdapter (Day 11 spike)
 *
 * Pins are 3D-native annotations anchored to a surface via UV. The Day-11
 * spike renders each pin as a small sphere at the resolved world position;
 * Day 13/14 swaps in icon billboards driven by `pin.pin_type`.
 *
 * R15 audit-fix · polygon_override fallback:
 *   - if the host wall carries `polygon_override`, we cannot resolve UV →
 *     world deterministically (the V1 portal solver does not support
 *     irregular outlines). The adapter falls back to the nearest vertex of
 *     the polygon ring + the small `anchor_offset_normal_m` lift along the
 *     wall normal. This matches the bridge's worst-case behaviour and
 *     keeps the pin visible while the operator decides whether to
 *     re-anchor it.
 *
 * Resolves on a per-pin basis; consumers usually render `<PinAdapter>`
 * inside `<PinSet>` (Day 17) which subscribes to the resolved scene and
 * iterates `scene.pins`.
 */

import { useMemo, type ReactElement } from 'react'
import { Vector3 } from 'three'

import type { Pin } from '../../../../../lib/spatial/canonical/types/annotations.ts'
import type { Wall, Floor, Ceiling } from '../../../../../lib/spatial/canonical/types/geometry.ts'
import type { SpatialObject } from '../../../../../lib/spatial/canonical/types/objects.ts'

type AnchorHost = Wall | Floor | Ceiling | SpatialObject

/**
 * Pin marker colour per {@link Pin.pin_type}. Mirrors `PinIcon.COLOR_BY_TYPE`
 * + the Mockup-15 Pin-Picker palette (`damage` rose · `wish` green ·
 * `note` blue · `photo` gold) so the inline-sphere `<PinAdapter>` and the
 * billboard `<PinIcon>` paths render an identical colour for every pin.
 */
const PIN_COLOR: Record<Pin['pin_type'], string> = {
  damage: '#b8536c',
  wish: '#5a8a4d',
  note: '#4a90c2',
  measurement: '#4caf50',
  material: '#f5a623',
  task: '#3a82ff',
  photo: '#c79b4a',
}

interface PinAdapterProps {
  pin: Pin
  host: AnchorHost | null
  /** Optional click handler for the Day-17 PinDetailSheet trigger. */
  onSelect?: (pinId: string) => void
}

export function PinAdapter({ pin, host, onSelect }: PinAdapterProps): ReactElement | null {
  const world = useMemo(() => resolvePinWorld(pin, host), [pin, host])
  if (!world) return null

  const color = PIN_COLOR[pin.pin_type] ?? '#666666'

  return (
    <mesh
      position={[world.x, world.y, world.z]}
      onClick={(e) => {
        e.stopPropagation()
        onSelect?.(pin.id)
      }}
      name={`pin-${pin.id}`}
    >
      <sphereGeometry args={[0.04, 16, 16]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.25} />
    </mesh>
  )
}

/**
 * Resolve a pin's `anchor_uv` to world-XYZ given the host node.
 * Returns `null` when the host is missing or the host type is unsupported.
 */
function resolvePinWorld(pin: Pin, host: AnchorHost | null): Vector3 | null {
  if (!host) return null
  if (pin.anchor_surface_type === 'wall') {
    const wall = host as Wall
    // R15 fallback: polygon_override walls cannot UV-resolve deterministically.
    if (wall.polygon_override && wall.polygon_override.length >= 3) {
      const nearest = nearestPolygonVertex(wall.polygon_override, wall.start_point)
      return new Vector3(nearest.x, nearest.y + 0.5, nearest.z)
    }
    return wallUvToWorld(wall, pin.anchor_uv.u, pin.anchor_uv.v, pin.anchor_offset_normal_m)
  }
  if (pin.anchor_surface_type === 'floor') {
    const floor = host as Floor
    return polygonUvToWorld(floor.polygon, pin.anchor_uv.u, pin.anchor_uv.v, 0)
  }
  if (pin.anchor_surface_type === 'ceiling') {
    const ceil = host as Ceiling
    return polygonUvToWorld(ceil.polygon, pin.anchor_uv.u, pin.anchor_uv.v, ceil.height_m)
  }
  // Object host — for V1 we attach the pin at the object origin + a small
  // upward lift. Day-12 will plumb the asset's UV map.
  const obj = host as SpatialObject
  return new Vector3(
    obj.transform?.position?.x ?? 0,
    (obj.transform?.position?.y ?? 0) + (obj.dimensions?.height_m ?? 0.2) + 0.05,
    obj.transform?.position?.z ?? 0,
  )
}

function wallUvToWorld(wall: Wall, u: number, v: number, normalOffset: number): Vector3 {
  const len = Math.hypot(
    wall.end_point.x - wall.start_point.x,
    wall.end_point.z - wall.start_point.z,
  )
  const dx = len === 0 ? 0 : (wall.end_point.x - wall.start_point.x) / len
  const dz = len === 0 ? 0 : (wall.end_point.z - wall.start_point.z) / len
  // Outer-facing normal (RH-rule on XZ).
  const nx = dz
  const nz = -dx
  const x = wall.start_point.x + dx * len * u + nx * normalOffset
  const z = wall.start_point.z + dz * len * u + nz * normalOffset
  const y = wall.base_height_m + wall.height_m * v
  return new Vector3(x, y, z)
}

function polygonUvToWorld(
  ring: ReadonlyArray<{ x: number; z: number }>,
  u: number,
  v: number,
  worldY: number,
): Vector3 {
  if (ring.length < 3) return new Vector3(0, worldY, 0)
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const p of ring) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.z < minZ) minZ = p.z
    if (p.z > maxZ) maxZ = p.z
  }
  return new Vector3(minX + (maxX - minX) * u, worldY, minZ + (maxZ - minZ) * v)
}

function nearestPolygonVertex(
  ring: ReadonlyArray<{ x: number; y: number; z: number }>,
  to: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  let best = ring[0]
  let bestSq = Infinity
  for (const v of ring) {
    const dx = v.x - to.x
    const dy = v.y - to.y
    const dz = v.z - to.z
    const sq = dx * dx + dy * dy + dz * dz
    if (sq < bestSq) {
      bestSq = sq
      best = v
    }
  }
  return best
}
