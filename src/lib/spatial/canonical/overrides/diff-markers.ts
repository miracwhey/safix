/**
 * Spatial · Canonical · Overrides · Diff Markers (Phase 2 · Block 2.12)
 *
 * Pure L1 bridge between {@link DiffReport} (`diff-variants.ts`) and the L3
 * visual-diff overlay (`VisualDiffOverlay.tsx`).
 *
 * `diffVariants()` reports WHICH nodes changed (`added` / `removed` /
 * `modified`) but not WHERE they sit in the scene. The renderer needs a
 * world-space anchor per changed node to place a coloured marker. This module
 * resolves that anchor from a {@link RoomScene} with zero three.js / React —
 * it stays trivially unit-testable.
 *
 * Marker semantics (Master-Plan §4 · Block 2.12):
 *   - added    → green
 *   - removed  → red
 *   - modified → amber
 *
 * `added` / `modified` markers anchor to the node in the COMPARED scene
 * (the one that has the node). `removed` markers anchor to the node in the
 * BASE scene (the compared scene no longer has it). The overlay therefore
 * needs BOTH scenes; {@link buildDiffMarkers} takes them explicitly.
 */

import type { RoomScene, Node } from '../types/scene-graph.ts'
import type { Wall, Floor, Ceiling, WallOpening } from '../types/geometry.ts'
import type { SpatialObject } from '../types/objects.ts'
import type { Vector3 } from '../types/primitives.ts'
import type { DiffReport } from './diff-variants.ts'

/** Diff colour per kind — WCAG-checked against the dark canvas background. */
export const DIFF_MARKER_COLORS = Object.freeze({
  added: '#22c55e',
  removed: '#ef4444',
  modified: '#f59e0b',
})

/** One placed visual-diff marker. */
export interface DiffMarker {
  /** Stable node id the marker concerns. */
  node_id: string
  /** Change kind — selects the marker colour. */
  kind: 'added' | 'removed' | 'modified'
  /** Concrete node type (for the overlay's accessible label). */
  node_type?: string
  /** World-space anchor the marker is drawn at. */
  position: Vector3
  /** Hex colour ({@link DIFF_MARKER_COLORS} keyed by `kind`). */
  color: string
}

// ─────────────────────────────────────────────────────────────────────────────
// World-anchor resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Midpoint of a wall's two endpoints, at half wall-height. */
function wallAnchor(w: Wall): Vector3 {
  return {
    x: (w.start_point.x + w.end_point.x) / 2,
    y: (w.base_height_m ?? 0) + w.height_m / 2,
    z: (w.start_point.z + w.end_point.z) / 2,
  }
}

/** Centroid of a polygon ring (floor / ceiling). */
function polygonCentroid(ring: ReadonlyArray<Vector3>, y: number): Vector3 {
  if (ring.length === 0) return { x: 0, y, z: 0 }
  let sx = 0
  let sz = 0
  for (const p of ring) {
    sx += p.x
    sz += p.z
  }
  return { x: sx / ring.length, y, z: sz / ring.length }
}

/** A node carrying a `transform.position` (object / pin / opening fallback). */
function transformAnchor(n: Node): Vector3 {
  const p = n.transform?.position
  return p ? { x: p.x, y: p.y, z: p.z } : { x: 0, y: 0, z: 0 }
}

/**
 * Resolve the world-space anchor of one scene node. Falls back to
 * `transform.position`, then origin, so an unrecognised node never crashes
 * the overlay.
 */
export function nodeWorldAnchor(node: Node): Vector3 {
  switch (node.type) {
    case 'wall':
      return wallAnchor(node as Wall)
    case 'floor': {
      const f = node as Floor
      return polygonCentroid(f.polygon, 0.02)
    }
    case 'ceiling': {
      const c = node as Ceiling
      return polygonCentroid(c.polygon, c.height_m)
    }
    default:
      return transformAnchor(node)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Node index
// ─────────────────────────────────────────────────────────────────────────────

/** Flatten every addressable node of a scene into an id → node map. */
export function indexSceneNodes(scene: RoomScene): Map<string, Node> {
  const out = new Map<string, Node>()
  out.set(scene.id, scene)
  out.set(scene.floor.id, scene.floor)
  out.set(scene.ceiling.id, scene.ceiling)
  for (const w of scene.walls) {
    out.set(w.id, w)
    for (const o of w.openings) out.set(o.id, o as WallOpening)
    for (const o of w.wall_mounted) out.set(o.id, o)
  }
  for (const o of scene.floor.floor_mounted) out.set(o.id, o)
  for (const o of scene.ceiling.ceiling_mounted) out.set(o.id, o)
  for (const o of scene.free_objects) out.set(o.id, o as SpatialObject)
  for (const p of scene.pins) out.set(p.id, p)
  for (const p of scene.photos) out.set(p.id, p)
  for (const n of scene.notes) out.set(n.id, n)
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Marker build
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Place a {@link DiffMarker} for every entry in `report`.
 *
 *   - `added` / `modified` resolve their anchor from `comparedScene` (the
 *     scene the diff's `b` side — the variant being inspected),
 *   - `removed` resolve from `baseScene` (the `a` side — the comparison base
 *     still has the node the compared variant dropped).
 *
 * Entries whose node cannot be located in the expected scene are skipped
 * rather than crashing — a defensive guard for a diff against a stale scene.
 * The room node itself is never marked (it is the whole scene).
 */
export function buildDiffMarkers(
  report: DiffReport,
  baseScene: RoomScene,
  comparedScene: RoomScene,
): DiffMarker[] {
  const baseIndex = indexSceneNodes(baseScene)
  const comparedIndex = indexSceneNodes(comparedScene)
  const markers: DiffMarker[] = []

  const place = (
    nodeId: string,
    kind: DiffMarker['kind'],
    index: Map<string, Node>,
    nodeType?: string,
  ): void => {
    if (nodeId === baseScene.id || nodeId === comparedScene.id) return
    const node = index.get(nodeId)
    if (!node) return
    markers.push({
      node_id: nodeId,
      kind,
      node_type: nodeType ?? node.type,
      position: nodeWorldAnchor(node),
      color: DIFF_MARKER_COLORS[kind],
    })
  }

  for (const e of report.added) place(e.node_id, 'added', comparedIndex, e.node_type)
  for (const e of report.modified) place(e.node_id, 'modified', comparedIndex, e.node_type)
  for (const e of report.removed) place(e.node_id, 'removed', baseIndex, e.node_type)

  return markers
}
