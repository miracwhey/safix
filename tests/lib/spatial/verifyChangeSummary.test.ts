/**
 * Verify-flow Stage-5 change summary — `verifyChangeSummary.ts` (Block 3.8).
 *
 * Covers the base-vs-resolved diff: measurement corrections, layout edits,
 * wish-pins, the empty-summary path, and the German one-line projections.
 */
import { describe, it, expect } from 'vitest'

import {
  deriveVerifyChangeSummary,
  measurementSummaryLine,
  layoutSummaryLine,
  pinSummaryLine,
} from '../../../src/lib/spatial/workflow/verifyChangeSummary'
import {
  makeRoom,
  makeWall,
  makeOpening,
  makePin,
} from './canonical/__helpers__/sceneFactory'

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A 4-wall room — the base scene for every diff. */
function baseRoom() {
  return makeRoom({
    walls: [
      makeWall({ id: 'w_s', name: 'Eingangswand', height_m: 2.5 }),
      makeWall({ id: 'w_e', name: 'Rechte Wand', height_m: 2.5 }),
      makeWall({ id: 'w_n', name: 'Rückwand', height_m: 2.5 }),
      makeWall({ id: 'w_w', name: 'Linke Wand', height_m: 2.5 }),
    ],
  })
}

describe('deriveVerifyChangeSummary · empty paths', () => {
  it('a null base or resolved scene yields an empty summary', () => {
    expect(deriveVerifyChangeSummary(null, baseRoom()).isEmpty).toBe(true)
    expect(deriveVerifyChangeSummary(baseRoom(), null).isEmpty).toBe(true)
    expect(deriveVerifyChangeSummary(null, null).totalChanges).toBe(0)
  })

  it('an unchanged resolved scene yields an empty summary', () => {
    const base = baseRoom()
    const summary = deriveVerifyChangeSummary(base, baseRoom())
    expect(summary.isEmpty).toBe(true)
    expect(summary.totalChanges).toBe(0)
    expect(summary.measurements).toEqual([])
    expect(summary.layout).toEqual([])
    expect(summary.pins).toEqual([])
  })
})

describe('deriveVerifyChangeSummary · measurements', () => {
  it('detects a wall whose height changed', () => {
    const base = baseRoom()
    const resolved = baseRoom()
    resolved.walls[0] = makeWall({ id: 'w_s', name: 'Eingangswand', height_m: 2.8 })
    const summary = deriveVerifyChangeSummary(base, resolved)
    expect(summary.measurements).toHaveLength(1)
    expect(summary.measurements[0]).toMatchObject({
      wallId: 'w_s',
      wallName: 'Eingangswand',
      heightBeforeM: 2.5,
      heightAfterM: 2.8,
    })
  })

  it('ignores a sub-epsilon (floating-point noise) height delta', () => {
    const base = baseRoom()
    const resolved = baseRoom()
    resolved.walls[0] = makeWall({ id: 'w_s', name: 'Eingangswand', height_m: 2.5 + 1e-9 })
    expect(deriveVerifyChangeSummary(base, resolved).measurements).toHaveLength(0)
  })
})

describe('deriveVerifyChangeSummary · layout', () => {
  it('detects a deleted base wall', () => {
    const base = baseRoom()
    const resolved = baseRoom()
    resolved.walls = resolved.walls.filter((w) => w.id !== 'w_e')
    const summary = deriveVerifyChangeSummary(base, resolved)
    expect(summary.layout).toHaveLength(1)
    expect(summary.layout[0]).toMatchObject({ kind: 'wall_deleted', nodeId: 'w_e' })
  })

  it('detects an added opening (door)', () => {
    const base = baseRoom()
    const resolved = baseRoom()
    resolved.walls[0].openings = [
      makeOpening({ id: 'door-new', host_wall_id: 'w_s', type: 'door' }),
    ]
    const summary = deriveVerifyChangeSummary(base, resolved)
    expect(summary.layout).toHaveLength(1)
    expect(summary.layout[0]).toMatchObject({ kind: 'opening_added', nodeId: 'door-new' })
  })

  it('detects a moved opening', () => {
    const base = baseRoom()
    base.walls[0].openings = [
      makeOpening({
        id: 'door-1',
        host_wall_id: 'w_s',
        type: 'door',
        offset_along_wall_m: 0.5,
      }),
    ]
    const resolved = baseRoom()
    resolved.walls[0].openings = [
      makeOpening({
        id: 'door-1',
        host_wall_id: 'w_s',
        type: 'door',
        offset_along_wall_m: 1.5,
      }),
    ]
    const summary = deriveVerifyChangeSummary(base, resolved)
    expect(summary.layout).toHaveLength(1)
    expect(summary.layout[0]).toMatchObject({ kind: 'opening_moved', nodeId: 'door-1' })
  })
})

