/**
 * Spatial · Canonical · Commands · AddPinCommand (Phase 3 · Block 3.6)
 *
 * `add_pin` — drop a new 3D-native {@link Pin} onto a surface (the
 * Customer-Verify Stage-4 "Wunsch-Pin" · Implementation-Spec §Stage-4).
 *
 * Like {@link AddDoorCommand}, this command introduces a NEW scene-graph node.
 * The override engine cannot express that — `resolveScene` only merges deltas
 * onto base nodes that already exist — so the pin is appended to / removed from
 * the BASE scene's `pins` array directly via {@link SceneEditContext.setScene}.
 * `do()` / `redo()` append the pin; `undo()` removes it. The base scene is
 * replaced immutably (a fresh `RoomScene` object), never mutated in place.
 *
 * The pin node carries `variant_id = activeVariantId` (the customer's
 * `customer_corrections` layer · RBAC-resolved upstream) and `source: 'manual'`
 * so the variant resolver + the audit trail can see which layer authored it.
 *
 * ── Constraint gate ─────────────────────────────────────────────────────────
 * `editHistoryStore.apply()` runs the Phase-2 per-move validator's `add_pin`
 * branch BEFORE this command executes — a pin whose anchor surface is missing
 * or whose UV is out of [0,1]² is hard-rejected and never reaches `do()`.
 */

import type { RoomScene } from '../types/scene-graph.ts'
import type { Pin } from '../types/annotations.ts'
import type { VariantId, NodeOverride } from '../types/variants.ts'
import type { EditOperation, PinAnchor } from '../types/commands.ts'
import { CanonicalError } from '../types/errors.ts'
import { BaseCommand, type SceneEditContext } from './BaseCommand.ts'

export class AddPinCommand extends BaseCommand {
  private readonly pin: Pin

  constructor(params: { pin: Pin; variantId: VariantId; label?: string }) {
    // Force the pin onto the active variant + `manual` provenance — the caller
    // may pass a bare pin; the command owns the variant/source discipline so a
    // verify-flow pin can never be mis-attributed to `base_roomplan`.
    const pin: Pin = {
      ...params.pin,
      type: 'pin',
      variant_id: params.variantId,
      source: 'manual',
    }
    const anchor: PinAnchor = {
      anchor_surface_id: pin.anchor_surface_id,
      anchor_surface_type: pin.anchor_surface_type,
      anchor_uv: pin.anchor_uv,
      anchor_offset_normal_m: pin.anchor_offset_normal_m,
    }
    const operation: EditOperation = {
      kind: 'add_pin',
      pin_id: pin.id,
      anchor,
    }
    super({
      operation,
      label: params.label ?? 'Markierung gesetzt',
      variantId: params.variantId,
      // No override rows — the pin is a base-scene node, not a delta.
      affectedNodeIds: [],
    })
    this.pin = pin
  }

  /** No override rows — the whole edit is a base-scene mutation. */
  protected computeAfter(): (NodeOverride | null)[] {
    return []
  }

  /** Append the pin node to the scene's `pins` array. */
  protected applyForward(ctx: SceneEditContext): void {
    this.mutatePins(ctx, (pins) =>
      pins.some((p) => p.id === this.pin.id)
        ? pins // idempotent — re-running do/redo never duplicates
        : [...pins, this.pin],
    )
  }

  /**
   * Remove the pin node from the scene's `pins` array.
   *
   * Undo MUST be symmetric: it can only succeed if the pin it added is still
   * present to remove. If the base scene was replaced between `do()` and
   * `undo()` so the pin is gone, a silent id-filter no-op would falsely report
   * a successful undo. Detect that and THROW so the caller (the history store)
   * surfaces the failed undo instead of swallowing it.
   */
  protected applyInverse(ctx: SceneEditContext): void {
    const scene = ctx.scene
    if (!scene) {
      throw new CanonicalError(
        'NOT_FOUND',
        `AddPinCommand undo failed — no scene loaded; cannot remove pin ${this.pin.id}`,
      )
    }
    if (!scene.pins.some((p) => p.id === this.pin.id)) {
      throw new CanonicalError(
        'NOT_FOUND',
        `AddPinCommand undo failed — pin ${this.pin.id} is no longer on the scene; ` +
          `the base scene changed since the pin was added`,
      )
    }
    this.mutatePins(ctx, (pins) => pins.filter((p) => p.id !== this.pin.id))
  }

  private mutatePins(
    ctx: SceneEditContext,
    transform: (pins: Pin[]) => Pin[],
  ): void {
    const scene = ctx.scene
    if (!scene) return
    const next: RoomScene = { ...scene, pins: transform(scene.pins) }
    ctx.setScene(next)
  }
}
