/**
 * Spatial · Canonical · Commands · AddWallCommand (Lane-2.5 · Stream B · B3)
 *
 * `add_wall` — append a new `Wall` node to the host room.
 *
 * Mirrors the apply model of {@link AddDoorCommand}: the wall is a NEW
 * scene-graph node, which the override engine cannot express (`resolveScene`
 * only merges deltas onto pre-existing nodes). So this command mutates the
 * base scene directly via {@link SceneEditContext.setScene} — appending the
 * wall on `do()` / `redo()` and removing it on `undo()`. The base scene is
 * replaced immutably (a fresh RoomScene object), never mutated in place.
 *
 * The wall carries `variant_id = activeVariantId` and `source: 'manual'` so
 * the audit trail can attribute the edit to the active variant. Geometry
 * derivations (length, normal) are pure functions of start/end + thickness.
 */

import type { Wall } from '../types/geometry.ts'
import type { Vector3 } from '../types/primitives.ts'
import type { RoomScene } from '../types/scene-graph.ts'
import type { VariantId } from '../types/variants.ts'
import type { NodeOverride } from '../types/variants.ts'
import type { EditOperation } from '../types/commands.ts'
import {
  IDENTITY_QUATERNION,
  IDENTITY_VECTOR3,
  ONE_VECTOR3,
} from '../types/primitives.ts'
import { CanonicalError } from '../types/errors.ts'
import { rebuildFloorCeilingFromWalls } from '../geometry/footprint.ts'
import { BaseCommand, type SceneEditContext } from './BaseCommand.ts'

const DEFAULT_WALL_THICKNESS_M = 0.15

export class AddWallCommand extends BaseCommand {
  private readonly wall: Wall
  private readonly roomId: string

  constructor(params: {
    /** Stable id for the new wall. Caller-supplied so the command stack and
     *  the persisted edit-history reference the same node. */
    wallId: string
    /** Parent room node id — the wall is appended to `room.walls`. */
    roomId: string
    start: Vector3
    end: Vector3
    heightM: number
    /** Optional thickness override. Defaults to 0.15 m (matches presets). */
    thicknessM?: number
    variantId: VariantId
    label?: string
    /** Optional timestamp for tests; defaults to {@link Date.now}. */
    createdAt?: string
  }) {
    const thicknessM = params.thicknessM ?? DEFAULT_WALL_THICKNESS_M
    const wall = buildWall({
      id: params.wallId,
      parentId: params.roomId,
      start: params.start,
      end: params.end,
      heightM: params.heightM,
      thicknessM,
      variantId: params.variantId,
      createdAt: params.createdAt ?? new Date().toISOString(),
    })
    const operation: EditOperation = {
      kind: 'add_wall',
      wall_id: params.wallId,
      room_id: params.roomId,
      start_point: { ...params.start },
      end_point: { ...params.end },
      height_m: params.heightM,
      thickness_m: thicknessM,
    }
    super({
      operation,
      label: params.label ?? 'Wand hinzugefügt',
      variantId: params.variantId,
      // No override rows — the wall is added as a base-scene node, not a delta.
      affectedNodeIds: [],
    })
    this.wall = wall
    this.roomId = params.roomId
  }

  /** No override rows — pure base-scene mutation. */
  protected computeAfter(): (NodeOverride | null)[] {
    return []
  }

  protected applyForward(ctx: SceneEditContext): void {
    this.mutateRoomWalls(ctx, (walls) =>
      walls.some((w) => w.id === this.wall.id)
        ? walls // idempotent re-do is a no-op
        : [...walls, this.wall],
    )
  }

  protected applyInverse(ctx: SceneEditContext): void {
    const scene = ctx.scene
    if (!scene) {
      throw new CanonicalError(
        'NOT_FOUND',
        `AddWallCommand undo failed — no scene loaded; cannot remove wall ${this.wall.id}`,
      )
    }
    if (!scene.walls.some((w) => w.id === this.wall.id)) {
      throw new CanonicalError(
        'NOT_FOUND',
        `AddWallCommand undo failed — wall ${this.wall.id} is no longer in the room; ` +
          'the base scene changed since the wall was added',
      )
    }
    this.mutateRoomWalls(ctx, (walls) => walls.filter((w) => w.id !== this.wall.id))
  }

  private mutateRoomWalls(
    ctx: SceneEditContext,
    transform: (walls: Wall[]) => Wall[],
  ): void {
    const scene = ctx.scene
    if (!scene) return
    if (scene.id !== this.roomId) {
      throw new CanonicalError(
        'NOT_FOUND',
        `AddWallCommand: room id mismatch (expected ${this.roomId}, scene is ${scene.id})`,
      )
    }
    const nextWalls = transform(scene.walls)
    if (nextWalls === scene.walls) return
    const next: RoomScene = { ...scene, walls: nextWalls }
    // Footprint-first: re-derive floor + ceiling + room metrics from the wall
    // ring so they never drift (this replaces the never-implemented "AddWall
    // patches the polygon" claim in the empty-canvas preset). Open / <3-wall
    // rings keep an empty polygon — the legitimate in-progress draw state.
    ctx.setScene(rebuildFloorCeilingFromWalls(next))
  }
}

interface BuildWallInput {
  id: string
  parentId: string
  start: Vector3
  end: Vector3
  heightM: number
  thicknessM: number
  variantId: VariantId
  createdAt: string
}

function buildWall(input: BuildWallInput): Wall {
  const dx = input.end.x - input.start.x
  const dz = input.end.z - input.start.z
  const length = Math.hypot(dx, dz)
  // Outward-facing 2D normal — rotated 90° CW around Y. For a CCW ring this
  // points away from the room interior; the renderer may flip it per face
  // based on the floor-polygon winding, but the canonical normal stays
  // consistent with the preset builder.
  const normalX = length > 0 ? dz / length : 0
  const normalZ = length > 0 ? -dx / length : 0
  return {
    id: input.id,
    type: 'wall',
    parent_id: input.parentId,
    children_ids: [],
    variant_id: input.variantId,
    source: 'manual',
    confidence: 1,
    transform: {
      position: IDENTITY_VECTOR3,
      rotation: IDENTITY_QUATERNION,
      scale: ONE_VECTOR3,
    },
    created_at: input.createdAt,
    updated_at: input.createdAt,
    start_point: { ...input.start },
    end_point: { ...input.end },
    height_m: input.heightM,
    thickness_m: input.thicknessM,
    base_height_m: 0,
    openings: [],
    wall_mounted: [],
    is_exterior_wall: true,
    walkable_blocker: true,
    length_m: length,
    normal: { x: normalX, y: 0, z: normalZ },
  }
}
