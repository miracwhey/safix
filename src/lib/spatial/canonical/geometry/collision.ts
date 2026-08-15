/**
 * Spatial · Canonical · Geometry · Collision
 *
 * Geometric collision primitives used by the walk-mode camera controller
 * (Day 16 P15) to keep the camera-capsule inside the walkable area and
 * outside every wall / floor-mounted obstacle.
 *
 * Risk R14 mitigation: walk-mode camera-capsule could oscillate when
 * resolved against two walls simultaneously (push into wall A, slide into
 * wall B, push into wall A again, …). The iterative resolver here caps
 * itself at 3 push iterations; if collision still persists, it falls back
 * to clamping the camera's Y position (raising it slightly), which
 * defuses corner-wedge cases without teleporting the user.
 *
 * All routines are pure — they consume immutable inputs and return
 * fresh result objects.
 */

import { EPSILON, type Vector3 } from '../types/primitives.ts'
import type {
  BoxShape,
  CameraCapsule,
  WalkablePolygon,
} from '../types/walkable.ts'

/**
 * Minimal capsule shape used by the collision helpers. Compatible with
 * BOTH `CapsuleShape` (tagged collision-volume) and `CameraCapsule`
 * (camera-controller setting) — duck-typing on `radius_m` + `height_m`.
 */
