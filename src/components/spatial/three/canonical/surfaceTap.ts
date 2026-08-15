/**
 * Spatial · Canonical · Three · Surface-Tap Resolution (Phase 2 · Block 2.12 host)
 *
 * Pure helpers for the Edit-Mode-Viewer-Host's raycast surface-tap. Every
 * canonical adapter wraps its mesh in a NAMED `<group>`:
 *   - `wall-${id}` · `floor-${id}` · `ceiling-${id}` · `object-${id}`
 *
 * A raycast hit lands on a leaf `<mesh>`; this module walks the object's
 * ancestor chain to recover the `(kind, nodeId)` of the canonical node that
 * was tapped. Zero React / three.js imports — it operates on the minimal
 * `{ name, parent }` shape so it is unit-testable with plain literals.
 */

/** The canonical node kinds a surface-tap can resolve. */
export type TappedSurfaceKind = 'wall' | 'floor' | 'ceiling' | 'object'

/** A world-space point — the XYZ of a raycast hit. */
export interface TapPoint {
  x: number
  y: number
  z: number
}

/** A resolved surface tap — the canonical node behind a raycast hit. */
export interface TappedSurface {
  kind: TappedSurfaceKind
  /** Canonical node id (the suffix of the adapter group name). */
  nodeId: string
  /**
   * World-space XYZ of the raycast hit on the surface. Present when the
   * pointer event carried an intersection point (it always does for a real
   * r3f raycast; absent in synthetic tap fixtures). The Stage-4 Pin-Drop path
   * projects this onto the host surface's canonical UV.
   */
  point?: TapPoint
}

/** Minimal scene-graph node shape — `THREE.Object3D` satisfies it structurally. */
export interface NamedObject {
  name?: string
  parent?: NamedObject | null
  /**
   * `Object3D.visible`. Optional weil synthetic Fixtures es weglassen — wenn
   * present und `false`, wird die Surface beim Resolve übersprungen (R12.2:
   * AutoCeilingCutaway + FrontWall-Hide sollen Raycast nicht fangen).
   */
  visible?: boolean
}

const GROUP_NAME = /^(wall|floor|ceiling|object)-(.+)$/

/**
 * Parse a single adapter group name (`wall-w_s`, `object-obj-toilet`, …) into
 * its `(kind, nodeId)`, or `null` when the name is not an adapter group.
 */
export function parseAdapterGroupName(name: string | undefined): TappedSurface | null {
  if (!name) return null
  const m = GROUP_NAME.exec(name)
  if (!m) return null
  return { kind: m[1] as TappedSurfaceKind, nodeId: m[2] }
}

/**
 * Walk an object's ancestor chain (the hit object included) and return the
 * first canonical adapter group it finds, or `null` when the hit is outside
 * any canonical surface (e.g. a helper grid, a gizmo).
 *
 * R12.2 (Visibility-Filter): wenn ein Mesh oder eine seiner Ancestor-Groups
 * `visible === false` ist (CeilingAdapter remove_ceiling, WallAdapter
 * FrontWall-Hide), wird die Surface NICHT zurückgegeben. Sonst würde ein
 * Raycast durch eine ausgeblendete Decke die hintere Wand verfehlen, weil
 * three.js Raycaster Invisible-Meshes per Default mitprüft. Defense in depth
 * neben `raycast={() => null}` auf hidden mesh-elements.
 *
 * A depth cap guards against a malformed/cyclic graph.
 */
export function resolveTappedSurface(hit: NamedObject | null | undefined): TappedSurface | null {
  let cursor: NamedObject | null | undefined = hit
  let depth = 0
  while (cursor && depth < 64) {
    if (cursor.visible === false) return null
    const parsed = parseAdapterGroupName(cursor.name)
    if (parsed) return parsed
    cursor = cursor.parent
    depth += 1
  }
  return null
}

/**
 * Minimal-Shape eines R3F-Intersection-Eintrags — strukturkompatibel mit
 * `THREE.Intersection`. Hält das Modul testbar ohne three.js-Import.
 */
export interface SurfaceHit {
  object: NamedObject
  distance: number
  point?: { x: number; y: number; z: number }
}

/**
 * R12.4: Wand-Priorität bei Multi-Hit-Raycast. Ein Finger-Tap nahe einer
 * Wand-Boden-Kante trifft den Boden mit ~mm Offset minimal näher als die
 * dahinterliegende Wand → User wollte aber die Wand. Strategie: wenn der
 * NEAREST-Hit Floor oder Ceiling ist UND es innerhalb dieser Distance-
 * Tolerance auch einen Wand-Hit gibt, picke die Wand. Object-Hits (Möbel)
 * bleiben respektiert weil sie meistens echte Tap-Targets sind.
 *
 * Tolerance 0.5m. Großzügig genug für iOS-Finger-Offsets (10-15mm screen
 * → ~30cm world-distance bei normaler Dollhouse-Cam-Distance ~5m + FoV 50°),
 * eng genug damit User-intentional Boden-Taps nicht überschrieben werden
 * wenn er WIRKLICH den Boden meint (dann liegt keine Wand 50cm dahinter).
 */
