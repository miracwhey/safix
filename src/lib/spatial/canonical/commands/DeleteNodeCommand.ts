/**
 * Spatial · Canonical · Commands · DeleteNodeCommand
 *
 * `delete_node` — remove a node from the active variant. The deletion is
 * expressed as the canonical `{ __deleted: true }` override marker; the
 * variant resolver (`resolveScene`) drops the node — and any annotations
 * orphaned by the drop — from the resolved scene.
 *
 * `undo()` restores whatever override existed before (or removes the marker
 * row entirely if the node was previously un-overridden), so the node
 * re-appears with its prior per-variant state intact.
 */

import type { NodeOverride, VariantId } from '../types/variants.ts'
import type { EditOperation } from '../types/commands.ts'
import { DELETION_MARKER_KEY } from '../overrides/layer-merge.ts'
import { BaseCommand } from './BaseCommand.ts'

export class DeleteNodeCommand extends BaseCommand {
  private readonly nodeId: string

  constructor(params: { nodeId: string; variantId: VariantId; label?: string }) {
    const operation: EditOperation = {
      kind: 'delete_node',
      node_id: params.nodeId,
    }
    super({
      operation,
      label: params.label ?? 'Gelöscht',
      variantId: params.variantId,
      affectedNodeIds: [params.nodeId],
    })
    this.nodeId = params.nodeId
  }

  protected computeAfter(): (NodeOverride | null)[] {
    // The deletion marker is total — it replaces any prior override on the
    // pair. The resolver stops merging once a node is deleted in a layer, so
    // keeping stale fields around would be dead weight.
    return [
      {
        base_node_id: this.nodeId,
        variant_id: this.variantId,
        override_fields: { [DELETION_MARKER_KEY]: true },
      },
    ]
  }
}
