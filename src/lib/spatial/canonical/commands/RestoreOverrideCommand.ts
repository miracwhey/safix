/**
 * Spatial · Canonical · Commands · RestoreOverrideCommand (Phase 2 · Block 2.15)
 *
 * The command behind the PERSISTENT reverter — distinct from session-undo.
 *
 * ── Reverter vs session-undo ────────────────────────────────────────────────
 *   - Session-undo (`editHistoryStore.undo()`) pops the last command off the
 *     in-memory stack and re-applies its inverse. Ephemeral, max 50, gone on
 *     logout. It can only walk BACKWARD from the current head.
 *   - The reverter is a FORWARD edit: it re-applies a chosen historical state
 *     as a brand-new override write. It does NOT pop the stack — it pushes a
 *     new command onto it (so the revert is itself undoable) and writes a new
 *     `spatial_edit_history` row with `command='restore'`.
 *
 * `RestoreOverrideCommand` is the override-write part of that. It targets a
 * single `(base_node_id, variant_id)` pair and writes a CHOSEN override delta:
 *   - `targetOverride !== null` ⇒ the pair is set to that exact delta,
 *   - `targetOverride === null` ⇒ the override is removed (pair reverts to
 *     pure base-scene state).
 *
 * It carries a real {@link EditOperation} so it flows through the same
 * Block-2.6 constraint gate (`editHistoryStore.apply()` → `validateComponentMove`)
 * as any other command. The operation is reconstructed by the reverter
 * workflow from the historical delta — for a material restore that is a
 * `set_material`, for a deletion restore a `delete_node`, for a transform
 * restore a `move_node`. The constraint gate re-validates the restored state:
 * a state that was legal when first applied stays legal on restore.
 *
 * Layer: pure L1 — no three.js / React / DOM, same as every other command.
 */

import type { NodeOverride, VariantId } from '../types/variants.ts'
import type { EditOperation } from '../types/commands.ts'
import { BaseCommand } from './BaseCommand.ts'

export class RestoreOverrideCommand extends BaseCommand {
  /** The override delta to restore — or `null` to reset the pair to base. */
  private readonly targetOverride: NodeOverride | null

  constructor(params: {
    /** Base-scene node the restore targets. */
    nodeId: string
    /** Variant layer the restore writes to (the role-correct writable layer). */
    variantId: VariantId
    /**
     * The historical override delta to re-apply, or `null` to remove the
     * override entirely (restore the node to base-scene state).
     */
    targetOverride: NodeOverride | null
    /**
     * The {@link EditOperation} this restore is semantically equivalent to —
     * reconstructed by the reverter workflow from the historical delta. Drives
     * the constraint gate + the `semantic_op` audit column.
     */
    operation: EditOperation
    /** German history-timeline / undo-toast label. */
    label?: string
  }) {
    super({
      operation: params.operation,
      label: params.label ?? 'Stand wiederhergestellt',
      variantId: params.variantId,
      affectedNodeIds: [params.nodeId],
    })
    this.targetOverride =
      params.targetOverride === null
        ? null
        : {
            base_node_id: params.nodeId,
            variant_id: params.variantId,
            override_fields: { ...params.targetOverride.override_fields },
          }
  }

  protected computeAfter(): (NodeOverride | null)[] {
    // Positional: index 0 ↔ affectedNodeIds[0]. `null` ⇒ remove the override.
    return [this.targetOverride]
  }
}
