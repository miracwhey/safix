/**
 * Spatial · Canonical · Commands · SnapObjectCommand
 *
 * `snap_object` — re-host a {@link SpatialObject} onto a different surface
 * (floor / wall / ceiling / corner / free) and apply the world-space
 * transform produced by the snap resolver.
 *
 * The caller resolves the transform with the pure resolvers from
 * `canonical/snap/asset-snap.ts` (`resolveFloorSnap` / `resolveWallSnap` /
 * `resolveCounterSnap`) and passes the result in; this command's job is to
 * persist `host`, `host_id` and `transform` as one atomic override on the
 * active variant so the re-host and the move can never desync.
 *
 * {@link snapResultToTransform} is a thin adapter from a `SnapResult`
 * (`{ position, rotationYDeg }`) to the canonical {@link Transform}.
 */

import type { Transform, Vector3 } from '../types/primitives.ts'
import { ONE_VECTOR3 } from '../types/primitives.ts'
import type { ObjectHost } from '../types/objects.ts'
import type { NodeOverride, VariantId } from '../types/variants.ts'
import type { EditOperation } from '../types/commands.ts'
import { fromEuler } from '../algebra/quaternion.ts'
import type { SnapResult } from '../snap/asset-snap.ts'
import { BaseCommand } from './BaseCommand.ts'

const DEG2RAD = Math.PI / 180

/**
 * Adapt a {@link SnapResult} from the snap resolvers into a canonical
 * {@link Transform}. `rotationYDeg` becomes a pure-Y quaternion; scale is
 * identity (snap never rescales an object).
 */
export function snapResultToTransform(result: SnapResult): Transform {
  const position: Vector3 = { ...result.position }
  const rotation = fromEuler(0, result.rotationYDeg * DEG2RAD, 0)
  return { position, rotation, scale: { ...ONE_VECTOR3 } }
}

export class SnapObjectCommand extends BaseCommand {
  private readonly objectId: string
  private readonly newHost: ObjectHost
  private readonly newHostId: string
  private readonly newTransform: Transform

  constructor(params: {
    objectId: string
    newHost: ObjectHost
    newHostId: string
    /** World-space transform from a snap resolver — or a raw SnapResult. */
    snap: Transform | SnapResult
    variantId: VariantId
    label?: string
  }) {
    const newTransform: Transform = isSnapResult(params.snap)
      ? snapResultToTransform(params.snap)
      : params.snap
    const operation: EditOperation = {
      kind: 'snap_object',
      object_id: params.objectId,
      new_host: params.newHost,
      new_host_id: params.newHostId,
      new_transform: newTransform,
    }
    super({
      operation,
      label: params.label ?? 'Objekt platziert',
      variantId: params.variantId,
      affectedNodeIds: [params.objectId],
    })
    this.objectId = params.objectId
    this.newHost = params.newHost
    this.newHostId = params.newHostId
    this.newTransform = newTransform
  }

  protected computeAfter(before: readonly (NodeOverride | null)[]): (NodeOverride | null)[] {
    const prior = before[0]
    return [
      {
        base_node_id: this.objectId,
        variant_id: this.variantId,
        override_fields: {
          ...(prior?.override_fields ?? {}),
          host: this.newHost,
          host_id: this.newHostId,
          transform: this.newTransform,
        },
      },
    ]
  }

  /**
   * Rebuild the snap with an auto-snap-corrected transform (§8.3) — the host /
   * host-id are preserved, only the transform is replaced. Returns a fresh
   * `SnapObjectCommand` so the persisted override carries the snapped value;
   * the apply funnel calls this before the command's first `do()`.
   */
  override withCorrectedTransform(transform: Transform): SnapObjectCommand {
    return new SnapObjectCommand({
      objectId: this.objectId,
      newHost: this.newHost,
      newHostId: this.newHostId,
      snap: transform,
      variantId: this.variantId,
      label: this.label,
    })
  }
}

function isSnapResult(v: Transform | SnapResult): v is SnapResult {
  return (v as SnapResult).rotationYDeg !== undefined
}
