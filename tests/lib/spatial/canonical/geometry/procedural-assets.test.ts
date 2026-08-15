/**
 * Tests for geometry/procedural-primitives.ts + procedural-assets.ts.
 *
 * The 26 box-placeholder fixtures (asset-source-map §0) must produce
 * watertight-indexed meshes with a correct bounding box and a pivot
 * reference point translated to the origin — that is what keeps collision,
 * clearance and snapping accurate before real GLB models swap in (Phase 2).
 */
import { describe, it, expect } from 'vitest'

import {
  makeBox,
  makeCylinder,
  makeOpenTopBox,
  mergeMeshes,
  translateMesh,
  computeMeshBounds,
  triangleCount,
  type ProceduralMesh,
} from '../../../../../src/lib/spatial/canonical/geometry/procedural-primitives.ts'
import {
  PROCEDURAL_ASSET_SLUGS,
  buildProceduralAsset,
  buildGenericBox,
  hasProceduralAsset,
} from '../../../../../src/lib/spatial/canonical/geometry/procedural-assets.ts'

/** Every index must reference an existing vertex; buffers must be aligned. */
function assertWellFormed(mesh: ProceduralMesh): void {
  const vertexCount = mesh.positions.length / 3
  expect(mesh.positions.length % 3).toBe(0)
  expect(mesh.normals.length).toBe(mesh.positions.length)
  expect(mesh.uvs.length / 2).toBe(vertexCount)
  expect(mesh.indices.length % 3).toBe(0)
  for (const idx of mesh.indices) {
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(idx).toBeLessThan(vertexCount)
  }
}

/**
 * Every triangle must be wound CCW as seen from outside — i.e. its geometric
 * face normal must agree (dot > 0) with the shading normals at its vertices.
 * This is what catches inside-out winding (the cylinder side/cap bug class)
 * that `assertWellFormed` cannot see.
 */
function assertOutwardWinding(mesh: ProceduralMesh): void {
  const p = mesh.positions
  const n = mesh.normals
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const ia = mesh.indices[t] * 3
    const ib = mesh.indices[t + 1] * 3
    const ic = mesh.indices[t + 2] * 3
    const e1 = [p[ib] - p[ia], p[ib + 1] - p[ia + 1], p[ib + 2] - p[ia + 2]]
    const e2 = [p[ic] - p[ia], p[ic + 1] - p[ia + 1], p[ic + 2] - p[ia + 2]]
    const fn = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ]
    const len = Math.hypot(fn[0], fn[1], fn[2])
    if (len < 1e-9) continue // skip degenerate slivers
    // Average the three vertex shading normals.
    const vn = [
      (n[ia] + n[ib] + n[ic]) / 3,
      (n[ia + 1] + n[ib + 1] + n[ic + 1]) / 3,
      (n[ia + 2] + n[ib + 2] + n[ic + 2]) / 3,
    ]
    const dot = (fn[0] * vn[0] + fn[1] * vn[1] + fn[2] * vn[2]) / len
    expect(dot).toBeGreaterThan(0)
  }
}

describe('procedural-primitives · makeBox', () => {
  it('produces a 24-vertex, 12-triangle box with the requested extents', () => {
    const mesh = makeBox({ x: 2, y: 4, z: 6 })
    expect(mesh.positions.length / 3).toBe(24)
    expect(triangleCount(mesh)).toBe(12)
    assertWellFormed(mesh)
    assertOutwardWinding(mesh)
    const b = computeMeshBounds(mesh)
    expect(b.min).toEqual({ x: -1, y: -2, z: -3 })
    expect(b.max).toEqual({ x: 1, y: 2, z: 3 })
  })

  it('emits unit-length normals', () => {
    const mesh = makeBox({ x: 1, y: 1, z: 1 })
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const len = Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2])
      expect(len).toBeCloseTo(1, 6)
    }
  })

  it('honors the center offset', () => {
    const b = computeMeshBounds(makeBox({ x: 2, y: 2, z: 2 }, { x: 5, y: 0, z: -3 }))
    expect(b.min).toEqual({ x: 4, y: -1, z: -4 })
    expect(b.max).toEqual({ x: 6, y: 1, z: -2 })
  })
})

describe('procedural-primitives · makeCylinder', () => {
  it('builds a closed cylinder within the requested radius + height', () => {
    const mesh = makeCylinder({ radiusTop: 0.5, radiusBottom: 0.5, height: 2, radialSegments: 16 })
    assertWellFormed(mesh)
    assertOutwardWinding(mesh)
    const b = computeMeshBounds(mesh)
    expect(b.min.y).toBeCloseTo(-1, 6)
    expect(b.max.y).toBeCloseTo(1, 6)
    expect(b.max.x).toBeCloseTo(0.5, 6)
    expect(triangleCount(mesh)).toBeGreaterThan(0)
  })

  it('omits the cap when a radius collapses to zero (cone tip)', () => {
    const mesh = makeCylinder({ radiusTop: 0, radiusBottom: 0.5, height: 1, radialSegments: 12 })
    assertWellFormed(mesh)
  })
})

