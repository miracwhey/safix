/**
 * Spatial · Canonical · Algebra · Quaternions
 *
 * Unit-quaternion operations used by the rotation pipeline. The Hamilton
 * convention is used throughout: i² = j² = k² = ijk = -1; storage layout is
 * `{ x, y, z, w }` with `w` as the scalar part — matching three.js, glTF, and
 * the iOS RoomPlan plugin.
 *
 * All "rotate-a-vector"-style helpers assume the input quaternion is
 * normalised. If you obtained a quaternion from arithmetic (multiply / slerp /
 * decompose), pipe it through `normalize()` before applying it to a vector —
 * the error otherwise compounds quickly over composition chains.
 */

import {
  IDENTITY_QUATERNION,
  type Quaternion,
  type Vector3,
} from '../types/primitives.ts'

/**
 * Return a fresh identity quaternion (mutable copy).
 *
 * Pre-frozen copy lives in `types/primitives.ts#IDENTITY_QUATERNION`; use
 * that when you only need to read.
 */
export function identityQuaternion(): Quaternion {
  return { x: 0, y: 0, z: 0, w: 1 }
}

/**
 * Squared length of a quaternion. Cheaper than `length()` when you only need
 * to check magnitude — e.g. to compare unit-ness against `1`.
 */
export function lengthSquared(q: Quaternion): number {
  return q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w
}

/**
 * Quaternion length (= sqrt of dot with self).
 */
export function length(q: Quaternion): number {
  return Math.sqrt(lengthSquared(q))
}

/**
 * Tolerance for the zero-quaternion check in {@link normalize}. The previous
 * implementation reused the generic geometric `EPSILON` (1e-9) on the squared
 * length, which rejected legitimately small (but valid) quaternions whose
 * components are ~1e-5. Comparing the un-squared length against 1e-12 gives
 * a much tighter, well-defined threshold (H1 audit-fix).
 */
export const QUATERNION_ZERO_EPSILON = 1e-12

/**
 * Return a unit-length copy of `q`. If `q` is the zero quaternion (length
 * below {@link QUATERNION_ZERO_EPSILON}), return identity as a safe fallback —
 * matches the three.js / glTF convention and prevents NaN propagation.
 */
export function normalize(q: Quaternion): Quaternion {
  const len = length(q)
  if (len < QUATERNION_ZERO_EPSILON) return identityQuaternion()
  const invLen = 1 / len
  return {
    x: q.x * invLen,
    y: q.y * invLen,
    z: q.z * invLen,
    w: q.w * invLen,
  }
}

/**
 * Hamilton-product of two quaternions: `result = a · b`.
 *
 * Application convention matches three.js: rotating a vector by
 * `(a · b)` is equivalent to first rotating by `b`, then by `a`.
 */
export function multiply(a: Quaternion, b: Quaternion): Quaternion {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

/**
 * Conjugate of a unit-quaternion (== inverse rotation).
 *
 * For non-unit quaternions this is NOT the multiplicative inverse —
 * normalise first if needed.
 */
export function conjugate(q: Quaternion): Quaternion {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w }
}

/**
 * Dot product. Used by `slerp` to pick the shortest rotation path.
 */
export function dot(a: Quaternion, b: Quaternion): number {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
}

/**
 * Spherical-linear interpolation between two quaternions.
 *
 * Always picks the SHORTEST rotation path by flipping the sign of `b` when
 * `dot(a, b) < 0` — this is the critical fix that the naïve formula misses
 * and that gives slerp its "natural" feel.
 *
 * Falls back to linear interpolation (with renormalisation) when the two
 * quaternions are nearly parallel (cos > 1 - 1e-6), to avoid division by a
 * near-zero `sin(theta)`.
 *
 * @param a    Start quaternion (assumed normalised)
 * @param b    End quaternion (assumed normalised)
 * @param t    Interpolation parameter in [0, 1]
 */
export function slerp(a: Quaternion, b: Quaternion, t: number): Quaternion {
  let bx = b.x, by = b.y, bz = b.z, bw = b.w

  // Pick the shortest arc by flipping `b` if necessary.
  let cosTheta = dot(a, b)
  if (cosTheta < 0) {
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
    cosTheta = -cosTheta
  }

  // Linear-interpolation fallback for nearly-parallel quaternions.
  if (cosTheta > 1 - 1e-6) {
    return normalize({
      x: a.x + (bx - a.x) * t,
      y: a.y + (by - a.y) * t,
      z: a.z + (bz - a.z) * t,
      w: a.w + (bw - a.w) * t,
    })
  }

  const theta = Math.acos(cosTheta)
  const sinTheta = Math.sin(theta)
  const w1 = Math.sin((1 - t) * theta) / sinTheta
  const w2 = Math.sin(t * theta) / sinTheta

  return {
    x: a.x * w1 + bx * w2,
    y: a.y * w1 + by * w2,
    z: a.z * w1 + bz * w2,
    w: a.w * w1 + bw * w2,
  }
}

/**
 * Build a quaternion from an axis (assumed unit-length) and an angle in
 * radians, using the standard half-angle formula.
 */
export function fromAxisAngle(axis: Vector3, angleRad: number): Quaternion {
  const half = angleRad / 2
  const s = Math.sin(half)
  return {
    x: axis.x * s,
    y: axis.y * s,
    z: axis.z * s,
    w: Math.cos(half),
  }
}

