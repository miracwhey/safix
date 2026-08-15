/**
 * Tests for canonical/commands/* — the 8 Phase-2 edit commands + BaseCommand.
 *
 * Each command is exercised do / undo / redo against the live canonical scene
 * store, asserting the override stack (and, for add_door, the base scene) is
 * mutated exactly as the EditOperation describes — and that undo is a verbatim
 * inverse.
 */
import { describe, it, expect, beforeEach } from 'vitest'

import { useCanonicalSceneStore } from '../../../../../src/lib/spatial/canonical/store/sceneStore.ts'
import {
  MoveNodeCommand,
  ResizeWallCommand,
  AddDoorCommand,
  DeleteNodeCommand,
  SnapObjectCommand,
  SetMaterialCommand,
  MovePinCommand,
  SetRoomHeightCommand,
} from '../../../../../src/lib/spatial/canonical/commands/index.ts'
import { DELETION_MARKER_KEY } from '../../../../../src/lib/spatial/canonical/overrides/layer-merge.ts'
import {
  IDENTITY_QUATERNION,
  ONE_VECTOR3,
} from '../../../../../src/lib/spatial/canonical/types/primitives.ts'
import type { Transform } from '../../../../../src/lib/spatial/canonical/types/primitives.ts'
import type { WallOpening } from '../../../../../src/lib/spatial/canonical/types/geometry.ts'
import type { PinAnchor } from '../../../../../src/lib/spatial/canonical/types/commands.ts'
import { makeRoom } from '../__helpers__/sceneFactory.ts'

const VARIANT = 'customer_corrections'

/** The live store as a SceneEditContext. */
function ctx() {
  return useCanonicalSceneStore.getState()
}

function overridesFor(nodeId: string) {
  return ctx().overrides.filter((o) => o.base_node_id === nodeId && o.variant_id === VARIANT)
}

function transformAt(pos: { x: number; y: number; z: number }): Transform {
  return { position: pos, rotation: { ...IDENTITY_QUATERNION }, scale: { ...ONE_VECTOR3 } }
}

beforeEach(() => {
  const store = useCanonicalSceneStore.getState()
  store.setScene(makeRoom())
  store.setOverrides([])
  store.setVariants([
    { id: 'base_roomplan', display_name: 'Scan', is_default: true },
    { id: VARIANT, display_name: 'Customer', is_default: false, parent_variant_id: 'base_roomplan' },
  ])
})

// ── move_node ────────────────────────────────────────────────────────────────

describe('MoveNodeCommand', () => {
  it('writes a transform override on do, removes it on undo', () => {
    const cmd = new MoveNodeCommand({
      nodeId: 'obj_1',
      newTransform: transformAt({ x: 1, y: 0, z: 2 }),
      variantId: VARIANT,
    })
    cmd.do(ctx())
    expect(overridesFor('obj_1')).toHaveLength(1)
    expect(overridesFor('obj_1')[0].override_fields.transform).toEqual(transformAt({ x: 1, y: 0, z: 2 }))

    cmd.undo(ctx())
    expect(overridesFor('obj_1')).toHaveLength(0)

    cmd.redo(ctx())
    expect(overridesFor('obj_1')[0].override_fields.transform).toEqual(transformAt({ x: 1, y: 0, z: 2 }))
  })

  it('undo restores a pre-existing override verbatim', () => {
    ctx().upsertOverride({
      base_node_id: 'obj_1',
      variant_id: VARIANT,
      override_fields: { transform: transformAt({ x: 9, y: 9, z: 9 }), material_id: 'keep_me' },
    })
    const cmd = new MoveNodeCommand({
      nodeId: 'obj_1',
      newTransform: transformAt({ x: 1, y: 0, z: 2 }),
      variantId: VARIANT,
    })
    cmd.do(ctx())
    // unrelated field survives the shallow merge
    expect(overridesFor('obj_1')[0].override_fields.material_id).toBe('keep_me')

    cmd.undo(ctx())
    expect(overridesFor('obj_1')).toHaveLength(1)
    expect(overridesFor('obj_1')[0].override_fields.transform).toEqual(transformAt({ x: 9, y: 9, z: 9 }))
  })
})

// ── resize_wall ──────────────────────────────────────────────────────────────

describe('ResizeWallCommand', () => {
  it('writes height + thickness together, reverts on undo', () => {
    const cmd = new ResizeWallCommand({
      wallId: 'w_s',
      newHeightM: 2.8,
      newThicknessM: 0.25,
      variantId: VARIANT,
    })
    cmd.do(ctx())
    expect(overridesFor('w_s')[0].override_fields).toMatchObject({ height_m: 2.8, thickness_m: 0.25 })

    cmd.undo(ctx())
    expect(overridesFor('w_s')).toHaveLength(0)
  })
})

