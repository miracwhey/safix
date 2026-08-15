/**
 * Spatial · Canonical · Commands · MovePinCommand
 *
 * `move_pin` — re-anchor a {@link Pin} to a (possibly different) surface UV.
 *
 * The four anchor fields (`anchor_surface_id`, `anchor_surface_type`,
 * `anchor_uv`, `anchor_offset_normal_m`) are written together as one override
 * so a partial re-anchor can never leave a pin half on the old surface and
 * half on the new one. Any other overridden field on the pin survives the
 * shallow merge.
 */

import type { NodeOverride, VariantId } from '../types/variants.ts'
import type { EditOperation, PinAnchor } from '../types/commands.ts'
import { BaseCommand } from './BaseCommand.ts'

export class MovePinCommand extends BaseCommand {
  private readonly pinId: string
  private readonly newAnchor: PinAnchor

  constructor(params: { pinId: string; newAnchor: PinAnchor; variantId: VariantId; label?: string }) {
    const operation: EditOperation = {
      kind: 'move_pin',
      pin_id: params.pinId,
      new_anchor: params.newAnchor,
    }
    super({
      operation,
      label: params.label ?? 'Pin verschoben',
      variantId: params.variantId,
      affectedNodeIds: [params.pinId],
    })
    this.pinId = params.pinId
    this.newAnchor = params.newAnchor
  }

  protected computeAfter(before: readonly (NodeOverride | null)[]): (NodeOverride | null)[] {
    const prior = before[0]
    return [
      {
        base_node_id: this.pinId,
        variant_id: this.variantId,
        override_fields: {
          ...(prior?.override_fields ?? {}),
          anchor_surface_id: this.newAnchor.anchor_surface_id,
          anchor_surface_type: this.newAnchor.anchor_surface_type,
          anchor_uv: this.newAnchor.anchor_uv,
          anchor_offset_normal_m: this.newAnchor.anchor_offset_normal_m,
        },
      },
    ]
  }
}
