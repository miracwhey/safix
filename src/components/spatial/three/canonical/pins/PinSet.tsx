/**
 * Spatial · Canonical · Pins · PinSet (Day 17)
 *
 * Reads the resolved RoomScene from the canonical store and renders one
 * `<PinIcon>` per pin at the resolved UV→world position. Picking up the
 * selectedPin state triggers `<PinDetailSheet>` from the host page.
 *
 * Replaces the Day-11 sphere placeholder rendered by `<PinAdapter>` —
 * the renderer should mount this in lieu of the per-pin sphere when the
 * billboarded UX is preferable.
 */

import { useMemo, type ReactElement } from 'react'

import { useCanonicalSceneStore } from '../../../../../lib/spatial/canonical/store/sceneStore'
import type { Wall, Floor, Ceiling } from '../../../../../lib/spatial/canonical/types/geometry'
import type { SpatialObject } from '../../../../../lib/spatial/canonical/types/objects'

import { PinIcon } from './PinIcon'

type AnchorHost = Wall | Floor | Ceiling | SpatialObject

interface PinSetProps {
  selectedPinId?: string | null
  onSelect?: (pinId: string) => void
}

export function PinSet({ selectedPinId = null, onSelect }: PinSetProps): ReactElement | null {
  const resolved = useCanonicalSceneStore((s) => s.resolved)

  const hostsById = useMemo(() => {
    const m = new Map<string, AnchorHost>()
    if (!resolved) return m
    for (const w of resolved.walls) {
      m.set(w.id, w)
      for (const o of w.wall_mounted) m.set(o.id, o)
    }
    m.set(resolved.floor.id, resolved.floor)
    for (const o of resolved.floor.floor_mounted) m.set(o.id, o)
    m.set(resolved.ceiling.id, resolved.ceiling)
    for (const o of resolved.ceiling.ceiling_mounted) m.set(o.id, o)
    for (const o of resolved.free_objects) m.set(o.id, o)
    return m
  }, [resolved])

  if (!resolved) return null
  return (
    <group name="pin-set">
      {resolved.pins.map((pin) => {
        const host = hostsById.get(pin.anchor_surface_id) ?? null
        const world = resolvePinWorld(pin, host)
        if (!world) return null
        return (
          <PinIcon
            key={pin.id}
            pin={pin}
            position={world}
            selected={pin.id === selectedPinId}
            onClick={onSelect}
          />
        )
      })}
    </group>
  )
}

function resolvePinWorld(
  pin: { anchor_surface_type: string; anchor_uv: { u: number; v: number }; anchor_offset_normal_m: number },
  host: AnchorHost | null,
): [number, number, number] | null {
  if (!host) return null
  if (pin.anchor_surface_type === 'wall') {
    const w = host as Wall
    const len = Math.hypot(w.end_point.x - w.start_point.x, w.end_point.z - w.start_point.z)
    const dx = len === 0 ? 0 : (w.end_point.x - w.start_point.x) / len
    const dz = len === 0 ? 0 : (w.end_point.z - w.start_point.z) / len
    const nx = dz
    const nz = -dx
    const x = w.start_point.x + dx * len * pin.anchor_uv.u + nx * pin.anchor_offset_normal_m
    const z = w.start_point.z + dz * len * pin.anchor_uv.u + nz * pin.anchor_offset_normal_m
    const y = w.base_height_m + w.height_m * pin.anchor_uv.v
    return [x, y, z]
  }
  if (pin.anchor_surface_type === 'floor' || pin.anchor_surface_type === 'ceiling') {
    const node = host as Floor | Ceiling
    const ring = node.polygon
    if (ring.length < 3) return null
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
    const y = pin.anchor_surface_type === 'ceiling' ? (host as Ceiling).height_m : 0
    return [
      minX + (maxX - minX) * pin.anchor_uv.u,
      y + pin.anchor_offset_normal_m,
      minZ + (maxZ - minZ) * pin.anchor_uv.v,
    ]
  }
  // Object host fallback
  const obj = host as SpatialObject
  return [
    obj.transform?.position?.x ?? 0,
    (obj.transform?.position?.y ?? 0) + (obj.dimensions?.height_m ?? 0.2) + 0.05,
    obj.transform?.position?.z ?? 0,
  ]
}
