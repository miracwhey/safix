/**
 * Spatial · Canonical · Variants (Layers)
 *
 * Master-Spec §6. Variants implement non-destructive editing on top of a
 * single canonical base scene: rather than maintaining N parallel scene-
 * graphs ("scan model", "customer corrected", "provider annotated"), the
 * canonical model stores ONE base scene plus per-variant overrides that
 * are merged on read.
 *
 * This mirrors OpenUSD's `Composition Arcs + Variants + Overrides` pattern
 * but stays JS-pragmatic — we do not import a USD library; the override
 * engine is ~200 LOC of custom code in `overrides/` (Day 4 A17 · risk R8
 * cache-mitigation).
 *
 * Ownership model (binding · simplified 2026-05-19):
 *
 *   | variant_id                    | owner   | mandatory? | editable by   |
 *   |-------------------------------|---------|------------|---------------|
 *   | base_roomplan                 | System  | auto       | nobody (immutable) |
 *   | customer_corrections          | Customer| 1× verify  | Customer      |
 *   | provider_{X}_annotations      | ProviderX| optional  | Provider X    |
 *   | job_{Y}_final                 | both    | auto on accept | nobody (immutable) |
 *   | operator_review               | Operator| trigger    | Operator      |
 */

import type { VariantId } from './scene-graph.ts'
// Re-export so consumers can import `VariantId` from the variants module
// without reaching into scene-graph (it logically belongs to variants).
export type { VariantId }

/**
 * Variant metadata. The variant graph supports inheritance via
 * `parent_variant_id` (composition) — e.g. `job_42_final` inherits from
 * `customer_corrections`, which itself inherits from `base_roomplan`. The
 * resolver walks the chain and merges overrides from base outward.
 */
export interface Variant {
  id: VariantId
  display_name: string
  parent_variant_id?: VariantId
  is_default: boolean
}

/**
 * A single per-node override owned by a variant. `override_fields` is a
 * shallow-merge mask that replaces the matching fields on the base node;
 * deeply nested mutations should be expressed by overriding the entire
 * nested object (e.g. replace the whole `transform` rather than just
 * `transform.position`).
 *
 * Deletion marker: an override with `override_fields === { __deleted: true }`
 * removes the node from the resolved scene. Implemented in
 * `overrides/layer-merge.ts` (Day 4 A17).
 */
export interface NodeOverride {
  /** ID of the base-scene node this override targets. */
  base_node_id: string
  /** Which variant layer owns the override. */
  variant_id: VariantId
  /** Shallow-merge mask — typically `Partial<Node>` plus the deletion marker. */
  override_fields: Record<string, unknown>
}

/**
 * Canonical variant-id constants used across the codebase. Customer- and
 * provider-specific variant ids are constructed from the templates below
 * with the owning user-id appended (e.g. `provider_${userId}_annotations`).
 */
export const STANDARD_VARIANTS = Object.freeze({
  BASE_ROOMPLAN: 'base_roomplan' as VariantId,
  CUSTOMER_CORRECTIONS: 'customer_corrections' as VariantId,
  OPERATOR_REVIEW: 'operator_review' as VariantId,
})

/**
 * Template for provider-annotation variant ids · the resolver matches by
 * prefix. One provider has at most one annotation layer per scene; the
 * spy-prevention RLS (CD-7) gates read access by `provider_id === auth.uid()`.
 */
export const PROVIDER_ANNOTATIONS_PREFIX = 'provider_' as const
export const PROVIDER_ANNOTATIONS_SUFFIX = '_annotations' as const

/**
 * Construct the provider-annotations variant id for a given provider user.
 */
export function providerAnnotationsVariantId(providerUserId: string): VariantId {
  return `${PROVIDER_ANNOTATIONS_PREFIX}${providerUserId}${PROVIDER_ANNOTATIONS_SUFFIX}`
}

/**
 * Template for job-final variant ids · the resolver matches by prefix. The
 * job-final layer is sealed (immutable) at job-accept time; subsequent
 * edits go on a new variant or trigger a re-scan.
 */
export const JOB_FINAL_PREFIX = 'job_' as const
export const JOB_FINAL_SUFFIX = '_final' as const

/**
 * Construct the job-final variant id for a given job.
 */
export function jobFinalVariantId(jobId: string): VariantId {
  return `${JOB_FINAL_PREFIX}${jobId}${JOB_FINAL_SUFFIX}`
}
