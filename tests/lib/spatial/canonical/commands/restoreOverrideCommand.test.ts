/**
 * Tests for canonical/commands/RestoreOverrideCommand.ts + the German
 * edit-operation labels (Block 2.14-2.15).
 */
import { describe, it, expect } from 'vitest'

import { RestoreOverrideCommand } from '../../../../../src/lib/spatial/canonical/commands/RestoreOverrideCommand.ts'
import type { SceneEditContext } from '../../../../../src/lib/spatial/canonical/commands/BaseCommand.ts'
import {
  editOperationLabel,
  editHistoryCommandLabel,
  historyRowLabel,
} from '../../../../../src/lib/spatial/canonical/types/editOperationLabels.ts'
import { EDIT_OPERATION_KINDS } from '../../../../../src/lib/spatial/canonical/types/commands.ts'
import type { NodeOverride } from '../../../../../src/lib/spatial/canonical/types/variants.ts'
import type { EditOperation } from '../../../../../src/lib/spatial/canonical/types/commands.ts'

const VARIANT = 'customer_corrections'

/** A minimal in-memory SceneEditContext (override list + writers). */
function ctx(initial: NodeOverride[] = []): SceneEditContext {
  let overrides = [...initial]
  return {
    get overrides() {
      return overrides
    },
    upsertOverride(o) {
      const i = overrides.findIndex(
        (x) => x.base_node_id === o.base_node_id && x.variant_id === o.variant_id,
      )
      overrides = i >= 0 ? overrides.map((x, k) => (k === i ? o : x)) : [...overrides, o]
    },
    removeOverride(baseNodeId, variantId) {
      overrides = overrides.filter(
        (o) => !(o.base_node_id === baseNodeId && o.variant_id === variantId),
      )
    },
    scene: null,
    setScene() {},
  }
}

const SET_MATERIAL_OP: EditOperation = {
  kind: 'set_material',
  node_id: 'obj-1',
  surface: 'object',
  material_id: 'paint-white',
}

describe('RestoreOverrideCommand', () => {
  it('writes the target override on do()', () => {
    const c = ctx()
    const cmd = new RestoreOverrideCommand({
      nodeId: 'obj-1',
      variantId: VARIANT,
      targetOverride: {
        base_node_id: 'obj-1',
        variant_id: VARIANT,
        override_fields: { material_id: 'paint-white' },
      },
      operation: SET_MATERIAL_OP,
    })
    cmd.do(c)
    expect(c.overrides).toHaveLength(1)
    expect(c.overrides[0].override_fields.material_id).toBe('paint-white')
    // `after` carries the written row for persistence (Block 2.13).
    expect(cmd.toEditCommand().after).toHaveLength(1)
  })

  it('REMOVES the override when the target is null (restore-to-base)', () => {
    const c = ctx([
      { base_node_id: 'obj-1', variant_id: VARIANT, override_fields: { material_id: 'tile' } },
    ])
    const cmd = new RestoreOverrideCommand({
      nodeId: 'obj-1',
      variantId: VARIANT,
      targetOverride: null,
      operation: { kind: 'delete_node', node_id: 'obj-1' },
    })
    cmd.do(c)
    expect(c.overrides).toHaveLength(0)
  })

  it('undo() restores the pre-restore state', () => {
    const c = ctx([
      { base_node_id: 'obj-1', variant_id: VARIANT, override_fields: { material_id: 'tile' } },
    ])
    const cmd = new RestoreOverrideCommand({
      nodeId: 'obj-1',
      variantId: VARIANT,
      targetOverride: {
        base_node_id: 'obj-1',
        variant_id: VARIANT,
        override_fields: { material_id: 'paint-white' },
      },
      operation: SET_MATERIAL_OP,
    })
    cmd.do(c)
    expect(c.overrides[0].override_fields.material_id).toBe('paint-white')
    cmd.undo(c)
    // The override is back to the pre-restore material.
    expect(c.overrides[0].override_fields.material_id).toBe('tile')
  })
})

describe('editOperationLabels — German labels', () => {
  it('has a label for every canonical operation kind', () => {
    for (const kind of EDIT_OPERATION_KINDS) {
      expect(editOperationLabel(kind)).toBeTruthy()
      expect(editOperationLabel(kind)).not.toBe(kind)
    }
  })

  it('maps the coarse command primitives', () => {
    expect(editHistoryCommandLabel('set')).toBe('Geändert')
    expect(editHistoryCommandLabel('delete')).toBe('Gelöscht')
    expect(editHistoryCommandLabel('restore')).toBe('Wiederhergestellt')
  })

  it('suffixes a restore row label with (wiederhergestellt)', () => {
    expect(historyRowLabel('set_material', 'set')).toBe('Material geändert')
    expect(historyRowLabel('set_material', 'restore')).toBe(
      'Material geändert (wiederhergestellt)',
    )
  })
})