describe('deriveVerifyChangeSummary · pins', () => {
  it('lists every customer pin not on the base scene', () => {
    const base = baseRoom()
    const resolved = baseRoom()
    resolved.pins = [
      makePin({
        id: 'pin-1',
        anchor_surface_id: 'w_s',
        anchor_surface_type: 'wall',
        pin_type: 'damage',
        title: 'Schimmel',
        severity: 'high',
      }),
      makePin({
        id: 'pin-2',
        anchor_surface_id: 'w_e',
        anchor_surface_type: 'wall',
        pin_type: 'wish',
        title: 'Neue Dusche',
      }),
    ]
    const summary = deriveVerifyChangeSummary(base, resolved)
    expect(summary.pins).toHaveLength(2)
    expect(summary.pins[0]).toMatchObject({
      pinId: 'pin-1',
      pinType: 'damage',
      title: 'Schimmel',
      severity: 'high',
    })
  })

  it('does NOT list a pin already present on the base scene', () => {
    const existing = makePin({
      id: 'pin-base',
      anchor_surface_id: 'w_s',
      anchor_surface_type: 'wall',
      pin_type: 'note',
    })
    const base = baseRoom()
    base.pins = [existing]
    const resolved = baseRoom()
    resolved.pins = [existing]
    expect(deriveVerifyChangeSummary(base, resolved).pins).toHaveLength(0)
  })
})

describe('deriveVerifyChangeSummary · totalChanges', () => {
  it('sums all three buckets', () => {
    const base = baseRoom()
    const resolved = baseRoom()
    resolved.walls[0] = makeWall({ id: 'w_s', name: 'Eingangswand', height_m: 2.9 })
    resolved.walls = resolved.walls.filter((w) => w.id !== 'w_n')
    resolved.pins = [
      makePin({ id: 'p1', anchor_surface_id: 'w_s', anchor_surface_type: 'wall', pin_type: 'wish' }),
    ]
    const summary = deriveVerifyChangeSummary(base, resolved)
    expect(summary.totalChanges).toBe(3)
    expect(summary.isEmpty).toBe(false)
  })
})

describe('verifyChangeSummary · German summary lines', () => {
  it('measurementSummaryLine pluralises', () => {
    const base = baseRoom()
    const one = baseRoom()
    one.walls[0] = makeWall({ id: 'w_s', name: 'Eingangswand', height_m: 2.9 })
    expect(measurementSummaryLine(deriveVerifyChangeSummary(base, one))).toBe('1 Maß-Korrektur')

    const two = baseRoom()
    two.walls[0] = makeWall({ id: 'w_s', name: 'Eingangswand', height_m: 2.9 })
    two.walls[1] = makeWall({ id: 'w_e', name: 'Rechte Wand', height_m: 2.9 })
    expect(measurementSummaryLine(deriveVerifyChangeSummary(base, two))).toBe('2 Maß-Korrekturen')
  })

  it('layoutSummaryLine returns null when empty', () => {
    expect(layoutSummaryLine(deriveVerifyChangeSummary(baseRoom(), baseRoom()))).toBeNull()
  })

  it('pinSummaryLine breaks down by kind', () => {
    const base = baseRoom()
    const resolved = baseRoom()
    resolved.pins = [
      makePin({ id: 'p1', anchor_surface_id: 'w_s', anchor_surface_type: 'wall', pin_type: 'damage' }),
      makePin({ id: 'p2', anchor_surface_id: 'w_s', anchor_surface_type: 'wall', pin_type: 'damage' }),
      makePin({ id: 'p3', anchor_surface_id: 'w_e', anchor_surface_type: 'wall', pin_type: 'wish' }),
    ]
    const line = pinSummaryLine(deriveVerifyChangeSummary(base, resolved))
    expect(line).toContain('3 Pins')
    expect(line).toContain('2 Schaden')
    expect(line).toContain('1 Wunsch')
  })
})
