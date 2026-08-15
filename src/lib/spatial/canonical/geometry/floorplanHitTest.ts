/**
 * Spatial · Canonical · Geometry · Floorplan Hit-Test (pure · three.js-free)
 *
 * Screen-pixel hit resolution for the 2D top-down footprint editor
 * (`FloorplanDragLayer`). Every radius is compared in CSS px AFTER projecting
 * world XZ through the live ortho camera (the caller injects `toPx`), so the
 * hit targets stay finger-sized at any zoom — radii are NEVER metric.
 *
 * Priority (first match wins): wall-hosted opening / wall-mounted object →
 * floor / free object → wall → nothing. The mid-bar slide handle is resolved
 * BEFORE this (highest priority) in the gesture layer's pointer-down via
 * {@link isWithinBarSegmentPx}.
 */

export interface XZ {
  x: number
  z: number
}

export interface Px {
  x: number
  y: number
}

/** Along-wall span of a hosted child: [offsetAlong, offsetAlong + width]. */
export interface HitWallChild {
  id: string
  offsetAlong: number
  width: number
}

/** A wall centerline segment + its along-wall children (openings + mounted). */
export interface HitWall {
  id: string
  start: XZ
  end: XZ
  openings: HitWallChild[]
  wallMounted: HitWallChild[]
}

/** A floor / free object's oriented footprint (top-down). */
export interface HitObject {
  id: string
  center: XZ
  width: number
  depth: number
  yawDeg: number
}

export type FloorplanTapResult =
  | { kind: 'object'; id: string }
  | { kind: 'wallObject'; id: string }
  | { kind: 'wall'; id: string }
  | { kind: null }

/** Screen-space distance from point (px,py) to the segment (ax,ay)→(bx,by). */
export function pointToSegmentPx(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/**
 * The four world-space XZ corners of an oriented footprint rect, in ring order
 * (local −w/−d, +w/−d, +w/+d, −w/+d rotated by `yawDeg` around Y, then offset
 * to `center`).
 */
export function orientedRectCornersWorld(o: {
  center: XZ
  width: number
  depth: number
  yawDeg: number
}): XZ[] {
  const a = (o.yawDeg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const hw = o.width / 2
  const hd = o.depth / 2
  const local: [number, number][] = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ]
  return local.map(([lx, lz]) => ({
    x: o.center.x + lx * c - lz * s,
    z: o.center.z + lx * s + lz * c,
  }))
}

/** Even-odd point-in-polygon test in screen px. */
export function pointInPolyPx(p: Px, poly: Px[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x
    const yi = poly[i].y
    const xj = poly[j].x
    const yj = poly[j].y
    const intersects =
      yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

/** Min px distance from `p` to any edge of the (closed) polygon. */
function minEdgeDistPx(p: Px, poly: Px[]): number {
  let best = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const d = pointToSegmentPx(p.x, p.y, poly[j].x, poly[j].y, poly[i].x, poly[i].y)
    if (d < best) best = d
  }
  return best
}

/**
 * True when the finger is within `radiusPx` of the rendered mid-bar SEGMENT
 * (its two scaled end points), so the WHOLE visible bar is grabbable — not just
 * a disc at its midpoint.
 */
export function isWithinBarSegmentPx(
  point: Px,
  barEndA: Px,
  barEndB: Px,
  radiusPx: number,
): boolean {
  return (
    pointToSegmentPx(point.x, point.y, barEndA.x, barEndA.y, barEndB.x, barEndB.y) <=
    radiusPx
  )
}

export interface FloorplanHitInput {
  point: Px
  walls: HitWall[]
  objects: HitObject[]
  toPx: (p: XZ) => Px
  openingPx: number
  objectPx: number
  wallPx: number
  /**
   * When `true`, a WALL under the finger wins over a wall-hosted opening /
   * wall-mounted object. In the 2D top-down footprint editor an opening is
   * COLLINEAR with its wall (same screen line), so the default opening-first
   * priority makes a wall un-tappable wherever a window sits on it. Surfaces
   * whose 2D job is wall-dimension editing set this `true` (openings are then
   * edited in 3D); floor/free objects keep top priority either way. Default
   * `false` (opening-first — the provider/legacy behaviour).
   */
  preferWall?: boolean
}

/**
 * Resolve a floorplan tap to the highest-priority target under the finger.
 * Default priority: wall-hosted opening / wall-mounted → floor / free object →
 * wall → null. With `preferWall`, walls outrank wall-hosted objects:
 * floor / free object → wall → wall-hosted opening / wall-mounted → null.
 * Object ties break to the SMALLEST footprint (a small fixture sitting on a big
 * one stays reachable).
 */
export function resolveFloorplanHit(input: FloorplanHitInput): FloorplanTapResult {
  const { point, walls, objects, toPx, openingPx, objectPx, wallPx, preferWall = false } = input

  // Openings + wall-mounted objects — project the along-wall span to px.
  let openHit: { id: string; d: number } | null = null
  for (const w of walls) {
    const dx = w.end.x - w.start.x
    const dz = w.end.z - w.start.z
    const len = Math.hypot(dx, dz)
    if (len < 1e-6) continue
    const ux = dx / len
    const uz = dz / len
    for (const child of [...w.openings, ...w.wallMounted]) {
      const a = toPx({ x: w.start.x + ux * child.offsetAlong, z: w.start.z + uz * child.offsetAlong })
      const b = toPx({
        x: w.start.x + ux * (child.offsetAlong + child.width),
        z: w.start.z + uz * (child.offsetAlong + child.width),
      })
      const d = pointToSegmentPx(point.x, point.y, a.x, a.y, b.x, b.y)
      if (d <= openingPx && (!openHit || d < openHit.d)) openHit = { id: child.id, d }
    }
  }

  // Floor / free objects — oriented footprint, tie-break smallest area.
  let objHit: { id: string; area: number } | null = null
  for (const o of objects) {
    const poly = orientedRectCornersWorld(o).map(toPx)
    if (!pointInPolyPx(point, poly) && minEdgeDistPx(point, poly) > objectPx) continue
    const area = o.width * o.depth
    if (!objHit || area < objHit.area) objHit = { id: o.id, area }
  }

  // Walls — nearest centerline segment within the wall band.
  let wallHit: { id: string; d: number } | null = null
  for (const w of walls) {
    const a = toPx(w.start)
    const b = toPx(w.end)
    const d = pointToSegmentPx(point.x, point.y, a.x, a.y, b.x, b.y)
    if (d <= wallPx && (!wallHit || d < wallHit.d)) wallHit = { id: w.id, d }
  }

  const wallObject: FloorplanTapResult | null = openHit
    ? { kind: 'wallObject', id: openHit.id }
    : null
  const object: FloorplanTapResult | null = objHit ? { kind: 'object', id: objHit.id } : null
  const wall: FloorplanTapResult | null = wallHit ? { kind: 'wall', id: wallHit.id } : null

  if (preferWall) {
    return object ?? wall ?? wallObject ?? { kind: null }
  }
  return wallObject ?? object ?? wall ?? { kind: null }
}
