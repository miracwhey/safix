/**
 * Spatial · Canonical · Commands · DeleteWallCommand (Lane-2.5 · Stream B · B3)
 *
 * `delete_wall` — remove an existing wall from the host room.
 *
 * Like {@link AddWallCommand} this is a base-scene mutation rather than an
 * override write (the override engine has no way to "un-list" a base node —
 * `__deleted` markers express deletion for the resolver, but we want the
 * wall genuinely gone from `room.walls` so the polygon-area helper, the
 * Bom hydrator and the renderer all see a consistent shape). Undo restores
 * the captured wall node verbatim.
 *
 * Guardrails:
 *   - A delete that would leave the room with zero walls is allowed (the
 *     empty-canvas preset starts that way), so we do not enforce a min-1.
 *   - Walls referenced by an `add_door` or `add_pin` in flight are still
 *     deletable — the dependent override / node simply orphans, and the
 *     renderer skips it. A future "cascade" pass can clean those up, but
 *     blocking the delete here would prevent the user from tidying a
 *     mis-placed wall.
 */

import type { Wall } from '../types/geometry.ts'
import type { RoomScene } from '../types/scene-graph.ts'
import type { VariantId, NodeOverride } from '../types/variants.ts'
import type { EditOperation } from '../types/commands.ts'
import { CanonicalError } from '../types/errors.ts'
import { rebuildFloorCeilingFromWalls } from '../geometry/footprint.ts'
import { BaseCommand, type SceneEditContext } from './BaseCommand.ts'

export class DeleteWallCommand extends BaseCommand {
  private readonly wallId: string
  private readonly roomId: string
  /** Captured on first `do()` so `undo()` can restore the exact node. */
  private capturedWall: Wall | null = null

  constructor(params: {
    wallId: string
    roomId: string
    variantId: VariantId
    label?: string
  }) {
    const operation: EditOperation = {
      kind: 'delete_wall',
      wall_id: params.wallId,
      room_id: params.roomId,
    }
    super({
      operation,
      label: params.label ?? 'Wand entfernt',
      variantId: params.variantId,
      // No override rows — the wall removal is a base-scene mutation.
      affectedNodeIds: [],
    })
    this.wallId = params.wallId
    this.roomId = params.roomId
  }

  /** No override rows — pure base-scene mutation. */
  protected computeAfter(): (NodeOverride | null)[] {
    return []
  }

  protected applyForward(ctx: SceneEditContext): void {
    const scene = ctx.scene
    if (!scene) {
      throw new CanonicalError(
        'NOT_FOUND',
        `DeleteWallCommand: no scene loaded; cannot delete wall ${this.wallId}`,
      )
    }
    if (scene.id !== this.roomId) {
      throw new CanonicalError(
        'NOT_FOUND',
        `DeleteWallCommand: room id mismatch (expected ${this.roomId}, scene is ${scene.id})`,
      )
    }
    const target = scene.walls.find((w) => w.id === this.wallId)
    if (!target) {
      // Re-do after the same delete is idempotent — the wall is already gone.
      if (this.capturedWall) return
      throw new CanonicalError(
        'NOT_FOUND',
        `DeleteWallCommand: wall ${this.wallId} not found in room ${this.roomId}`,
      )
    }
    if (!this.capturedWall) {
      this.capturedWall = cloneWall(target)
    }
    const next: RoomScene = {
      ...scene,
      walls: scene.walls.filter((w) => w.id !== this.wallId),
    }
    // Footprint-first: re-derive floor + ceiling from the remaining wall ring.
    ctx.setScene(rebuildFloorCeilingFromWalls(next))
  }

  protected applyInverse(ctx: SceneEditContext): void {
    const scene = ctx.scene
    if (!scene) {
      throw new CanonicalError(
        'NOT_FOUND',
        `DeleteWallCommand undo failed — no scene loaded; cannot restore wall ${this.wallId}`,
      )
    }
    if (!this.capturedWall) {
      throw new CanonicalError(
        'NOT_FOUND',
        `DeleteWallCommand undo failed — no captured wall to restore for ${this.wallId}`,
      )
    }
    if (scene.walls.some((w) => w.id === this.wallId)) {
      // Already present — nothing to do, treat as idempotent undo.
      return
    }
    const next: RoomScene = {
      ...scene,
      walls: [...scene.walls, cloneWall(this.capturedWall)],
    }
    // Footprint-first: restoring the wall re-closes the ring → re-derive.
    ctx.setScene(rebuildFloorCeilingFromWalls(next))
  }
}

function cloneWall(w: Wall): Wall {
  return {
    ...w,
    transform: {
      position: { ...w.transform.position },
      rotation: { ...w.transform.rotation },
      scale: { ...w.transform.scale },
    },
    start_point: { ...w.start_point },
    end_point: { ...w.end_point },
    normal: { ...w.normal },
    openings: w.openings.map((o) => ({ ...o })),
    wall_mounted: [...w.wall_mounted],
    children_ids: [...w.children_ids],
  }
}
