/**
 * AddWallCommand / DeleteWallCommand — Lane-2.5 manual base-scene commands.
 * These had ZERO coverage (recon gap). Exercised against the live store: field
 * derivation, variant/source stamping, idempotent redo, verbatim undo restore.
 * (Floor/ceiling re-derivation is covered in geometry/floorDeriveAfterWallEdit.)
 */
import { describe, it, expect, beforeEach } from 'vitest'

import { useCanonicalSceneStore } from '../../../../../src/lib/spatial/canonical/store/sceneStore.ts'
import {
  AddWallCommand,
  DeleteWallCommand,
} from '../../../../../src/lib/spatial/canonical/commands/index.ts'
import { buildEmptyCanvasPreset } from '../../../../../src/lib/spatial/canonical/presets/presetEmptyRoom.ts'

const ROOM = 'room_1'
const VARIANT = 'customer_corrections'
const T = '2026-06-04T00:00:00.000Z'

function ctx() {
  return useCanonicalSceneStore.getState()
}

beforeEach(() => {
  ctx().setScene(buildEmptyCanvasPreset({ roomNodeId: ROOM, createdAt: T }))
  ctx().setOverrides([])
})

describe('AddWallCommand', () => {
  it('derives length + outward normal, stamps variant + manual source', () => {
    new AddWallCommand({
      wallId: 'w1',
      roomId: ROOM,
      start: { x: 0, y: 0, z: 0 },
      end: { x: 4, y: 0, z: 0 },
      heightM: 2.5,
      thicknessM: 0.15,
      variantId: VARIANT,
      createdAt: T,
    }).do(ctx())
    const w = ctx().scene!.walls.find((x) => x.id === 'w1')!
    expect(w.length_m).toBeCloseTo(4, 6)
    // (0,0,0)→(4,0,0): normal = (dz/len, 0, -dx/len) = (0, 0, -1)
    expect(w.normal.x).toBeCloseTo(0, 6)
    expect(w.normal.z).toBeCloseTo(-1, 6)
    expect(w.variant_id).toBe(VARIANT)
    expect(w.source).toBe('manual')
  })

  it('redo is idempotent (no duplicate wall); undo removes it', () => {
    const cmd = new AddWallCommand({
      wallId: 'w1',
      roomId: ROOM,
      start: { x: 0, y: 0, z: 0 },
      end: { x: 4, y: 0, z: 0 },
      heightM: 2.5,
      variantId: VARIANT,
      createdAt: T,
    })
    cmd.do(ctx())
    cmd.do(ctx()) // idempotent re-apply — must NOT duplicate
    expect(ctx().scene!.walls.filter((w) => w.id === 'w1')).toHaveLength(1)
    cmd.undo(ctx())
    expect(ctx().scene!.walls.some((w) => w.id === 'w1')).toBe(false)
  })
})

describe('DeleteWallCommand', () => {
  it('removes the wall; undo restores its geometry verbatim', () => {
    new AddWallCommand({
      wallId: 'w1',
      roomId: ROOM,
      start: { x: 1, y: 0, z: 2 },
      end: { x: 4, y: 0, z: 2 },
      heightM: 2.6,
      thicknessM: 0.2,
      variantId: VARIANT,
      createdAt: T,
    }).do(ctx())
    const before = ctx().scene!.walls.find((w) => w.id === 'w1')!
    const del = new DeleteWallCommand({ wallId: 'w1', roomId: ROOM, variantId: VARIANT })
    del.do(ctx())
    expect(ctx().scene!.walls.some((w) => w.id === 'w1')).toBe(false)
    del.undo(ctx())
    const after = ctx().scene!.walls.find((w) => w.id === 'w1')!
    expect(after.start_point).toEqual(before.start_point)
    expect(after.end_point).toEqual(before.end_point)
    expect(after.height_m).toBe(before.height_m)
    expect(after.thickness_m).toBe(before.thickness_m)
  })
})
