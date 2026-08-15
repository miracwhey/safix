/**
 * Tests for snap/asset-snap.ts (Day 18 · placement foundation).
 *
 * Covers the rule tables (snap targets, ObjectCategory→AssetCategory,
 * per-object default SnapRule) and the pure floor / wall / counter resolvers.
 */
import { describe, it, expect } from 'vitest'

import {
  ASSET_CATEGORIES,
  SNAP_RULES,
  isSnapTargetAllowed,
  defaultSnapTarget,
  objectCategoryToAssetCategory,
  DEFAULT_SNAP_RULE,
  resolveFloorSnap,
  resolveWallSnap,
  resolveCounterSnap,
} from '../../../../../src/lib/spatial/canonical/snap/asset-snap.ts'
import { CATEGORY_DEFAULT_HOST } from '../../../../../src/lib/spatial/canonical/types/objects.ts'
import type { ObjectCategory } from '../../../../../src/lib/spatial/canonical/types/objects.ts'
import type { WallGeometryInput } from '../../../../../src/lib/spatial/canonical/geometry/wall-geometry.ts'

describe('asset-snap · rule tables', () => {
  it('every category has a non-empty target list with a usable default', () => {
    for (const category of ASSET_CATEGORIES) {
      expect(SNAP_RULES[category].length).toBeGreaterThan(0)
      expect(isSnapTargetAllowed(category, defaultSnapTarget(category))).toBe(true)
    }
  })

  it('rejects disallowed snap targets', () => {
    expect(isSnapTargetAllowed('furniture', 'wall-opening')).toBe(false)
    expect(isSnapTargetAllowed('architecture', 'wall-opening')).toBe(true)
    expect(isSnapTargetAllowed('kitchen', 'counter')).toBe(true)
  })

  it('maps every ObjectCategory to a coarse AssetCategory', () => {
    for (const category of Object.keys(CATEGORY_DEFAULT_HOST) as ObjectCategory[]) {
      expect(ASSET_CATEGORIES).toContain(objectCategoryToAssetCategory(category))
    }
    expect(objectCategoryToAssetCategory('toilet')).toBe('sanitary')
    expect(objectCategoryToAssetCategory('oven')).toBe('kitchen')
    expect(objectCategoryToAssetCategory('radiator')).toBe('architecture')
    expect(objectCategoryToAssetCategory('sofa')).toBe('furniture')
  })
})

describe('asset-snap · DEFAULT_SNAP_RULE', () => {
  it('provides a rule for every ObjectCategory with a host matching the default', () => {
    for (const category of Object.keys(CATEGORY_DEFAULT_HOST) as ObjectCategory[]) {
      const rule = DEFAULT_SNAP_RULE[category]
      expect(rule).toBeDefined()
      expect(rule.target_host).toBe(CATEGORY_DEFAULT_HOST[category])
    }
  })

  it('wall-mounted fixtures carry a mount height + normal alignment', () => {
    expect(DEFAULT_SNAP_RULE.sink.target_host).toBe('wall')
    expect(DEFAULT_SNAP_RULE.sink.align_to_normal).toBe(true)
    expect(DEFAULT_SNAP_RULE.sink.default_height_from_floor_m).toBeGreaterThan(0)
    expect(DEFAULT_SNAP_RULE.light_switch.default_height_from_floor_m).toBeCloseTo(1.05, 2)
  })

  it('corner fixtures opt into corner-snapping', () => {
    expect(DEFAULT_SNAP_RULE.shower.target_host).toBe('corner')
    expect(DEFAULT_SNAP_RULE.shower.snap_to_corner).toBe(true)
  })
})

describe('asset-snap · resolveFloorSnap', () => {
  it('places the pivot on the floor plane at the footprint point', () => {
    const r = resolveFloorSnap({ footprint: { x: 1.5, z: -2 }, floorHeightM: 0, rotationYDeg: 90 })
    expect(r.position).toEqual({ x: 1.5, y: 0, z: -2 })
    expect(r.rotationYDeg).toBe(90)
  })

  it('normalises rotation into [0, 360)', () => {
    expect(resolveFloorSnap({ footprint: { x: 0, z: 0 }, floorHeightM: 0, rotationYDeg: -90 }).rotationYDeg).toBe(270)
  })
})

describe('asset-snap · resolveWallSnap', () => {
  const wallAlongX: WallGeometryInput = {
    start_point: { x: 0, y: 0, z: 0 },
    end_point: { x: 4, y: 0, z: 0 },
    thickness_m: 0.2,
    height_m: 2.5,
    base_height_m: 0,
  }

  it('lands the pivot on the room-facing wall face at the requested offset + height', () => {
    const r = resolveWallSnap({
      wall: wallAlongX,
      offsetAlongWallM: 2,
      heightFromFloorM: 1,
    })
    // inward normal of an X-aligned wall is +Z; face offset = thickness/2.
    expect(r.position.x).toBeCloseTo(2, 6)
    expect(r.position.y).toBeCloseTo(1, 6)
    expect(r.position.z).toBeCloseTo(0.1, 6)
    expect(r.rotationYDeg).toBeCloseTo(0, 6)
  })

  it('rotates the asset forward axis to the inward normal of a Z-aligned wall', () => {
    const wallAlongZ: WallGeometryInput = {
      start_point: { x: 0, y: 0, z: 0 },
      end_point: { x: 0, y: 0, z: 4 },
      thickness_m: 0.2,
      height_m: 2.5,
      base_height_m: 0,
    }
    const r = resolveWallSnap({ wall: wallAlongZ, offsetAlongWallM: 2, heightFromFloorM: 1 })
    // inward normal is -X → rotation 270°.
    expect(r.rotationYDeg).toBeCloseTo(270, 4)
  })

  it('applies extra protrusion into the room', () => {
    const r = resolveWallSnap({
      wall: wallAlongX,
      offsetAlongWallM: 1,
      heightFromFloorM: 0.5,
      protrusionM: 0.3,
    })
    expect(r.position.z).toBeCloseTo(0.4, 6)
  })

  it('does not align rotation when alignToNormal is false', () => {
    const r = resolveWallSnap({
      wall: wallAlongX,
      offsetAlongWallM: 1,
      heightFromFloorM: 1,
      alignToNormal: false,
    })
    expect(r.rotationYDeg).toBe(0)
  })

  it('falls back to the wall start for a degenerate zero-length wall', () => {
    const degenerate: WallGeometryInput = {
      start_point: { x: 3, y: 0, z: 3 },
      end_point: { x: 3, y: 0, z: 3 },
      thickness_m: 0.2,
      height_m: 2.5,
      base_height_m: 0,
    }
    const r = resolveWallSnap({ wall: degenerate, offsetAlongWallM: 1, heightFromFloorM: 1 })
    expect(r.position).toEqual({ x: 3, y: 0, z: 3 })
    expect(Number.isNaN(r.rotationYDeg)).toBe(false)
  })
})

describe('asset-snap · resolveCounterSnap', () => {
  it('places the pivot on the counter top surface', () => {
    const r = resolveCounterSnap({ footprint: { x: 0.5, z: 0.3 }, counterTopHeightM: 0.86 })
    expect(r.position).toEqual({ x: 0.5, y: 0.86, z: 0.3 })
  })
})
