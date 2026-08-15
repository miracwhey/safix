// @vitest-environment jsdom
/**
 * Render tests for the Block-2.8 `ClearanceZoneOverlay` — the L3 component
 * that draws a selected object's clearance zone as a translucent volume.
 *
 * The component returns only r3f intrinsic elements (`<group>` / `<mesh>` /
 * `<boxGeometry>` / `<meshBasicMaterial>`) and uses NO r3f hooks (`useThree`,
 * `useFrame`), so it reconciles fine under jsdom without a real `<Canvas>` —
 * React 19 renders the unknown lowercase tags as custom elements. That lets
 * the test exercise the real component code (zone derivation, the enabled
 * toggle, geometry sizing) rather than a mock.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

import { ClearanceZoneOverlay } from '../../../../../src/components/spatial/three/canonical/ClearanceZoneOverlay.tsx'
import type { SpatialObject } from '../../../../../src/lib/spatial/canonical/types/objects.ts'
import {
  IDENTITY_QUATERNION,
  ONE_VECTOR3,
} from '../../../../../src/lib/spatial/canonical/types/primitives.ts'

function makeWcObject(overrides: Partial<SpatialObject> = {}): SpatialObject {
  return {
    id: 'wc',
    type: 'object',
    parent_id: 'floor',
    children_ids: [],
    source: 'manual',
    confidence: 1,
    variant_id: 'base_roomplan',
    created_at: '2026-05-20T00:00:00.000Z',
    updated_at: '2026-05-20T00:00:00.000Z',
    transform: { position: { x: 2, y: 0, z: 1 }, rotation: { ...IDENTITY_QUATERNION }, scale: { ...ONE_VECTOR3 } },
    category: 'toilet',
    host: 'floor',
    host_id: 'floor',
    dimensions: { width_m: 0.4, depth_m: 0.6, height_m: 0.4 },
    ...overrides,
  }
}

afterEach(cleanup)

describe('ClearanceZoneOverlay', () => {
  it('renders a clearance group for a selected fixture', () => {
    const { container } = render(<ClearanceZoneOverlay object={makeWcObject()} enabled />)
    expect(container.querySelector('group[name="clearance-zone-wc"]')).toBeTruthy()
    expect(container.querySelector('mesh')).toBeTruthy()
    expect(container.querySelector('boxGeometry')).toBeTruthy()
  })

  it('renders nothing when the toggle is off (edit-mode off)', () => {
    const { container } = render(<ClearanceZoneOverlay object={makeWcObject()} enabled={false} />)
    expect(container.querySelector('group')).toBeNull()
  })

  it('defaults the toggle to on', () => {
    const { container } = render(<ClearanceZoneOverlay object={makeWcObject()} />)
    expect(container.querySelector('group[name="clearance-zone-wc"]')).toBeTruthy()
  })

  it('accepts color + opacity overrides without crashing', () => {
    const { container } = render(
      <ClearanceZoneOverlay object={makeWcObject()} enabled color="#00ff00" opacity={0.5} />,
    )
    expect(container.querySelector('meshBasicMaterial')).toBeTruthy()
  })
})
