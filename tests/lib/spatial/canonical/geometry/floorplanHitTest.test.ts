/**
 * Tests for floorplanHitTest.ts — the pure, three.js-free screen-px hit
 * resolution behind the 2D footprint editor (FloorplanDragLayer F1).
 *
 * A trivial top-down projection (`world {x,z} → px {x: x, y: z}`, 1 m = 1 px)
 * keeps the px radii readable as world units, so every assertion reasons about
 * geometry directly. Covers: opening beats overlapping wall, object
 * point-in-poly + edge pad + smallest-footprint tie-break, the full priority
 * order (handle > opening > object > wall), null on empty, and whole-bar grab.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveFloorplanHit,
  isWithinBarSegmentPx,
  orientedRectCornersWorld,
  pointInPolyPx,
  type HitWall,
  type HitObject,
  type XZ,
  type Px,
} from '../../../../../src/lib/spatial/canonical/geometry/floorplanHitTest.ts'

/** Identity top-down projection: 1 world meter == 1 CSS px. */
const project = (p: XZ): Px => ({ x: p.x, y: p.z })

const baseRadii = { openingPx: 6, objectPx: 4, wallPx: 5 }

function makeWall(over: Partial<HitWall> = {}): HitWall {
  return {
    id: 'wall-1',
    start: { x: 0, z: 0 },
    end: { x: 10, z: 0 },
    openings: [],
    wallMounted: [],
    ...over,
  }
}

describe('resolveFloorplanHit', () => {
  it('returns null on an empty scene', () => {
    expect(
      resolveFloorplanHit({
        point: { x: 0, y: 0 },
        walls: [],
        objects: [],
        toPx: project,
        ...baseRadii,
      }),
    ).toEqual({ kind: null })
  })

  it('an opening beats the wall it overlaps (wallObject wins over wall)', () => {
    const wall = makeWall({
      openings: [{ id: 'door-1', offsetAlong: 4, width: 2 }],
    })
    // Point sits on the centerline inside the opening span [4,6] → both the
    // opening segment and the wall segment are hit; opening has priority.
    const hit = resolveFloorplanHit({
      point: { x: 5, y: 0 },
      walls: [wall],
      objects: [],
      toPx: project,
      ...baseRadii,
    })
    expect(hit).toEqual({ kind: 'wallObject', id: 'door-1' })
  })

  it('preferWall: a wall TAP wins over the opening it overlaps', () => {
    const wall = makeWall({
      openings: [{ id: 'door-1', offsetAlong: 4, width: 2 }],
    })
    // Same point as the opening-priority case, but preferWall flips it to the
    // wall (2D footprint editing: tapping a wall must select the wall, not the
    // window sitting on it).
    const hit = resolveFloorplanHit({
      point: { x: 5, y: 0 },
      walls: [wall],
      objects: [],
      toPx: project,
      ...baseRadii,
      preferWall: true,
    })
    expect(hit).toEqual({ kind: 'wall', id: 'wall-1' })
  })

  it('preferWall: a floor/free object still outranks the wall', () => {
    const obj: HitObject = { id: 'sofa-1', center: { x: 5, z: 0 }, width: 2, depth: 2, yawDeg: 0 }
    const wall = makeWall()
    const hit = resolveFloorplanHit({
      point: { x: 5, y: 0 },
      walls: [wall],
      objects: [obj],
      toPx: project,
      ...baseRadii,
      preferWall: true,
    })
    expect(hit).toEqual({ kind: 'object', id: 'sofa-1' })
  })

  it('wall-mounted objects resolve as wallObject too', () => {
    const wall = makeWall({
      wallMounted: [{ id: 'sink-1', offsetAlong: 1, width: 1 }],
    })
    const hit = resolveFloorplanHit({
      point: { x: 1.5, y: 0 },
      walls: [wall],
      objects: [],
      toPx: project,
      ...baseRadii,
    })
    expect(hit).toEqual({ kind: 'wallObject', id: 'sink-1' })
  })

  it('selects a floor object by point-in-poly and within the edge pad', () => {
    const obj: HitObject = { id: 'sofa-1', center: { x: 0, z: 0 }, width: 2, depth: 2, yawDeg: 0 }
    const inside = resolveFloorplanHit({
      point: { x: 0, y: 0 },
      walls: [],
      objects: [obj],
      toPx: project,
      ...baseRadii,
    })
    expect(inside).toEqual({ kind: 'object', id: 'sofa-1' })

    // Just outside the +x edge (x=1) but within objectPx=4 → still a hit.
    const edgePad = resolveFloorplanHit({
      point: { x: 1 + 3, y: 0 },
      walls: [],
      objects: [obj],
      toPx: project,
      ...baseRadii,
    })
    expect(edgePad).toEqual({ kind: 'object', id: 'sofa-1' })

    // Beyond the edge pad (x=1 + 5 > objectPx=4) → no object, no wall → null.
    const beyond = resolveFloorplanHit({
      point: { x: 1 + 5, y: 0 },
      walls: [],
      objects: [obj],
      toPx: project,
      ...baseRadii,
    })
    expect(beyond).toEqual({ kind: null })
  })

  it('object tie-break picks the SMALLEST footprint', () => {
    const big: HitObject = { id: 'rug', center: { x: 0, z: 0 }, width: 4, depth: 4, yawDeg: 0 }
    const small: HitObject = { id: 'stool', center: { x: 0, z: 0 }, width: 1, depth: 1, yawDeg: 0 }
    const hit = resolveFloorplanHit({
      point: { x: 0, y: 0 },
      walls: [],
      objects: [big, small],
      toPx: project,
      ...baseRadii,
    })
    expect(hit).toEqual({ kind: 'object', id: 'stool' })
  })

  it('enforces priority handle > opening > object > wall', () => {
    const wall = makeWall({ openings: [{ id: 'door-1', offsetAlong: 4, width: 2 }] })
    const obj: HitObject = { id: 'cabinet', center: { x: 5, z: 0 }, width: 4, depth: 4, yawDeg: 0 }
    const point: Px = { x: 5, y: 0 } // overlaps opening span, object footprint, AND the wall

    // Highest priority is the mid-bar handle (resolved before the tap path):
    // a bar covering this point grabs first, short-circuiting the resolver.
    expect(isWithinBarSegmentPx(point, { x: 0, y: 0 }, { x: 10, y: 0 }, 30)).toBe(true)

    // Opening wins over both object and wall.
    expect(
      resolveFloorplanHit({ point, walls: [wall], objects: [obj], toPx: project, ...baseRadii }),
    ).toEqual({ kind: 'wallObject', id: 'door-1' })

    // Drop the opening → object wins over the wall.
    expect(
      resolveFloorplanHit({
        point,
        walls: [makeWall()],
        objects: [obj],
        toPx: project,
        ...baseRadii,
      }),
    ).toEqual({ kind: 'object', id: 'cabinet' })

    // Drop the object → wall wins.
    expect(
      resolveFloorplanHit({ point, walls: [makeWall()], objects: [], toPx: project, ...baseRadii }),
    ).toEqual({ kind: 'wall', id: 'wall-1' })
  })
})

