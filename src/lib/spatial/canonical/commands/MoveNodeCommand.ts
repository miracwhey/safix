/**
 * Spatial · Canonical · Commands · MoveNodeCommand
 *
 * `move_node` — relocate a scene node (object / pin host / opening) to a new
 * parent-relative {@link Transform}. The edit is expressed as a `transform`
 * shallow-merge override on the active variant; the wider field set on any
 * prior override survives the merge.
 */

import type { Transform } from '../types/primitives.ts'
import type { NodeOverride, VariantId } from '../types/variants.ts'
import type { EditOperation } from '../types/commands.ts'
import { BaseCommand } from './BaseCommand.ts'

export class MoveNodeCommand extends BaseCommand {
  private readonly nodeId: string
  private readonly newTransform: Transform

  constructor(params: { nodeId: string; newTransform: Transform; variantId: VariantId; label?: string }) {
    const operation: EditOperation = {
      kind: 'move_node',
      node_id: params.nodeId,
      new_transform: params.newTransform,
    }
    super({
      operation,
      label: params.label ?? 'Verschoben',
      variantId: params.variantId,
      affectedNodeIds: [params.nodeId],
    })
    this.nodeId = params.nodeId
    this.newTransform = params.newTransform
  }

  protected computeAfter(before: readonly (NodeOverride | null)[]): (NodeOverride | null)[] {
    const prior = before[0]
    return [
      {
        base_node_id: this.nodeId,
        variant_id: this.variantId,
        override_fields: {
          ...(prior?.override_fields ?? {}),
          transform: this.newTransform,
        },
      },
    ]
  }

  /**
   * Rebuild the move with an auto-snap-corrected transform (§8.3). Returns a
   * fresh `MoveNodeCommand` so the persisted override carries the snapped
   * value; the apply funnel calls this before the command's first `do()`.
   */
  override withCorrectedTransform(transform: Transform): MoveNodeCommand {
    return new MoveNodeCommand({
      nodeId: this.nodeId,
      newTransform: transform,
      variantId: this.variantId,
      label: this.label,
    })
  }
}
