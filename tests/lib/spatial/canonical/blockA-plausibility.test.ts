/**
 * Block A · Physical-Plausibility — regression lock.
 *
 * Maßstab Möbel↔Raum stimmt (alles Meter, GLB pre-scaled), aber ohne diese
 * Checks kann die Szene unrealistisch werden:
 *   A1 — zwei Möbel auf demselben Punkt (Soft-Notice, KEIN Block; „Stuhl unter
 *        Tisch" bleibt erlaubt; flache Unterlagen/Teppiche lösen nichts aus)
 *   A2 — Möbel höher als der Raum (Place/Duplicate Hard-Reject; Hochskalieren an
 *        die Deckenhöhe gedeckelt)
 */
import { describe, expect, it } from 'vitest'

import {
  findSubstantialFloorOverlap,
  scaledHeightM,
  validateFloorObjectPosition,
  FLAT_OBJECT_MAX_HEIGHT_M,
} from '../../../../src/lib/spatial/canonical/validator/objectPositionValidator.ts'
import {
  placeFurniture,
  duplicateFurniture,
  scaleFurniture,
  setFurnitureScale,
} from '../../../../src/lib/spatial/canonical/workflow/customerFurnitureOrchestrator.ts'
import { makeObject, makeRoom, vec } from './__helpers__/sceneFactory.ts'

const GEN = '2026-05-31T00:00:00.000Z'

