/**
 * Spatial · Canonical · Geometry · Procedural Primitives
 *
 * Renderer-agnostic triangle-mesh primitives + mesh algebra. The L1 layer
 * produces plain numeric vertex buffers; the L3 renderer adapter turns a
 * {@link ProceduralMesh} into a `THREE.BufferGeometry` without this module
 * ever importing three.js.
 *
 * Used by `procedural-assets.ts` to compose the Phase-1 box-placeholder
 * fixtures (sanitary / kitchen / architecture) from boxes and cylinders —
 * the asset-source-map §0 strategy: catalog-stable placeholders now, real
 * GLB swap in Phase 2 without a schema change.
 *
 * Conventions (binding · Master-Spec §2):
 *   - Right-Handed Y-Up, meters.
 *   - Triangles are CCW when viewed from outside (front-face = CCW), so the
 *     renderer can keep default back-face culling.
 *   - `positions` / `normals` are flat XYZ triples, `uvs` flat UV pairs, one
 *     entry per vertex; `indices` are triangle indices into those arrays.
 *
 * Pure: no three.js / React / DOM, no module-level mutable state.
 */

import { EPSILON, type Vector3 } from '../types/primitives.ts'

/**
 * A renderer-agnostic indexed triangle mesh. Buffers are plain arrays so the
 * structure stays JSON-serialisable and unit-testable.
 */
export interface ProceduralMesh {
  /** Flat XYZ triples — vertex positions in meters, asset-local space. */
  positions: number[]
  /** Flat XYZ triples — unit normals, one per position vertex. */
  normals: number[]
  /** Flat UV pairs — one per position vertex. */
  uvs: number[]
  /** Triangle indices into the position / normal / uv arrays. */
  indices: number[]
}

/** Axis-aligned bounding box in mesh-local space. */
export interface MeshBounds {
  min: Vector3
  max: Vector3
}

// ─────────────────────────────────────────────────────────────────────────────
// Box
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Six box faces as unit corners (±1) + outward normal. Corner order is CCW
 * viewed from outside; UVs map corner 0→(0,0) 1→(1,0) 2→(1,1) 3→(0,1).
 * Winding is verified so triangles (0,1,2)+(0,2,3) face along the normal.
 */