// ── add_door ─────────────────────────────────────────────────────────────────

describe('AddDoorCommand', () => {
  const door: WallOpening = {
    id: 'door_new',
    type: 'door',
    parent_id: 'w_s',
    children_ids: [],
    transform: transformAt({ x: 0, y: 0, z: 0 }),
    source: 'manual',
    confidence: 1,
    variant_id: 'base_roomplan',
    created_at: '2026-05-20T00:00:00.000Z',
    updated_at: '2026-05-20T00:00:00.000Z',
    host_wall_id: 'w_s',
    offset_along_wall_m: 1.2,
    offset_from_floor_m: 0,
    width_m: 0.9,
    height_m: 2.0,
    is_walkable_portal: true,
  }

  it('appends the door to the host wall on do, removes it on undo', () => {
    const cmd = new AddDoorCommand({ wallId: 'w_s', door, variantId: VARIANT })
    cmd.do(ctx())
    const wallAfter = ctx().scene!.walls.find((w) => w.id === 'w_s')!
    expect(wallAfter.openings.map((o) => o.id)).toContain('door_new')
    // door is stamped onto the active variant
    expect(wallAfter.openings.find((o) => o.id === 'door_new')!.variant_id).toBe(VARIANT)

    cmd.undo(ctx())
    expect(ctx().scene!.walls.find((w) => w.id === 'w_s')!.openings.map((o) => o.id)).not.toContain('door_new')

    cmd.redo(ctx())
    expect(ctx().scene!.walls.find((w) => w.id === 'w_s')!.openings.map((o) => o.id)).toContain('door_new')
  })

  it('is idempotent — re-running do never duplicates the door', () => {
    const cmd = new AddDoorCommand({ wallId: 'w_s', door, variantId: VARIANT })
    cmd.do(ctx())
    cmd.do(ctx())
    const openings = ctx().scene!.walls.find((w) => w.id === 'w_s')!.openings
    expect(openings.filter((o) => o.id === 'door_new')).toHaveLength(1)
  })
})

// ── delete_node ──────────────────────────────────────────────────────────────

describe('DeleteNodeCommand', () => {
  it('writes the __deleted marker, removes it on undo', () => {
    const cmd = new DeleteNodeCommand({ nodeId: 'w_e', variantId: VARIANT })
    cmd.do(ctx())
    expect(overridesFor('w_e')[0].override_fields[DELETION_MARKER_KEY]).toBe(true)

    cmd.undo(ctx())
    expect(overridesFor('w_e')).toHaveLength(0)
  })

  it('undo restores the prior override instead of leaving the node deleted', () => {
    ctx().upsertOverride({
      base_node_id: 'w_e',
      variant_id: VARIANT,
      override_fields: { material_id: 'tile_blue' },
    })
    const cmd = new DeleteNodeCommand({ nodeId: 'w_e', variantId: VARIANT })
    cmd.do(ctx())
    expect(overridesFor('w_e')[0].override_fields[DELETION_MARKER_KEY]).toBe(true)

    cmd.undo(ctx())
    expect(overridesFor('w_e')[0].override_fields).toEqual({ material_id: 'tile_blue' })
  })
})

// ── snap_object ──────────────────────────────────────────────────────────────

describe('SnapObjectCommand', () => {
  it('writes host, host_id and transform as one override', () => {
    const cmd = new SnapObjectCommand({
      objectId: 'sink_1',
      newHost: 'wall',
      newHostId: 'w_n',
      snap: transformAt({ x: 2, y: 0.85, z: 3 }),
      variantId: VARIANT,
    })
    cmd.do(ctx())
    expect(overridesFor('sink_1')[0].override_fields).toMatchObject({
      host: 'wall',
      host_id: 'w_n',
      transform: transformAt({ x: 2, y: 0.85, z: 3 }),
    })

    cmd.undo(ctx())
    expect(overridesFor('sink_1')).toHaveLength(0)
  })

  it('accepts a raw SnapResult and converts rotationYDeg to a quaternion', () => {
    const cmd = new SnapObjectCommand({
      objectId: 'sink_1',
      newHost: 'floor',
      newHostId: 'floor',
      snap: { position: { x: 1, y: 0, z: 1 }, rotationYDeg: 90 },
      variantId: VARIANT,
    })
    cmd.do(ctx())
    const t = overridesFor('sink_1')[0].override_fields.transform as Transform
    // 90° about Y → quaternion (0, sin45, 0, cos45)
    expect(t.rotation.y).toBeCloseTo(Math.SQRT1_2, 6)
    expect(t.rotation.w).toBeCloseTo(Math.SQRT1_2, 6)
  })
})

