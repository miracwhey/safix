/**
 * Tests for canonical/store/editHistoryStore.ts — the command-stack store.
 *
 * Covers: apply against the override stack, undo/redo round-trips, redo-clear
 * on a fresh apply, the 50-command cap, that commands target the active
 * variant, the Block-2.6 hard-reject gate (`apply` returns `applied:false`
 * and never pushes / never writes for an illegal command), the Block-2.10
 * RBAC gate (a foreign-variant command is rejected before any override is
 * written — spy-rejection), and the §8.3 auto-snap adoption (the persisted
 * override carries the snapped transform).
 */
import { describe, it, expect, beforeEach } from 'vitest'

import { useCanonicalSceneStore } from '../../../../../src/lib/spatial/canonical/store/sceneStore.ts'
import {
  useEditHistoryStore,
  UNDO_STACK_CAP,
} from '../../../../../src/lib/spatial/canonical/store/editHistoryStore.ts'
import {
  SetMaterialCommand,
  MoveNodeCommand,
} from '../../../../../src/lib/spatial/canonical/commands/index.ts'
import {
  IDENTITY_QUATERNION,
  ONE_VECTOR3,
} from '../../../../../src/lib/spatial/canonical/types/primitives.ts'
import type { SpatialEditUser } from '../../../../../src/lib/spatial/workflow/spatialEditPermissions.ts'
import { providerAnnotationsVariantId } from '../../../../../src/lib/spatial/canonical/types/variants.ts'
import { makeRoom, makeObject } from '../__helpers__/sceneFactory.ts'

const VARIANT = 'customer_corrections'

/** A customer whose role-correct writable variant IS `customer_corrections`. */
const CUSTOMER: SpatialEditUser = {
  userId: 'cust-test',
  role: 'customer',
  isOperator: false,
}

function scene() {
  return useCanonicalSceneStore.getState()
}
function history() {
  return useEditHistoryStore.getState()
}
/** Apply through the store as the test customer — passes the RBAC gate. */
function applyAs(cmd: Parameters<ReturnType<typeof history>['apply']>[0]) {
  return history().apply(cmd, CUSTOMER)
}
function materialOf(nodeId: string): unknown {
  return scene().overrides.find((o) => o.base_node_id === nodeId && o.variant_id === VARIANT)
    ?.override_fields.material_id
}
function setMaterial(nodeId: string, slug: string) {
  return new SetMaterialCommand({ nodeId, surface: 'wall', materialId: slug, variantId: VARIANT })
}

/** A room seeded with N free floor-objects so move/cap tests target real nodes. */
function roomWithObjects(n: number) {
  const free_objects = Array.from({ length: n }, (_, i) =>
    makeObject({
      id: `obj_${i}`,
      category: 'generic_cuboid',
      host: 'free',
      host_id: 'floor',
      transform: { position: { x: 1, y: 0, z: 1 }, rotation: IDENTITY_QUATERNION, scale: ONE_VECTOR3 },
    }),
  )
  return makeRoom({ free_objects })
}

beforeEach(() => {
  const s = useCanonicalSceneStore.getState()
  s.setScene(roomWithObjects(UNDO_STACK_CAP + 10))
  s.setOverrides([])
  s.setVariants([
    { id: 'base_roomplan', display_name: 'Scan', is_default: true },
    { id: VARIANT, display_name: 'Customer', is_default: false, parent_variant_id: 'base_roomplan' },
  ])
  s.setActiveVariantId(VARIANT)
  useEditHistoryStore.getState().clear()
})

describe('editHistoryStore · apply', () => {
  it('executes the command against the scene override stack', () => {
    applyAs(setMaterial('w_s', 'm_a'))
    expect(materialOf('w_s')).toBe('m_a')
    expect(history().undoStack).toHaveLength(1)
    expect(history().canUndo).toBe(true)
    expect(history().canRedo).toBe(false)
  })

  it('returns an applied:true result with the serialisable EditCommand', () => {
    const result = applyAs(setMaterial('w_s', 'm_a'))
    expect(result.applied).toBe(true)
    if (!result.applied) throw new Error('expected applied')
    expect(result.command.operation.kind).toBe('set_material')
    expect(result.command.variant_id).toBe(VARIANT)
    expect(result.command.after).toHaveLength(1)
    expect(result.warnings).toEqual([])
  })
})

