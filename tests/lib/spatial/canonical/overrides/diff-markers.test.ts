/**
 * Visual-diff marker tests — `diff-markers.ts` (Block 2.12).
 *
 * Covers world-anchor resolution per node type, the scene index, and
 * `buildDiffMarkers` colour/anchor placement for added / removed / modified.
 */
import { describe, it, expect } from 'vitest'

import {
  DIFF_MARKER_COLORS,
  buildDiffMarkers,
  indexSceneNodes,
  nodeWorldAnchor,
} from '../../../../../src/lib/spatial/canonical/overrides/diff-markers'
import type { DiffReport } from '../../../../../src/lib/spatial/canonical/overrides/diff-variants'
import type { RoomScene } from '../../../../../src/lib/spatial/canonical/types/scene-graph'
import type { Wall, Floor, Ceiling } from '../../../../../src/lib/spatial/canonical/types/geometry'
import type { SpatialObject } from '../../../../../src/lib/spatial/canonical/types/objects'
import {
  IDENTITY_QUATERNION,
  IDENTITY_VECTOR3,
  ONE_VECTOR3,
} from '../../../../../src/lib/spatial/canonical/types/primitives'

const NOW = '2026-05-20T00:00:00.000Z'

function baseNode<T extends string>(id: string, type: T, parentId: string) {
  return {
    id,
    type,
    parent_id: parentId,
    children_ids: [] as string[],
    variant_id: 'base_roomplan',
    source: 'manual' as const,
    confidence: 1,
    transform: { position: IDENTITY_VECTOR3, rotation: IDENTITY_QUATERNION, scale: ONE_VECTOR3 },
    created_at: NOW,
    updated_at: NOW,
  }
}

function mkWall(id: string): Wall {
  return {
    ...baseNode(id, 'wall', 'room'),
    start_point: { x: 0, y: 0, z: 0 },
    end_point: { x: 4, y: 0, z: 0 },
    height_m: 2.5,
    thickness_m: 0.15,
    base_height_m: 0,
    openings: [],
    wall_mounted: [],
    is_exterior_wall: true,
    walkable_blocker: true as const,
    length_m: 4,
    normal: { x: 0, y: 0, z: 0 },
  }
}

function mkObject(id: string, pos: { x: number; y: number; z: number }): SpatialObject {
  return {
    ...baseNode(id, 'object', 'room'),
    transform: { position: pos, rotation: IDENTITY_QUATERNION, scale: ONE_VECTOR3 },
    category: 'toilet',
    host: 'floor',
    host_id: 'floor',
    dimensions: { width_m: 0.4, depth_m: 0.7, height_m: 0.8 },
  }
}

function mkScene(objects: SpatialObject[]): RoomScene {
  const ring = [
    { x: 0, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
    { x: 4, y: 0, z: 5 },
    { x: 0, y: 0, z: 5 },
  ]
  const floor: Floor = {
    ...baseNode('floor', 'floor', 'room'),
    polygon: ring,
    walkable_surface: true as const,
    floor_mounted: [],
  }
  const ceiling: Ceiling = {
    ...baseNode('ceiling', 'ceiling', 'room'),
    polygon: ring,
    height_m: 2.5,
    ceiling_mounted: [],
  }
  return {
    ...baseNode('room', 'room', 'building'),
    category: 'bathroom',
    walls: [mkWall('w1')],
    floor,
    ceiling,
    free_objects: objects,
    pins: [],
    photos: [],
    notes: [],
    bounds_min: { x: 0, y: 0, z: 0 },
    bounds_max: { x: 4, y: 2.5, z: 5 },
    computed_area_m2: 20,
    computed_volume_m3: 50,
  }
}

describe('nodeWorldAnchor', () => {
  it('a wall anchors at the midpoint of its endpoints, half-height', () => {
    const anchor = nodeWorldAnchor(mkWall('w1'))
    expect(anchor).toEqual({ x: 2, y: 1.25, z: 0 })
  })

  it('an object anchors at its transform position', () => {
    const anchor = nodeWorldAnchor(mkObject('o1', { x: 1, y: 0, z: 3 }))
    expect(anchor).toEqual({ x: 1, y: 0, z: 3 })
  })

  it('a floor anchors at its polygon centroid', () => {
    const scene = mkScene([])
    const anchor = nodeWorldAnchor(scene.floor)
    expect(anchor.x).toBeCloseTo(2)
    expect(anchor.z).toBeCloseTo(2.5)
  })
})

describe('indexSceneNodes', () => {
  it('indexes every addressable node', () => {
    const scene = mkScene([mkObject('o1', { x: 1, y: 0, z: 1 })])
    const index = indexSceneNodes(scene)
    expect(index.has('room')).toBe(true)
    expect(index.has('w1')).toBe(true)
    expect(index.has('floor')).toBe(true)
    expect(index.has('ceiling')).toBe(true)
    expect(index.has('o1')).toBe(true)
  })
})

describe('buildDiffMarkers', () => {
  it('places a green marker for an added node, from the compared scene', () => {
    const base = mkScene([])
    const compared = mkScene([mkObject('o-new', { x: 2, y: 0, z: 2 })])
    const report: DiffReport = {
      added: [{ kind: 'added', node_id: 'o-new', node_type: 'object' }],
      removed: [],
      modified: [],
    }
    const markers = buildDiffMarkers(report, base, compared)
    expect(markers).toHaveLength(1)
    expect(markers[0].kind).toBe('added')
    expect(markers[0].color).toBe(DIFF_MARKER_COLORS.added)
    expect(markers[0].position).toEqual({ x: 2, y: 0, z: 2 })
  })

  it('places a red marker for a removed node, from the BASE scene', () => {
    const base = mkScene([mkObject('o-gone', { x: 3, y: 0, z: 1 })])
    const compared = mkScene([])
    const report: DiffReport = {
      added: [],
      removed: [{ kind: 'removed', node_id: 'o-gone', node_type: 'object' }],
      modified: [],
    }
    const markers = buildDiffMarkers(report, base, compared)
    expect(markers).toHaveLength(1)
    expect(markers[0].kind).toBe('removed')
    expect(markers[0].color).toBe(DIFF_MARKER_COLORS.removed)
    expect(markers[0].position).toEqual({ x: 3, y: 0, z: 1 })
  })

  it('places an amber marker for a modified node', () => {
    const base = mkScene([mkObject('o1', { x: 1, y: 0, z: 1 })])
    const compared = mkScene([mkObject('o1', { x: 1, y: 0, z: 1 })])
    const report: DiffReport = {
      added: [],
      removed: [],
      modified: [{ kind: 'modified', node_id: 'o1', node_type: 'object', changed_fields: ['material_id'] }],
    }
    const markers = buildDiffMarkers(report, base, compared)
    expect(markers).toHaveLength(1)
    expect(markers[0].kind).toBe('modified')
    expect(markers[0].color).toBe(DIFF_MARKER_COLORS.modified)
  })

  it('never marks the room node itself', () => {
    const base = mkScene([])
    const compared = mkScene([])
    const report: DiffReport = {
      added: [],
      removed: [],
      modified: [{ kind: 'modified', node_id: 'room', node_type: 'room' }],
    }
    expect(buildDiffMarkers(report, base, compared)).toHaveLength(0)
  })

  it('skips an entry whose node is absent from the expected scene', () => {
    const base = mkScene([])
    const compared = mkScene([])
    const report: DiffReport = {
      added: [{ kind: 'added', node_id: 'ghost', node_type: 'object' }],
      removed: [],
      modified: [],
    }
    expect(buildDiffMarkers(report, base, compared)).toHaveLength(0)
  })
})
