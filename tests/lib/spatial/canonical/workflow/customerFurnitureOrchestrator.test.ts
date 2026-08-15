/**
 * Cluster A regression lock — customerFurnitureOrchestrator.
 *
 * These tests encode the contract that the radical review found broken: every
 * place/move/edit op must build on the LIVE accumulated scene. The original bug
 * was the screen reading a FROZEN scene snapshot as its mutation base, so a 2nd
 * placement wiped the 1st, rapid edits lost state, etc. The orchestrator takes
 * the scene as an explicit parameter; the screen passes
 * `useCanonicalSceneStore.getState().scene` at a single call site. The
 * `stale-base` test below documents exactly what goes wrong if a caller ever
 * passes a frozen base again.
 */
import { describe, expect, it } from 'vitest'

import {
  deleteFurniture,
  duplicateFurniture,
  moveFurniture,
  placeFurniture,
  resolveSelectedFurnitureTap,
  rotateFurniture,
  scaleFurniture,
  setFurnitureRotationDeg,
  setFurnitureScale,
  snapDegrees,
  FURNITURE_SCALE_MAX,
  FURNITURE_SCALE_MIN,
  FURNITURE_MAX_OBJECTS,
} from '../../../../../src/lib/spatial/canonical/workflow/customerFurnitureOrchestrator.ts'
import { makeObject, makeRoom, vec } from '../__helpers__/sceneFactory.ts'

const ASSET = {
  slug: 'furn-chair-basic',
  objectCategory: 'generic_cuboid' as const,
  dimensions: { width_m: 0.5, depth_m: 0.5, height_m: 0.8 },
}

/** Place a furniture asset at (x,z), asserting it succeeded, and return the
 *  accumulated scene. */
function placeAt(scene: ReturnType<typeof makeRoom>, id: string, x: number, z: number) {
  const result = placeFurniture({
    scene,
    asset: ASSET,
    newId: id,
    generatedAt: '2026-05-29T00:00:00.000Z',
    tapX: x,
    tapZ: z,
  })
  if (result.kind !== 'placed') throw new Error(`expected placed, got ${result.kind}`)
  return result.scene
}

describe('placeFurniture — accumulation (stale-base-place-clobbers-prior)', () => {
  it('placing a 2nd object onto the result of the 1st keeps BOTH', () => {
    const base = makeRoom()
    const afterA = placeAt(base, 'a', 1, 1)
    const afterB = placeAt(afterA, 'b', 2.5, 2)

    const ids = afterB.floor.floor_mounted.map((o) => o.id)
    expect(ids).toEqual(['a', 'b'])
  })

  it('CONTRAST: placing the 2nd object onto the FROZEN base loses the 1st (the bug)', () => {
    const base = makeRoom()
    placeAt(base, 'a', 1, 1) // result discarded — simulates reading the frozen hook
    const afterBOnFrozen = placeAt(base, 'b', 2.5, 2)

    // Building on the frozen base → only 'b' survives. This is precisely the
    // Cluster A blocker; the screen must pass the live store scene instead.
    expect(afterBOnFrozen.floor.floor_mounted.map((o) => o.id)).toEqual(['b'])
  })

  it('clamps an out-of-floor tap inside the room instead of rejecting', () => {
    const result = placeFurniture({
      scene: makeRoom(),
      asset: ASSET,
      newId: 'x',
      generatedAt: '2026-05-29T00:00:00.000Z',
      tapX: 3.95,
      tapZ: 2.9,
    })
    expect(result.kind).toBe('placed')
    if (result.kind === 'placed') {
      const obj = result.scene.floor.floor_mounted.find((o) => o.id === 'x')
      // chair 0.5×0.5 → half 0.25 → centre clamped to (3.75, 2.75) in the 4×3 room.
      expect(obj?.transform.position.x).toBeCloseTo(3.75)
      expect(obj?.transform.position.z).toBeCloseTo(2.75)
    }
  })

  it('rejects placing an object that is larger than the room', () => {
    const result = placeFurniture({
      scene: makeRoom(),
      asset: {
        slug: 'huge',
        objectCategory: 'generic_cuboid' as const,
        dimensions: { width_m: 5, depth_m: 5, height_m: 1 },
      },
      newId: 'big',
      generatedAt: '2026-05-29T00:00:00.000Z',
      tapX: 2,
      tapZ: 1.5,
    })
    expect(result.kind).toBe('rejected')
    if (result.kind === 'rejected') expect(result.message).toBeTruthy()
  })
})