describe('editHistoryStore · undo / redo', () => {
  it('undo reverts the scene and moves the command to the redo stack', () => {
    applyAs(setMaterial('w_s', 'm_a'))
    history().undo()
    expect(materialOf('w_s')).toBeUndefined()
    expect(history().undoStack).toHaveLength(0)
    expect(history().redoStack).toHaveLength(1)
    expect(history().canUndo).toBe(false)
    expect(history().canRedo).toBe(true)
  })

  it('redo re-applies the command', () => {
    applyAs(setMaterial('w_s', 'm_a'))
    history().undo()
    history().redo()
    expect(materialOf('w_s')).toBe('m_a')
    expect(history().undoStack).toHaveLength(1)
    expect(history().redoStack).toHaveLength(0)
  })

  it('undo on an empty stack is a no-op returning null', () => {
    expect(history().undo()).toBeNull()
    expect(history().redo()).toBeNull()
  })

  it('round-trips a multi-command sequence in LIFO order', () => {
    applyAs(setMaterial('w_s', 'm_a'))
    applyAs(setMaterial('w_s', 'm_b'))
    applyAs(setMaterial('w_s', 'm_c'))
    expect(materialOf('w_s')).toBe('m_c')

    history().undo()
    expect(materialOf('w_s')).toBe('m_b')
    history().undo()
    expect(materialOf('w_s')).toBe('m_a')
    history().undo()
    expect(materialOf('w_s')).toBeUndefined()

    history().redo()
    expect(materialOf('w_s')).toBe('m_a')
  })
})

describe('editHistoryStore · redo-clear on fresh apply', () => {
  it('a new command after an undo clears the redo branch', () => {
    applyAs(setMaterial('w_s', 'm_a'))
    applyAs(setMaterial('w_s', 'm_b'))
    history().undo() // m_b is now redo-able
    expect(history().redoStack).toHaveLength(1)

    applyAs(setMaterial('w_s', 'm_c')) // fresh edit
    expect(history().redoStack).toHaveLength(0)
    expect(history().canRedo).toBe(false)
    expect(materialOf('w_s')).toBe('m_c')

    // m_b is no longer reachable — redo is a no-op
    expect(history().redo()).toBeNull()
  })
})

describe('editHistoryStore · undo-stack cap', () => {
  // The cap tests exercise STACK mechanics only — they need N commands that all
  // apply cleanly. `set_material` carries no geometric constraint (the
  // per-move validator accepts it unconditionally), so it is the right vehicle
  // for a 60-command burst without colliding with any object-placement rule.
  it(`caps the undo stack at ${UNDO_STACK_CAP} and drops the oldest`, () => {
    for (let i = 0; i < UNDO_STACK_CAP + 10; i += 1) {
      const result = applyAs(setMaterial(`obj_${i}`, `m_${i}`))
      expect(result.applied).toBe(true)
    }
    expect(history().undoStack).toHaveLength(UNDO_STACK_CAP)
    // The oldest 10 commands fell off the stack — newest is obj_59.
    const stack = history().undoStack
    expect(stack[stack.length - 1].operation).toMatchObject({ node_id: 'obj_59' })
    expect(stack[0].operation).toMatchObject({ node_id: 'obj_10' })
  })

  it('a dropped command stays applied to the scene', () => {
    for (let i = 0; i < UNDO_STACK_CAP + 1; i += 1) {
      applyAs(setMaterial(`obj_${i}`, `m_${i}`))
    }
    // obj_0's command was dropped from the stack but its override remains.
    expect(scene().overrides.some((o) => o.base_node_id === 'obj_0')).toBe(true)
    expect(history().undoStack).toHaveLength(UNDO_STACK_CAP)
  })
})