function floorObj(
  overrides: Partial<Parameters<typeof makeObject>[0]> = {},
  dims = { width_m: 0.5, depth_m: 0.5, height_m: 0.8 },
) {
  return makeObject({
    id: 'a',
    category: 'generic_cuboid',
    host: 'floor',
    host_id: 'floor',
    dimensions: dims,
    transform: { position: vec(2, 0, 1.5), rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
    rotation_around_y_deg: 0,
    ...overrides,
  })
}

/** A room (4×3 floor) whose ceiling height is overridden. */
function roomWithCeiling(heightM: number, floorMounted: ReturnType<typeof makeObject>[] = []) {
  const base = makeRoom()
  return {
    ...base,
    ceiling: { ...base.ceiling, height_m: heightM },
    floor: { ...base.floor, floor_mounted: floorMounted },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure validator
// ─────────────────────────────────────────────────────────────────────────────

describe('scaledHeightM', () => {
  it('multiplies catalog height by the y-scale', () => {
    expect(scaledHeightM(floorObj({}, { width_m: 1, depth_m: 1, height_m: 2 }))).toBeCloseTo(2)
    const scaled = floorObj(
      { transform: { position: vec(2, 0, 1.5), rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1.5, y: 1.5, z: 1.5 } } },
      { width_m: 1, depth_m: 1, height_m: 2 },
    )
    expect(scaledHeightM(scaled)).toBeCloseTo(3)
  })
})

describe('A2 · validateFloorObjectPosition height cap', () => {
  it('rejects an object taller than the ceiling with reason too_tall', () => {
    const r = validateFloorObjectPosition({
      floor: makeRoom().floor,
      object: floorObj({}, { width_m: 0.5, depth_m: 0.5, height_m: 3 }),
      ceilingHeightM: 2.5,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('too_tall')
  })

  it('accepts an object within the ceiling height', () => {
    const r = validateFloorObjectPosition({
      floor: makeRoom().floor,
      object: floorObj({}, { width_m: 0.5, depth_m: 0.5, height_m: 2.4 }),
      ceilingHeightM: 2.5,
    })
    expect(r.ok).toBe(true)
  })

  it('skips the height check when no ceilingHeightM is given (footprint-only callers)', () => {
    const r = validateFloorObjectPosition({
      floor: makeRoom().floor,
      object: floorObj({}, { width_m: 0.5, depth_m: 0.5, height_m: 9 }),
    })
    expect(r.ok).toBe(true)
  })
})

describe('A1 · findSubstantialFloorOverlap', () => {
  it('flags two objects on the same point (100% overlap)', () => {
    const a = floorObj({ id: 'a', name: 'Sofa' })
    const candidate = floorObj({ id: 'b' })
    const floor = { ...makeRoom().floor, floor_mounted: [a] }
    const hit = findSubstantialFloorOverlap({ floor, candidate })
    expect(hit?.id).toBe('a')
    expect(hit?.name).toBe('Sofa')
  })

  it('does NOT flag a small partial touch (< 50% of the smaller footprint)', () => {
    // 0.5×0.5 each; centres 0.45 apart on x → overlap 0.05 wide → ratio 0.1.
    const a = floorObj({ id: 'a', transform: { position: vec(2, 0, 1.5), rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } } })
    const candidate = floorObj({ id: 'b', transform: { position: vec(2.45, 0, 1.5), rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } } })
    const floor = { ...makeRoom().floor, floor_mounted: [a] }
    expect(findSubstantialFloorOverlap({ floor, candidate })).toBeNull()
  })

  it('ignores flat underlay objects (rug) under the candidate', () => {
    const rug = floorObj({ id: 'rug' }, { width_m: 2, depth_m: 1.4, height_m: 0.02 })
    expect(0.02).toBeLessThan(FLAT_OBJECT_MAX_HEIGHT_M)
    const candidate = floorObj({ id: 'chair' })
    const floor = { ...makeRoom().floor, floor_mounted: [rug] }
    expect(findSubstantialFloorOverlap({ floor, candidate })).toBeNull()
  })

  it('ignores a flat candidate (placing a rug under furniture)', () => {
    const sofa = floorObj({ id: 'sofa' }, { width_m: 2, depth_m: 0.9, height_m: 0.85 })
    const rugCandidate = floorObj({ id: 'rug' }, { width_m: 2, depth_m: 1.4, height_m: 0.02 })
    const floor = { ...makeRoom().floor, floor_mounted: [sofa] }
    expect(findSubstantialFloorOverlap({ floor, candidate: rugCandidate })).toBeNull()
  })

  it('skips the excluded id (object being edited)', () => {
    const a = floorObj({ id: 'a' })
    const candidate = floorObj({ id: 'a' })
    const floor = { ...makeRoom().floor, floor_mounted: [a] }
    expect(findSubstantialFloorOverlap({ floor, candidate, excludeId: 'a' })).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('A2 · placeFurniture height cap', () => {
  it('rejects placing an object taller than the room', () => {
    const r = placeFurniture({
      scene: makeRoom(), // ceiling 2.5
      asset: { slug: 'pole', objectCategory: 'generic_cuboid', dimensions: { width_m: 0.3, depth_m: 0.3, height_m: 3 } },
      newId: 'tall',
      generatedAt: GEN,
      tapX: 2,
      tapZ: 1.5,
    })
    expect(r.kind).toBe('rejected')
    if (r.kind === 'rejected') expect(r.message).toMatch(/höher als der Raum/)
  })
})

describe('A2 · scale is capped at the ceiling', () => {
  it('setFurnitureScale never grows the object past the ceiling', () => {
    // 2.0m object, 2.1m ceiling → cap 1.05. A scale request of 5 must be clamped
    // so the scaled height stays under the ceiling.
    const scene = roomWithCeiling(2.1, [floorObj({}, { width_m: 0.4, depth_m: 0.4, height_m: 2.0 })])
    const r = setFurnitureScale({ scene, objectId: 'a', scale: 5 })
    expect(r.kind).toBe('updated')
    if (r.kind === 'updated') {
      const s = r.scene.floor.floor_mounted.find((o) => o.id === 'a')!.transform.scale.x
      expect(s * 2.0).toBeLessThanOrEqual(2.1 + 1e-6)
    }
  })

  it('scaleFurniture (additive) respects the ceiling cap', () => {
    const scene = roomWithCeiling(2.1, [floorObj({}, { width_m: 0.4, depth_m: 0.4, height_m: 2.0 })])
    const next = scaleFurniture({ scene, objectId: 'a', delta: 1.0 })
    // delta would push to 2.0× but the ceiling cap (1.05) binds.
    if (next) {
      const s = next.floor.floor_mounted.find((o) => o.id === 'a')!.transform.scale.x
      expect(s * 2.0).toBeLessThanOrEqual(2.1 + 1e-6)
    }
  })
})

describe('A1 · overlapNotice surfacing', () => {
  it('placeFurniture returns an overlapNotice when dropped onto an existing object', () => {
    const first = placeFurniture({
      scene: makeRoom(),
      asset: { slug: 'sofa', objectCategory: 'generic_cuboid', dimensions: { width_m: 0.8, depth_m: 0.8, height_m: 0.85 } },
      newId: 'a',
      generatedAt: GEN,
      tapX: 2,
      tapZ: 1.5,
    })
    expect(first.kind).toBe('placed')
    if (first.kind !== 'placed') return
    const second = placeFurniture({
      scene: first.scene,
      asset: { slug: 'sofa2', objectCategory: 'generic_cuboid', dimensions: { width_m: 0.8, depth_m: 0.8, height_m: 0.85 } },
      newId: 'b',
      generatedAt: GEN,
      tapX: 2,
      tapZ: 1.5,
    })
    expect(second.kind).toBe('placed')
    if (second.kind === 'placed') {
      expect(second.overlapNotice).toBeTruthy()
      // still placed — not a rejection
      expect(second.scene.floor.floor_mounted.map((o) => o.id)).toEqual(['a', 'b'])
    }
  })

  it('placeFurniture has no overlapNotice on a clear spot', () => {
    const first = placeFurniture({
      scene: makeRoom(),
      asset: { slug: 'sofa', objectCategory: 'generic_cuboid', dimensions: { width_m: 0.5, depth_m: 0.5, height_m: 0.85 } },
      newId: 'a',
      generatedAt: GEN,
      tapX: 1,
      tapZ: 1,
    })
    if (first.kind !== 'placed') throw new Error('expected placed')
    const second = placeFurniture({
      scene: first.scene,
      asset: { slug: 'sofa2', objectCategory: 'generic_cuboid', dimensions: { width_m: 0.5, depth_m: 0.5, height_m: 0.85 } },
      newId: 'b',
      generatedAt: GEN,
      tapX: 3,
      tapZ: 2.5,
    })
    expect(second.kind).toBe('placed')
    if (second.kind === 'placed') expect(second.overlapNotice).toBeUndefined()
  })

  it('duplicateFurniture surfaces an overlapNotice (the +0.3 clone overlaps a large source)', () => {
    const big = floorObj({ id: 'a', name: 'Sofa' }, { width_m: 1.5, depth_m: 1.5, height_m: 0.85 })
    const scene = { ...makeRoom(), floor: { ...makeRoom().floor, floor_mounted: [big] } }
    const r = duplicateFurniture({ scene, objectId: 'a', newId: 'a-copy', generatedAt: GEN })
    expect(r.kind).toBe('duplicated')
    if (r.kind === 'duplicated') expect(r.overlapNotice).toBeTruthy()
  })
})