const WALL_PRIORITY_DISTANCE_M = 0.5

export function resolveTappedSurfaceFromHits(
  hits: ReadonlyArray<SurfaceHit>,
): { surface: TappedSurface; point?: { x: number; y: number; z: number } } | null {
  if (hits.length === 0) return null
  // Erstes valides Surface ist Baseline. R3F sortiert intersections nach
  // distance ascending; resolveTappedSurface verwirft invisible-Subtrees.
  let primary: { hit: SurfaceHit; surface: TappedSurface } | null = null
  for (const hit of hits) {
    const surface = resolveTappedSurface(hit.object)
    if (surface) {
      primary = { hit, surface }
      break
    }
  }
  if (!primary) return null
  // Wenn der nächste Treffer schon eine Wand oder ein Object ist, fertig —
  // beide sind absichtliche Tap-Ziele.
  if (primary.surface.kind === 'wall' || primary.surface.kind === 'object') {
    return { surface: primary.surface, point: primary.hit.point }
  }
  // Sonst: nach einer Wand innerhalb der Toleranz hinter dem Floor/Ceiling
  // suchen. Wenn vorhanden, die Wand picken (mit ihrem eigenen Hit-Point).
  const tolerance = primary.hit.distance + WALL_PRIORITY_DISTANCE_M
  for (const hit of hits) {
    if (hit.distance > tolerance) break
    if (hit === primary.hit) continue
    const surface = resolveTappedSurface(hit.object)
    if (surface?.kind === 'wall') {
      return { surface, point: hit.point }
    }
  }
  return { surface: primary.surface, point: primary.hit.point }
}

/**
 * Default Raycaster-Layer (Channel 0). three.js Raycaster prüft
 * `object.layers.test(raycaster.layers)` vor jedem Mesh.raycast() — disablen
 * von Channel 0 auf einem Subtree macht ihn raycast-unsichtbar OHNE die
 * Render-Visibility zu beeinflussen.
 *
 * **V1.6.1 R14:** dieser Helper ist obsolet (Pick-Layer-Decoupling, siehe
 * `pickLayer.ts` + `PickProxy.tsx`). Behalten als no-op-kompatibler Stub,
 * damit alte Call-Sites nicht brechen während des Refactors. Neue Code-Pfade
 * sollen `markPickOnly` aus `pickLayer.ts` benutzen und die Pick-Geometry
 * als dedizierte PickProxy-Plane mounten.
 */
const RAYCAST_LAYER = 0

/** Minimal subset of THREE.Object3D used by setSubtreeRaycastable. */
interface RaycastableNode {
  layers: { enable(channel: number): void; disable(channel: number): void }
  children?: ReadonlyArray<RaycastableNode>
}

/**
 * @deprecated Use `markPickOnly` from `pickLayer.ts` + `<PickProxy>` instead.
 * Kept for back-compat with existing adapters during the R14 refactor.
 */
export function setSubtreeRaycastable(
  root: RaycastableNode | null | undefined,
  raycastable: boolean,
): void {
  if (!root) return
  const stack: RaycastableNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (raycastable) node.layers.enable(RAYCAST_LAYER)
    else node.layers.disable(RAYCAST_LAYER)
    if (node.children) {
      for (const child of node.children) stack.push(child)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// R14 · Multi-Sample-Probe + Vote-Mode-Aggregation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single tap on a mobile touchscreen has finger-fat tolerance (~22-30 CSS-px
 * radius). A single raycast at the exact pointer position regularly misses
 * the intended surface (especially thin walls in dollhouse view). Industry
 * pattern (Sketchfab, Magicplan): run N raycasts in a small cross/grid around
 * the tap and pick the most-voted surface.
 *
 * 9-Point-Probe: center + 8 offsets (axial ±dPx and diagonal ±dPx scaled by
 * PROBE_DIAGONAL_RATIO so the diagonal samples stay inside the same probe
 * radius). Offsets are in CSS pixels — convert to NDC at probe time using
 * current canvas size.
 */
const PROBE_OFFSET_PX = 12 as const
/** Diagonal samples sit at 3/4 of the axial radius to keep a round cluster. */
const PROBE_DIAGONAL_RATIO = 0.75
const PROBE_DIAGONAL_PX = PROBE_OFFSET_PX * PROBE_DIAGONAL_RATIO
export const PROBE_OFFSETS_PX: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [PROBE_OFFSET_PX, 0],
  [-PROBE_OFFSET_PX, 0],
  [0, PROBE_OFFSET_PX],
  [0, -PROBE_OFFSET_PX],
  [PROBE_DIAGONAL_PX, PROBE_DIAGONAL_PX],
  [-PROBE_DIAGONAL_PX, PROBE_DIAGONAL_PX],
  [PROBE_DIAGONAL_PX, -PROBE_DIAGONAL_PX],
  [-PROBE_DIAGONAL_PX, -PROBE_DIAGONAL_PX],
] as const

