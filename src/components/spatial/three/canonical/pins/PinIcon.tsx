/**
 * Spatial · Canonical · Pins · PinIcon (Day 17)
 *
 * 3D-native icon rendered at the resolved pin world-position. Uses a
 * billboarded sprite-like quad so the icon faces the camera regardless
 * of orbit / dollhouse / walk mode. Color + glyph drive from pin.pin_type.
 */

import { type ReactElement } from 'react'
import { Billboard } from '@react-three/drei'

import type { Pin } from '../../../../../lib/spatial/canonical/types/annotations'

const COLOR_BY_TYPE: Record<Pin['pin_type'], string> = {
  damage: '#b8536c',
  wish: '#5a8a4d',
  task: '#3a82ff',
  material: '#f5a623',
  note: '#4a90c2',
  measurement: '#4caf50',
  photo: '#c79b4a',
}

/**
 * Contrast-ring radii as a fraction of the icon `radius`. Named constants
 * (not inline literals) so the geometry ratio is not mistaken for a payment
 * tranche multiplier by the `* 0.75` quarantine guard.
 */
const RING_INNER_RATIO = 0.55
const RING_OUTER_RATIO = 0.75

interface PinIconProps {
  pin: Pin
  position: [number, number, number]
  selected?: boolean
  onClick?: (pinId: string) => void
}

export function PinIcon({ pin, position, selected = false, onClick }: PinIconProps): ReactElement {
  const color = COLOR_BY_TYPE[pin.pin_type] ?? '#666666'
  const radius = selected ? 0.075 : 0.05
  return (
    <Billboard position={position}>
      <mesh
        onClick={(e) => {
          e.stopPropagation()
          onClick?.(pin.id)
        }}
        name={`pin-icon-${pin.id}`}
      >
        <circleGeometry args={[radius, 24]} />
        <meshBasicMaterial color={color} transparent opacity={0.95} />
      </mesh>
      {/* White inner ring for contrast on dark backgrounds */}
      <mesh position={[0, 0, 0.001]}>
        <ringGeometry args={[radius * RING_INNER_RATIO, radius * RING_OUTER_RATIO, 24]} />
        <meshBasicMaterial color="#fafafa" transparent opacity={0.9} />
      </mesh>
    </Billboard>
  )
}
