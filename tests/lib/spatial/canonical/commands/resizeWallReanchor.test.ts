/**
 * F11 — ResizeWallCommand child re-anchoring.
 *
 * When a wall is resized shorter, its hosted children (door / window openings
 * and wall-mounted objects) can hang above the new wall top. `ResizeWallCommand`,
 * given the resolved host wall, re-anchors them in the SAME operation:
 *   - a child that still fits has its vertical offset clamped;
 *   - a child taller than the new wall is dropped (`__deleted` marker);
 *   - dropped / clamped children ride the command's snapshot so `undo()`
 *     restores them verbatim alongside the wall.
 *
 * The legacy 3-arg path (no `wall` supplied) must keep resizing the wall only.
 */
import { describe, it, expect, beforeEach } from 'vitest'

import { useCanonicalSceneStore } from '../../../../../src/lib/spatial/canonical/store/sceneStore.ts'
import { ResizeWallCommand } from '../../../../../src/lib/spatial/canonical/commands/ResizeWallCommand.ts'
import { DELETION_MARKER_KEY } from '../../../../../src/lib/spatial/canonical/overrides/layer-merge.ts'
import { makeRoom, makeWall, makeOpening, makeObject } from '../__helpers__/sceneFactory.ts'
import type { Wall } from '../../../../../src/lib/spatial/canonical/types/geometry.ts'

const VARIANT = 'customer_corrections'

function ctx() {
  return useCanonicalSceneStore.getState()
}

function overridesFor(nodeId: string) {
  return ctx().overrides.filter((o) => o.base_node_id === nodeId && o.variant_id === VARIANT)
}

/** A 2.5 m-tall south wall hosting a 2 m window (sill 1.0 m) + a wall radiator. */
function wallWithChildren(): Wall {
  const window = makeOpening({
    id: 'win_s', host_wall_id: 'w_s', type: 'window',
    offset_along_wall_m: 1, offset_from_floor_m: 1.0, width_m: 1.2, height_m: 1.0,
  })
  const radiator = makeObject({
    id: 'rad_s', category: 'radiator', host: 'wall', host_id: 'w_s',
    dimensions: { width_m: 0.8, depth_m: 0.1, height_m: 0.6 },
    height_from_floor_m: 1.7,
  })
  return makeWall({
    id: 'w_s',
    start_point: { x: 0, y: 0, z: 0 },
    end_point: { x: 4, y: 0, z: 0 },
    height_m: 2.5,
    openings: [window],
    wall_mounted: [radiator],
  })
}

beforeEach(() => {
  const store = useCanonicalSceneStore.getState()
  const wall = wallWithChildren()
  const base = makeRoom()
  store.setScene(makeRoom({ walls: [wall, ...base.walls.filter((w) => w.id !== 'w_s')] }))
  store.setOverrides([])
  store.setVariants([
    { id: 'base_roomplan', display_name: 'Scan', is_default: true },
    { id: VARIANT, display_name: 'Customer', is_default: false, parent_variant_id: 'base_roomplan' },
  ])
})