describe('resolveSelectedFurnitureTap', () => {
  it('tapping a DIFFERENT existing object switches selection (just-placed is selectable)', () => {
    const scene = placeAt(placeAt(makeRoom(), 'a', 1, 1), 'b', 2.5, 2)
    const r = resolveSelectedFurnitureTap({
      scene,
      selectedObjectId: 'a',
      tap: { kind: 'object', surfaceExternalId: 'b' },
    })
    expect(r).toEqual({ kind: 'select-object', objectId: 'b' })
  })

  it('tapping a non-existent object id is ignored', () => {
    const scene = placeAt(makeRoom(), 'a', 1, 1)
    const r = resolveSelectedFurnitureTap({
      scene,
      selectedObjectId: 'a',
      tap: { kind: 'object', surfaceExternalId: 'ghost' },
    })
    expect(r.kind).toBe('ignore')
  })

  it('#5b a floor tap DESELECTS the selected object (move is drag-only now)', () => {
    const scene = placeAt(placeAt(makeRoom(), 'a', 1, 1), 'b', 2.5, 2)
    const r = resolveSelectedFurnitureTap({
      scene,
      selectedObjectId: 'a',
      tap: { kind: 'floor', surfaceExternalId: 'floor', worldXyz: vec(2, 0, 1) },
    })
    expect(r).toEqual({ kind: 'deselect' })
  })

  it('#5b a floor tap never mutates the scene (no accidental teleport)', () => {
    const scene = placeAt(makeRoom(), 'a', 1, 1)
    const before = scene.floor.floor_mounted.find((o) => o.id === 'a')!.transform.position
    const r = resolveSelectedFurnitureTap({
      scene,
      selectedObjectId: 'a',
      tap: { kind: 'floor', surfaceExternalId: 'floor', worldXyz: vec(3.95, 0, 2.9) },
    })
    expect(r.kind).toBe('deselect')
    expect(r).not.toHaveProperty('scene')
    // The object stays exactly where it was — the teleport bug is gone.
    expect(scene.floor.floor_mounted.find((o) => o.id === 'a')?.transform.position).toEqual(before)
  })

  it('tapping the selected object itself is ignored (stays selected)', () => {
    const scene = placeAt(makeRoom(), 'a', 1, 1)
    const r = resolveSelectedFurnitureTap({
      scene,
      selectedObjectId: 'a',
      tap: { kind: 'object', surfaceExternalId: 'a' },
    })
    expect(r.kind).toBe('ignore')
  })
})

describe('rotate / scale — last-edit-does-not-win regression', () => {
  it('rotate then scale (each on the prior result) keeps BOTH the rotation and the scale', () => {
    const scene = placeAt(makeRoom(), 'a', 2, 1.5)
    const afterRotate = rotateFurniture({ scene, objectId: 'a' })
    expect(afterRotate).not.toBeNull()
    const afterScale = scaleFurniture({ scene: afterRotate!, objectId: 'a', delta: 0.1 })
    expect(afterScale).not.toBeNull()

    const obj = afterScale!.floor.floor_mounted.find((o) => o.id === 'a')
    // If scale had rebased on the pre-rotate (stale) scene, the 45° would be
    // discarded → this is the exact "rotation lost when scaling" blocker.
    expect(obj?.rotation_around_y_deg).toBe(45)
    expect(obj?.transform.scale.x).toBeCloseTo(1.1)
  })

  it('rotate wraps at 360°', () => {
    let scene = placeAt(makeRoom(), 'a', 2, 1.5)
    for (let i = 0; i < 8; i++) scene = rotateFurniture({ scene, objectId: 'a' })!
    const obj = scene.floor.floor_mounted.find((o) => o.id === 'a')
    expect(obj?.rotation_around_y_deg).toBe(0)
  })

  it('scale at the max clamp produces no change (returns null)', () => {
    const scene = makeRoom({
      floor: {
        ...makeRoom().floor,
        floor_mounted: [
          makeObject({
            id: 'a',
            category: 'generic_cuboid',
            host: 'floor',
            host_id: 'floor',
            transform: { position: vec(2, 0, 1.5), rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: FURNITURE_SCALE_MAX, y: FURNITURE_SCALE_MAX, z: FURNITURE_SCALE_MAX } },
            rotation_around_y_deg: 0,
          }),
        ],
      },
    })
    expect(scaleFurniture({ scene, objectId: 'a', delta: 0.1 })).toBeNull()
  })

  it('returns null when the target object is gone (idempotent no-op)', () => {
    const scene = makeRoom()
    expect(rotateFurniture({ scene, objectId: 'missing' })).toBeNull()
    expect(scaleFurniture({ scene, objectId: 'missing', delta: 0.1 })).toBeNull()
  })
})

