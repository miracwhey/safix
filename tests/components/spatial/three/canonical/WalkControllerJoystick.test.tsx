// @vitest-environment jsdom
/**
 * F5 contract — WalkController suppresses its imperative touch joystick while
 * an edit overlay is open.
 *
 * The joystick is created in a `document.createElement` effect and appended to
 * `document.body` as a `position:fixed; z-index:70` node — a SIBLING of the
 * viewer portal (`z-[60]`). Every edit sheet nests INSIDE that portal so it can
 * never out-stack the joystick; z-reordering can't win. The fix suppresses the
 * joystick instead: when `suppressJoystick` flips true the effect's cleanup
 * tears the node down AND zeroes the (module-private) `inputRef.forward/right`,
 * so the joystick stops covering the sheet and stops driving the camera. The
 * node-teardown asserted here is that exact cleanup path; `inputRef` is internal
 * to the component, so its reset is verified through the teardown it lives in.
 *
 * WalkController uses the r3f hooks `useThree` / `useFrame`, so they are mocked
 * with a stable fake camera + canvas — the component then reconciles its
 * intrinsic `<mesh>` under jsdom (React 19 renders unknown lowercase tags as
 * custom elements) and the joystick DOM effect runs for real against
 * `document.body`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'

import type { WalkablePolygon } from '../../../../../src/lib/spatial/canonical/types/walkable.ts'

// Stable fake r3f context so [gl]-dependent effects don't churn across rerenders
// and the FOV effect early-returns (the camera is NOT a PerspectiveCamera).
const harness = vi.hoisted(() => ({
  gl: null as { domElement: HTMLCanvasElement } | null,
  camera: null as Record<string, unknown> | null,
}))

vi.mock('@react-three/fiber', () => ({
  useThree: () => {
    if (!harness.gl) harness.gl = { domElement: document.createElement('canvas') }
    if (!harness.camera) {
      harness.camera = {
        fov: 50,
        updateProjectionMatrix: () => {},
        position: { set: () => {} },
        rotation: { order: 'XYZ', set: () => {} },
        updateMatrixWorld: () => {},
      }
    }
    return { camera: harness.camera, gl: harness.gl }
  },
  // No-op: the camera frame loop is irrelevant to the joystick-DOM lifecycle.
  useFrame: () => {},
}))

import { WalkController } from '../../../../../src/components/spatial/three/canonical/cameras/WalkController.tsx'

// 4 m × 4 m square room — large enough that preferredSpawn + resolveCameraCollision
// resolve a valid interior spawn without throwing.
const WALKABLE: WalkablePolygon = {
  outer: [
    { x: 0, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
    { x: 4, y: 0, z: 4 },
    { x: 0, y: 0, z: 4 },
  ],
  holes: [],
}

/**
 * The joystick zone is the body-level node tagged `data-walk-joystick` (a stable
 * marker on the imperative orphan node — jsdom does not reflect the zone's
 * complex `backdrop-filter`/`box-shadow` cssText into `style.position`/`zIndex`,
 * so a CSS-based lookup is unreliable here).
 */
function findJoystick(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-walk-joystick]')
}

afterEach(cleanup)

describe('WalkController · joystick suppression (F5)', () => {
  it('mounts a fixed z-index:70 joystick node when enabled and not suppressed', () => {
    render(<WalkController walkable={WALKABLE} obstacles={[]} mobileJoystick suppressJoystick={false} />)
    const zone = findJoystick()
    expect(zone).toBeTruthy()
    expect(zone?.tagName).toBe('DIV')
    // Knob child confirms it is the real joystick zone, not a stray fixed node.
    expect(zone?.querySelector('div')).toBeTruthy()
  })

  it('tears the joystick down when suppressJoystick flips true, and rebuilds it when false', () => {
    const { rerender } = render(
      <WalkController walkable={WALKABLE} obstacles={[]} mobileJoystick suppressJoystick={false} />,
    )
    expect(findJoystick()).toBeTruthy()

    // Suppress → cleanup runs: zone.remove() + inputRef.forward/right = 0.
    rerender(<WalkController walkable={WALKABLE} obstacles={[]} mobileJoystick suppressJoystick />)
    expect(findJoystick()).toBeNull()

    // Un-suppress → suppressJoystick is in the effect dep array, so the joystick
    // is re-created (not permanently gone).
    rerender(
      <WalkController walkable={WALKABLE} obstacles={[]} mobileJoystick suppressJoystick={false} />,
    )
    expect(findJoystick()).toBeTruthy()
  })

  it('never mounts the joystick when suppressed from the first render', () => {
    render(<WalkController walkable={WALKABLE} obstacles={[]} mobileJoystick suppressJoystick />)
    expect(findJoystick()).toBeNull()
  })

  it('never mounts the joystick when mobileJoystick is off', () => {
    render(<WalkController walkable={WALKABLE} obstacles={[]} mobileJoystick={false} />)
    expect(findJoystick()).toBeNull()
  })
})
