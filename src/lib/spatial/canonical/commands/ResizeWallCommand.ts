/**
 * Spatial · Canonical · Commands · ResizeWallCommand
 *
 * `resize_wall` — change a wall's `height_m` and/or `thickness_m`. Both fields
 * are written together so a partial resize cannot leave the wall in an
 * inconsistent geometry state. The override is a shallow-merge on the active
 * variant; `length_m` / `normal` are computed downstream by the renderer and
 * are never written here.
 *
 * F11 — child re-anchoring. A wall's hosted children (door / window openings
 * and wall-mounted objects) place themselves PARAMETRICALLY against the wall
 * geometry: an opening at `offset_from_floor_m`, a wall-mounted object at
 * `height_from_floor_m`. Shrinking the wall's `height_m` can leave a child
 * hanging above the new wall top. When the caller supplies the resolved
 * {@link Wall} (with its `openings` + `wall_mounted` populated), this command
 * re-anchors every affected child IN THE SAME operation:
 *
 *   - an opening / object that still fits the new height has its vertical
 *     offset CLAMPED so its top edge sits at-or-below the new wall top;
 *   - an opening / object TALLER than the new wall cannot fit at all — it is
 *     dropped via the `{ __deleted: true }` marker and a warning is recorded.
 *
 * The clamped / dropped children are folded into `affectedNodeIds`, so their
 * pre-edit override rows are snapshotted and `undo()` restores them verbatim
 * alongside the wall. `length_m` is NOT a `resize_wall` field, so an opening's
 * `offset_along_wall_m` (which tracks wall LENGTH) is unaffected and is left
 * untouched here.
 */

import type { NodeOverride, VariantId } from '../types/variants.ts'
import type { EditOperation } from '../types/commands.ts'
import type { Wall, WallOpening } from '../types/geometry.ts'
import type { SpatialObject } from '../types/objects.ts'
import { BaseCommand } from './BaseCommand.ts'
import { DELETION_MARKER_KEY } from '../overrides/layer-merge.ts'

/** Numeric slack for the "child still fits the new wall height" comparison. */
const FIT_EPSILON_M = 1e-6

interface ReanchorPlan {
  /** Positional override (or `null`) for each child in `childIds` order. */
  childOverrides: (NodeOverride | null)[]
  /** Ids of the children the resize re-anchors, in stable order. */
  childIds: string[]
  /** Human-readable notes — dropped children + clamps, for the Confirm-Toast. */
  warnings: string[]
}

export class ResizeWallCommand extends BaseCommand {
  private readonly wallId: string
  private readonly newHeightM: number
  private readonly newThicknessM: number
  /** Re-anchor overrides for hosted children, positional to `childIds`. */
  private readonly plan: ReanchorPlan

  constructor(params: {
    wallId: string
    newHeightM: number
    newThicknessM: number
    variantId: VariantId
    label?: string
    /**
     * The resolved host wall, with `openings` + `wall_mounted` populated.
     * Supply it so the command can re-anchor children that no longer fit the
     * new height (F11). When omitted the command resizes the wall only — see
     * the class header for the latent gap that leaves.
     */
    wall?: Wall
  }) {
    const operation: EditOperation = {
      kind: 'resize_wall',
      wall_id: params.wallId,
      new_height_m: params.newHeightM,
      new_thickness_m: params.newThicknessM,
    }
    const plan = ResizeWallCommand.planReanchor(
      params.wall,
      params.newHeightM,
      params.variantId,
    )
    super({
      operation,
      label: params.label ?? 'Wand angepasst',
      variantId: params.variantId,
      // The wall is index 0; its re-anchored children follow.
      affectedNodeIds: [params.wallId, ...plan.childIds],
    })
    this.wallId = params.wallId
    this.newHeightM = params.newHeightM
    this.newThicknessM = params.newThicknessM
    this.plan = plan
  }

  /**
   * Re-anchor warnings (dropped / clamped children) — surfaced to the
   * Confirm-Toast so the user knows the resize cascaded. Empty when no wall
   * was supplied or no child was affected.
   */
  get reanchorWarnings(): readonly string[] {
    return this.plan.warnings
  }

  protected computeAfter(before: readonly (NodeOverride | null)[]): (NodeOverride | null)[] {
    const priorWall = before[0]
    const wallOverride: NodeOverride = {
      base_node_id: this.wallId,
      variant_id: this.variantId,
      override_fields: {
        ...(priorWall?.override_fields ?? {}),
        height_m: this.newHeightM,
        thickness_m: this.newThicknessM,
      },
    }

    // Children: merge the planned re-anchor mask onto each child's prior
    // override so an unrelated field (a material, a prior transform) survives.
    const childOverrides = this.plan.childOverrides.map((planned, i) => {
      if (planned === null) return null
      const prior = before[i + 1]
      // A drop (`__deleted`) replaces the row outright — it must not be diluted
      // by a stale prior override.
      if (planned.override_fields[DELETION_MARKER_KEY] === true) return planned
      return {
        base_node_id: planned.base_node_id,
        variant_id: this.variantId,
        override_fields: {
          ...(prior?.override_fields ?? {}),
          ...planned.override_fields,
        },
      }
    })

    return [wallOverride, ...childOverrides]
  }