describe('isWithinBarSegmentPx', () => {
  const barA: Px = { x: -130, y: 0 }
  const barB: Px = { x: 130, y: 0 }
  const r = 30

  it('grabs anywhere along the whole bar, not just its midpoint', () => {
    expect(isWithinBarSegmentPx({ x: 0, y: 0 }, barA, barB, r)).toBe(true) // midpoint
    expect(isWithinBarSegmentPx({ x: 130, y: 0 }, barA, barB, r)).toBe(true) // far end
    // Near a bar END but far from the MIDPOINT: a midpoint-disc test would miss
    // it (hypot(130,25)=132 > 30); the segment test grabs it (25 <= 30).
    expect(isWithinBarSegmentPx({ x: 130, y: 25 }, barA, barB, r)).toBe(true)
  })

  it('does not grab beyond half-length + radius', () => {
    expect(isWithinBarSegmentPx({ x: 160, y: 0 }, barA, barB, r)).toBe(true) // exactly at the band edge
    expect(isWithinBarSegmentPx({ x: 161, y: 0 }, barA, barB, r)).toBe(false) // just past it
  })
})

describe('orientedRectCornersWorld', () => {
  it('rotates the footprint around its center (90° swaps width/depth extents)', () => {
    const corners = orientedRectCornersWorld({ center: { x: 0, z: 0 }, width: 4, depth: 2, yawDeg: 90 })
    // After a 90° yaw the 4 m width lies along Z and the 2 m depth along X.
    const xs = corners.map((c) => c.x)
    const zs = corners.map((c) => c.z)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2, 6)
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(4, 6)
    // The rotated rect still contains its center.
    expect(pointInPolyPx({ x: 0, y: 0 }, corners.map((c) => ({ x: c.x, y: c.z })))).toBe(true)
  })
})
