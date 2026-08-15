/**
 * Spatial Core · Block E2 · snapHelpers tests
 *
 * Pure-function coverage for the Top-Down cardinal-angle snap + the D2
 * anchor resolve fast-path. Both ship inside the heavy three.js chunk but
 * carry no three.js dependency themselves, so we can vitest them without
 * a browser or canvas.
 */

import { describe, expect, it } from 'vitest'
import {
  CARDINAL_ANGLES_RAD,
  SNAP_TOLERANCE_RAD,
  normalizeAngle,
  resolveAnchorWorldXyz,
  snapToCardinal,
} from '../../../src/components/spatial/three/snapHelpers'

describe('normalizeAngle', () => {
  it('returns the input when already in [0, 2π)', () => {
    expect(normalizeAngle(0)).toBe(0)
    expect(normalizeAngle(Math.PI)).toBe(Math.PI)
  })

  it('wraps negative angles forward into [0, 2π)', () => {
    expect(normalizeAngle(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2, 6)
  })

  it('wraps angles ≥ 2π back into the first revolution', () => {
    expect(normalizeAngle(Math.PI * 2)).toBe(0)
    expect(normalizeAngle(Math.PI * 2 + 0.5)).toBeCloseTo(0.5, 6)
  })
})

describe('snapToCardinal', () => {
  it.each(CARDINAL_ANGLES_RAD)(
    'snaps angles within tolerance to cardinal %f',
    target => {
      const within = target + SNAP_TOLERANCE_RAD * 0.5
      const result = snapToCardinal(within)
      expect(result.angle).toBe(target)
      expect(result.didSnap).toBe(true)
    },
  )

  it('does not snap angles outside tolerance', () => {
    const offMidway = Math.PI / 4 // 45° — exactly between 0 and 90
    const result = snapToCardinal(offMidway)
    expect(result.angle).toBeCloseTo(offMidway, 6)
    expect(result.didSnap).toBe(false)
  })

  it('treats already-on-cardinal angles as not-snapped (no feedback fired twice)', () => {
    const result = snapToCardinal(Math.PI)
    expect(result.angle).toBe(Math.PI)
    expect(result.didSnap).toBe(false)
  })

  it('wraps near-2π angles into 0 so the snap fires across the seam', () => {
    const nearWrap = Math.PI * 2 - SNAP_TOLERANCE_RAD * 0.5
    const result = snapToCardinal(nearWrap)
    expect(result.angle).toBe(0)
    expect(result.didSnap).toBe(true)
  })
})

describe('resolveAnchorWorldXyz', () => {
  it('returns the per-format cache hit when present', () => {
    const cache = {
      gltf: { x: 1, y: 2, z: 3 },
      usdz: { x: 9, y: 9, z: 9 },
      computedAt: '2026-05-17T00:00:00Z',
    }
    expect(resolveAnchorWorldXyz(cache, 'gltf', null)).toEqual({
      x: 1,
      y: 2,
      z: 3,
    })
    expect(resolveAnchorWorldXyz(cache, 'usdz', null)).toEqual({
      x: 9,
      y: 9,
      z: 9,
    })
  })

  it('falls back to the centroid when the requested format is missing', () => {
    const cache = {
      gltf: { x: 1, y: 2, z: 3 },
      computedAt: '2026-05-17T00:00:00Z',
    }
    const fallback = { x: 5, y: 0, z: 5 }
    expect(resolveAnchorWorldXyz(cache, 'usdz', fallback)).toBe(fallback)
  })

  it('returns null when both the cache and the fallback are missing', () => {
    expect(resolveAnchorWorldXyz(null, 'gltf', null)).toBeNull()
  })

  it('returns null when the format is missing AND the caller has no fallback', () => {
    const cache = {
      usdz: { x: 1, y: 1, z: 1 },
      computedAt: '2026-05-17T00:00:00Z',
    }
    expect(resolveAnchorWorldXyz(cache, 'gltf', null)).toBeNull()
  })
})