// ── set_material ─────────────────────────────────────────────────────────────

describe('SetMaterialCommand', () => {
  it('writes a material_id override, reverts on undo', () => {
    const cmd = new SetMaterialCommand({
      nodeId: 'w_s',
      surface: 'wall',
      materialId: 'wall-tile-white',
      variantId: VARIANT,
    })
    cmd.do(ctx())
    expect(overridesFor('w_s')[0].override_fields.material_id).toBe('wall-tile-white')

    cmd.undo(ctx())
    expect(overridesFor('w_s')).toHaveLength(0)
  })

  it('undo restores the prior material when one existed', () => {
    new SetMaterialCommand({ nodeId: 'w_s', surface: 'wall', materialId: 'm_a', variantId: VARIANT }).do(ctx())
    const second = new SetMaterialCommand({ nodeId: 'w_s', surface: 'wall', materialId: 'm_b', variantId: VARIANT })
    second.do(ctx())
    expect(overridesFor('w_s')[0].override_fields.material_id).toBe('m_b')

    second.undo(ctx())
    expect(overridesFor('w_s')[0].override_fields.material_id).toBe('m_a')
  })
})

// ── move_pin ─────────────────────────────────────────────────────────────────

describe('MovePinCommand', () => {
  const anchor: PinAnchor = {
    anchor_surface_id: 'w_n',
    anchor_surface_type: 'wall',
    anchor_uv: { u: 0.3, v: 0.7 },
    anchor_offset_normal_m: 0.02,
  }

  it('writes the 4 anchor fields together, reverts on undo', () => {
    const cmd = new MovePinCommand({ pinId: 'pin_1', newAnchor: anchor, variantId: VARIANT })
    cmd.do(ctx())
    expect(overridesFor('pin_1')[0].override_fields).toMatchObject({
      anchor_surface_id: 'w_n',
      anchor_surface_type: 'wall',
      anchor_uv: { u: 0.3, v: 0.7 },
      anchor_offset_normal_m: 0.02,
    })

    cmd.undo(ctx())
    expect(overridesFor('pin_1')).toHaveLength(0)
  })
})

// ── set_room_height ──────────────────────────────────────────────────────────

describe('SetRoomHeightCommand', () => {
  it('writes a height_m override on the ceiling AND every listed wall', () => {
    const cmd = new SetRoomHeightCommand({
      roomId: 'room',
      ceilingId: 'ceiling',
      wallIds: ['w_s', 'w_e', 'w_n', 'w_w'],
      newHeightM: 3.0,
      variantId: VARIANT,
    })
    cmd.do(ctx())
    for (const id of ['ceiling', 'w_s', 'w_e', 'w_n', 'w_w']) {
      expect(overridesFor(id)[0].override_fields.height_m).toBe(3.0)
    }

    cmd.undo(ctx())
    for (const id of ['ceiling', 'w_s', 'w_e', 'w_n', 'w_w']) {
      expect(overridesFor(id)).toHaveLength(0)
    }
  })

  it('undo restores per-node prior overrides', () => {
    ctx().upsertOverride({
      base_node_id: 'w_s',
      variant_id: VARIANT,
      override_fields: { height_m: 2.4, material_id: 'keep' },
    })
    const cmd = new SetRoomHeightCommand({
      roomId: 'room',
      ceilingId: 'ceiling',
      wallIds: ['w_s'],
      newHeightM: 3.0,
      variantId: VARIANT,
    })
    cmd.do(ctx())
    expect(overridesFor('w_s')[0].override_fields).toMatchObject({ height_m: 3.0, material_id: 'keep' })

    cmd.undo(ctx())
    expect(overridesFor('w_s')[0].override_fields).toEqual({ height_m: 2.4, material_id: 'keep' })
    expect(overridesFor('ceiling')).toHaveLength(0)
  })
})

// ── variant targeting ────────────────────────────────────────────────────────

describe('command variant targeting', () => {
  it('always writes to the variant passed at construction, never base', () => {
    const cmd = new SetMaterialCommand({
      nodeId: 'w_s',
      surface: 'wall',
      materialId: 'm_x',
      variantId: 'provider_42_annotations',
    })
    cmd.do(ctx())
    const written = ctx().overrides.filter((o) => o.base_node_id === 'w_s')
    expect(written).toHaveLength(1)
    expect(written[0].variant_id).toBe('provider_42_annotations')
    expect(written[0].variant_id).not.toBe('base_roomplan')
  })
})

// ── F2 · before-snapshot captured exactly once ───────────────────────────────

