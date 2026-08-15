/**
 * Tests for validator/rules/pin-rules.ts
 */
import { describe, it, expect } from 'vitest'

import {
  checkPinAnchorNotFound,
  checkPinOffSurface,
} from '../../../../../src/lib/spatial/canonical/validator/rules/pin-rules.ts'
import { makePin, makeRoom } from '../__helpers__/sceneFactory.ts'

describe('pin-rules · PIN_ANCHOR_NOT_FOUND', () => {
  it('flags pins anchored to a missing wall', () => {
    const pin = makePin({
      id: 'p1',
      pin_type: 'damage',
      anchor_surface_id: 'ghost',
      anchor_surface_type: 'wall',
    })
    const scene = makeRoom({ pins: [pin] })
    expect(checkPinAnchorNotFound(scene)).toHaveLength(1)
  })

  it('passes pins anchored to a known wall', () => {
    const pin = makePin({
      id: 'p1',
      pin_type: 'damage',
      anchor_surface_id: 'w_s',
      anchor_surface_type: 'wall',
    })
    const scene = makeRoom({ pins: [pin] })
    expect(checkPinAnchorNotFound(scene)).toEqual([])
  })
})

describe('pin-rules · PIN_OFF_SURFACE', () => {
  it('warns when UV is outside [0,1]²', () => {
    const pin = makePin({
      id: 'p1',
      pin_type: 'damage',
      anchor_surface_id: 'w_s',
      anchor_surface_type: 'wall',
      anchor_uv: { u: 1.5, v: 0.5 },
    })
    const scene = makeRoom({ pins: [pin] })
    expect(checkPinOffSurface(scene)).toHaveLength(1)
  })

  it('does not warn for UV inside [0,1]²', () => {
    const pin = makePin({
      id: 'p1',
      pin_type: 'damage',
      anchor_surface_id: 'w_s',
      anchor_surface_type: 'wall',
      anchor_uv: { u: 0.5, v: 0.5 },
    })
    const scene = makeRoom({ pins: [pin] })
    expect(checkPinOffSurface(scene)).toEqual([])
  })
})
