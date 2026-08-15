/**
 * Spatial · Canonical · Algebra · 4×4 Matrices
 *
 * Column-major matrix operations used by the transform pipeline. Mirrors the
 * conventions of three.js / glTF / RoomPlan (`simd_float4x4`) so the same
 * matrices round-trip through any of those toolchains without re-ordering.
 *
 * Pure functions only — no side-effects, no allocations besides the result.
 *
 * Element layout per `types/primitives.ts#Matrix4`:
 *
 *   M[col * 4 + row]   ⇒   m_{row,col} = M[col * 4 + row]
 *
 *   ┌                                                         ┐
 *   │ M[0]  M[4]  M[8]   M[12]   ← row 0 (e.g. x-translation) │
 *   │ M[1]  M[5]  M[9]   M[13]   ← row 1                      │
 *   │ M[2]  M[6]  M[10]  M[14]   ← row 2                      │
 *   │ M[3]  M[7]  M[11]  M[15]   ← row 3 (homogeneous)        │
 *   └                                                         ┘
 */

import {
  EPSILON,
  IDENTITY_MATRIX4,
  type Matrix4,
  type Matrix4Mutable,
  type Quaternion,
  type Vector3,
} from '../types/primitives.ts'

/**
 * Return a fresh identity matrix (mutable; readonly copy via `IDENTITY_MATRIX4`).
 */
export function identityMatrix(): Matrix4Mutable {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]
}

/**
 * Compose a column-major 4×4 matrix from translation, rotation, scale.
 *
 * Equivalent to T(translation) · R(rotation) · S(scale). The resulting matrix
 * applies scale first, then rotation, then translation to a point —
 * `p_world = M · p_local`.
 *
 * Mirrors `THREE.Matrix4.compose` exactly so round-trips with three.js are
 * lossless.
 */
export function composeMatrix(
  translation: Vector3,
  rotation: Quaternion,
  scale: Vector3,
): Matrix4Mutable {
  const { x, y, z, w } = rotation
  const x2 = x + x
  const y2 = y + y
  const z2 = z + z
  const xx = x * x2
  const xy = x * y2
  const xz = x * z2
  const yy = y * y2
  const yz = y * z2
  const zz = z * z2
  const wx = w * x2
  const wy = w * y2
  const wz = w * z2

  const sx = scale.x
  const sy = scale.y
  const sz = scale.z

  // Column-major: M[col * 4 + row]
  const m: Matrix4Mutable = [
    // Column 0: (1 - (yy + zz)) * sx,  (xy + wz) * sx,        (xz - wy) * sx,        0
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    // Column 1: (xy - wz) * sy,        (1 - (xx + zz)) * sy,  (yz + wx) * sy,        0
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    // Column 2: (xz + wy) * sz,        (yz - wx) * sz,        (1 - (xx + yy)) * sz,  0
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    // Column 3: translation, 1
    translation.x,
    translation.y,
    translation.z,
    1,
  ]
  return m
}

/**
 * Decompose a column-major 4×4 matrix into translation / rotation / scale.
 *
 * Caveats:
 *   - Assumes the matrix has the standard TRS shape (no shear). The bridge
 *     (Day 8 B13 · `scanToParametric`) ensures this is true for RoomPlan
 *     output; manual edits that introduce shear are rejected by the
 *     edit-system's pre-apply check (Phase 2).
 *   - Negative scale is detected by checking the determinant; if det < 0, the
 *     X-axis scale is negated so the rotation matrix has det = +1. This is
 *     the same convention used by three.js.
 */
