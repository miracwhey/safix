/**
 * Spatial · Canonical · Overrides · Variant Resolution
 *
 * Resolve a {@link RoomScene} against a chosen variant id by applying the
 * override stack from the base layer outward through any inheritance arc
 * declared via {@link Variant.parent_variant_id}.
 *
 * The resolver is the read-side entry point. Writers (Phase-2 edit-system)
 * MUTATE only the overrides array; the base scene is treated as immutable
 * once persisted.
 *
 * Performance: the resolver is O(N · K) where N is the node count and K is
 * the override-chain depth (typically ≤ 3). For deep override stacks plus
 * frequent re-renders, wrap the resolver with the WeakMap cache in
 * `./cache.ts` (Risk R8).
 */

import type { Node, RoomScene } from '../types/scene-graph.ts'
import type { Variant, NodeOverride, VariantId } from '../types/variants.ts'
import type { Wall, Floor, Ceiling, WallOpening } from '../types/geometry.ts'
import type { SpatialObject } from '../types/objects.ts'
import type { Pin, Photo, Note } from '../types/annotations.ts'

import { mergeOverrides, selectOverrides } from './layer-merge.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Inheritance chain
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk the parent-variant chain bottom-up so the resolver applies the base
 * variant first and stronger arcs last (USD "weak-to-strong" composition).
 *
 * Returns the list of variant ids in apply-order — base, parent, child, ...
 * Cycles are guarded against by an explicit visited-set; on a cycle we stop
 * early and return what we have rather than throwing.
 */
export function variantChain(target: VariantId, variants: ReadonlyArray<Variant>): VariantId[] {
  const byId = new Map(variants.map(v => [v.id, v]))
  const chain: VariantId[] = []
  const visited = new Set<VariantId>()
  let current: VariantId | undefined = target
  while (current && !visited.has(current)) {
    visited.add(current)
    chain.push(current)
    current = byId.get(current)?.parent_variant_id
  }
  return chain.reverse()
}

