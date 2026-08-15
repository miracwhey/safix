/**
 * Spatial · Canonical · Three · Geometry · ProceduralMesh → BufferGeometry
 *
 * The L3 renderer-adapter step that `procedural-primitives.ts` (lines 4-7)
 * explicitly defers to this layer: turn the renderer-agnostic, JSON-shaped
 * {@link ProceduralMesh} (flat numeric `positions` / `normals` / `uvs` +
 * `indices`) into a GPU-uploadable `THREE.BufferGeometry`.
 *
 * Winding contract (binding · Master-Spec §2): the L1 primitives wind every
 * triangle CCW as seen from outside so default back-face culling works. This
 * converter MUST take the `indices` array 1:1 — re-ordering or reversing the
 * index buffer here would invert face winding (the Phase-1 cylinder-winding
 * CRIT class). It therefore only copies buffers; it never sorts or flips.
 *
 * Disposal: a `BufferGeometry` owns GPU-backed `BufferAttribute`s that
 * three.js never frees automatically. The geometry returned here is fully
 * disposable — the consumer (`ObjectAdapter`) calls `.dispose()` in its
 * effect cleanup on unmount / prop churn.
 */

import { BufferAttribute, BufferGeometry } from 'three'

import type { ProceduralMesh } from '../../../../../lib/spatial/canonical/geometry/procedural-primitives.ts'

/**
 * Build a `THREE.BufferGeometry` from a flat {@link ProceduralMesh}.
 *
 * Attributes:
 *   - `position` — itemSize 3, from `mesh.positions`
 *   - `normal`   — itemSize 3, from `mesh.normals`
 *   - `uv`       — itemSize 2, from `mesh.uvs`
 *   - index buffer — from `mesh.indices`, copied verbatim (winding preserved)
 *
 * Buffers are copied into freshly-allocated `Float32Array` / `Uint32Array`
 * views so the geometry never aliases the L1 plain-number arrays — the L1
 * mesh stays immutable and the GPU buffer is independently disposable.
 *
 * @throws if the mesh buffers are internally inconsistent (mis-aligned
 *   lengths or an out-of-range index) — a malformed mesh must fail loudly
 *   here rather than render as corrupt geometry.
 */
export function proceduralMeshToBufferGeometry(mesh: ProceduralMesh): BufferGeometry {
  const vertexCount = mesh.positions.length / 3

  if (mesh.positions.length % 3 !== 0) {
    throw new Error(
      `[spatial] proceduralMeshToBufferGeometry: positions length ${mesh.positions.length} is not a multiple of 3`,
    )
  }
  if (mesh.normals.length !== mesh.positions.length) {
    throw new Error(
      `[spatial] proceduralMeshToBufferGeometry: normals length ${mesh.normals.length} ≠ positions length ${mesh.positions.length}`,
    )
  }
  if (mesh.uvs.length !== vertexCount * 2) {
    throw new Error(
      `[spatial] proceduralMeshToBufferGeometry: uvs length ${mesh.uvs.length} ≠ ${vertexCount * 2} (2 per vertex)`,
    )
  }
  if (mesh.indices.length % 3 !== 0) {
    throw new Error(
      `[spatial] proceduralMeshToBufferGeometry: indices length ${mesh.indices.length} is not a multiple of 3`,
    )
  }
  for (let i = 0; i < mesh.indices.length; i++) {
    const idx = mesh.indices[i]
    if (!Number.isInteger(idx) || idx < 0 || idx >= vertexCount) {
      throw new Error(
        `[spatial] proceduralMeshToBufferGeometry: index ${idx} at slot ${i} is out of range [0, ${vertexCount})`,
      )
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(mesh.positions), 3))
  geometry.setAttribute('normal', new BufferAttribute(Float32Array.from(mesh.normals), 3))
  geometry.setAttribute('uv', new BufferAttribute(Float32Array.from(mesh.uvs), 2))
  // Index order copied verbatim — see the winding contract in the file header.
  geometry.setIndex(new BufferAttribute(Uint32Array.from(mesh.indices), 1))

  // Tight bounds for frustum culling + raycasting; cheap, derived from the
  // position buffer that was just uploaded.
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()

  return geometry
}
