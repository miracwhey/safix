/**
 * Spatial · Canonical · Catalog · Instancing Plan (Block 1.20)
 *
 * Decides which catalog assets a scene should render through a batched /
 * instanced draw path. When the same model appears more than
 * {@link INSTANCING_THRESHOLD} times (e.g. six identical dining chairs) the
 * renderer should collapse them into a single `THREE.BatchedMesh` draw call
 * instead of N individual meshes (asset-source-map §4).
 *
 * Pure L1 — the threshold maths is renderer-agnostic; the L3 ObjectAdapter
 * consumes the plan. No three.js / React / DOM.
 */

/** Instance count strictly above which a model is worth batching. */
export const INSTANCING_THRESHOLD = 3

/** A scene's render plan, partitioning catalog assets by draw strategy. */
export interface InstancingPlan {
  /** asset_id → instance count — render via a shared BatchedMesh. */
  batched: Map<string, number>
  /** asset_id → instance count — render as individual meshes. */
  individual: Map<string, number>
}

/**
 * Partition a scene's object asset references into batched vs individual
 * draw groups. `null` / `undefined` ids (generic cuboids without an asset)
 * are ignored — they have no shared geometry to batch.
 */
export function planAssetInstancing(
  assetIds: readonly (string | null | undefined)[],
): InstancingPlan {
  const counts = new Map<string, number>()
  for (const id of assetIds) {
    if (!id) continue
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }

  const batched = new Map<string, number>()
  const individual = new Map<string, number>()
  for (const [id, count] of counts) {
    if (count > INSTANCING_THRESHOLD) batched.set(id, count)
    else individual.set(id, count)
  }
  return { batched, individual }
}

/** Whether a given asset, at `count` instances, should be batched. */
export function shouldBatchAsset(count: number): boolean {
  return count > INSTANCING_THRESHOLD
}