export function decomposeMatrix(m: Matrix4): {
  position: Vector3
  rotation: Quaternion
  scale: Vector3
} {
  // Translation (column 3, rows 0-2)
  const position: Vector3 = { x: m[12], y: m[13], z: m[14] }

  // Extract scale as the length of each basis column.
  let sx = Math.hypot(m[0], m[1], m[2])
  const sy = Math.hypot(m[4], m[5], m[6])
  const sz = Math.hypot(m[8], m[9], m[10])

  // Handle negative scale via determinant.
  const det = determinant3x3(m)
  if (det < 0) sx = -sx

  // Build the rotation matrix by normalising each basis column.
  const invSx = sx !== 0 ? 1 / sx : 0
  const invSy = sy !== 0 ? 1 / sy : 0
  const invSz = sz !== 0 ? 1 / sz : 0

  const r00 = m[0] * invSx
  const r10 = m[1] * invSx
  const r20 = m[2] * invSx
  const r01 = m[4] * invSy
  const r11 = m[5] * invSy
  const r21 = m[6] * invSy
  const r02 = m[8] * invSz
  const r12 = m[9] * invSz
  const r22 = m[10] * invSz

  // Convert the 3×3 rotation matrix to a quaternion via Shepperd's method
  // (numerically stable across all rotation axes).
  const trace = r00 + r11 + r22
  let qw: number, qx: number, qy: number, qz: number
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    qw = 0.25 / s
    qx = (r21 - r12) * s
    qy = (r02 - r20) * s
    qz = (r10 - r01) * s
  } else if (r00 > r11 && r00 > r22) {
    const s = 2 * Math.sqrt(1 + r00 - r11 - r22)
    qw = (r21 - r12) / s
    qx = 0.25 * s
    qy = (r01 + r10) / s
    qz = (r02 + r20) / s
  } else if (r11 > r22) {
    const s = 2 * Math.sqrt(1 + r11 - r00 - r22)
    qw = (r02 - r20) / s
    qx = (r01 + r10) / s
    qy = 0.25 * s
    qz = (r12 + r21) / s
  } else {
    const s = 2 * Math.sqrt(1 + r22 - r00 - r11)
    qw = (r10 - r01) / s
    qx = (r02 + r20) / s
    qy = (r12 + r21) / s
    qz = 0.25 * s
  }

  return {
    position,
    rotation: { x: qx, y: qy, z: qz, w: qw },
    scale: { x: sx, y: sy, z: sz },
  }
}

/**
 * Multiply two column-major 4×4 matrices: returns `a · b`.
 *
 * The convention here matches three.js: applying the result to a point is
 * `p' = (a · b) · p = a · (b · p)` — i.e. b is applied first, then a.
 */
export function multiplyMatrix(a: Matrix4, b: Matrix4): Matrix4Mutable {
  const out: Matrix4Mutable = [
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ]
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3]
    }
  }
  return out
}

/**
 * Compute the inverse of a column-major 4×4 matrix. Returns `null` if the
 * matrix is singular (det ≈ 0). Implemented via the adjugate formula —
 * stable enough for the well-conditioned TRS matrices produced by RoomPlan.
 *
 * For the rare case of needing a pseudo-inverse (e.g. user-edited near-
 * singular matrices), the caller should fall back to recomposition from
 * decompose() + invert each component.
 */
export function inverseMatrix(m: Matrix4): Matrix4Mutable | null {
  const n11 = m[0], n21 = m[1], n31 = m[2], n41 = m[3]
  const n12 = m[4], n22 = m[5], n32 = m[6], n42 = m[7]
  const n13 = m[8], n23 = m[9], n33 = m[10], n43 = m[11]
  const n14 = m[12], n24 = m[13], n34 = m[14], n44 = m[15]

  const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44
  const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44
  const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44
  const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34

  const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14
  if (Math.abs(det) < EPSILON) return null

  const detInv = 1 / det

  return [
    t11 * detInv,
    (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * detInv,
    (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * detInv,
    (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * detInv,

    t12 * detInv,
    (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * detInv,
    (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * detInv,
    (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * detInv,

    t13 * detInv,
    (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * detInv,
    (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * detInv,
    (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * detInv,

    t14 * detInv,
    (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * detInv,
    (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * detInv,
    (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * detInv,
  ]
}

/**
 * Multiply a column-major 4×4 matrix by a 3D point (with implicit w=1).
 * The result is the transformed point in world-space (or whichever frame
 * the matrix maps into).
 */
export function multiplyVector(m: Matrix4, v: Vector3): Vector3 {
  return {
    x: m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12],
    y: m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13],
    z: m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14],
  }
}

/**
 * Determinant of the upper-left 3×3 sub-matrix. Used by `decomposeMatrix` to
 * detect mirrored / negative-scale matrices.
 */
function determinant3x3(m: Matrix4): number {
  const m00 = m[0], m01 = m[4], m02 = m[8]
  const m10 = m[1], m11 = m[5], m12 = m[9]
  const m20 = m[2], m21 = m[6], m22 = m[10]
  return (
    m00 * (m11 * m22 - m12 * m21) -
    m01 * (m10 * m22 - m12 * m20) +
    m02 * (m10 * m21 - m11 * m20)
  )
}

/**
 * Approximate matrix equality within a tunable tolerance — useful in tests
 * and in cache-invalidation logic that wants to skip a recompute when the
 * computed result has not meaningfully changed.
 */
export function matrixApproxEquals(a: Matrix4, b: Matrix4, tolerance = EPSILON): boolean {
  for (let i = 0; i < 16; i++) {
    if (Math.abs(a[i] - b[i]) > tolerance) return false
  }
  return true
}

/**
 * Re-exports for ergonomic imports from `algebra/`.
 */
export { IDENTITY_MATRIX4 }
