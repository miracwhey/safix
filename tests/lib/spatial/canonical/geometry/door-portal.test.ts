/**
 * Tests for src/lib/spatial/canonical/geometry/door-portal.ts
 *
 * Covers portal polygon construction, host-wall matching (single +
 * ambiguous candidates · R11), and wall-doubling detection (R12).
 */
import { describe, it, expect } from 'vitest'

import {
  findHostWall,
  findOverlappingWalls,
  portalFloorFootprint,
  portalPolygonCompute,
  type HostWallCandidate,
} from '../../../../../src/lib/spatial/canonical/geometry/door-portal.ts'
import type { WallGeometryInput } from '../../../../../src/lib/spatial/canonical/geometry/wall-geometry.ts'

function wall(opts: Partial<WallGeometryInput> & { id?: string } = {}): HostWallCandidate {
  return {
    id: opts.id ?? 'wall',
    geometry: {
      start_point: opts.start_point ?? { x: 0, y: 0, z: 0 },
      end_point: opts.end_point ?? { x: 4, y: 0, z: 0 },
      thickness_m: opts.thickness_m ?? 0.2,
      height_m: opts.height_m ?? 2.5,
      base_height_m: opts.base_height_m ?? 0,
    },
  }
}

describe('door-portal · portalPolygonCompute', () => {
  it('builds a 4-vertex rectangle on the wall plane', () => {
    const w = wall().geometry
    const portal = portalPolygonCompute(w, {
      offset_along_wall_m: 1,
      offset_from_floor_m: 0,
      width_m: 0.9,
      height_m: 2,
    })
    expect(portal).toHaveLength(4)
    // Bottom vertices at y = 0; top at y = 2.
    expect(portal[0].y).toBe(0)
    expect(portal[2].y).toBe(2)
    // Door starts at x = 1, ends at x = 1.9.
    expect(portal[0].x).toBeCloseTo(1, 6)
    expect(portal[1].x).toBeCloseTo(1.9, 6)
  })

  it('returns [] for a degenerate host wall', () => {
    expect(
      portalPolygonCompute(
        { start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 0, y: 0, z: 0 }, thickness_m: 0.2, height_m: 2.5, base_height_m: 0 },
        { offset_along_wall_m: 0, offset_from_floor_m: 0, width_m: 0.9, height_m: 2 },
      ),
    ).toEqual([])
  })

  it('respects offset_from_floor for windows', () => {
    const w = wall().geometry
    const window = portalPolygonCompute(w, {
      offset_along_wall_m: 2,
      offset_from_floor_m: 1,
      width_m: 1,
      height_m: 1.2,
    })
    expect(window[0].y).toBeCloseTo(1, 6)
    expect(window[2].y).toBeCloseTo(2.2, 6)
  })
})

describe('door-portal · portalFloorFootprint', () => {
  it('produces a wall-thickness-wide rectangle on the floor plane', () => {
    const w = wall().geometry
    const footprint = portalFloorFootprint(w, {
      offset_along_wall_m: 1,
      offset_from_floor_m: 0,
      width_m: 0.9,
      height_m: 2,
    })
    expect(footprint).toHaveLength(4)
    // All vertices on floor plane.
    for (const p of footprint) expect(p.y).toBe(0)
    // Two vertices on outer side (z = -thickness/2), two on inner side (z = +thickness/2).
    const half = w.thickness_m / 2
    expect(footprint.some(p => Math.abs(p.z + half) < 1e-9)).toBe(true)
    expect(footprint.some(p => Math.abs(p.z - half) < 1e-9)).toBe(true)
  })
})

describe('door-portal · findHostWall (single candidate)', () => {
  it('returns the only wall when it is close enough', () => {
    const candidate = wall({ id: 'w1' })
    const result = findHostWall({ x: 2, y: 0, z: -0.05 }, [candidate])
    expect(result.winner?.id).toBe('w1')
    expect(result.confidence).toBe(1)
    expect(result.warnings).toEqual([])
  })

  it('returns no winner when no wall is close enough', () => {
    const candidate = wall({ id: 'w1' })
    const result = findHostWall({ x: 2, y: 0, z: -5 }, [candidate], { max_distance_m: 0.5 })
    expect(result.winner).toBeNull()
    expect(result.confidence).toBe(0)
  })

  it('rejects candidates whose projection falls outside the wall span', () => {
    const candidate = wall({ id: 'w1' }) // along +X from 0 to 4
    const result = findHostWall({ x: 10, y: 0, z: -0.05 }, [candidate], { along_tolerance_m: 0.1 })
    expect(result.winner).toBeNull()
  })
})