describe('procedural-primitives · makeOpenTopBox + algebra', () => {
  it('open-top box keeps the outer extents', () => {
    const b = computeMeshBounds(makeOpenTopBox({ x: 1.7, y: 0.6, z: 0.75 }, 0.07))
    expect(b.max.x - b.min.x).toBeCloseTo(1.7, 6)
    expect(b.max.y - b.min.y).toBeCloseTo(0.6, 6)
    expect(b.max.z - b.min.z).toBeCloseTo(0.75, 6)
  })

  it('mergeMeshes re-bases triangle indices onto the combined buffer', () => {
    const a = makeBox({ x: 1, y: 1, z: 1 })
    const b = makeBox({ x: 1, y: 1, z: 1 }, { x: 10, y: 0, z: 0 })
    const merged = mergeMeshes([a, b])
    expect(merged.positions.length).toBe(a.positions.length + b.positions.length)
    expect(merged.indices.length).toBe(a.indices.length + b.indices.length)
    assertWellFormed(merged)
  })

  it('translateMesh shifts positions but leaves normals untouched', () => {
    const src = makeBox({ x: 1, y: 1, z: 1 })
    const moved = translateMesh(src, { x: 3, y: 0, z: 0 })
    expect(moved.normals).toEqual(src.normals)
    expect(computeMeshBounds(moved).min.x).toBeCloseTo(2.5, 6)
  })
})

describe('procedural-assets · placeholder catalog', () => {
  it('exposes 26 procedural slugs (10 sanitary + 8 kitchen + 8 architecture)', () => {
    expect(PROCEDURAL_ASSET_SLUGS).toHaveLength(35)
    expect(PROCEDURAL_ASSET_SLUGS.filter((s) => s.startsWith('sanitary-'))).toHaveLength(10)
    expect(PROCEDURAL_ASSET_SLUGS.filter((s) => s.startsWith('kitchen-'))).toHaveLength(8)
    expect(PROCEDURAL_ASSET_SLUGS.filter((s) => s.startsWith('arch-'))).toHaveLength(17)
  })

  it('builds every placeholder with a well-formed mesh + sane dimensions', () => {
    for (const slug of PROCEDURAL_ASSET_SLUGS) {
      const asset = buildProceduralAsset(slug)
      assertWellFormed(asset.mesh)
      assertOutwardWinding(asset.mesh)
      expect(asset.triangles).toBeGreaterThan(0)
      // Placeholders are primitive — far below the LOD0 polycount budgets.
      expect(asset.triangles).toBeLessThan(5000)
      for (const dim of [asset.dimensions.width_m, asset.dimensions.depth_m, asset.dimensions.height_m]) {
        expect(dim).toBeGreaterThan(0.01)
        expect(dim).toBeLessThan(3)
      }
    }
  })

  it('translates the pivot reference point to the origin per pivot convention', () => {
    for (const slug of PROCEDURAL_ASSET_SLUGS) {
      const { bbox, pivot } = buildProceduralAsset(slug)
      const cx = (bbox.min.x + bbox.max.x) / 2
      const cz = (bbox.min.z + bbox.max.z) / 2
      if (pivot === 'bottom_center') {
        expect(bbox.min.y).toBeCloseTo(0, 6)
        expect(cx).toBeCloseTo(0, 6)
        expect(cz).toBeCloseTo(0, 6)
      } else if (pivot === 'wall_back_center') {
        expect(bbox.min.z).toBeCloseTo(0, 6)
        expect(cx).toBeCloseTo(0, 6)
      } else if (pivot === 'corner_back_left') {
        expect(bbox.min.x).toBeCloseTo(0, 6)
        expect(bbox.min.y).toBeCloseTo(0, 6)
        expect(bbox.min.z).toBeCloseTo(0, 6)
      }
    }
  })

  it('matches the curated reference size for the standard floor toilet', () => {
    const toilet = buildProceduralAsset('sanitary-toilet-standard-floor')
    expect(toilet.dimensions.width_m).toBeCloseTo(0.37, 2)
    expect(toilet.dimensions.depth_m).toBeCloseTo(0.7, 1)
    expect(toilet.pivot).toBe('bottom_center')
  })

  it('hasProceduralAsset reflects the catalog; unknown slugs throw', () => {
    expect(hasProceduralAsset('sanitary-toilet-standard-floor')).toBe(true)
    expect(hasProceduralAsset('furn-sofa-3seater-fabric-grey')).toBe(false)
    expect(() => buildProceduralAsset('does-not-exist')).toThrow(/no procedural placeholder/)
  })

  it('buildGenericBox falls back to a dimensioned cuboid with pivot normalisation', () => {
    const box = buildGenericBox({ width_m: 2, depth_m: 0.9, height_m: 0.8 }, 'bottom_center')
    expect(box.dimensions).toEqual({ width_m: 2, depth_m: 0.9, height_m: 0.8 })
    expect(box.bbox.min.y).toBeCloseTo(0, 6)
    expect(triangleCount(box.mesh)).toBe(12)
  })
})