describe('editHistoryStore · hard-reject gate (Block 2.6)', () => {
  it('rejects a move_node on a wall and never pushes / never writes', () => {
    const result = applyAs(
      new MoveNodeCommand({
        nodeId: 'w_s',
        newTransform: {
          position: { x: 2, y: 0, z: 2 },
          rotation: { ...IDENTITY_QUATERNION },
          scale: { ...ONE_VECTOR3 },
        },
        variantId: VARIANT,
      }),
    )
    expect(result.applied).toBe(false)
    if (result.applied) throw new Error('expected reject')
    expect(result.error.code).toBe('WALL_IMMOVABLE')
    expect(history().undoStack).toHaveLength(0)
    expect(scene().overrides).toHaveLength(0)
  })

  it('rejects a move_node onto a node that does not exist', () => {
    const result = applyAs(
      new MoveNodeCommand({
        nodeId: 'ghost_node',
        newTransform: {
          position: { x: 1, y: 0, z: 1 },
          rotation: { ...IDENTITY_QUATERNION },
          scale: { ...ONE_VECTOR3 },
        },
        variantId: VARIANT,
      }),
    )
    expect(result.applied).toBe(false)
    if (result.applied) throw new Error('expected reject')
    expect(result.error.code).toBe('NODE_NOT_FOUND')
    expect(history().undoStack).toHaveLength(0)
  })

  it('rejects a move_node that leaves the room bounds', () => {
    const result = applyAs(
      new MoveNodeCommand({
        nodeId: 'obj_0',
        newTransform: {
          position: { x: 99, y: 0, z: 99 },
          rotation: { ...IDENTITY_QUATERNION },
          scale: { ...ONE_VECTOR3 },
        },
        variantId: VARIANT,
      }),
    )
    expect(result.applied).toBe(false)
    if (result.applied) throw new Error('expected reject')
    expect(result.error.code).toBe('OUTSIDE_ROOM_BOUNDS')
    expect(scene().overrides).toHaveLength(0)
  })
})