describe('duplicate / delete', () => {
  it('duplicate offsets +0.3/+0.3 and keeps the original', () => {
    const scene = placeAt(makeRoom(), 'a', 2, 1.5)
    const result = duplicateFurniture({
      scene,
      objectId: 'a',
      newId: 'a-copy',
      generatedAt: '2026-05-29T00:00:00.000Z',
    })
    expect(result.kind).toBe('duplicated')
    if (result.kind !== 'duplicated') return
    expect(result.scene.floor.floor_mounted.map((o) => o.id)).toEqual(['a', 'a-copy'])
    const clone = result.scene.floor.floor_mounted.find((o) => o.id === 'a-copy')
    expect(clone?.transform.position.x).toBeCloseTo(2.3)
    expect(clone?.transform.position.z).toBeCloseTo(1.8)
  })

  it('#5 duplicate of an object near the edge is rejected when the +0.3 clone leaves the floor', () => {
    // Place at the far corner so the +0.3/+0.3 clone is pushed out of the 4×3 floor.
    const scene = placeAt(makeRoom(), 'a', 3.7, 2.7)
    const result = duplicateFurniture({
      scene,
      objectId: 'a',
      newId: 'a-copy',
      generatedAt: '2026-05-29T00:00:00.000Z',
    })
    expect(result.kind).toBe('rejected')
  })

  it('#5 duplicate is refused once the soft cap is reached', () => {
    const floor = makeRoom().floor
    const many = Array.from({ length: FURNITURE_MAX_OBJECTS }, (_, i) =>
      makeObject({
        id: `o${i}`,
        category: 'generic_cuboid',
        host: 'floor',
        host_id: 'floor',
        transform: { position: vec(2, 0, 1.5), rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
        rotation_around_y_deg: 0,
      }),
    )
    const scene = makeRoom({ floor: { ...floor, floor_mounted: many } })
    const result = duplicateFurniture({
      scene,
      objectId: 'o0',
      newId: 'o-copy',
      generatedAt: '2026-05-29T00:00:00.000Z',
    })
    expect(result.kind).toBe('rejected')
  })

  it('duplicate of a missing object returns { kind:"missing" }', () => {
    const result = duplicateFurniture({
      scene: makeRoom(),
      objectId: 'ghost',
      newId: 'x',
      generatedAt: '2026-05-29T00:00:00.000Z',
    })
    expect(result.kind).toBe('missing')
  })

  it('delete removes only the target object', () => {
    const scene = placeAt(placeAt(makeRoom(), 'a', 1, 1), 'b', 2.5, 2)
    const next = deleteFurniture({ scene, objectId: 'a' })
    expect(next.floor.floor_mounted.map((o) => o.id)).toEqual(['b'])
  })
})

describe('placeFurniture — host gating (#4)', () => {
  it('rejects a wall-hosted asset dropped on the floor with kind "wrong-host"', () => {
    const result = placeFurniture({
      scene: makeRoom(),
      asset: {
        slug: 'deco-wall-mirror',
        objectCategory: 'mirror', // CATEGORY_DEFAULT_HOST.mirror === 'wall'
        dimensions: { width_m: 0.6, depth_m: 0.05, height_m: 0.9 },
      },
      newId: 'm',
      generatedAt: '2026-05-29T00:00:00.000Z',
      tapX: 2,
      tapZ: 1.5,
    })
    expect(result.kind).toBe('wrong-host')
  })

  it('allows a null-category asset (falls back to floor-hosted generic_cuboid)', () => {
    const result = placeFurniture({
      scene: makeRoom(),
      asset: { slug: 'x', objectCategory: null, dimensions: { width_m: 0.5, depth_m: 0.5, height_m: 0.8 } },
      newId: 'n',
      generatedAt: '2026-05-29T00:00:00.000Z',
      tapX: 2,
      tapZ: 1.5,
    })
    expect(result.kind).toBe('placed')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 · FurnitureGestureLayer — continuous move / absolute rotate / scale.
// These power the finger gestures (drag / dial / pinch). Unlike the discrete
// edit ops above, every one re-validates the footprint and the caller HOLDS
// the last valid pose on `rejected`.
// ─────────────────────────────────────────────────────────────────────────────

/** A room with a single floor object placed directly (bypasses placement). */
function roomWith(object: ReturnType<typeof makeObject>) {
  const floor = makeRoom().floor
  return makeRoom({ floor: { ...floor, floor_mounted: [object] } })
}

function floorObj(
  overrides: Partial<ReturnType<typeof makeObject>> = {},
  dims = { width_m: 0.5, depth_m: 0.5, height_m: 0.8 },
) {
  return makeObject({
    id: 'a',
    category: 'generic_cuboid',
    host: 'floor',
    host_id: 'floor',
    dimensions: dims,
    transform: { position: vec(2, 0.7, 1.5), rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
    rotation_around_y_deg: 0,
    ...overrides,
  })
}

describe('snapDegrees', () => {
  it('snaps to the nearest 15° and normalises to [0,360)', () => {
    expect(snapDegrees(0)).toBe(0)
    expect(snapDegrees(7)).toBe(0)
    expect(snapDegrees(8)).toBe(15)
    expect(snapDegrees(44)).toBe(45)
    expect(snapDegrees(360)).toBe(0)
    expect(snapDegrees(370)).toBe(15)
    expect(snapDegrees(-15)).toBe(345)
  })
})

describe('moveFurniture (drag)', () => {
  it('moves to an absolute floor point, preserves y, and reports updated', () => {
    const r = moveFurniture({ scene: roomWith(floorObj()), objectId: 'a', x: 1, z: 1 })
    expect(r.kind).toBe('updated')
    if (r.kind !== 'updated') return
    const obj = r.scene.floor.floor_mounted.find((o) => o.id === 'a')
    expect(obj?.transform.position.x).toBeCloseTo(1)
    expect(obj?.transform.position.z).toBeCloseTo(1)
    expect(obj?.transform.position.y).toBeCloseTo(0.7) // y untouched (derived by renderer)
  })

  it('clamps a drag toward a wall flush instead of freezing', () => {
    const r = moveFurniture({ scene: roomWith(floorObj()), objectId: 'a', x: 3.9, z: 2.9 })
    expect(r.kind).toBe('updated')
    if (r.kind === 'updated') {
      const obj = r.scene.floor.floor_mounted.find((o) => o.id === 'a')
      // 0.5×0.5 footprint → centre clamps to (3.75, 2.75); y is preserved.
      expect(obj?.transform.position.x).toBeCloseTo(3.75)
      expect(obj?.transform.position.z).toBeCloseTo(2.75)
      expect(obj?.transform.position.y).toBeCloseTo(0.7)
    }
  })

  it('rejects a drag of an object larger than the room (caller holds last pose)', () => {
    const big = floorObj({}, { width_m: 5, depth_m: 5, height_m: 0.8 })
    const r = moveFurniture({ scene: roomWith(big), objectId: 'a', x: 2, z: 1.5 })
    expect(r.kind).toBe('rejected')
    expect(r).not.toHaveProperty('scene') // no scene → caller keeps the live store
  })

  it('preserves the other objects when moving one', () => {
    const a = floorObj()
    const b = floorObj({ id: 'b', transform: { position: vec(1, 0, 1), rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } } })
    const scene = makeRoom({ floor: { ...makeRoom().floor, floor_mounted: [a, b] } })
    const r = moveFurniture({ scene, objectId: 'a', x: 2.5, z: 2 })
    expect(r.kind).toBe('updated')
    if (r.kind === 'updated') expect(r.scene.floor.floor_mounted.map((o) => o.id)).toEqual(['a', 'b'])
  })

  it('returns missing when the object is gone', () => {
    expect(moveFurniture({ scene: makeRoom(), objectId: 'ghost', x: 1, z: 1 }).kind).toBe('missing')
  })
})

describe('setFurnitureRotationDeg (dial)', () => {
  it('snaps the angle to 15° and applies it', () => {
    const r = setFurnitureRotationDeg({ scene: roomWith(floorObj()), objectId: 'a', deg: 44 })
    expect(r.kind).toBe('updated')
    if (r.kind === 'updated') {
      expect(r.scene.floor.floor_mounted.find((o) => o.id === 'a')?.rotation_around_y_deg).toBe(45)
    }
  })

  it('rejects a rotation whose rotated footprint leaves the room', () => {
    // A long bar fits axis-aligned (x 0.25–3.75) but at 90° its 3.5m length runs
    // along z (1.5 ± 1.75 → −0.25..3.25) → out of the 4×3 floor.
    const bar = floorObj({}, { width_m: 3.5, depth_m: 0.4, height_m: 0.8 })
    const r = setFurnitureRotationDeg({ scene: roomWith(bar), objectId: 'a', deg: 90 })
    expect(r.kind).toBe('rejected')
  })
})

describe('setFurnitureScale (pinch)', () => {
  it('applies an absolute uniform scale', () => {
    const r = setFurnitureScale({ scene: roomWith(floorObj()), objectId: 'a', scale: 1.5 })
    expect(r.kind).toBe('updated')
    if (r.kind === 'updated') {
      const s = r.scene.floor.floor_mounted.find((o) => o.id === 'a')?.transform.scale
      expect(s).toEqual({ x: 1.5, y: 1.5, z: 1.5 })
    }
  })

  it('clamps to [MIN, MAX]', () => {
    const up = setFurnitureScale({ scene: roomWith(floorObj()), objectId: 'a', scale: 5 })
    const down = setFurnitureScale({ scene: roomWith(floorObj()), objectId: 'a', scale: 0.05 })
    expect(up.kind === 'updated' && up.scene.floor.floor_mounted[0].transform.scale.x).toBe(FURNITURE_SCALE_MAX)
    expect(down.kind === 'updated' && down.scene.floor.floor_mounted[0].transform.scale.x).toBe(FURNITURE_SCALE_MIN)
  })

  it('rejects a scale-up that grows the footprint out of the room', () => {
    // 3×2 object fits at 1× (x 0.5–3.5, z 0.5–2.5); at 1.4× width 4.2 runs out.
    const big = floorObj({}, { width_m: 3, depth_m: 2, height_m: 0.8 })
    const r = setFurnitureScale({ scene: roomWith(big), objectId: 'a', scale: 1.4 })
    expect(r.kind).toBe('rejected')
  })
})

describe('cross-feature isolation', () => {
  it('rotating furniture leaves wall openings untouched (no cross-feature clobber)', () => {
    const room = makeRoom()
    const withOpening = makeRoom({
      walls: room.walls.map((w, i) =>
        i === 0
          ? {
              ...w,
              openings: [
                {
                  ...w,
                  id: 'door1',
                  type: 'door' as const,
                  offset_along_wall_m: 1,
                  offset_from_floor_m: 0,
                  width_m: 0.9,
                  height_m: 2,
                  is_walkable_portal: true,
                },
              ],
            }
          : w,
      ),
    })
    const scene = placeAt(withOpening, 'a', 2, 1.5)
    const afterRotate = rotateFurniture({ scene, objectId: 'a' })!
    expect(afterRotate.walls[0].openings.map((o) => o.id)).toEqual(['door1'])
  })
})
