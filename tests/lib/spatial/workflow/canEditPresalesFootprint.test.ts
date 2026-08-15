import { describe, it, expect } from 'vitest'

import {
  canEditPresalesFootprint,
  type FootprintEditableScene,
} from '../../../../src/lib/spatial/workflow/canEditPresalesFootprint'

const UID = 'user-1'
const manualOwned: FootprintEditableScene = { origin: 'manual', providerId: UID }

describe('canEditPresalesFootprint', () => {
  it('is true for an owner-held manual scene with ≥3 walls and an open status', () => {
    expect(canEditPresalesFootprint(manualOwned, UID, 'scanned', 4)).toBe(true)
    expect(canEditPresalesFootprint(manualOwned, UID, 'draft', 3)).toBe(true)
    expect(canEditPresalesFootprint(manualOwned, UID, 'quoted', 6)).toBe(true)
  })

  // ── the six negative branches — drift backstop for both call-sites ──────────
  it('is false without a scene', () => {
    expect(canEditPresalesFootprint(null, UID, 'scanned', 4)).toBe(false)
    expect(canEditPresalesFootprint(undefined, UID, 'scanned', 4)).toBe(false)
  })

  it('is false without a signed-in user', () => {
    expect(canEditPresalesFootprint(manualOwned, null, 'scanned', 4)).toBe(false)
    expect(canEditPresalesFootprint(manualOwned, undefined, 'scanned', 4)).toBe(false)
  })

  it('is false for non-manual origins (read-only geometry)', () => {
    expect(canEditPresalesFootprint({ origin: 'roomplan', providerId: UID }, UID, 'scanned', 4)).toBe(false)
    expect(canEditPresalesFootprint({ origin: 'example_room', providerId: UID }, UID, 'scanned', 4)).toBe(false)
  })

  it('is false when the scene belongs to another provider', () => {
    expect(canEditPresalesFootprint({ origin: 'manual', providerId: 'other' }, UID, 'scanned', 4)).toBe(false)
    expect(canEditPresalesFootprint({ origin: 'manual', providerId: null }, UID, 'scanned', 4)).toBe(false)
  })

  it('is false once the project is sealed into a job (converted / archived)', () => {
    expect(canEditPresalesFootprint(manualOwned, UID, 'converted', 4)).toBe(false)
    expect(canEditPresalesFootprint(manualOwned, UID, 'archived', 4)).toBe(false)
  })

  it('is false for fewer than 3 walls (0-wall empty_canvas dead-end)', () => {
    expect(canEditPresalesFootprint(manualOwned, UID, 'scanned', 0)).toBe(false)
    expect(canEditPresalesFootprint(manualOwned, UID, 'scanned', 2)).toBe(false)
  })
})