describe('BaseCommand · before-snapshot capture (idempotent do)', () => {
  it('a second do() reuses the ORIGINAL before-state — undo stays exact', () => {
    // Pre-existing override — this is the TRUE pre-edit state the inverse must
    // restore. A second do() must NOT re-snapshot the (now post-edit) store.
    ctx().upsertOverride({
      base_node_id: 'obj_1',
      variant_id: VARIANT,
      override_fields: { transform: transformAt({ x: 9, y: 9, z: 9 }) },
    })
    const cmd = new MoveNodeCommand({
      nodeId: 'obj_1',
      newTransform: transformAt({ x: 1, y: 0, z: 2 }),
      variantId: VARIANT,
    })
    cmd.do(ctx())
    // Second do() with no intervening undo — the corruption trigger.
    cmd.do(ctx())
    expect(overridesFor('obj_1')[0].override_fields.transform).toEqual(transformAt({ x: 1, y: 0, z: 2 }))

    // Undo must still restore the ORIGINAL (9,9,9), not the post-do state.
    cmd.undo(ctx())
    expect(overridesFor('obj_1')).toHaveLength(1)
    expect(overridesFor('obj_1')[0].override_fields.transform).toEqual(transformAt({ x: 9, y: 9, z: 9 }))
  })

  it('a second do() on a clean (all-base) node still undoes to base', () => {
    // No pre-existing override — the before-snapshot is an EMPTY array, the
    // case a truthy-array guard would mis-classify as "never captured".
    const cmd = new MoveNodeCommand({
      nodeId: 'obj_2',
      newTransform: transformAt({ x: 3, y: 0, z: 3 }),
      variantId: VARIANT,
    })
    cmd.do(ctx())
    cmd.do(ctx())
    expect(overridesFor('obj_2')).toHaveLength(1)

    cmd.undo(ctx())
    // Undo removes the override entirely — back to pure base state.
    expect(overridesFor('obj_2')).toHaveLength(0)
  })
})

// ── F4 · node-adding command undo symmetry ───────────────────────────────────

describe('AddDoorCommand · undo symmetry', () => {
  const door: WallOpening = {
    id: 'door_f4',
    type: 'door',
    parent_id: 'w_s',
    children_ids: [],
    transform: transformAt({ x: 0, y: 0, z: 0 }),
    source: 'manual',
    confidence: 1,
    variant_id: 'base_roomplan',
    created_at: '2026-05-20T00:00:00.000Z',
    updated_at: '2026-05-20T00:00:00.000Z',
    host_wall_id: 'w_s',
    offset_along_wall_m: 1.2,
    offset_from_floor_m: 0,
    width_m: 0.9,
    height_m: 2.0,
    is_walkable_portal: true,
  }

  it('undo throws instead of silently no-ooping when the base scene changed', () => {
    const cmd = new AddDoorCommand({ wallId: 'w_s', door, variantId: VARIANT })
    cmd.do(ctx())
    // The base scene is REPLACED — a fresh room without the added door.
    ctx().setScene(makeRoom())
    // undo can no longer remove the door it added — it MUST surface a failure.
    expect(() => cmd.undo(ctx())).toThrow(/door_f4|no longer/)
  })

  it('undo throws when the host wall is gone', () => {
    const cmd = new AddDoorCommand({ wallId: 'w_s', door, variantId: VARIANT })
    cmd.do(ctx())
    const room = ctx().scene!
    ctx().setScene({ ...room, walls: room.walls.filter((w) => w.id !== 'w_s') })
    expect(() => cmd.undo(ctx())).toThrow()
  })

  it('undo still succeeds normally when the scene is intact', () => {
    const cmd = new AddDoorCommand({ wallId: 'w_s', door, variantId: VARIANT })
    cmd.do(ctx())
    expect(() => cmd.undo(ctx())).not.toThrow()
    expect(ctx().scene!.walls.find((w) => w.id === 'w_s')!.openings.map((o) => o.id)).not.toContain('door_f4')
  })
})

// ── EditCommand serialisation ────────────────────────────────────────────────

describe('BaseCommand.toEditCommand', () => {
  it('captures operation, label, variant and before/after snapshots', () => {
    const cmd = new MoveNodeCommand({
      nodeId: 'obj_1',
      newTransform: transformAt({ x: 5, y: 0, z: 0 }),
      variantId: VARIANT,
    })
    cmd.do(ctx())
    const ec = cmd.toEditCommand()
    expect(ec.operation.kind).toBe('move_node')
    expect(ec.label).toBe('Verschoben')
    expect(ec.variant_id).toBe(VARIANT)
    expect(ec.before).toHaveLength(0)
    expect(ec.after).toHaveLength(1)
    expect(ec.after[0].base_node_id).toBe('obj_1')
    expect(typeof ec.id).toBe('string')
    expect(typeof ec.timestamp).toBe('number')
  })
})