export interface CapsuleDims {
  radius_m: number
  height_m: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Capsule × box
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 3D AABB used by the box-vs-capsule helper. World-space, axis-aligned.
 *
 * Rotated furniture is handled by pairing a `BoxBounds` (the obstacle's
 * UN-rotated extent) with a `rotationY` — see {@link capsuleVsRotatedBox}
 * and {@link CameraObstacle}. The AABB then describes the box in its own
 * local frame; `rotationY` orients it.
 */
export interface BoxBounds {
  /** Lowest-coordinate corner of the AABB. */
  min: Vector3
  /** Highest-coordinate corner of the AABB. */
  max: Vector3
}

/**
 * Build an AABB centred at the given world-position with the dimensions of
 * a {@link BoxShape}. Convenience used by tests and by the camera
 * controller to convert collision volumes into AABBs at runtime.
 */
export function boxBoundsFromShape(center: Vector3, box: BoxShape): BoxBounds {
  const halfW = box.width_m / 2
  const halfH = box.height_m / 2
  const halfD = box.depth_m / 2
  return {
    min: { x: center.x - halfW, y: center.y - halfH, z: center.z - halfD },
    max: { x: center.x + halfW, y: center.y + halfH, z: center.z + halfD },
  }
}

/**
 * Outcome of a capsule-vs-box test.
 *
 *   - `colliding`        : whether the capsule overlaps the box
 *   - `penetrationDepth` : how far into the box the capsule reaches
 *     (always ≥ 0; meaningful only when `colliding`)
 *   - `normal`           : unit-vector that the capsule should be pushed
 *     along to resolve the collision (points from box towards capsule)
 *   - `closestPoint`     : the closest point on the box AABB to the capsule's
 *     centerline — useful for debug visualisations.
 */
export interface CapsuleBoxResult {
  colliding: boolean
  penetrationDepth: number
  normal: Vector3
  closestPoint: Vector3
}

/**
 * Capsule-vs-AABB collision detection.
 *
 * The capsule is described by:
 *   - `capsulePosition`  : world-space position of the capsule's FEET (the
 *                          centre of the bottom hemisphere)
 *   - `capsule.radius_m` : radius of both hemispheres + cylinder
 *   - `capsule.height_m` : TOTAL capsule height (feet → top of head hemi)
 *
 * The algorithm collapses the capsule to its centerline segment, clamps the
 * segment endpoints into the AABB to find the closest point on the box,
 * then tests the distance from the capsule centerline to that point.
 *
 * This is the standard segment-vs-AABB closest-point algorithm; it produces
 * the correct normal even when the capsule penetrates deeply (the normal
 * is computed from the closest-point delta, never the raw center delta).
 */
export function capsuleVsBox(
  capsule: CapsuleDims,
  capsulePosition: Vector3,
  box: BoxBounds,
): CapsuleBoxResult {
  // Capsule centerline endpoints. Feet at `capsulePosition`, head at
  // `capsulePosition + (0, height - 2*radius, 0)` so the hemispheres cap the
  // ends. Floor-clamping: if the capsule would extend below its feet we cap
  // there too (negligible for V1 but defensive).
  const cylinderLength = Math.max(0, capsule.height_m - 2 * capsule.radius_m)
  const bottomY = capsulePosition.y + capsule.radius_m
  const topY = bottomY + cylinderLength

  // Closest point on the AABB to the capsule centerline segment. Because
  // the segment is vertical (constant X/Z), we can decouple per-axis:
  //   - X: clamp capsulePosition.x to [box.min.x, box.max.x]
  //   - Z: same
  //   - Y: clamp to overlap between [bottomY, topY] and [box.min.y, box.max.y]
  const clampedX = clamp(capsulePosition.x, box.min.x, box.max.x)
  const clampedZ = clamp(capsulePosition.z, box.min.z, box.max.z)
  const clampedY = clamp(
    clamp((bottomY + topY) / 2, box.min.y, box.max.y),
    Math.min(bottomY, box.min.y),
    Math.max(topY, box.max.y),
  )

  const closestPoint: Vector3 = { x: clampedX, y: clampedY, z: clampedZ }

  // Closest point on the capsule centerline to the AABB point.
  const segmentY = clamp(clampedY, bottomY, topY)
  const dx = clampedX - capsulePosition.x
  const dy = clampedY - segmentY
  const dz = clampedZ - capsulePosition.z
  const distance = Math.hypot(dx, dy, dz)

  // Capsule centerline is fully inside the AABB → "closest point" sits on
  // the centerline itself and the distance is 0. In that case we cannot
  // derive a normal from the centerline-to-point vector, so we pick the
  // SHORTEST escape direction across the six AABB faces.
  if (distance < EPSILON) {
    const px = capsulePosition.x
    const pz = capsulePosition.z
    const distRight = box.max.x - px
    const distLeft = px - box.min.x
    const distFront = box.max.z - pz
    const distBack = pz - box.min.z
    // Y axis only matters when the capsule centerline is inside vertically;
    // walls are tall enough that the capsule cylinder always overlaps in Y.
    let best = { axis: 'x' as 'x' | 'z', sign: 1, dist: distRight }
    if (distLeft < best.dist) best = { axis: 'x', sign: -1, dist: distLeft }
    if (distFront < best.dist) best = { axis: 'z', sign: 1, dist: distFront }
    if (distBack < best.dist) best = { axis: 'z', sign: -1, dist: distBack }
    const escapeNormal: Vector3 =
      best.axis === 'x'
        ? { x: best.sign, y: 0, z: 0 }
        : { x: 0, y: 0, z: best.sign }
    return {
      colliding: true,
      // Push out far enough to clear the face plus one capsule radius.
      penetrationDepth: best.dist + capsule.radius_m,
      normal: escapeNormal,
      closestPoint,
    }
  }

  if (distance >= capsule.radius_m - EPSILON) {
    return {
      colliding: false,
      penetrationDepth: 0,
      normal: { x: 0, y: 1, z: 0 },
      closestPoint,
    }
  }

  // Normal points from the box towards the capsule centerline.
  const normal: Vector3 = {
    x: -dx / distance,
    y: -dy / distance,
    z: -dz / distance,
  }

  return {
    colliding: true,
    penetrationDepth: capsule.radius_m - distance,
    normal,
    closestPoint,
  }
}

/**
 * Capsule-vs-ORIENTED-box collision (B-1).
 *
 * `box` is the obstacle's AABB in its own un-rotated local frame; `rotationY`
 * (radians, around the Y axis through the box centre) orients it in the
 * world. A rotated couch / bed therefore collides against its true footprint
 * instead of the inflated axis-aligned hull — the walk camera no longer
 * bumps empty space beside rotated furniture, nor walks through its corners.
 *
 * Implementation: the vertical capsule is rotationally symmetric, so the test
 * reduces to rotating the capsule's position into the box-local frame,
 * running the plain {@link capsuleVsBox}, and rotating the resulting normal /
 * closest-point back into world space. A `rotationY` of ~0 falls straight
 * through to {@link capsuleVsBox}.
 */
export function capsuleVsRotatedBox(
  capsule: CapsuleDims,
  capsulePosition: Vector3,
  box: BoxBounds,
  rotationY: number,
): CapsuleBoxResult {
  if (Math.abs(rotationY) < EPSILON) {
    return capsuleVsBox(capsule, capsulePosition, box)
  }

  const cx = (box.min.x + box.max.x) / 2
  const cz = (box.min.z + box.max.z) / 2
  const cos = Math.cos(rotationY)
  const sin = Math.sin(rotationY)

  // World → box-local: translate to centre, rotate by -rotationY, restore.
  const relX = capsulePosition.x - cx
  const relZ = capsulePosition.z - cz
  const localPosition: Vector3 = {
    x: cx + relX * cos + relZ * sin,
    y: capsulePosition.y,
    z: cz - relX * sin + relZ * cos,
  }

  const local = capsuleVsBox(capsule, localPosition, box)
  if (!local.colliding) return local

  // Box-local → world: rotate the normal + closest-point back by +rotationY.
  const rotX = (x: number, z: number): number => x * cos - z * sin
  const rotZ = (x: number, z: number): number => x * sin + z * cos
  const cpRelX = local.closestPoint.x - cx
  const cpRelZ = local.closestPoint.z - cz

  return {
    colliding: true,
    penetrationDepth: local.penetrationDepth,
    normal: {
      x: rotX(local.normal.x, local.normal.z),
      y: local.normal.y,
      z: rotZ(local.normal.x, local.normal.z),
    },
    closestPoint: {
      x: cx + rotX(cpRelX, cpRelZ),
      y: local.closestPoint.y,
      z: cz + rotZ(cpRelX, cpRelZ),
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Slide along a wall
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a single capsule-vs-box collision by pushing the capsule out of
 * the box along the resolved normal AND projecting any leftover camera
 * motion onto the plane perpendicular to that normal — producing a "slide
 * along the wall" feel rather than a hard stop.
 *
 * Returns the new capsule-feet position. The capsule's Y coordinate is
 * preserved by default (walls are vertical); callers that need 3D sliding
 * along arbitrary surfaces can disable the `lockY` flag.
 */
export function slideAlongWall(
  capsulePosition: Vector3,
  intendedMotion: Vector3,
  resolution: CapsuleBoxResult,
  lockY: boolean = true,
): Vector3 {
  if (!resolution.colliding) {
    return {
      x: capsulePosition.x + intendedMotion.x,
      y: capsulePosition.y + (lockY ? 0 : intendedMotion.y),
      z: capsulePosition.z + intendedMotion.z,
    }
  }
  // Push the capsule out by the penetration depth along the resolution normal.
  const pushed: Vector3 = {
    x: capsulePosition.x + resolution.normal.x * resolution.penetrationDepth,
    y: lockY
      ? capsulePosition.y
      : capsulePosition.y + resolution.normal.y * resolution.penetrationDepth,
    z: capsulePosition.z + resolution.normal.z * resolution.penetrationDepth,
  }
  // Project intended motion onto the plane perpendicular to the normal.
  const motionAlongNormal =
    intendedMotion.x * resolution.normal.x +
    (lockY ? 0 : intendedMotion.y * resolution.normal.y) +
    intendedMotion.z * resolution.normal.z
  const projectedMotion: Vector3 = {
    x: intendedMotion.x - motionAlongNormal * resolution.normal.x,
    y: lockY ? 0 : intendedMotion.y - motionAlongNormal * resolution.normal.y,
    z: intendedMotion.z - motionAlongNormal * resolution.normal.z,
  }
  return {
    x: pushed.x + projectedMotion.x,
    y: pushed.y + projectedMotion.y,
    z: pushed.z + projectedMotion.z,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Walkable polygon point-in-poly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Test whether a point (XZ-projected) is inside a walkable polygon: inside
 * the outer ring AND outside every hole.
 *
 * Uses the standard ray-casting algorithm. Numerically robust enough for
 * RoomPlan output; edge cases on exact ring boundaries are conservatively
 * treated as "outside" so a camera-capsule never accidentally believes
 * it's standing on a wall.
 */
export function isPointInWalkable(point: Vector3, polygon: WalkablePolygon): boolean {
  if (polygon.outer.length < 3) return false
  if (!pointInRing(point.x, point.z, polygon.outer)) return false
  for (const hole of polygon.holes) {
    if (hole.length < 3) continue
    if (pointInRing(point.x, point.z, hole)) return false
  }
  return true
}

function pointInRing(x: number, z: number, ring: Vector3[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x
    const zi = ring[i].z
    const xj = ring[j].x
    const zj = ring[j].z
    const intersects =
      zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

// ─────────────────────────────────────────────────────────────────────────────
// Camera resolver (R14)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single obstacle the walk camera tests against. `bounds` is the AABB in
 * the obstacle's own local frame; the optional `rotationY` (radians) orients
 * it — omit it (or pass 0) for axis-aligned walls, supply it for rotated
 * furniture so the capsule collides against the true footprint (B-1).
 */
export interface CameraObstacle {
  id: string
  bounds: BoxBounds
  rotationY?: number
}

/**
 * Collision context input for {@link resolveCameraCollision}: the camera-
 * capsule, its current position, the intended motion, and the obstacles
 * to test against.
 *
 * Obstacles are derived from walls + floor-mounted objects; walls map to a
 * plain AABB, rotated objects carry a `rotationY`.
 */
export interface CameraResolveInput {
  capsule: CameraCapsule
  position: Vector3
  intendedMotion: Vector3
  obstacles: ReadonlyArray<CameraObstacle>
  walkable: WalkablePolygon
}

/** Capsule-vs-obstacle dispatch — oriented box when `rotationY` is set. */
function capsuleVsObstacle(
  capsule: CapsuleDims,
  position: Vector3,
  obstacle: CameraObstacle,
): CapsuleBoxResult {
  return obstacle.rotationY
    ? capsuleVsRotatedBox(capsule, position, obstacle.bounds, obstacle.rotationY)
    : capsuleVsBox(capsule, position, obstacle.bounds)
}

/**
 * Outcome of {@link resolveCameraCollision}:
 *
 *   - `position`          : the resolved capsule-feet position
 *   - `iterations`        : how many push-iterations were needed
 *   - `stuckFallback`     : true when R14's Y-clamp fallback fired
 *     (the camera was lifted slightly to break a multi-wall wedge)
 *   - `collisions`        : per-iteration list of which obstacles pushed
 *     back (for debug overlays)
 */
export interface CameraResolveResult {
  position: Vector3
  iterations: number
  stuckFallback: boolean
  collisions: string[]
}

/**
 * The default upper bound on push iterations. After this many push +
 * slide attempts the resolver gives up and triggers the Y-clamp fallback.
 * Three is empirically sufficient for the corner-wedge scenarios that
 * RoomPlan output produces; raising it past five rarely helps and starts
 * to feel like jitter.
 */
export const DEFAULT_MAX_RESOLVE_ITERATIONS = 3

/**
 * The Y offset applied when the resolver falls back to Y-clamp mode (R14).
 * A single centimetre is enough to break a tight 2-wall corner without
 * the user noticing the camera "stepped up".
 */
export const STUCK_FALLBACK_Y_LIFT_M = 0.01

/**
 * Iteratively resolve the camera-capsule against every obstacle and against
 * the walkable polygon. The procedure:
 *
 *   1. Apply intended motion.
 *   2. For up to `maxIterations`:
 *        - Test capsule against every obstacle.
 *        - If colliding, slide along the most-penetrating obstacle.
 *        - Re-test; if still colliding against another obstacle, loop.
 *   3. If still colliding after `maxIterations`, lift the capsule by
 *      `STUCK_FALLBACK_Y_LIFT_M` and report `stuckFallback === true`.
 *   4. Finally, clamp the resolved XZ position to the walkable polygon
 *      (point-in-poly check); if outside, snap to the nearest in-polygon
 *      point along the intended-motion vector.
 */
export function resolveCameraCollision(
  input: CameraResolveInput,
  maxIterations: number = DEFAULT_MAX_RESOLVE_ITERATIONS,
): CameraResolveResult {
  const collisions: string[] = []
  let position: Vector3 = {
    x: input.position.x + input.intendedMotion.x,
    y: input.position.y, // walls are vertical · keep Y stable
    z: input.position.z + input.intendedMotion.z,
  }
  let iterations = 0

  for (; iterations < maxIterations; iterations++) {
    // Find the deepest-penetrating obstacle.
    let deepest: { id: string; resolution: CapsuleBoxResult } | null = null
    for (const obs of input.obstacles) {
      const r = capsuleVsObstacle(input.capsule, position, obs)
      if (r.colliding && (deepest === null || r.penetrationDepth > deepest.resolution.penetrationDepth)) {
        deepest = { id: obs.id, resolution: r }
      }
    }
    if (deepest === null) break

    collisions.push(deepest.id)
    // Push out by penetration depth along normal (no extra motion, so
    // `intendedMotion = {0,0,0}` for the slide call). This avoids
    // double-applying the user's input on each loop.
    position = slideAlongWall(
      position,
      { x: 0, y: 0, z: 0 },
      deepest.resolution,
    )
  }

  // Fallback if we still collide after maxIterations.
  let stuckFallback = false
  if (iterations >= maxIterations) {
    // Verify a final collision pass — if anything is still in collision,
    // lift the camera Y by a small amount, then re-test (H16 audit-fix).
    let stillColliding = false
    for (const obs of input.obstacles) {
      if (capsuleVsObstacle(input.capsule, position, obs).colliding) {
        stillColliding = true
        break
      }
    }
    if (stillColliding) {
      stuckFallback = true
      position = { x: position.x, y: position.y + STUCK_FALLBACK_Y_LIFT_M, z: position.z }

      // H16 audit-fix · re-test after the Y-lift. If anything still
      // collides, snap to the nearest walkable-polygon vertex so the camera
      // can never end up wedged forever inside a corner. This is preferable
      // to silently leaving the camera stuck at the lifted position.
      let stillStuckAfterLift = false
      for (const obs of input.obstacles) {
        if (capsuleVsObstacle(input.capsule, position, obs).colliding) {
          stillStuckAfterLift = true
          break
        }
      }
      if (stillStuckAfterLift && input.walkable.outer.length >= 3) {
        const snapped = nearestWalkableVertex(position, input.walkable)
        if (snapped !== null) {
          position = { x: snapped.x, y: position.y, z: snapped.z }
        }
      }
    }
  }

  // Final walkable-polygon check. Inside-polygon = keep; outside-polygon =
  // snap back to the previous in-polygon position along intended motion.
  if (input.walkable.outer.length >= 3 && !isPointInWalkable(position, input.walkable)) {
    // Try to retreat halfway along the intended-motion direction.
    const halfway: Vector3 = {
      x: input.position.x + input.intendedMotion.x / 2,
      y: position.y,
      z: input.position.z + input.intendedMotion.z / 2,
    }
    if (isPointInWalkable(halfway, input.walkable)) {
      position = halfway
    } else if (isPointInWalkable(input.position, input.walkable)) {
      position = input.position
    } else {
      // Even the pre-move position is outside the room: a zero-motion spawn
      // seeded outside a non-convex footprint, or a tunnelling overshoot. Snap
      // to a guaranteed interior point so the camera is NEVER left outside the
      // room — robustly satisfies "always spawn inside".
      const interior = walkableInteriorPoint(input.walkable)
      position = interior
        ? { x: interior.x, y: position.y, z: interior.z }
        : input.position
    }
  }

  return { position, iterations, stuckFallback, collisions }
}

/**
 * Return the walkable-polygon vertex closest (in XZ) to `pos`, or `null`
 * when the outer ring has fewer than three vertices. Used by the R14
 * Y-lift fallback (H16 audit-fix) to break stuck-camera states when the
 * iterative slide + lift could not free the capsule.
 */
export function nearestWalkableVertex(
  pos: Vector3,
  walkable: WalkablePolygon,
): Vector3 | null {
  const verts = walkable.outer
  if (verts.length < 3) return null
  let bestSq = Infinity
  let best: Vector3 = verts[0]
  for (const v of verts) {
    const dx = v.x - pos.x
    const dz = v.z - pos.z
    const sq = dx * dx + dz * dz
    if (sq < bestSq) {
      bestSq = sq
      best = v
    }
  }
  return best
}

/**
 * A point GUARANTEED to lie inside the walkable polygon (inside the outer ring,
 * outside every hole), for spawn seeding. The AABB-corner / vertex-mean spawn
 * heuristics are only inside-safe for convex / rectilinear rooms — a corner-drag-
 * edited L-/U-shape can put them in dead space OUTSIDE the room, and the
 * zero-motion resolver cannot pull a non-penetrating outside-point back in.
 *
 * Primary: cast a horizontal scanline through the outer-ring vertex-mean Z and
 * take the midpoint of the LONGEST inside span — always interior for a simple
 * polygon — verified with isPointInWalkable. Fallback (degenerate scanline / a
 * hole over the midpoint): a coarse interior grid sample nearest the AABB centre.
 * Returns null only for a degenerate (<3-vertex) ring.
 */
export function walkableInteriorPoint(polygon: WalkablePolygon): Vector3 | null {
  const outer = polygon.outer
  if (outer.length < 3) return null

  let zc = 0
  for (const p of outer) zc += p.z
  zc /= outer.length
  const xs: number[] = []
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    const zi = outer[i].z
    const zj = outer[j].z
    if (zi > zc !== zj > zc) {
      xs.push(outer[i].x + ((zc - zi) / (zj - zi)) * (outer[j].x - outer[i].x))
    }
  }
  xs.sort((a, b) => a - b)
  let best: Vector3 | null = null
  let bestLen = -1
  for (let k = 0; k + 1 < xs.length; k += 2) {
    const len = xs[k + 1] - xs[k]
    const cand: Vector3 = { x: (xs[k] + xs[k + 1]) / 2, y: 0, z: zc }
    if (len > bestLen && isPointInWalkable(cand, polygon)) {
      bestLen = len
      best = cand
    }
  }
  if (best) return best

  // Hole-heavy / degenerate fallback: coarse grid, pick the inside sample
  // nearest the AABB centre.
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const p of outer) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.z < minZ) minZ = p.z
    if (p.z > maxZ) maxZ = p.z
  }
  const cx = (minX + maxX) / 2
  const cz = (minZ + maxZ) / 2
  const STEPS = 8
  let gridBest: Vector3 | null = null
  let gridBestSq = Infinity
  for (let ix = 1; ix < STEPS; ix++) {
    for (let iz = 1; iz < STEPS; iz++) {
      const cand: Vector3 = {
        x: minX + ((maxX - minX) * ix) / STEPS,
        y: 0,
        z: minZ + ((maxZ - minZ) * iz) / STEPS,
      }
      if (!isPointInWalkable(cand, polygon)) continue
      const sq = (cand.x - cx) ** 2 + (cand.z - cz) ** 2
      if (sq < gridBestSq) {
        gridBestSq = sq
        gridBest = cand
      }
    }
  }
  return gridBest
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function clamp(value: number, lo: number, hi: number): number {
  if (lo > hi) return value
  return Math.max(lo, Math.min(hi, value))
}
