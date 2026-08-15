/**
 * Spatial · Canonical · Workflow · BoM Auto-Items (Phase C · C-4 · Seam 4)
 *
 * Pure logic — zero React, zero side-effects.
 *
 * Derives the `source='auto'` Bill-of-Materials items from a hydrated
 * `RoomScene`: one item per wall (surface m²), one for the floor (m²), one
 * per fixture (pcs). Each carries a STABLE `nodeId` so the plan↔list
 * bi-selection and the {@link reconcileAutoItems} merge can key on the
 * scene-graph node rather than a display position.
 *
 * {@link computeBomPlan} projects the same nodes onto a normalised 0–100
 * floor-plan space — the data-driven replacement for the hard-wired
 * `PLAN_MARKER_MAP` placeholder.
 */

import type { RoomScene } from '../types/scene-graph.ts'
import type { Wall } from '../types/geometry.ts'
import type { Vector3 } from '../types/primitives.ts'
import type { BomItem, WallAreaBreakdown } from './bomModel.ts'

/** Round to 2 decimals — quantities are display values, not money. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ─── Surface-area + perimeter geometry (pure) ────────────────────────────────

/**
 * Billable wall surface, openings deducted.
 *
 * `grossM2 = length_m × height_m`; `openingsM2 = Σ(width_m × height_m)` over the
 * wall's doors / windows / openings; `netM2 = max(0, gross − openings)`. Net is
 * the default billed quantity — a door or window is not a tiled / painted
 * surface — while the gross + deduction are surfaced (see {@link WallAreaBreakdown})
 * so the craftsman can switch back to gross for the trades where small openings
 * are übermessen (VOB/C · DIN 18363 Maler / DIN 18352 Fliesen).
 */
export function computeWallSurfaceArea(wall: Wall): WallAreaBreakdown {
  const gross = wall.length_m * wall.height_m
  const openings = wall.openings.reduce((sum, op) => sum + op.width_m * op.height_m, 0)
  const net = Math.max(0, gross - openings)
  return {
    grossM2: round2(gross),
    openingsM2: round2(openings),
    netM2: round2(net),
  }
}

/**
 * Perimeter of a closed floor polygon in meters — Σ of consecutive edge lengths
 * projected onto the XZ-plane (Y is floor level), mirroring the projection
 * {@link computeBomPlan} uses. A degenerate (<2-vertex) ring is 0.
 */
export function polygonPerimeterM(polygon: Vector3[]): number {
  if (polygon.length < 2) return 0
  let sum = 0
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]
    sum += Math.hypot(b.x - a.x, b.z - a.z)
  }
  return sum
}

export interface FloorPerimeterResult {
  /** Total floor-polygon perimeter in meters. */
  perimeterM: number
  /** Σ width of walkable portals (doors / unframed openings) — no skirting there. */
  doorWidthsM: number
  /** max(0, perimeter − doorWidths) — billable skirting-board length. */
  skirtingM: number
}

/**
 * Skirting-board length (Sockelleiste · lfm) = floor perimeter minus the width
 * of every walkable portal (doors + unframed openings; windows keep their
 * skirting below the sill).
 */
export function computeFloorPerimeterForBom(
  polygon: Vector3[],
  walls: Wall[],
): FloorPerimeterResult {
  const perimeterM = polygonPerimeterM(polygon)
  const doorWidthsM = walls.reduce(
    (sum, wall) =>
      sum +
      wall.openings.reduce(
        (wSum, op) => (op.is_walkable_portal ? wSum + op.width_m : wSum),
        0,
      ),
    0,
  )
  const skirtingM = Math.max(0, perimeterM - doorWidthsM)
  return {
    perimeterM: round2(perimeterM),
    doorWidthsM: round2(doorWidthsM),
    skirtingM: round2(skirtingM),
  }
}

/** All fixture objects of a scene — free-standing plus wall-mounted. */
function sceneFixtures(scene: RoomScene) {
  return [...scene.free_objects, ...scene.walls.flatMap((w) => w.wall_mounted)]
}

/**
 * Generate the auto BoM items for a scene. Positions are assigned 1..N in
 * `floor → walls → fixtures` order; {@link reconcileAutoItems} owns the merge
 * that preserves entered prices when this is re-run on a fresh scene.
 */
