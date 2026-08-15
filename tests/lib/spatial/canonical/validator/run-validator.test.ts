/**
 * Tests for validator/run-validator.ts
 *
 * Validates the R7 dual-flag behaviour: `is_renderable` (graceful) +
 * `requires_user_confirmation` (strict) must move independently.
 */
import { describe, it, expect } from 'vitest'

import { runValidator } from '../../../../../src/lib/spatial/canonical/validator/run-validator.ts'
import { makeRoom, makeWall } from '../__helpers__/sceneFactory.ts'

describe('runValidator · R7 dual-flag', () => {
  it('reports is_renderable=true for a healthy room', () => {
    const report = runValidator(makeRoom())
    expect(report.is_renderable).toBe(true)
    expect(report.requires_user_confirmation).toBe(false)
  })

  it('keeps is_renderable=true even with non-blocking warnings', () => {
    // A wall with default thickness emits a WARNING but is renderable.
    const scene = makeRoom({
      walls: [
        makeWall({ id: 'a', thickness_m: 0.15 }),
        makeWall({ id: 'b', thickness_m: 0.15 }),
        makeWall({ id: 'c', thickness_m: 0.15 }),
        makeWall({ id: 'd', thickness_m: 0.15 }),
      ],
    })
    const report = runValidator(scene)
    expect(report.is_renderable).toBe(true)
    expect(report.requires_user_confirmation).toBe(false)
    expect(report.warnings.length).toBeGreaterThan(0)
  })

  it('flips requires_user_confirmation=true when a zero-length wall slips through', () => {
    const scene = makeRoom({
      walls: [
        makeWall({ id: 'a' }),
        makeWall({ id: 'b' }),
        makeWall({ id: 'c' }),
        makeWall({ id: 'd', start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 0, y: 0, z: 0 } }),
      ],
    })
    const report = runValidator(scene)
    // Still renderable (floor + ≥3 walls) but confirmation required.
    expect(report.is_renderable).toBe(true)
    expect(report.requires_user_confirmation).toBe(true)
    expect(report.errors.length).toBeGreaterThan(0)
  })

  it('flips is_renderable=false when the floor polygon is missing', () => {
    const scene = makeRoom({ floor: { ...makeRoom().floor, polygon: [] } })
    const report = runValidator(scene)
    expect(report.is_renderable).toBe(false)
  })

  it('returns a stable issue surface (errors / warnings / hints buckets)', () => {
    const report = runValidator(makeRoom())
    expect(report.errors).toBeDefined()
    expect(report.warnings).toBeDefined()
    expect(report.hints).toBeDefined()
    expect(report.scene_id).toBe('room')
  })
})