// ─────────────────────────────────────────────────────────────────────────────
// Node-level resolve
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a single base node against the variant chain. Returns `null` when
 * the strongest override in the chain marks the node as deleted.
 *
 * Use this for hot-path mutations (e.g. measurement table looking up a
 * single wall's value); for full-scene resolves use {@link resolveScene}.
 */
export function resolveNode<T extends Node>(
  base: T,
  overrides: NodeOverride[],
  variantChainIds: ReadonlyArray<VariantId>,
): T | null {
  if (variantChainIds.length === 0) return base
  const applicable = variantChainIds.flatMap(vid => selectOverrides(overrides, base.id, vid))
  return mergeOverrides(base, applicable)
}

// ─────────────────────────────────────────────────────────────────────────────
// Scene-level resolve
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inputs accepted by {@link resolveScene}. We accept the variant LIST so
 * the resolver knows the inheritance arcs; the caller passes the live
 * scene + the active variant id; the override table can either be carried
 * inside the parametric.json document or fetched separately for V1.x
 * (override-table backend).
 *
 * `onWarning` (optional · H22 audit-fix) receives one human-readable line
 * per dropped orphan annotation/object. Pass `console.warn` for live debug
 * or a collector array in tests.
 */
export interface ResolveSceneInput {
  scene: RoomScene
  overrides: NodeOverride[]
  variants: ReadonlyArray<Variant>
  activeVariantId: VariantId
  onWarning?: (warning: string) => void
}

/**
 * Apply the variant chain to every node in the scene-graph and return a
 * fresh RoomScene with the resolved state. Nodes marked deleted are
 * filtered out from their parent arrays; their children are NOT
 * automatically deleted — Phase-2 edit-system handles cascade explicitly
 * via the command-pattern (so the audit log records every deletion).
 *
 * H22 audit-fix · cascading-delete orphan handling:
 * after walls/floor/ceiling/objects are filtered, any Pin/Photo/Note whose
 * `anchor_surface_id` references a now-deleted surface (or a wall-mounted
 * object whose host wall is gone) is dropped from the result so consumers
 * never see dangling anchors. Each drop is reported via `onWarning`.
 */
export function resolveScene(input: ResolveSceneInput): RoomScene {
  const chain = variantChain(input.activeVariantId, input.variants)
  if (chain.length === 0) return input.scene

  const apply = <T extends Node>(node: T): T | null => resolveNode(node, input.overrides, chain)
  const warn = input.onWarning ?? (() => {})

  // Resolve every node level-by-level. The resolver does NOT recurse into
  // children: each parent already exposes its children as a typed array,
  // and we map those arrays with the same apply() function. The result
  // preserves referential structure.

  const resolvedFloor = apply(input.scene.floor) as Floor | null
  const resolvedCeiling = apply(input.scene.ceiling) as Ceiling | null

  // H22 · when a wall is deleted in the active variant its `openings` and
  // `wall_mounted` children are orphaned — they have no surviving host. The
  // resolver drops them with the wall (they live inside the wall node, so
  // they never reach the resolved scene) and reports each drop via
  // `onWarning` so the deletion is observable + auditable, not silent.
  const walls = input.scene.walls
    .map(w => {
      const resolved = apply(w) as Wall | null
      if (resolved === null) {
        for (const o of w.openings) {
          warn(`resolveScene · dropping opening ${o.id}: host wall ${w.id} was deleted`)
        }
        for (const o of w.wall_mounted) {
          warn(`resolveScene · dropping wall-mounted object ${o.id}: host wall ${w.id} was deleted`)
        }
        return null
      }
      const openings = w.openings.map(o => apply(o) as WallOpening | null).filter((o): o is WallOpening => o !== null)
      const wallMounted = w.wall_mounted
        .map(o => apply(o) as SpatialObject | null)
        .filter((o): o is SpatialObject => o !== null)
      return { ...resolved, openings, wall_mounted: wallMounted }
    })
    .filter((w): w is Wall => w !== null)

  const floor: Floor | null = resolvedFloor
    ? {
      ...resolvedFloor,
      floor_mounted: input.scene.floor.floor_mounted
        .map(o => apply(o) as SpatialObject | null)
        .filter((o): o is SpatialObject => o !== null),
    }
    : null

  const ceiling: Ceiling | null = resolvedCeiling
    ? {
      ...resolvedCeiling,
      ceiling_mounted: input.scene.ceiling.ceiling_mounted
        .map(o => apply(o) as SpatialObject | null)
        .filter((o): o is SpatialObject => o !== null),
    }
    : null

  const freeObjects = input.scene.free_objects
    .map(o => apply(o) as SpatialObject | null)
    .filter((o): o is SpatialObject => o !== null)

  // ── H22 · cascading-delete orphan cleanup ─────────────────────────────
  // Build a set of every surface-id that is still present after the
  // variant filter so we can drop annotations anchored to deleted ones.
  const liveSurfaceIds = new Set<string>()
  for (const w of walls) liveSurfaceIds.add(w.id)
  if (floor) liveSurfaceIds.add(floor.id)
  if (ceiling) liveSurfaceIds.add(ceiling.id)
  for (const w of walls) for (const o of w.wall_mounted) liveSurfaceIds.add(o.id)
  if (floor) for (const o of floor.floor_mounted) liveSurfaceIds.add(o.id)
  if (ceiling) for (const o of ceiling.ceiling_mounted) liveSurfaceIds.add(o.id)
  for (const o of freeObjects) liveSurfaceIds.add(o.id)

  const isOrphan = (
    nodeId: string,
    nodeKind: string,
    anchorId: string | undefined,
  ): boolean => {
    if (anchorId === undefined) return false
    if (liveSurfaceIds.has(anchorId)) return false
    warn(
      `resolveScene · dropping ${nodeKind} ${nodeId}: anchor_surface_id=${anchorId} not present in resolved scene`,
    )
    return true
  }

  const pins = input.scene.pins
    .map(p => apply(p) as Pin | null)
    .filter((p): p is Pin => p !== null)
    .filter(p => !isOrphan(p.id, 'pin', p.anchor_surface_id))
  const photos = input.scene.photos
    .map(p => apply(p) as Photo | null)
    .filter((p): p is Photo => p !== null)
    .filter(p => !isOrphan(p.id, 'photo', p.anchor_surface_id))
  const notes = input.scene.notes
    .map(n => apply(n) as Note | null)
    .filter((n): n is Note => n !== null)
    .filter(n => !isOrphan(n.id, 'note', n.anchor_surface_id))

  return {
    ...input.scene,
    walls,
    floor: floor ?? input.scene.floor,
    ceiling: ceiling ?? input.scene.ceiling,
    free_objects: freeObjects,
    pins,
    photos,
    notes,
  }
}
