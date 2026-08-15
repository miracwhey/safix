/**
 * Spatial Core · Block E2 · 3D Pin Markers (D2 hybrid anchor)
 *
 * Renders one billboarded sprite per `ScanAnnotation`. Resolution chain:
 *
 *   1. `anchorWorldCache.gltf` → fast path, the common case (Block F's
 *      pin-set writes the cache atomically with the UV-SoT).
 *   2. `anchor2d` → renders as a floor-level proxy at `(svgX, 0, svgY)` so
 *      a 2D-only annotation still has a visual anchor in 3D (visually
 *      distinguished by a dashed ring — UI cue that "this is a floorplan
 *      pin, not a wall pin").
 *   3. Otherwise → not rendered (no XYZ to place).
 *
 * The component never computes a UV → XYZ projection itself — that math
 * lives in Block F's pin-set workflow (raycast against the loaded mesh,
 * write the result back to `anchorWorldCache` so subsequent reads hit the
 * fast path here).
 *
 * Pins billboard toward the camera via drei's `<Billboard>` so they stay
 * legible from any orbit angle. Click hands off to `onPinSelected` — the
 * Pin-Editor sheet (Block F) listens.
 */

import { Billboard } from '@react-three/drei'
import { useMemo } from 'react'
import type { ScanAnnotation } from '../../../lib/spatial/types'
import { resolveAnchorWorldXyz } from './snapHelpers'

export interface AnchorPinsProps {
  annotations: ScanAnnotation[]
  /** When true (`view` mode or Layers→Pins=off) render nothing. */
  visible: boolean
  selectedId?: string | null
  onPinSelected?: (annotationId: string) => void
}

const KIND_COLOR: Record<ScanAnnotation['kind'], string> = {
  damage: '#ef4444',
  note: '#facc15',
  photo: '#22d3ee',
  measurement_ref: '#a78bfa',
  gewerk_marker: '#34d399',
}

export function AnchorPins(props: AnchorPinsProps) {
  const placed = useMemo(() => {
    return props.annotations
      .map(a => {
        const xyz = resolveAnchorWorldXyz(
          a.anchorWorldCache,
          'gltf',
          a.anchor2d ? { x: a.anchor2d.svgX, y: 0, z: a.anchor2d.svgY } : null,
        )
        return xyz ? { a, xyz, isFallback: !a.anchorWorldCache?.gltf } : null
      })
      .filter((p): p is { a: ScanAnnotation; xyz: { x: number; y: number; z: number }; isFallback: boolean } => p !== null)
  }, [props.annotations])

  if (!props.visible) return null

  return (
    <group name="anchor-pins">
      {placed.map(({ a, xyz, isFallback }) => (
        <Billboard key={a.id} position={[xyz.x, xyz.y, xyz.z]}>
          <PinSprite
            color={KIND_COLOR[a.kind] ?? '#ffffff'}
            selected={props.selectedId === a.id}
            dashed={isFallback}
            onSelect={() => props.onPinSelected?.(a.id)}
          />
        </Billboard>
      ))}
    </group>
  )
}

interface PinSpriteProps {
  color: string
  selected: boolean
  dashed: boolean
  onSelect: () => void
}

function PinSprite(props: PinSpriteProps) {
  const radius = props.selected ? 0.07 : 0.05
  const ringRadius = radius * 1.6
  return (
    <group
      onPointerDown={e => {
        e.stopPropagation()
        props.onSelect()
      }}
    >
      <mesh>
        <sphereGeometry args={[radius, 16, 16]} />
        <meshStandardMaterial
          color={props.color}
          emissive={props.color}
          emissiveIntensity={props.selected ? 0.9 : 0.4}
          roughness={0.35}
          metalness={0.1}
        />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[ringRadius, ringRadius + 0.008, 32]} />
        <meshBasicMaterial
          color={props.color}
          transparent
          opacity={props.dashed ? 0.5 : 0.85}
        />
      </mesh>
    </group>
  )
}
