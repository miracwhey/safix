/**
 * Spatial · Canonical · Commands · AddDoorCommand
 *
 * `add_door` — insert a new door (a {@link WallOpening} with `type: 'door'`)
 * into a host wall's `openings` array.
 *
 * Unlike the other 7 commands, `add_door` introduces a NEW node. The override
 * engine cannot express that: `resolveScene` only merges deltas onto nodes
 * that already exist on the base scene. So this command mutates the base scene
 * directly via {@link SceneEditContext.setScene} — appending the door on
 * `do()` / `redo()` and removing it on `undo()`. The base scene is replaced
 * immutably (a fresh RoomScene object), never mutated in place.
 *
 * The door node carries `variant_id = activeVariantId` and `source: 'manual'`
 * so the audit trail and the resolver can still see which variant authored it.
 */

import type { RoomScene } from '../types/scene-graph.ts'
import type { Wall, WallOpening } from '../types/geometry.ts'
import type { VariantId } from '../types/variants.ts'
import type { NodeOverride } from '../types/variants.ts'
import type { EditOperation } from '../types/commands.ts'
import { CanonicalError } from '../types/errors.ts'
import { BaseCommand, type SceneEditContext } from './BaseCommand.ts'

export class AddDoorCommand extends BaseCommand {
  private readonly wallId: string
  private readonly door: WallOpening

  constructor(params: {
    wallId: string
    door: WallOpening
    variantId: VariantId
    label?: string
  }) {
    const door: WallOpening = {
      ...params.door,
      type: 'door',
      host_wall_id: params.wallId,
      is_walkable_portal: true,
      variant_id: params.variantId,
      source: 'manual',
    }
    const operation: EditOperation = {
      kind: 'add_door',
      wall_id: params.wallId,
      door,
    }
    super({
      operation,
      label: params.label ?? 'Tür hinzugefügt',
      variantId: params.variantId,
      // No override rows — the door is added as a base-scene node, not a delta.
      affectedNodeIds: [],
    })
    this.wallId = params.wallId
    this.door = door
  }

  /** No override rows — the whole edit is a base-scene mutation. */
  protected computeAfter(): (NodeOverride | null)[] {
    return []
  }

  /** Append the door node to its host wall's `openings` array. */
  protected applyForward(ctx: SceneEditContext): void {
    this.mutateWallOpenings(ctx, (openings) =>
      openings.some((o) => o.id === this.door.id)
        ? openings // idempotent — re-running do/redo never duplicates
        : [...openings, this.door],
    )
  }

  /**
   * Remove the door node from its host wall's `openings` array.
   *
   * Undo MUST be symmetric: it can only succeed if the node it added is still
   * present to remove. If the base scene was replaced between `do()` and
   * `undo()` so that the host wall — or the door itself — is gone, a silent
   * id-filter no-op would falsely report a successful undo while leaving the
   * scene unchanged. Detect that and THROW so the caller (the history store)
   * surfaces the failed undo instead of swallowing it.
   */
  protected applyInverse(ctx: SceneEditContext): void {
    const scene = ctx.scene
    if (!scene) {
      throw new CanonicalError(
        'NOT_FOUND',
        `AddDoorCommand undo failed — no scene loaded; cannot remove door ${this.door.id}`,
      )
    }
    const wall = scene.walls.find((w) => w.id === this.wallId)
    if (!wall) {
      throw new CanonicalError(
        'NOT_FOUND',
        `AddDoorCommand undo failed — host wall ${this.wallId} no longer exists; ` +
          `cannot remove door ${this.door.id}`,
      )
    }
    if (!wall.openings.some((o) => o.id === this.door.id)) {
      throw new CanonicalError(
        'NOT_FOUND',
        `AddDoorCommand undo failed — door ${this.door.id} is no longer on wall ` +
          `${this.wallId}; the base scene changed since the door was added`,
      )
    }
    this.mutateWallOpenings(ctx, (openings) =>
      openings.filter((o) => o.id !== this.door.id),
    )
  }

  private mutateWallOpenings(
    ctx: SceneEditContext,
    transform: (openings: WallOpening[]) => WallOpening[],
  ): void {
    const scene = ctx.scene
    if (!scene) return
    let touched = false
    const walls = scene.walls.map((w: Wall): Wall => {
      if (w.id !== this.wallId) return w
      touched = true
      return { ...w, openings: transform(w.openings) }
    })
    if (!touched) return
    const next: RoomScene = { ...scene, walls }
    ctx.setScene(next)
  }
}
