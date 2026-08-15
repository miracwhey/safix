/**
 * Tests for fitScale — the scan render-fallback fit-to-AABB math.
 *
 * Locks the riskiest part of the render-fallback (review finding render-1): a
 * category-default model is catalog-sized but the scan AABB differs, so the model
 * must be scaled to the measured dims or its feet float/sink. This pins the scale
 * math (incl. the no-target passthrough and the div-by-zero guard) so a future
 * refactor of ObjectAdapter can't silently reintroduce the float/sink.
 */
import { describe, it, expect } from 'vitest'

import { fitScaleForDims, extentOfBox } from '../../../../../src/lib/spatial/canonical/geometry/fitScale.ts'

describe('fitScaleForDims', () => {
  it('returns null when no target (asset_id set → Manual/Example untouched)', () => {
    expect(fitScaleForDims({ x: 1, y: 1, z: 1 }, null)).toBeNull()
  })

  it('is identity (1,1,1) when source extent already equals the target', () => {
    expect(fitScaleForDims({ x: 0.6, y: 0.82, z: 0.6 }, { w: 0.6, h: 0.82, d: 0.6 })).toEqual([
      1, 1, 1,
    ])
  })

  it('scales each axis by target/source (catalog → scan dims)', () => {
    // catalog fridge 0.6×1.78×0.6 → measured scan 0.7×1.85×0.7
    const s = fitScaleForDims({ x: 0.6, y: 1.78, z: 0.6 }, { w: 0.7, h: 1.85, d: 0.7 })!
    expect(s[0]).toBeCloseTo(0.7 / 0.6, 6)
    expect(s[1]).toBeCloseTo(1.85 / 1.78, 6)
    expect(s[2]).toBeCloseTo(0.7 / 0.6, 6)
  })

  it('makes the feet flush: a centred model scaled by Y-fit has height === targetH', () => {
    const modelH = 1.78
    const targetH = 1.85
    const sy = fitScaleForDims({ x: 1, y: modelH, z: 1 }, { w: 1, h: targetH, d: 1 })![1]
    // rendered height = modelH * sy must equal the scan height → centre at h/2 → feet at 0
    expect(modelH * sy).toBeCloseTo(targetH, 6)
  })

  it('guards each degenerate (zero) source axis to scale 1, never NaN/Infinity', () => {
    const s = fitScaleForDims({ x: 0, y: 0, z: 0.5 }, { w: 0.4, h: 0.9, d: 0.5 })!
    expect(s[0]).toBe(1)
    expect(s[1]).toBe(1)
    expect(s[2]).toBe(1)
    expect(s.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('extentOfBox computes max−min per axis', () => {
    expect(
      extentOfBox({ min: { x: -0.5, y: 0, z: -0.35 }, max: { x: 0.5, y: 1.85, z: 0.35 } }),
    ).toEqual({ x: 1, y: 1.85, z: 0.7 })
  })
})
