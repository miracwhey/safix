/**
 * Spatial · Canonical · Primitives
 *
 * Core math primitives used throughout the L1 pure-logic foundation:
 * 3D vectors, quaternions, transforms (TRS), and column-major matrices.
 *
 * Conventions (binding · Master-Spec §2):
 *   - Coordinate-System: Right-Handed Y-Up (compatible with RoomPlan + three.js + glTF).
 *   - Unit: METERS everywhere (no implicit conversions).
 *   - Quaternion-First-Storage: rotations are stored as quaternions (Master-Spec
 *     §19 Decision #1). Euler is for UI display only and is derived on demand.
 *   - Matrix4 is COLUMN-MAJOR with 16 elements (matches three.js, glTF, and
 *     RoomPlan simd_float4x4).
 *
 * Composite transform M = T(position) · R(rotation) · S(scale).
 */

/**
 * 3D vector in meters (Right-Handed Y-Up).
 *
 * Direct property access on `x`, `y`, `z` is the public API; do not introduce
 * branded variants here — that would force coercion at every call site without
 * a real safety win at room-scale entity counts.
 */
export interface Vector3 {
  x: number
  y: number
  z: number
}

/**
 * Unit quaternion (Hamilton convention: i² = j² = k² = ijk = -1).
 *
 * Components are stored as `{ x, y, z, w }` where `w` is the scalar part.
 * Quaternions are assumed to be normalized; helpers in `algebra/quaternion.ts`
 * enforce / restore normalization where it matters.
 *
 * Identity quaternion: `{ x: 0, y: 0, z: 0, w: 1 }`.
 */
export interface Quaternion {
  x: number
  y: number
  z: number
  w: number
}

/**
 * TRS (translation-rotation-scale) decomposition of a 3D transform.
 *
 * Stored as the canonical form because it survives serialization to JSON
 * unambiguously, avoids gimbal-lock, and re-composes to a Matrix4 on demand
 * via `algebra/transform.ts#composeTransform`.
 *
 * Per Master-Spec §2.3: `position` is ALWAYS parent-relative. The world-space
 * transform is computed by traversing the scene-graph ancestry chain.
 */
export interface Transform {
  position: Vector3
  rotation: Quaternion
  scale: Vector3
}

/**
 * 4x4 column-major matrix as a length-16 tuple.
 *
 * Layout (column-major, matches three.js / glTF / RoomPlan):
 *
 *   [m00, m10, m20, m30,    ← column 0 (right axis)
 *    m01, m11, m21, m31,    ← column 1 (up axis)
 *    m02, m12, m22, m32,    ← column 2 (forward axis)
 *    m03, m13, m23, m33]    ← column 3 (translation + w)
 *
 * Read this way: `M[col * 4 + row]`. The 16-tuple type is preferred over
 * `Float64Array` to keep the storage format JSON-serialisable and to let
 * TypeScript track the length at the type level.
 */
export type Matrix4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
]

/**
 * Mutable counterpart of {@link Matrix4} — used internally by algebra
 * routines that build up a matrix incrementally before returning it as a
 * readonly tuple.
 */
export type Matrix4Mutable = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
]

/**
 * Identity transform constants. Frozen to prevent accidental mutation; consume
 * them as defaults when constructing nodes that have not yet been positioned.
 */
export const IDENTITY_VECTOR3: Vector3 = Object.freeze({ x: 0, y: 0, z: 0 })
export const ONE_VECTOR3: Vector3 = Object.freeze({ x: 1, y: 1, z: 1 })
export const IDENTITY_QUATERNION: Quaternion = Object.freeze({ x: 0, y: 0, z: 0, w: 1 })
export const IDENTITY_TRANSFORM: Transform = Object.freeze({
  position: IDENTITY_VECTOR3,
  rotation: IDENTITY_QUATERNION,
  scale: ONE_VECTOR3,
})

/**
 * Identity matrix as a readonly Matrix4 tuple (column-major).
 */
export const IDENTITY_MATRIX4: Matrix4 = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
] as const)

/**
 * Numerical epsilon used by algebra and geometry routines to decide when two
 * floating-point quantities should be treated as equal. Chosen to be tighter
 * than typical RoomPlan capture noise (~5 mm = 0.005) yet generous enough to
 * tolerate float64 round-off across long composition chains.
 */
export const EPSILON = 1e-9

/**
 * Coordinate-system tag. The only value supported in V1 is the right-handed
 * Y-up convention used by RoomPlan, three.js, and glTF; keeping this as a
 * string-union (instead of a hard-coded constant) leaves the door open for
 * V2 left-handed engines without a breaking change to the type surface.
 */
export type CoordinateSystem = 'right-handed-y-up'

/**
 * Unit tag. V1 is meters everywhere; the type-union exists so we can extend
 * to imperial conversion at the boundary later without churning the core.
 */
export type Unit = 'meters'
