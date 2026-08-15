/**
 * Tests for wallCSGGeometry — the boolean half of the hybrid opening
 * strategy (block-plan A-3). three-bvh-csg evaluates CPU-side, so the real
 * boolean runs here with no GPU context — this doubles as the
 * three-bvh-csg ↔ three@0.182 runtime smoke test.
 */
import { describe, it, expect } from 'vitest'
import { computeMeshVolume } from 'three-bvh-csg'

import { wallCSGGeometry } from '../../../../../src/components/spatial/three/canonical/geometry/wallCSGGeometry.ts'
import { buildWallJoinGraph } from '../../../../../src/lib/spatial/canonical/geometry/wall-joins.ts'
import type { Wall, WallOpening } from '../../../../../src/lib/spatial/canonical/types/geometry.ts'

function makeWall(overrides: Partial<Wall> = {}): Wall {
  return {
    id: 'w1',
    type: 'wall',
    start_point: { x: 0, y: 0, z: 0 },
    end_point: { x: 4, y: 0, z: 0 },
    thickness_m: 0.2,
    height_m: 2.5,
    base_height_m: 0,
    openings: [],
    wall_mounted: [],
    is_exterior_wall: false,
    walkable_blocker: true,
    length_m: 4,
    normal: { x: 0, y: 0, z: -1 },
    ...overrides,
  } as Wall
}

function makeDoor(overrides: Partial<WallOpening> = {}): WallOpening {
  return {
    id: 'op1',
    type: 'door',
    host_wall_id: 'w1',
    offset_along_wall_m: 1.5,
    offset_from_floor_m: 0,
    width_m: 0.9,
    height_m: 2.1,
    is_walkable_portal: true,
    ...overrides,
  } as WallOpening
}

describe('wallCSGGeometry', () => {
  it('returns the solid footprint loft for a wall with no openings', () => {
    const wall = makeWall()
    const geom = wallCSGGeometry(wall, buildWallJoinGraph([wall]))
    expect(geom).not.toBeNull()
    expect(geom!.getAttribute('position').count).toBeGreaterThan(0)
    geom!.dispose()
  })

  it('subtracts a door opening — boolean reduces the wall volume', () => {
    const solidWall = makeWall()
    const holedWall = makeWall({ openings: [makeDoor()] })
    const graph = buildWallJoinGraph([solidWall])

    const solid = wallCSGGeometry(solidWall, graph)!
    const holed = wallCSGGeometry(holedWall, buildWallJoinGraph([holedWall]))!

    const solidVolume = computeMeshVolume(solid)
    const holedVolume = computeMeshVolume(holed)

    // A 0.9 × 2.1 × 0.2 door removes ≈ 0.378 m³ from the 2.0 m³ wall.
    expect(holedVolume).toBeLessThan(solidVolume)
    expect(solidVolume - holedVolume).toBeGreaterThan(0.3)

    solid.dispose()
    holed.dispose()
  })

  it('result carries position / normal / uv / uv2 attributes', () => {
    const wall = makeWall({ openings: [makeDoor()] })
    const geom = wallCSGGeometry(wall, buildWallJoinGraph([wall]))!
    expect(geom.getAttribute('position')).toBeDefined()
    expect(geom.getAttribute('normal')).toBeDefined()
    expect(geom.getAttribute('uv')).toBeDefined()
    expect(geom.getAttribute('uv2')).toBeDefined()
    geom.dispose()
  })

  it('two openings both punch through', () => {
    const wall = makeWall({
      openings: [
        makeDoor({ id: 'd1', offset_along_wall_m: 0.5 }),
        makeDoor({ id: 'w2', type: 'window', offset_along_wall_m: 2.4, offset_from_floor_m: 0.9, width_m: 1, height_m: 1.1 }),
      ],
    })
    const solid = wallCSGGeometry(makeWall(), buildWallJoinGraph([makeWall()]))!
    const holed = wallCSGGeometry(wall, buildWallJoinGraph([wall]))!
    expect(computeMeshVolume(holed)).toBeLessThan(computeMeshVolume(solid))
    solid.dispose()
    holed.dispose()
  })

  it('returns null for an override-polygon wall (no mitered footprint)', () => {
    const wall = makeWall({
      polygon_override: [
        { x: 0, y: 0, z: 0 },
        { x: 4, y: 0, z: 0 },
        { x: 4, y: 3, z: 0 },
      ],
      openings: [makeDoor()],
    })
    expect(wallCSGGeometry(wall, buildWallJoinGraph([wall]))).toBeNull()
  })
})