describe('door-portal · findHostWall (R11 ambiguous)', () => {
  it('flags ambiguity when two walls are equally close', () => {
    // Two parallel walls 4 cm apart (within the 5 cm default ambiguity tolerance).
    const a = wall({ id: 'a', start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 0 } })
    const b = wall({ id: 'b', start_point: { x: 0, y: 0, z: -0.04 }, end_point: { x: 4, y: 0, z: -0.04 } })

    const result = findHostWall({ x: 2, y: 0, z: -0.02 }, [a, b])
    expect(result.winner).not.toBeNull()
    expect(result.confidence).toBe(0.5)
    expect(result.warnings.some(w => w.startsWith('DOOR_HOST_WALL_AMBIGUOUS'))).toBe(true)
  })

  it('does NOT flag ambiguity when the second candidate is comfortably farther', () => {
    const a = wall({ id: 'a', start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 0 } })
    const b = wall({ id: 'b', start_point: { x: 0, y: 0, z: -0.4 }, end_point: { x: 4, y: 0, z: -0.4 } })

    const result = findHostWall({ x: 2, y: 0, z: -0.05 }, [a, b])
    expect(result.confidence).toBe(1)
    expect(result.warnings).toEqual([])
  })
})

describe('door-portal · findOverlappingWalls (R12)', () => {
  it('detects a doubled wall pair (anti-parallel, 16 cm distance, full overlap)', () => {
    const a = wall({ id: 'a', start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 0 } })
    // Anti-parallel wall (traversed the other direction), 16 cm to the outer side.
    const b = wall({
      id: 'b',
      start_point: { x: 4, y: 0, z: -0.16 },
      end_point: { x: 0, y: 0, z: -0.16 },
    })
    const pairs = findOverlappingWalls([a, b])
    expect(pairs).toHaveLength(1)
    expect(pairs[0].perpDistance_m).toBeCloseTo(0.16, 6)
    expect(pairs[0].lengthOverlapRatio).toBeCloseTo(1, 6)
  })

  it('does not detect non-parallel walls', () => {
    const a = wall({ id: 'a', start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 0 } })
    const b = wall({ id: 'b', start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 0, y: 0, z: 4 } })
    expect(findOverlappingWalls([a, b])).toEqual([])
  })

  it('does not detect parallel walls that are too far apart', () => {
    const a = wall({ id: 'a', start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 0 } })
    const b = wall({
      id: 'b',
      start_point: { x: 4, y: 0, z: -1 },
      end_point: { x: 0, y: 0, z: -1 },
    })
    expect(findOverlappingWalls([a, b])).toEqual([])
  })

  it('does not detect partial-overlap walls below the threshold', () => {
    const a = wall({ id: 'a', start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 0 } })
    // B is anti-parallel + close, but only the right half overlaps with A.
    const b = wall({
      id: 'b',
      start_point: { x: 5, y: 0, z: -0.15 },
      end_point: { x: 2, y: 0, z: -0.15 },
    })
    const pairs = findOverlappingWalls([a, b], { min_overlap_ratio: 0.8 })
    expect(pairs).toEqual([])
  })

  it('also detects PARALLEL-normal doubled walls (H10 audit-fix)', () => {
    // Both walls share the same outward normal direction (not the typical
    // anti-parallel pairing). The previous implementation skipped them.
    const a = wall({ id: 'a', start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 0 } })
    const b = wall({ id: 'b', start_point: { x: 0, y: 0, z: -0.15 }, end_point: { x: 4, y: 0, z: -0.15 } })
    const pairs = findOverlappingWalls([a, b])
    expect(pairs.length).toBe(1)
  })
})

describe('portalPolygonCompute · polygon_override (H11 audit-fix)', () => {
  it('throws R15_NOT_YET_IMPLEMENTED when the host wall has polygon_override', () => {
    const hostWall: WallGeometryInput = {
      start_point: { x: 0, y: 0, z: 0 },
      end_point: { x: 4, y: 0, z: 0 },
      thickness_m: 0.2,
      height_m: 2.5,
      base_height_m: 0,
      polygon_override: [
        { x: 0, y: 0, z: 0 },
        { x: 4, y: 0, z: 0 },
        { x: 4, y: 2.5, z: 0 },
        { x: 2, y: 2.7, z: 0 },
        { x: 0, y: 2.5, z: 0 },
      ],
    }
    const portal = {
      offset_along_wall_m: 1,
      offset_from_floor_m: 0,
      width_m: 0.9,
      height_m: 2.1,
    }
    let caught: unknown = null
    try {
      portalPolygonCompute(hostWall, portal)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe('R15_NOT_YET_IMPLEMENTED')
  })
})