  /**
   * Pure planner — given the host wall and the new height, decide the override
   * each hosted child needs. Walls without children, or a missing wall, yield
   * an empty plan (the command then resizes only the wall).
   */
  private static planReanchor(
    wall: Wall | undefined,
    newHeightM: number,
    variantId: VariantId,
  ): ReanchorPlan {
    if (!wall) return { childOverrides: [], childIds: [], warnings: [] }

    const childIds: string[] = []
    const childOverrides: (NodeOverride | null)[] = []
    const warnings: string[] = []

    const dropMarker = (id: string): NodeOverride => ({
      base_node_id: id,
      variant_id: variantId,
      override_fields: { [DELETION_MARKER_KEY]: true },
    })

    // ── Openings (doors / windows) — anchored by `offset_from_floor_m`. ──────
    for (const op of wall.openings) {
      const planned = ResizeWallCommand.planOpening(op, newHeightM, variantId, dropMarker, warnings)
      if (planned === undefined) continue
      childIds.push(op.id)
      childOverrides.push(planned)
    }

    // ── Wall-mounted objects — anchored by `height_from_floor_m`. ────────────
    for (const obj of wall.wall_mounted) {
      const planned = ResizeWallCommand.planWallObject(obj, newHeightM, variantId, dropMarker, warnings)
      if (planned === undefined) continue
      childIds.push(obj.id)
      childOverrides.push(planned)
    }

    return { childOverrides, childIds, warnings }
  }

  /**
   * Plan one opening. Returns `undefined` when the opening already fits and
   * needs no override, a `__deleted` override when it can never fit the new
   * wall, or an `offset_from_floor_m` clamp override otherwise.
   */
  private static planOpening(
    op: WallOpening,
    newHeightM: number,
    variantId: VariantId,
    dropMarker: (id: string) => NodeOverride,
    warnings: string[],
  ): NodeOverride | null | undefined {
    const top = op.offset_from_floor_m + op.height_m
    if (top <= newHeightM + FIT_EPSILON_M) return undefined // already fits

    // The opening is too tall for the new wall — it cannot be re-anchored.
    if (op.height_m > newHeightM + FIT_EPSILON_M) {
      warnings.push(
        `Opening ${op.id} (${op.height_m.toFixed(2)} m tall) no longer fits wall ` +
          `at ${newHeightM.toFixed(2)} m and was removed`,
      )
      return dropMarker(op.id)
    }

    // Clamp the sill so the opening's top edge sits at the new wall top.
    const clampedOffset = Math.max(0, newHeightM - op.height_m)
    warnings.push(
      `Opening ${op.id} re-anchored: sill ${op.offset_from_floor_m.toFixed(2)} m → ` +
        `${clampedOffset.toFixed(2)} m to fit the shorter wall`,
    )
    const fields: Record<string, unknown> = { offset_from_floor_m: clampedOffset }
    // `sill_height_m` aliases `offset_from_floor_m` for windows — keep them
    // consistent so explicit sill reads do not drift from the live offset.
    if (op.type === 'window') fields.sill_height_m = clampedOffset
    return { base_node_id: op.id, variant_id: variantId, override_fields: fields }
  }

  /**
   * Plan one wall-mounted object. Returns `undefined` when it already fits,
   * a `__deleted` override when the object is taller than the new wall, or a
   * `height_from_floor_m` clamp override otherwise.
   */
  private static planWallObject(
    obj: SpatialObject,
    newHeightM: number,
    variantId: VariantId,
    dropMarker: (id: string) => NodeOverride,
    warnings: string[],
  ): NodeOverride | null | undefined {
    const objHeight = obj.dimensions?.height_m ?? 0
    const base = obj.height_from_floor_m ?? 0
    const top = base + objHeight
    if (top <= newHeightM + FIT_EPSILON_M) return undefined // already fits

    if (objHeight > newHeightM + FIT_EPSILON_M) {
      warnings.push(
        `Wall-mounted object ${obj.id} (${objHeight.toFixed(2)} m tall) no longer ` +
          `fits wall at ${newHeightM.toFixed(2)} m and was removed`,
      )
      return dropMarker(obj.id)
    }

    const clamped = Math.max(0, newHeightM - objHeight)
    warnings.push(
      `Wall-mounted object ${obj.id} re-anchored: height-from-floor ` +
        `${base.toFixed(2)} m → ${clamped.toFixed(2)} m to fit the shorter wall`,
    )
    return {
      base_node_id: obj.id,
      variant_id: variantId,
      override_fields: { height_from_floor_m: clamped },
    }
  }
}