export function generateAutoItems(scene: RoomScene): BomItem[] {
  const items: BomItem[] = []
  let position = 1

  // Floor — one m² item.
  items.push({
    id: `auto-${scene.floor.id}`,
    position: position++,
    description: 'Bodenfläche',
    category: 'Boden',
    quantity: round2(scene.computed_area_m2),
    unit: 'm2',
    unitPriceCents: 0,
    source: 'auto',
    nodeId: scene.floor.id,
  })

  // Skirting board (Sockelleiste · lfm) — floor perimeter minus door openings.
  // Its nodeId is suffixed so it never collides with the floor item on the
  // `reconcileAutoItems` nodeId-map; it carries no plan marker (a perimeter,
  // not a point) so the floor-plan render skips it cleanly.
  const skirting = computeFloorPerimeterForBom(scene.floor.polygon, scene.walls)
  if (skirting.skirtingM > 0) {
    items.push({
      id: `auto-skirting-${scene.floor.id}`,
      position: position++,
      description: 'Sockelleiste',
      category: 'Boden',
      quantity: skirting.skirtingM,
      unit: 'lfm',
      unitPriceCents: 0,
      source: 'auto',
      nodeId: `${scene.floor.id}:skirting`,
    })
  }

  // Walls — one surface-m² item each. Billed quantity is the NET area
  // (gross minus door/window openings); the gross/openings/net breakdown rides
  // along on `areaBreakdown` so the deduction is shown — and reversible — in the UI.
  scene.walls.forEach((wall, idx) => {
    const area = computeWallSurfaceArea(wall)
    items.push({
      id: `auto-${wall.id}`,
      position: position++,
      description: wall.name ?? `Wand ${idx + 1}`,
      category: 'Wand',
      quantity: area.netM2,
      unit: 'm2',
      unitPriceCents: 0,
      source: 'auto',
      nodeId: wall.id,
      areaBreakdown: area,
    })
  })

  // Fixtures — one pcs item each.
  sceneFixtures(scene).forEach((obj, idx) => {
    items.push({
      id: `auto-${obj.id}`,
      position: position++,
      description: obj.name ?? obj.category ?? `Objekt ${idx + 1}`,
      category: 'Ausstattung',
      quantity: 1,
      unit: 'pcs',
      unitPriceCents: 0,
      source: 'auto',
      nodeId: obj.id,
    })
  })

  return items
}

// ─── Floor-plan projection ────────────────────────────────────────────────────

/** A floor-plan point in normalised 0–100 space. */
export interface BomPlanPoint {
  xPct: number
  yPct: number
}

/** A node's plan marker — keyed by the auto-item `nodeId`. */
export interface BomPlanMarker extends BomPlanPoint {
  nodeId: string
}

export interface BomPlan {
  /** Floor outline ring in normalised space — drives the `<polygon>`. */
  floorPolygon: BomPlanPoint[]
  /** One marker per scene node, keyed by `nodeId` (matches auto-item nodeId). */
  markers: BomPlanMarker[]
}

/** Padding (percent) around the room inside the 0–100 plan box. */
const PLAN_PAD = 12

/**
 * Project a scene's floor polygon + node centroids onto a normalised 0–100
 * square. Uniform scale (longest span fills the box) keeps the room
 * proportional; the shorter axis is centred.
 */
export function computeBomPlan(scene: RoomScene): BomPlan {
  const minX = scene.bounds_min.x
  const minZ = scene.bounds_min.z
  const spanX = scene.bounds_max.x - minX || 1
  const spanZ = scene.bounds_max.z - minZ || 1
  const span = Math.max(spanX, spanZ) || 1
  const scale = (100 - 2 * PLAN_PAD) / span
  const offX = PLAN_PAD + ((span - spanX) * scale) / 2
  const offZ = PLAN_PAD + ((span - spanZ) * scale) / 2

  const project = (x: number, z: number): BomPlanPoint => ({
    xPct: offX + (x - minX) * scale,
    yPct: offZ + (z - minZ) * scale,
  })

  const floorPolygon = scene.floor.polygon.map((p) => project(p.x, p.z))

  const markers: BomPlanMarker[] = []
  // Floor marker — the room centroid.
  markers.push({
    nodeId: scene.floor.id,
    ...project(minX + spanX / 2, minZ + spanZ / 2),
  })
  // Wall markers — the wall centreline midpoint.
  for (const wall of scene.walls) {
    markers.push({
      nodeId: wall.id,
      ...project(
        (wall.start_point.x + wall.end_point.x) / 2,
        (wall.start_point.z + wall.end_point.z) / 2,
      ),
    })
  }
  // Fixture markers — the object's transform position.
  for (const obj of sceneFixtures(scene)) {
    markers.push({
      nodeId: obj.id,
      ...project(obj.transform.position.x, obj.transform.position.z),
    })
  }

  return { floorPolygon, markers }
}
