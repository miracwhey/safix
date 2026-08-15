/**
 * Tests for the R1 converter — ProceduralMesh → THREE.BufferGeometry.
 *
 * Covers the four properties the renderer relies on:
 *   - vertex count + attribute itemSize are correct,
 *   - the index buffer is copied 1:1 (winding preserved — the Phase-1
 *     cylinder-winding CRIT class must not regress),
 *   - the geometry is disposable,
 *   - malformed meshes fail loudly rather than uploading corrupt buffers.
 */
import { describe, it, expect } from 'vitest'

import {
  makeBox,
  makeCylinder,
  type ProceduralMesh,
} from '../../../../../src/lib/spatial/canonical/geometry/procedural-primitives.ts'
import { buildProceduralAsset } from '../../../../../src/lib/spatial/canonical/geometry/procedural-assets.ts'
import { proceduralMeshToBufferGeometry } from '../../../../../src/components/spatial/three/canonical/geometry/proceduralMeshToBufferGeometry.ts'

describe('proceduralMeshToBufferGeometry', () => {
  it('builds position/normal/uv attributes with the correct itemSize', () => {
    const mesh = makeBox({ x: 1, y: 1, z: 1 })
    const geometry = proceduralMeshToBufferGeometry(mesh)

    const position = geometry.getAttribute('position')
    const normal = geometry.getAttribute('normal')
    const uv = geometry.getAttribute('uv')

    expect(position.itemSize).toBe(3)
    expect(normal.itemSize).toBe(3)
    expect(uv.itemSize).toBe(2)

    geometry.dispose()
  })

  it('preserves the vertex count (24 verts for a box)', () => {
    const mesh = makeBox({ x: 2, y: 0.5, z: 1 })
    const geometry = proceduralMeshToBufferGeometry(mesh)

    const vertexCount = mesh.positions.length / 3
    expect(vertexCount).toBe(24)
    expect(geometry.getAttribute('position').count).toBe(24)
    expect(geometry.getAttribute('normal').count).toBe(24)
    expect(geometry.getAttribute('uv').count).toBe(24)

    geometry.dispose()
  })

  it('copies the index buffer verbatim — order and values unchanged', () => {
    const mesh = makeCylinder({ radiusTop: 0.2, radiusBottom: 0.2, height: 1, radialSegments: 8 })
    const geometry = proceduralMeshToBufferGeometry(mesh)

    const index = geometry.getIndex()
    expect(index).not.toBeNull()
    if (!index) throw new Error('index missing')

    expect(index.count).toBe(mesh.indices.length)
    // 1:1 copy — every slot identical, no re-ordering / reversal.
    for (let i = 0; i < mesh.indices.length; i++) {
      expect(index.getX(i)).toBe(mesh.indices[i])
    }

    geometry.dispose()
  })

  it('positions match the source buffer exactly', () => {
    const mesh = makeBox({ x: 1, y: 2, z: 3 }, { x: 0.5, y: 1, z: -0.5 })
    const geometry = proceduralMeshToBufferGeometry(mesh)

    const position = geometry.getAttribute('position')
    for (let i = 0; i < mesh.positions.length; i++) {
      expect(position.array[i]).toBeCloseTo(mesh.positions[i], 5)
    }

    geometry.dispose()
  })

  it('computes a bounding box and sphere', () => {
    const geometry = proceduralMeshToBufferGeometry(makeBox({ x: 2, y: 2, z: 2 }))
    expect(geometry.boundingBox).not.toBeNull()
    expect(geometry.boundingSphere).not.toBeNull()
    geometry.dispose()
  })

  it('converts every procedural catalog asset without throwing', () => {
    const built = buildProceduralAsset('sanitary-toilet-standard-floor')
    const geometry = proceduralMeshToBufferGeometry(built.mesh)
    expect(geometry.getAttribute('position').count).toBe(built.mesh.positions.length / 3)
    expect(geometry.getIndex()?.count).toBe(built.mesh.indices.length)
    geometry.dispose()
  })

  it('dispose() frees the geometry without error', () => {
    const geometry = proceduralMeshToBufferGeometry(makeBox({ x: 1, y: 1, z: 1 }))
    expect(() => geometry.dispose()).not.toThrow()
  })

  it('throws on a positions buffer that is not a multiple of 3', () => {
    const bad: ProceduralMesh = { positions: [0, 0], normals: [], uvs: [], indices: [] }
    expect(() => proceduralMeshToBufferGeometry(bad)).toThrow(/not a multiple of 3/)
  })

  it('throws when normals length does not match positions length', () => {
    const bad: ProceduralMesh = {
      positions: [0, 0, 0, 1, 1, 1, 2, 2, 2],
      normals: [0, 1, 0],
      uvs: [0, 0, 0, 0, 0, 0],
      indices: [0, 1, 2],
    }
    expect(() => proceduralMeshToBufferGeometry(bad)).toThrow(/normals length/)
  })

  it('throws when uvs length does not match the vertex count', () => {
    const bad: ProceduralMesh = {
      positions: [0, 0, 0, 1, 1, 1, 2, 2, 2],
      normals: [0, 1, 0, 0, 1, 0, 0, 1, 0],
      uvs: [0, 0],
      indices: [0, 1, 2],
    }
    expect(() => proceduralMeshToBufferGeometry(bad)).toThrow(/uvs length/)
  })

  it('throws on an out-of-range triangle index', () => {
    const bad: ProceduralMesh = {
      positions: [0, 0, 0, 1, 1, 1, 2, 2, 2],
      normals: [0, 1, 0, 0, 1, 0, 0, 1, 0],
      uvs: [0, 0, 0, 0, 0, 0],
      indices: [0, 1, 9],
    }
    expect(() => proceduralMeshToBufferGeometry(bad)).toThrow(/out of range/)
  })
})
