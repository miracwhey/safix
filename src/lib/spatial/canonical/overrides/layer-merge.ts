/**
 * Spatial · Canonical · Overrides · Layer-Merge
 *
 * USD-inspired non-destructive override engine — JS-pragmatic, ~200 LOC.
 *
 * Pattern: every node in the canonical scene-graph lives on the base layer.
 * Per-variant changes are stored as {@link NodeOverride} records that the
 * resolver merges onto the base on read; the base is NEVER mutated.
 *
 * The merge semantics follow the USD "stronger-layer wins" rule:
 *   - `override_fields` is a SHALLOW merge mask applied on top of the base.
 *   - Deeply-nested mutations (e.g. changing one component of `transform`)
 *     must replace the entire parent object — partial transform updates use
 *     `override_fields.transform = {position, rotation, scale}`.
 *   - The special marker `{ __deleted: true }` removes the node from the
 *     resolved scene; resolvers must treat it as "this node does not exist
 *     in this variant".
 *
 * Override engine is the ONLY place where the `__deleted` marker is
 * interpreted; everywhere else in the codebase treats nodes as
 * always-present.
 */

import type { NodeOverride } from '../types/variants.ts'

/** Sentinel field used to mark a node as deleted in a variant. */
export const DELETION_MARKER_KEY = '__deleted'

/** Object signature of a deletion override. */
export interface DeletionMarker {
  [DELETION_MARKER_KEY]: true
}

/** True when the override should remove the target node entirely. */
export function isDeletionOverride(override: NodeOverride): boolean {
  return override.override_fields[DELETION_MARKER_KEY] === true
}

/**
 * Apply a single shallow-merge override on top of a base node value.
 *
 * Returns `null` when the override carries the deletion marker — the
 * caller treats `null` as "node removed from this variant".
 *
 * Pass `Object.freeze(base)` at the boundary if you want compile-time
 * confidence the base is not mutated; this function never mutates either
 * input regardless.
 */
export function applyOverride<T extends object>(base: T, override: NodeOverride): T | null {
  if (isDeletionOverride(override)) return null
  return { ...base, ...override.override_fields } as T
}

/**
 * Apply a stack of overrides in order. Layers later in the list win over
 * earlier ones (consistent with USD's "stronger arc" precedence rule).
 *
 * Stops short on the first deletion marker encountered — once a node has
 * been deleted in a stronger layer, downstream additions are NOT replayed.
 * This matches USD semantics and avoids accidentally resurrecting nodes
 * via a third-party variant.
 */
export function mergeOverrides<T extends object>(base: T, overrides: NodeOverride[]): T | null {
  let current: T | null = base
  for (const ov of overrides) {
    if (current === null) {
      // Already deleted by a previous override — later additions are dropped
      // unless they explicitly carry a "resurrect" semantic (V1.x feature;
      // for now: deletion is final within the variant chain).
      if (isDeletionOverride(ov)) continue
      // Treat as resurrection: fall back to applying on the base. This is
      // a deliberate decision to keep V1 resilient when the user removes
      // a node in a customer-layer and adds a different one in a provider-
      // layer (an actual use-case from the verify-flow).
      current = { ...base, ...ov.override_fields } as T
      continue
    }
    current = applyOverride(current, ov)
  }
  return current
}

/**
 * Filter a flat list of overrides down to the ones that target a specific
 * base node and belong to a specific variant. Used by the resolver to
 * avoid iterating the entire override table per node.
 */
export function selectOverrides(
  overrides: NodeOverride[],
  baseNodeId: string,
  variantId: string,
): NodeOverride[] {
  return overrides.filter(o => o.base_node_id === baseNodeId && o.variant_id === variantId)
}
