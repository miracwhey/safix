/**
 * Spatial · Canonical · Algebra · Transforms
 *
 * Combines matrices and quaternions into the higher-level transform
 * primitives used by the rest of the canonical layer:
 *
 *   - `composeTransform`     : TRS struct → Matrix4
 *   - `decomposeTransform`   : Matrix4 → TRS struct
 *   - `parentRelativeResolve`: child world-tx given parent world-tx and child local-tx
 *   - `worldTransformCompute`: walk scene-graph ancestry to produce world-tx (with cache)
 *
 * Per Master-Spec §2.3, every `Node.transform` is parent-relative. World-
 * space transforms are derived on demand. This module exists so the rest
 * of the L1 layer never has to think about traversal — adapters and
 * validators pull a `Matrix4` straight from `worldTransformCompute`.
 *
 * Cache strategy (R8 mitigation): a `WorldTransformCache` is a plain
 * `Map<nodeId, Matrix4>` owned by the caller. Pass it in to enable memoised
 * traversal; pass `undefined` to skip caching (e.g. one-shot tests). The
 * cache is invalidated by the caller — typically when a node's local
 * transform changes, the Phase-2 edit-system clears the cache for the
 * mutated node + all its descendants.
 */

import {
  IDENTITY_MATRIX4,
  type Matrix4,
  type Matrix4Mutable,
  type Transform,
} from '../types/primitives.ts'
import {
  composeMatrix,
  decomposeMatrix,
  multiplyMatrix,
} from './matrix.ts'

/**
 * A minimal node shape sufficient for traversal. Avoids importing the full
 * `Node` interface (which would create a dependency from algebra/ to
 * scene-graph/) — the structural type below is enough for `worldTransformCompute`.
 */
export interface TransformNode {
  id: string
  parent_id: string | null
  transform: Transform
}

/**
 * Look-up function shape. Pass any concrete implementation (Map.get, array
 * search, store-selector) — the algebra layer stays decoupled from the
 * storage choice.
 *
 * Returns `null` when the parent is unknown; `worldTransformCompute` treats
 * that as a no-parent (root) terminator.
 */
export type NodeLookup<T extends TransformNode = TransformNode> = (
  id: string,
) => T | null

/**
 * Cache used by `worldTransformCompute` to memoise traversals. A plain
 * `Map` is sufficient; callers may pre-fill it or wipe entries when a node
 * mutates.
 */
export type WorldTransformCache = Map<string, Matrix4>

/**
 * Compose a Matrix4 directly from a {@link Transform} struct. Pure wrapper
 * around `matrix.composeMatrix` that takes the TRS form callers actually
 * have.
 */
export function composeTransform(t: Transform): Matrix4Mutable {
  return composeMatrix(t.position, t.rotation, t.scale)
}

/**
 * Decompose a Matrix4 back into a {@link Transform} struct.
 */
export function decomposeTransform(m: Matrix4): Transform {
  const { position, rotation, scale } = decomposeMatrix(m)
  return { position, rotation, scale }
}

/**
 * Given the parent's world-space matrix and the child's parent-relative
 * local transform, return the child's world-space matrix.
 *
 *   M_world(child) = M_world(parent) · M_local(child)
 */
export function parentRelativeResolve(
  parentWorld: Matrix4,
  childLocal: Transform,
): Matrix4Mutable {
  return multiplyMatrix(parentWorld, composeTransform(childLocal))
}

/**
 * Walk the scene-graph ancestry and produce the world-space matrix for `node`.
 *
 * - For a root node (`parent_id === null`) returns the node's local matrix.
 * - For a child node, recursively resolves the parent's world matrix and
 *   pre-multiplies with the child's local.
 * - When `cache` is supplied, repeated calls become O(1) for already-seen
 *   nodes; without a cache the function is O(depth-of-tree).
 *
 * If the parent_id points to an unknown node (broken ancestry), the function
 * treats the current node as a root and returns its local transform. This
 * preserves "render-graceful" behaviour (Decision #5) and lets the validator
 * surface the broken-link as a separate error.
 *
 * @example
 *   const cache = new Map<string, Matrix4>()
 *   const lookup: NodeLookup = id => scene.nodesById.get(id) ?? null
 *   const m = worldTransformCompute(myNode, lookup, cache)
 */
export function worldTransformCompute<T extends TransformNode>(
  node: T,
  lookup: NodeLookup<T>,
  cache?: WorldTransformCache,
): Matrix4 {
  // Cache hit.
  if (cache) {
    const cached = cache.get(node.id)
    if (cached !== undefined) return cached
  }

  const localMatrix = composeTransform(node.transform)

  // Root node: world == local.
  if (node.parent_id === null) {
    if (cache) cache.set(node.id, localMatrix)
    return localMatrix
  }

  const parent = lookup(node.parent_id)
  // Broken ancestry: treat as root, validator will flag.
  if (parent === null) {
    if (cache) cache.set(node.id, localMatrix)
    return localMatrix
  }

  // Recursive case: parent's world × local.
  const parentWorld = worldTransformCompute(parent, lookup, cache)
  const world = multiplyMatrix(parentWorld, localMatrix)
  if (cache) cache.set(node.id, world)
  return world
}

/**
 * Invalidate the cache entry for `nodeId` and all its descendants.
 *
 * Used by the Phase-2 edit-system when a local transform changes — the
 * mutated node and every descendant need to be re-computed on next access.
 *
 * Implementation: builds a parent→children adjacency from the lookup and
 * walks downward from `nodeId`. The caller supplies the same lookup used
 * for `worldTransformCompute`, plus an additional `childrenLookup` for
 * efficient descendant enumeration (typically pre-computed in the store).
 */
export function invalidateWorldTransformCache(
  cache: WorldTransformCache,
  nodeId: string,
  childrenLookup: (id: string) => readonly string[],
): void {
  const queue: string[] = [nodeId]
  while (queue.length > 0) {
    const current = queue.pop() as string
    cache.delete(current)
    const children = childrenLookup(current)
    for (let i = 0; i < children.length; i++) queue.push(children[i])
  }
}

/**
 * Wipe the entire world-transform cache. Cheap escape hatch when the
 * caller cannot enumerate which subtree was affected (e.g. variant switch).
 */
export function clearWorldTransformCache(cache: WorldTransformCache): void {
  cache.clear()
}

/**
 * Identity-matrix accessor for callers that want a one-line "fresh world
 * matrix" without importing primitives.ts directly. Returns the frozen
 * reference — do NOT mutate.
 */
export function identityWorldMatrix(): Matrix4 {
  return IDENTITY_MATRIX4
}
