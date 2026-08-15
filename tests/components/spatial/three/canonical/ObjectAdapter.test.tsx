// @vitest-environment jsdom
/**
 * Regression test for F4 — ObjectAdapter's fit-to-AABB wiring.
 *
 * Before the fix `fitToDims` was `object.asset_id ? null : { w, h, d }`, so any
 * catalog (asset_id) object skipped the fit-scale wrap: its mesh rendered at the
 * native catalog size while the floor footprint, SelectionOutline, PickProxy and
 * host offset all tracked `object.dimensions`. After a dimension edit (which
 * patches `dimensions` but keeps `asset_id`) the mesh stayed the old size centred
 * on the new origin → it read as offset. The fix makes `fitToDims` unconditional
 * (`{ w, h, d }` for every object), so the mesh conforms to the declared AABB.
 *
 * The render path is exercised for real (jsdom + @testing-library, the
 * ClearanceZoneOverlay pattern): a procedural `asset_id` resolves no GLB URL, so
 * ObjectAdapter renders `PlaceholderMesh` inline. `fitScaleForDims` is spied — it
 * is ONLY called when `fitToDims` is non-null, so a recorded call with the
 * object's declared dims as the target proves the regression is fixed (pre-fix it
 * was never called for an asset_id object).
 */
import { describe, it, expect, afterEach, vi, type Mock } from 'vitest'
import { render, cleanup } from '@testing-library/react'

import type { SpatialObject } from '../../../../../src/lib/spatial/canonical/types/objects.ts'
import {
  IDENTITY_QUATERNION,
  ONE_VECTOR3,
} from '../../../../../src/lib/spatial/canonical/types/primitives.ts'

// r3f's `useThree` needs a fiber store; the procedural subtree (ObjectAdapter →
// PlaceholderMesh / PickProxy / SurfaceMaterial) only reads `invalidate`, so a
// thin selector stand-in lets the component reconcile under jsdom without a Canvas.
vi.mock('@react-three/fiber', () => ({
  useThree: (selector: (s: { invalidate: () => void; gl: object }) => unknown) =>
    selector({ invalidate: () => {}, gl: {} }),
}))

// PickProxy mounts a real three.js layer-mask via pickLayer.markPickOnly in an
// effect (n.layers.set). Under jsdom the r3f `<group>`/`<mesh>` refs are DOM
// nodes with no `.layers`, so it throws after render — stub it to null. The
// fitScaleForDims call we assert on happens during render, before this effect.
vi.mock('../../../../../src/components/spatial/three/canonical/PickProxy.tsx', () => ({
  PickProxy: () => null,
}))

// Spy the fit-scale math while keeping the real implementation (incl. extentOfBox).
vi.mock('../../../../../src/lib/spatial/canonical/geometry/fitScale.ts', async (orig) => {
  const actual = await orig<
    typeof import('../../../../../src/lib/spatial/canonical/geometry/fitScale.ts')
  >()
  return { ...actual, fitScaleForDims: vi.fn(actual.fitScaleForDims) }
})

import { ObjectAdapter } from '../../../../../src/components/spatial/three/canonical/adapters/ObjectAdapter.tsx'
import { fitScaleForDims } from '../../../../../src/lib/spatial/canonical/geometry/fitScale.ts'

const fitScaleSpy = fitScaleForDims as unknown as Mock

function makeObject(overrides: Partial<SpatialObject> = {}): SpatialObject {
  return {
    id: 'obj-1',
    type: 'object',
    parent_id: 'floor',
    children_ids: [],
    source: 'manual',
    confidence: 1,
    variant_id: 'base_roomplan',
    created_at: '2026-06-07T00:00:00.000Z',
    updated_at: '2026-06-07T00:00:00.000Z',
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { ...IDENTITY_QUATERNION }, scale: { ...ONE_VECTOR3 } },
    category: 'toilet',
    host: 'floor',
    host_id: 'floor',
    // Procedural catalog slug → no GLB URL → ObjectAdapter renders PlaceholderMesh inline.
    asset_id: 'sanitary-toilet-wall-hung',
    dimensions: { width_m: 0.5, height_m: 0.7, depth_m: 0.3 },
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  fitScaleSpy.mockClear()
})

describe('ObjectAdapter · F4 fit-to-AABB', () => {
  it('passes a non-null fitToDims (the declared dims) for an asset_id object', () => {
    render(<ObjectAdapter object={makeObject()} />)

    expect(fitScaleSpy).toHaveBeenCalled()
    // The fit target (2nd arg) is the object's declared AABB — was `null` pre-fix.
    const targets = fitScaleSpy.mock.calls.map((c) => c[1])
    expect(targets).toContainEqual({ w: 0.5, h: 0.7, d: 0.3 })
    expect(targets.every((t) => t !== null)).toBe(true)
  })

  it('fitToDims tracks edited dimensions (mesh conforms to the new AABB)', () => {
    render(
      <ObjectAdapter object={makeObject({ dimensions: { width_m: 0.9, height_m: 1.1, depth_m: 0.4 } })} />,
    )

    expect(fitScaleSpy.mock.calls.map((c) => c[1])).toContainEqual({ w: 0.9, h: 1.1, d: 0.4 })
  })
})
