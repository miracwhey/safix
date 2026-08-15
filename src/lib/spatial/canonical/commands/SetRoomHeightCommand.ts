/**
 * Spatial · Canonical · Commands · SetRoomHeightCommand
 *
 * `set_room_height` — set the room's ceiling height. Because walls in the
 * canonical model carry their own `height_m`, raising/lowering the room is a
 * MULTI-NODE edit: the ceiling's `height_m` AND every wall's `height_m` are
 * written together so the geometry never desyncs (a wall shorter than the
 * ceiling would leave a gap; the validator's `WALL_HEIGHT_UNUSUAL` rule would
 * fire on a partial edit).
 *
 * The caller passes the wall ids it wants synced (read from the active scene);
 * the command writes one `height_m` override per wall plus one for the
 * ceiling, all on the active variant. `undo()` restores every touched node's
 * prior override in one symmetric step.
 */

import type { NodeOverride, VariantId } from '../types/variants.ts'
import type { EditOperation } from '../types/commands.ts'
import { BaseCommand } from './BaseCommand.ts'

export class SetRoomHeightCommand extends BaseCommand {
  private readonly ceilingId: string
  private readonly wallIds: readonly string[]
  private readonly newHeightM: number

  constructor(params: {
    roomId: string
    ceilingId: string
    /** Wall ids to keep in sync with the new ceiling height. */
    wallIds: readonly string[]
    newHeightM: number
    variantId: VariantId
    label?: string
  }) {
    const operation: EditOperation = {
      kind: 'set_room_height',
      room_id: params.roomId,
      new_height_m: params.newHeightM,
    }
    super({
      operation,
      label: params.label ?? 'Raumhöhe geändert',
      variantId: params.variantId,
      // Ceiling first, then every wall — positional contract for computeAfter.
      affectedNodeIds: [params.ceilingId, ...params.wallIds],
    })
    this.ceilingId = params.ceilingId
    this.wallIds = params.wallIds
    this.newHeightM = params.newHeightM
  }

  protected computeAfter(before: readonly (NodeOverride | null)[]): (NodeOverride | null)[] {
    // Index 0 = ceiling, indices 1..n = walls — mirrors affectedNodeIds.
    return this.affectedNodeIds.map((nodeId, i) => {
      const prior = before[i]
      return {
        base_node_id: nodeId,
        variant_id: this.variantId,
        override_fields: {
          ...(prior?.override_fields ?? {}),
          height_m: this.newHeightM,
        },
      } satisfies NodeOverride
    })
  }

  /** Exposed for tests / callers — the ceiling node this command targets. */
  get targetCeilingId(): string {
    return this.ceilingId
  }

  /** Exposed for tests / callers — the wall ids this command keeps in sync. */
  get targetWallIds(): readonly string[] {
    return this.wallIds
  }
}