/**
 * Vote-mode aggregation across multiple probe samples. Each sample contributes
 * the resolved (kind, nodeId) of its nearest valid hit. Wins: highest vote
 * count, ties broken by nearest hit-distance. Returns null if no sample hit
 * any canonical surface.
 *
 * Per-sample input: the ALREADY-resolved surface (use resolveTappedSurface or
 * resolveTappedSurfaceFromHits) — keeps voting logic three.js-agnostic.
 */
export interface ProbeSample {
  /** Resolved surface for THIS sample's nearest valid hit, or null. */
  surface: TappedSurface | null
  /** Distance of the winning hit in this sample (closer = higher tiebreak). */
  distance: number
  /** World-space point of the winning hit. */
  point?: { x: number; y: number; z: number }
}

interface VoteEntry {
  surface: TappedSurface
  count: number
  bestDistance: number
  bestPoint: { x: number; y: number; z: number } | undefined
}

export function voteWinner(
  samples: ReadonlyArray<ProbeSample>,
): { surface: TappedSurface; point?: { x: number; y: number; z: number } } | null {
  const votes = new Map<string, VoteEntry>()
  for (const s of samples) {
    if (!s.surface) continue
    const key = `${s.surface.kind}-${s.surface.nodeId}`
    const existing = votes.get(key)
    if (existing) {
      existing.count += 1
      if (s.distance < existing.bestDistance) {
        existing.bestDistance = s.distance
        existing.bestPoint = s.point
      }
    } else {
      votes.set(key, {
        surface: s.surface,
        count: 1,
        bestDistance: s.distance,
        bestPoint: s.point,
      })
    }
  }
  if (votes.size === 0) return null
  let winner: VoteEntry | null = null
  for (const entry of votes.values()) {
    if (
      !winner ||
      entry.count > winner.count ||
      (entry.count === winner.count && entry.bestDistance < winner.bestDistance)
    ) {
      winner = entry
    }
  }
  if (!winner) return null
  return { surface: winner.surface, point: winner.bestPoint }
}

/** A distinct furniture object lying under the probe, with its nearest hit. */
export interface ObjectCandidate {
  nodeId: string
  distance: number
  point?: { x: number; y: number; z: number }
}

/**
 * Distinct OBJECT candidates under the probe, nearest-first (front → back).
 *
 * `voteWinner` can only ever surface the FRONT object at a screen point, so an
 * occluded one ("Stuhl unter Tisch") is otherwise unreachable — the dominant
 * "Möbel auswählen ist unübersichtlich" complaint. SurfaceTapLayer uses this to
 * let REPEATED taps at the same point walk the depth list. Pure + three.js-
 * agnostic → unit-testable like voteWinner. Only object samples contribute;
 * wall/floor/ceiling keep their own resolution untouched.
 */
export function objectCandidatesByDepth(
  samples: ReadonlyArray<ProbeSample>,
): ObjectCandidate[] {
  const best = new Map<string, ObjectCandidate>()
  for (const s of samples) {
    if (!s.surface || s.surface.kind !== 'object') continue
    const prev = best.get(s.surface.nodeId)
    if (!prev || s.distance < prev.distance) {
      best.set(s.surface.nodeId, {
        nodeId: s.surface.nodeId,
        distance: s.distance,
        point: s.point,
      })
    }
  }
  return [...best.values()].sort((a, b) => a.distance - b.distance)
}

/**
 * The `MaterialPickerSurface.type` an applied material targets, derived from
 * the tapped surface kind. Walls / floors / ceilings map 1:1; a tapped
 * `object` is a fixture/decor surface — the picker's category resolver treats
 * it as `fixture`.
 */
export function tappedKindToPickerSurfaceType(
  kind: TappedSurfaceKind,
): 'wall' | 'floor' | 'ceiling' | 'fixture' {
  return kind === 'object' ? 'fixture' : kind
}

/**
 * The `set_material` command's `surface` discriminator, derived from the
 * tapped surface kind. The command union accepts exactly
 * `'wall' | 'floor' | 'ceiling' | 'object'`.
 */
export function tappedKindToMaterialSurface(
  kind: TappedSurfaceKind,
): 'wall' | 'floor' | 'ceiling' | 'object' {
  return kind
}
