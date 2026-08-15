/**
 * Spatial · Canonical · Commands · SetMaterialCommand
 *
 * `set_material` — set the `material_id` slug of a wall / floor / ceiling /
 * object surface on the active variant.
 *
 * Mechanics are identical to the Phase-1 `writeMaterialOverride`
 * (`src/lib/spatial/hooks/useMaterialResolution.ts`): a `material_id`
 * shallow-merge override that preserves every other overridden field on the
 * `(surface, variant)` pair. The difference is ownership — `writeMaterialOverride`
 * returns an ad-hoc one-shot undo handle, whereas this command lives on the
 * proper history stack with full undo/redo. The command is re-implemented in
 * the L1 layer (rather than imported) because `useMaterialResolution.ts` is a
 * React hook module and `canonical/commands/` must stay React/DOM-free.
 *
 * AbortController note: `writeMaterialOverride` is fully SYNCHRONOUS — it
 * upserts an override into the zustand store and returns. `SetMaterialCommand`
 * keeps that property: `do()` / `undo()` are synchronous override writes with
 * no async texture fetch. No AbortController is required at this layer (see
 * the Block report). Texture loading is a separate L3 renderer concern keyed
 * off the resolved `material_id`.
 */

import type { NodeOverride, VariantId } from '../types/variants.ts'
import type { EditOperation } from '../types/commands.ts'
import { BaseCommand } from './BaseCommand.ts'

/** Surface kinds that carry a `material_id` field. */
export type MaterialSurface = 'wall' | 'floor' | 'ceiling' | 'object'

export class SetMaterialCommand extends BaseCommand {
  private readonly nodeId: string
  private readonly materialId: string

  constructor(params: {
    nodeId: string
    surface: MaterialSurface
    materialId: string
    variantId: VariantId
    label?: string
  }) {
    const operation: EditOperation = {
      kind: 'set_material',
      node_id: params.nodeId,
      surface: params.surface,
      material_id: params.materialId,
    }
    super({
      operation,
      label: params.label ?? 'Material geändert',
      variantId: params.variantId,
      affectedNodeIds: [params.nodeId],
    })
    this.nodeId = params.nodeId
    this.materialId = params.materialId
  }

  protected computeAfter(before: readonly (NodeOverride | null)[]): (NodeOverride | null)[] {
    const prior = before[0]
    return [
      {
        base_node_id: this.nodeId,
        variant_id: this.variantId,
        override_fields: {
          ...(prior?.override_fields ?? {}),
          material_id: this.materialId,
        },
      },
    ]
  }
}