/**
 * Build a quaternion from Tait-Bryan Euler angles (intrinsic, XYZ order:
 * rotate around X first, then around the new Y, then around the new Z).
 *
 * Angles are in RADIANS. UI surfaces that prompt the user in degrees should
 * convert at the boundary (Phase 2 edit-system).
 *
 * Intrinsic XYZ matches three.js's default `Euler` order. If you have data
 * from another tool with a different order, the safest path is to round-trip
 * through a matrix.
 */
export function fromEuler(xRad: number, yRad: number, zRad: number): Quaternion {
  const cx = Math.cos(xRad / 2)
  const cy = Math.cos(yRad / 2)
  const cz = Math.cos(zRad / 2)
  const sx = Math.sin(xRad / 2)
  const sy = Math.sin(yRad / 2)
  const sz = Math.sin(zRad / 2)

  // Intrinsic XYZ: q = qX * qY * qZ (apply Z first, then Y, then X)
  return {
    x: sx * cy * cz + cx * sy * sz,
    y: cx * sy * cz - sx * cy * sz,
    z: cx * cy * sz + sx * sy * cz,
    w: cx * cy * cz - sx * sy * sz,
  }
}

/**
 * Convert a unit-quaternion into Tait-Bryan Euler angles (intrinsic XYZ order,
 * radians). Inverse of `fromEuler()`.
 *
 * Derivation: the rotation matrix for intrinsic XYZ is `R = R_X · R_Y · R_Z`,
 * which means `R[0][2] = sin(pitch)`, `R[1][2] = -sin(roll)·cos(pitch)`,
 * `R[2][2] = cos(roll)·cos(pitch)`, etc. Expressed in terms of the
 * quaternion components (x, y, z, w):
 *
 *   sin(pitch)   = 2·(x·z + w·y)
 *   -sin(roll)·cos(pitch) = 2·(y·z - w·x)
 *    cos(roll)·cos(pitch) = 1 - 2·(x² + y²)
 *   -sin(yaw)·cos(pitch)  = 2·(x·y - w·z)
 *    cos(yaw)·cos(pitch)  = 1 - 2·(y² + z²)
 *
 * Gimbal-lock handling: when `cos(pitch) ≈ 0`, X and Z collapse into a
 * single degree of freedom. We pin X = 0 and place the remaining rotation
 * into Z (matches three.js's convention). UI consumers should be aware
 * that round-tripping a singular pose through Euler is lossy; the canonical
 * scene-graph stores quaternions precisely to avoid this.
 */
export function toEuler(q: Quaternion): { x: number; y: number; z: number } {
  const { x, y, z, w } = q

  // sin(pitch) = R[0][2]  → pitch ∈ [-π/2, π/2]
  const sinPitch = 2 * (x * z + w * y)
  const clampedSinPitch = Math.max(-1, Math.min(1, sinPitch))
  const pitch = Math.asin(clampedSinPitch)

  // Gimbal-lock: |sin(pitch)| ≈ 1 ⇒ cos(pitch) ≈ 0.
  if (Math.abs(clampedSinPitch) >= 1 - 1e-6) {
    // At pitch = ±π/2 the X and Z rotations are indistinguishable. Pin X = 0
    // and absorb the residual into Z. R[1][0] = sin(α ± γ), R[1][1] = cos(α ± γ);
    // with α = 0 this collapses to atan2(R[1][0], R[1][1]).
    return {
      x: 0,
      y: pitch,
      z: Math.atan2(2 * (x * y + w * z), 1 - 2 * (x * x + z * z)),
    }
  }

  return {
    // roll  = atan2(-R[1][2], R[2][2]) = atan2(2(wx - yz), 1 - 2(x² + y²))
    x: Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + y * y)),
    y: pitch,
    // yaw   = atan2(-R[0][1], R[0][0]) = atan2(2(wz - xy), 1 - 2(y² + z²))
    z: Math.atan2(2 * (w * z - x * y), 1 - 2 * (y * y + z * z)),
  }
}

/**
 * Rotate a 3D vector by a (assumed unit) quaternion. Implemented via the
 * sandwich form `q · v · q*`, but optimised so we never explicitly construct
 * an intermediate pure-imaginary quaternion — saves ~30 % over the naïve
 * formula and matches three.js's `Vector3.applyQuaternion`.
 */
export function rotateVector(q: Quaternion, v: Vector3): Vector3 {
  const { x: qx, y: qy, z: qz, w: qw } = q
  const { x: vx, y: vy, z: vz } = v

  // t = 2 * (q.xyz × v)
  const tx = 2 * (qy * vz - qz * vy)
  const ty = 2 * (qz * vx - qx * vz)
  const tz = 2 * (qx * vy - qy * vx)

  // v' = v + qw * t + (q.xyz × t)
  return {
    x: vx + qw * tx + (qy * tz - qz * ty),
    y: vy + qw * ty + (qz * tx - qx * tz),
    z: vz + qw * tz + (qx * ty - qy * tx),
  }
}

/**
 * Approximate quaternion equality within a tolerance. Treats `q` and `-q`
 * as equal (they represent the same rotation).
 */
export function quaternionApproxEquals(
  a: Quaternion,
  b: Quaternion,
  tolerance = 1e-6,
): boolean {
  const sameSign =
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.z - b.z) <= tolerance &&
    Math.abs(a.w - b.w) <= tolerance
  if (sameSign) return true
  // q and -q represent the same rotation; check that too.
  return (
    Math.abs(a.x + b.x) <= tolerance &&
    Math.abs(a.y + b.y) <= tolerance &&
    Math.abs(a.z + b.z) <= tolerance &&
    Math.abs(a.w + b.w) <= tolerance
  )
}

/**
 * Re-export the canonical identity constant for ergonomic imports.
 */
export { IDENTITY_QUATERNION }
