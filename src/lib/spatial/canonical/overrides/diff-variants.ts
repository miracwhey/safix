/**
 * Spatial · Canonical · Overrides · Diff Variants
 *
 * Compare two resolved scenes (typically `base` vs `customer_corrections` or
 * `customer_corrections` vs `provider_X_annotations`) and produce a
 * structured diff suitable for the compare-view in Phase 4.
 *
 * The diff is computed against RESOLVED scenes; callers should pass already-
 * resolved RoomScenes via {@link resolveScene} for both sides.
 */

import type { RoomScene, Node } from '../types/scene-graph.ts'

export interface DiffEntry {
  /** Type of change since the comparison base. */
  kind: 'added' | 'removed' | 'modified'
  /** Stable node id, present in at least one of the two scenes. */
  node_id: string
  /** Concrete node type — informs how the UI renders the entry. */
  node_type?: string
  /** Field paths that changed (only for `modified`). */
  changed_fields?: string[]
}

export interface DiffReport {
  added: DiffEntry[]
  removed: DiffEntry[]
  modified: DiffEntry[]
}

/**
 * Diff two scenes node-by-node. Both inputs must already be resolved
 * (i.e. base scene + overrides applied) so the comparison is between
 * the user-visible states of each variant, not against the raw base.
 *
 * Modified-detection compares shallow fields; deeply nested mutations
 * surface as "transform changed" without enumerating every sub-field.
 * Phase-2 edit-system will add a `commands` event log that gives the
 * actual edit history; the diff here is for at-a-glance review.
 */
export function diffVariants(a: RoomScene, b: RoomScene): DiffReport {
  const aMap = collect(a)
  const bMap = collect(b)
  const added: DiffEntry[] = []
  const removed: DiffEntry[] = []
  const modified: DiffEntry[] = []

  for (const [id, nodeA] of aMap) {
    const nodeB = bMap.get(id)
    if (!nodeB) {
      removed.push({ kind: 'removed', node_id: id, node_type: nodeA.type })
      continue
    }
    const changed = shallowDiff(nodeA as unknown as Record<string, unknown>, nodeB as unknown as Record<string, unknown>)
    if (changed.length > 0) {
      modified.push({ kind: 'modified', node_id: id, node_type: nodeA.type, changed_fields: changed })
    }
  }
  for (const [id, nodeB] of bMap) {
    if (!aMap.has(id)) added.push({ kind: 'added', node_id: id, node_type: nodeB.type })
  }

  return { added, removed, modified }
}

function collect(scene: RoomScene): Map<string, Node> {
  const out = new Map<string, Node>()
  out.set(scene.id, scene)
  if (scene.floor) out.set(scene.floor.id, scene.floor)
  if (scene.ceiling) out.set(scene.ceiling.id, scene.ceiling)
  for (const w of scene.walls) {
    out.set(w.id, w)
    for (const o of w.openings) out.set(o.id, o)
    for (const o of w.wall_mounted) out.set(o.id, o)
  }
  if (scene.floor) for (const o of scene.floor.floor_mounted) out.set(o.id, o)
  if (scene.ceiling) for (const o of scene.ceiling.ceiling_mounted) out.set(o.id, o)
  for (const o of scene.free_objects) out.set(o.id, o)
  for (const p of scene.pins) out.set(p.id, p)
  for (const p of scene.photos) out.set(p.id, p)
  for (const n of scene.notes) out.set(n.id, n)
  return out
}

function shallowDiff<T extends Record<string, unknown>>(a: T, b: T): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  // Volatile fields excluded from the visible diff — `updated_at` flips on
  // every variant-write regardless of substance, and `children_ids` is
  // re-derived from the resolver output (not user-meaningful).
  const ignore = new Set(['updated_at', 'children_ids'])
  const out: string[] = []
  for (const k of keys) {
    if (ignore.has(k)) continue
    if (!shallowEqual(a[k], b[k])) out.push(k)
  }
  return out
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!shallowEqual(a[i], b[i])) return false
    }
    return true
  }
  const aKeys = Object.keys(a as object)
  const bKeys = Object.keys(b as object)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (!shallowEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}