describe('ResizeWallCommand · F11 child re-anchoring', () => {
  it('clamps a window sill so its top edge sits at the new (shorter) wall top', () => {
    // Wall 2.5 → 1.6 m. Window is 1.0 m tall at sill 1.0 → top 2.0 > 1.6.
    // It still FITS (1.0 ≤ 1.6) so the sill clamps to 1.6 − 1.0 = 0.6 m.
    const cmd = new ResizeWallCommand({
      wallId: 'w_s', newHeightM: 1.6, newThicknessM: 0.2,
      variantId: VARIANT, wall: wallWithChildren(),
    })
    cmd.do(ctx())
    const winOv = overridesFor('win_s')[0]
    expect(winOv.override_fields.offset_from_floor_m).toBeCloseTo(0.6, 6)
    expect(winOv.override_fields.sill_height_m).toBeCloseTo(0.6, 6)
    expect(cmd.reanchorWarnings.some((w) => w.includes('win_s'))).toBe(true)
  })

  it('clamps a wall-mounted object that hangs above the new wall top', () => {
    // Wall 2.5 → 2.0 m. Radiator 0.6 m tall at height_from_floor 1.7 → top 2.3
    // > 2.0; it fits (0.6 ≤ 2.0) so height_from_floor clamps to 2.0 − 0.6 = 1.4.
    const cmd = new ResizeWallCommand({
      wallId: 'w_s', newHeightM: 2.0, newThicknessM: 0.2,
      variantId: VARIANT, wall: wallWithChildren(),
    })
    cmd.do(ctx())
    expect(overridesFor('rad_s')[0].override_fields.height_from_floor_m).toBeCloseTo(1.4, 6)
  })

  it('drops a child taller than the new wall via the __deleted marker', () => {
    // Wall 2.5 → 0.8 m. The 1.0 m window cannot fit at any sill → dropped.
    const cmd = new ResizeWallCommand({
      wallId: 'w_s', newHeightM: 0.8, newThicknessM: 0.2,
      variantId: VARIANT, wall: wallWithChildren(),
    })
    cmd.do(ctx())
    expect(overridesFor('win_s')[0].override_fields[DELETION_MARKER_KEY]).toBe(true)
    expect(cmd.reanchorWarnings.some((w) => w.includes('removed'))).toBe(true)
  })

  it('leaves children that already fit untouched (no override written)', () => {
    // Wall 2.5 → 2.4 m. Window top 2.0 ≤ 2.4, radiator top 2.3 ≤ 2.4 — both fit.
    const cmd = new ResizeWallCommand({
      wallId: 'w_s', newHeightM: 2.4, newThicknessM: 0.2,
      variantId: VARIANT, wall: wallWithChildren(),
    })
    cmd.do(ctx())
    expect(overridesFor('win_s')).toHaveLength(0)
    expect(overridesFor('rad_s')).toHaveLength(0)
    expect(cmd.reanchorWarnings).toEqual([])
  })

  it('undo restores the wall AND every re-anchored child verbatim', () => {
    const cmd = new ResizeWallCommand({
      wallId: 'w_s', newHeightM: 1.6, newThicknessM: 0.2,
      variantId: VARIANT, wall: wallWithChildren(),
    })
    cmd.do(ctx())
    expect(overridesFor('w_s')).toHaveLength(1)
    expect(overridesFor('win_s')).toHaveLength(1)

    cmd.undo(ctx())
    // No prior overrides existed → undo removes the wall + child overrides.
    expect(overridesFor('w_s')).toHaveLength(0)
    expect(overridesFor('win_s')).toHaveLength(0)
    expect(overridesFor('rad_s')).toHaveLength(0)

    cmd.redo(ctx())
    expect(overridesFor('win_s')[0].override_fields.offset_from_floor_m).toBeCloseTo(0.6, 6)
  })

  it('the dropped child stays dropped in the RESOLVED scene', () => {
    const cmd = new ResizeWallCommand({
      wallId: 'w_s', newHeightM: 0.8, newThicknessM: 0.2,
      variantId: VARIANT, wall: wallWithChildren(),
    })
    ctx().setActiveVariantId(VARIANT)
    cmd.do(ctx())
    const resolvedWall = ctx().resolved!.walls.find((w) => w.id === 'w_s')!
    expect(resolvedWall.openings.some((o) => o.id === 'win_s')).toBe(false)
  })

  it('writes height + thickness on the wall regardless of children', () => {
    const cmd = new ResizeWallCommand({
      wallId: 'w_s', newHeightM: 1.6, newThicknessM: 0.3,
      variantId: VARIANT, wall: wallWithChildren(),
    })
    cmd.do(ctx())
    expect(overridesFor('w_s')[0].override_fields).toMatchObject({ height_m: 1.6, thickness_m: 0.3 })
  })

  it('legacy 3-arg path (no wall supplied) resizes the wall only', () => {
    const cmd = new ResizeWallCommand({
      wallId: 'w_s', newHeightM: 1.6, newThicknessM: 0.2, variantId: VARIANT,
    })
    cmd.do(ctx())
    expect(overridesFor('w_s')).toHaveLength(1)
    // No re-anchor — children untouched, no warnings.
    expect(overridesFor('win_s')).toHaveLength(0)
    expect(cmd.reanchorWarnings).toEqual([])
  })
})