const BOX_FACES: ReadonlyArray<{
  normal: readonly [number, number, number]
  corners: ReadonlyArray<readonly [number, number, number]>
}> = [
  { normal: [1, 0, 0], corners: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { normal: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { normal: [0, 1, 0], corners: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { normal: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { normal: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { normal: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
]

const FACE_UVS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [1, 0], [1, 1], [0, 1],
]

/**
 * Axis-aligned box of the given size, centered at `center` (default origin).
 * 24 vertices (4 per face) so each face has its own flat normal + UV square.
 */
export function makeBox(
  size: Vector3,
  center: Vector3 = { x: 0, y: 0, z: 0 },
): ProceduralMesh {
  const hx = size.x / 2
  const hy = size.y / 2
  const hz = size.z / 2
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  for (const face of BOX_FACES) {
    const base = positions.length / 3
    for (let i = 0; i < 4; i++) {
      const c = face.corners[i]
      positions.push(center.x + c[0] * hx, center.y + c[1] * hy, center.z + c[2] * hz)
      normals.push(face.normal[0], face.normal[1], face.normal[2])
      uvs.push(FACE_UVS[i][0], FACE_UVS[i][1])
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }

  return { positions, normals, uvs, indices }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cylinder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vertical (Y-axis) cylinder / truncated cone, centered at `center`.
 *
 * Side normals are purely radial — exact for a cylinder, a close-enough
 * approximation for the gently-tapered cones used in placeholder fixtures
 * (faucet stems, burner discs). Flat top + bottom caps.
 */
export function makeCylinder(
  params: {
    radiusTop: number
    radiusBottom: number
    height: number
    radialSegments?: number
  },
  center: Vector3 = { x: 0, y: 0, z: 0 },
): ProceduralMesh {
  const segments = Math.max(3, params.radialSegments ?? 16)
  const hy = params.height / 2
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  // ── Side wall ──────────────────────────────────────────────────────────
  // (segments + 1) columns so the UV seam has duplicated vertices.
  const sideBase = 0
  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const angle = t * Math.PI * 2
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    // top vertex
    positions.push(
      center.x + cos * params.radiusTop,
      center.y + hy,
      center.z + sin * params.radiusTop,
    )
    normals.push(cos, 0, sin)
    uvs.push(t, 1)
    // bottom vertex
    positions.push(
      center.x + cos * params.radiusBottom,
      center.y - hy,
      center.z + sin * params.radiusBottom,
    )
    normals.push(cos, 0, sin)
    uvs.push(t, 0)
  }
  for (let i = 0; i < segments; i++) {
    const a = sideBase + i * 2 // top_i
    const b = a + 1 // bot_i
    const c = a + 2 // top_{i+1}
    const d = a + 3 // bot_{i+1}
    // CCW viewed from outside → radial-outward face normal.
    indices.push(a, d, b, a, c, d)
  }

  // ── Caps ───────────────────────────────────────────────────────────────
  const addCap = (y: number, radius: number, ny: number): void => {
    if (radius < EPSILON) return
    const centerIdx = positions.length / 3
    positions.push(center.x, center.y + y, center.z)
    normals.push(0, ny, 0)
    uvs.push(0.5, 0.5)
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      positions.push(center.x + cos * radius, center.y + y, center.z + sin * radius)
      normals.push(0, ny, 0)
      uvs.push(0.5 + cos * 0.5, 0.5 + sin * 0.5)
    }
    for (let i = 0; i < segments; i++) {
      const rim = centerIdx + 1 + i
      // Wind CCW seen from outside the cap (along +`ny`): the top cap
      // (ny>0) reverses the rim order relative to the bottom cap.
      if (ny > 0) indices.push(centerIdx, rim + 1, rim)
      else indices.push(centerIdx, rim, rim + 1)
    }
  }
  addCap(hy, params.radiusTop, 1)
  addCap(-hy, params.radiusBottom, -1)

  return { positions, normals, uvs, indices }
}

// ─────────────────────────────────────────────────────────────────────────────
// Open-top box (basins, tubs, shower trays)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An open-top box — a floor slab plus four walls, leaving the top face void.
 * Models the recessed-basin silhouette of tubs / sinks / shower trays with a
 * single helper instead of five hand-placed boxes.
 *
 * `size` is the outer extent; `wallThickness` is taken inward from each side.
 */
export function makeOpenTopBox(
  size: Vector3,
  wallThickness: number,
  center: Vector3 = { x: 0, y: 0, z: 0 },
): ProceduralMesh {
  const t = Math.min(wallThickness, size.x / 2 - EPSILON, size.z / 2 - EPSILON)
  // The ±X walls run the full depth; the ±Z walls span only the inner width
  // so the four walls abut at the corners without overlapping.
  const innerW = size.x - 2 * t
  const wallH = size.y
  const halfY = size.y / 2

  const parts: ProceduralMesh[] = [
    // floor slab
    makeBox(
      { x: size.x, y: t, z: size.z },
      { x: center.x, y: center.y - halfY + t / 2, z: center.z },
    ),
    // +X wall
    makeBox(
      { x: t, y: wallH, z: size.z },
      { x: center.x + size.x / 2 - t / 2, y: center.y, z: center.z },
    ),
    // -X wall
    makeBox(
      { x: t, y: wallH, z: size.z },
      { x: center.x - size.x / 2 + t / 2, y: center.y, z: center.z },
    ),
    // +Z wall
    makeBox(
      { x: innerW, y: wallH, z: t },
      { x: center.x, y: center.y, z: center.z + size.z / 2 - t / 2 },
    ),
    // -Z wall
    makeBox(
      { x: innerW, y: wallH, z: t },
      { x: center.x, y: center.y, z: center.z - size.z / 2 + t / 2 },
    ),
  ]
  return mergeMeshes(parts)
}

// ─────────────────────────────────────────────────────────────────────────────
// Vertical prism extrusion
// ─────────────────────────────────────────────────────────────────────────────

/** Signed area of a polygon ring on XZ (shoelace, `x·z'` convention). */
function ringSignedAreaXZ(ring: Vector3[]): number {
  let area = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    area += a.x * b.z - b.x * a.z
  }
  return area / 2
}

/**
 * Extrude a horizontal polygon ring straight up into a closed vertical prism.
 *
 * `ring` is a polygon on the floor plane (XZ); each vertex's own `y` is the
 * bottom, `y + height` the top. The result is a watertight mesh: a bottom
 * cap (facing -Y), a top cap (facing +Y) and one flat-shaded side quad per
 * ring edge (facing radially outward).
 *
 * Winding-robust: the ring is normalised to a single internal orientation
 * first, so either input winding produces correct outward faces (the cap
 * winding is the easy thing to get inverted — see the regression test).
 *
 * Caps are fan-triangulated from vertex 0 — exact for CONVEX rings, which is
 * all this primitive is used for (mitered wall footprints). A ring with
 * fewer than 3 vertices yields an empty mesh.
 *
 * This is the renderer-agnostic core behind `wall-profile.ts#extrudeWallProfile`:
 * a mitered wall body is just its footprint quad extruded by `height_m`.
 */
export function extrudeProfile(inputRing: Vector3[], height: number): ProceduralMesh {
  const n = inputRing.length
  if (n < 3) return { positions: [], normals: [], uvs: [], indices: [] }

  // Normalise to a consistent internal orientation (positive XZ shoelace), so
  // the cap + side winding below is correct regardless of caller winding.
  const ring = ringSignedAreaXZ(inputRing) < 0 ? [...inputRing].reverse() : inputRing

  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  // ── Bottom cap (facing -Y) ──────────────────────────────────────────────
  const bottomBase = positions.length / 3
  for (const v of ring) {
    positions.push(v.x, v.y, v.z)
    normals.push(0, -1, 0)
    uvs.push(v.x, v.z)
  }
  for (let i = 1; i < n - 1; i++) {
    indices.push(bottomBase, bottomBase + i, bottomBase + i + 1)
  }

  // ── Top cap (facing +Y) ─────────────────────────────────────────────────
  const topBase = positions.length / 3
  for (const v of ring) {
    positions.push(v.x, v.y + height, v.z)
    normals.push(0, 1, 0)
    uvs.push(v.x, v.z)
  }
  for (let i = 1; i < n - 1; i++) {
    indices.push(topBase, topBase + i + 1, topBase + i)
  }

  // ── Side walls — one flat quad per ring edge ────────────────────────────
  for (let i = 0; i < n; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % n]
    const dx = b.x - a.x
    const dz = b.z - a.z
    const len = Math.hypot(dx, dz)
    if (len < EPSILON) continue
    // Outward normal of a CCW ring edge — right-hand perpendicular.
    const nx = dz / len
    const nz = -dx / len
    const base = positions.length / 3
    // bottom_a, bottom_b, top_a, top_b
    positions.push(a.x, a.y, a.z)
    positions.push(b.x, b.y, b.z)
    positions.push(a.x, a.y + height, a.z)
    positions.push(b.x, b.y + height, b.z)
    for (let k = 0; k < 4; k++) normals.push(nx, 0, nz)
    uvs.push(0, 0, len, 0, 0, height, len, height)
    // Wind so the face points along the outward normal.
    indices.push(base, base + 3, base + 1, base, base + 2, base + 3)
  }

  return { positions, normals, uvs, indices }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mesh algebra
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge several meshes into one, re-basing each mesh's triangle indices onto
 * the combined vertex buffer. Pure — inputs are not mutated.
 */
export function mergeMeshes(meshes: readonly ProceduralMesh[]): ProceduralMesh {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  for (const mesh of meshes) {
    const vertexOffset = positions.length / 3
    positions.push(...mesh.positions)
    normals.push(...mesh.normals)
    uvs.push(...mesh.uvs)
    for (const idx of mesh.indices) indices.push(idx + vertexOffset)
  }

  return { positions, normals, uvs, indices }
}

/**
 * Return a copy of `mesh` translated by `offset`. Normals + UVs are unchanged
 * (translation does not rotate or scale).
 */
export function translateMesh(mesh: ProceduralMesh, offset: Vector3): ProceduralMesh {
  const positions = mesh.positions.slice()
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] += offset.x
    positions[i + 1] += offset.y
    positions[i + 2] += offset.z
  }
  return {
    positions,
    normals: mesh.normals.slice(),
    uvs: mesh.uvs.slice(),
    indices: mesh.indices.slice(),
  }
}

/**
 * Axis-aligned bounds of a mesh. Returns a zero-box at the origin for an
 * empty mesh so callers never have to special-case `Infinity`.
 */
export function computeMeshBounds(mesh: ProceduralMesh): MeshBounds {
  if (mesh.positions.length === 0) {
    return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }
  }
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i]
    const y = mesh.positions[i + 1]
    const z = mesh.positions[i + 2]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } }
}

/** Triangle count of a mesh — telemetry / polycount-budget assertions. */
export function triangleCount(mesh: ProceduralMesh): number {
  return mesh.indices.length / 3
}