describe('editHistoryStore · clear', () => {
  it('wipes both stacks', () => {
    applyAs(setMaterial('w_s', 'm_a'))
    history().undo()
    history().clear()
    expect(history().undoStack).toHaveLength(0)
    expect(history().redoStack).toHaveLength(0)
    expect(history().canUndo).toBe(false)
    expect(history().canRedo).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F1 · RBAC gate (Block 2.10) — apply() funnels every command through
// assertCanWriteVariant. A foreign-variant command is rejected BEFORE it
// writes — a spy cannot land an override via the store API.
// ─────────────────────────────────────────────────────────────────────────────

describe('editHistoryStore · RBAC gate (Block 2.10)', () => {
  const PROVIDER_A: SpatialEditUser = {
    userId: 'prov-A',
    role: 'craftsman',
    isOperator: false,
  }
  const OTHER_VARIANT = providerAnnotationsVariantId('prov-OTHER')

  it('rejects a provider writing ANOTHER provider\'s annotation layer (spy)', () => {
    // Provider A constructs a command that targets provider OTHER's layer and
    // pushes it straight at the store — bypassing the UI permission hook.
    const spyCommand = new SetMaterialCommand({
      nodeId: 'w_s',
      surface: 'wall',
      materialId: 'm_spy',
      variantId: OTHER_VARIANT,
    })
    const result = history().apply(spyCommand, PROVIDER_A)

    expect(result.applied).toBe(false)
    if (result.applied) throw new Error('expected RBAC reject')
    expect(result.reason).toBe('permission')
    expect(result.error.code).toBe('provider_spy')
    // No override was written to the foreign layer, no stack push.
    expect(
      scene().overrides.some((o) => o.variant_id === OTHER_VARIANT),
    ).toBe(false)
    expect(history().undoStack).toHaveLength(0)
  })

  it('rejects a customer writing a provider annotation layer', () => {
    const result = history().apply(
      new SetMaterialCommand({
        nodeId: 'w_s',
        surface: 'wall',
        materialId: 'm_x',
        variantId: providerAnnotationsVariantId('prov-A'),
      }),
      CUSTOMER,
    )
    expect(result.applied).toBe(false)
    if (result.applied) throw new Error('expected RBAC reject')
    expect(result.reason).toBe('permission')
    expect(scene().overrides).toHaveLength(0)
  })

  it('rejects a write onto the immutable base_roomplan layer', () => {
    const result = history().apply(
      new SetMaterialCommand({
        nodeId: 'w_s',
        surface: 'wall',
        materialId: 'm_x',
        variantId: 'base_roomplan',
      }),
      CUSTOMER,
    )
    expect(result.applied).toBe(false)
    if (result.applied) throw new Error('expected RBAC reject')
    expect(result.error.code).toBe('variant_read_only')
  })

  it('rejects every command when the acting user is signed out', () => {
    const signedOut: SpatialEditUser = { userId: null, role: null, isOperator: false }
    const result = history().apply(setMaterial('w_s', 'm_a'), signedOut)
    expect(result.applied).toBe(false)
    if (result.applied) throw new Error('expected RBAC reject')
    expect(result.error.code).toBe('no_user')
    expect(scene().overrides).toHaveLength(0)
  })

  it('ACCEPTS a provider writing their OWN annotation layer', () => {
    const result = history().apply(
      new SetMaterialCommand({
        nodeId: 'w_s',
        surface: 'wall',
        materialId: 'm_own',
        variantId: providerAnnotationsVariantId('prov-A'),
      }),
      PROVIDER_A,
    )
    expect(result.applied).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F3 · Auto-snap adoption (§8.3) — when the validator returns a
// correctedTransform, apply() rebuilds the command so the persisted override
// carries the SNAPPED value, not the raw one.
// ─────────────────────────────────────────────────────────────────────────────

describe('editHistoryStore · auto-snap adoption (§8.3)', () => {
  function transformAt(x: number, y: number, z: number) {
    return {
      position: { x, y, z },
      rotation: { ...IDENTITY_QUATERNION },
      scale: { ...ONE_VECTOR3 },
    }
  }

  beforeEach(() => {
    // A scene with a SINGLE isolated free object — no neighbours, so no
    // object-overlap rule interferes with the snap path under test.
    const s = useCanonicalSceneStore.getState()
    s.setScene(
      makeRoom({
        free_objects: [
          makeObject({
            id: 'lone_obj',
            category: 'generic_cuboid',
            host: 'free',
            host_id: 'floor',
            transform: transformAt(1, 0, 1),
          }),
        ],
      }),
    )
    s.setOverrides([])
    s.setVariants([
      { id: 'base_roomplan', display_name: 'Scan', is_default: true },
      { id: VARIANT, display_name: 'Customer', is_default: false, parent_variant_id: 'base_roomplan' },
    ])
    s.setActiveVariantId(VARIANT)
    useEditHistoryStore.getState().clear()
  })

  it('persists the snap-to-floor corrected transform, not the raw one', () => {
    // Moving the object to y=0.03 (within the 0.05 m snap-to-floor band) makes
    // the validator snap it flush to the floor and return a correctedTransform.
    const result = applyAs(
      new MoveNodeCommand({
        nodeId: 'lone_obj',
        newTransform: transformAt(1, 0.03, 1),
        variantId: VARIANT,
      }),
    )
    expect(result.applied).toBe(true)
    if (!result.applied) throw new Error('expected applied')

    // The persisted override transform was SNAPPED to the floor plane.
    const written = scene().overrides.find(
      (o) => o.base_node_id === 'lone_obj' && o.variant_id === VARIANT,
    )
    const persisted = written?.override_fields.transform as { position: { y: number } }
    expect(persisted.position.y).toBe(0)

    // The serialised command the caller persists also carries the snapped value.
    const cmdTransform = (
      result.command.operation as { new_transform: { position: { y: number } } }
    ).new_transform
    expect(cmdTransform.position.y).toBe(0)
  })

  it('leaves an already-on-plane transform untouched (no snap)', () => {
    const result = applyAs(
      new MoveNodeCommand({
        nodeId: 'lone_obj',
        newTransform: transformAt(2, 0, 2),
        variantId: VARIANT,
      }),
    )
    expect(result.applied).toBe(true)
    if (!result.applied) throw new Error('expected applied')
    const written = scene().overrides.find((o) => o.base_node_id === 'lone_obj')
    const persisted = written?.override_fields.transform as {
      position: { x: number; y: number; z: number }
    }
    // y stayed 0 (already on-plane) and x/z are the raw, un-nudged values.
    expect(persisted.position).toEqual({ x: 2, y: 0, z: 2 })
  })
})
