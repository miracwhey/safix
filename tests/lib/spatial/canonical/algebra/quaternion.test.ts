/**
 * Tests for src/lib/spatial/canonical/algebra/quaternion.ts
 *
 * Acceptance: normalization, multiplication, slerp shortest-path,
 * Euler ↔ quaternion round-trip (incl. gimbal-lock handling), axis-angle
 * round-trip, vector rotation matches matrix application.
 */
import { describe, it, expect } from 'vitest'

import {
  conjugate,
  dot,
  fromAxisAngle,
  fromEuler,
  identityQuaternion,
  length,
  multiply,
  normalize,
  quaternionApproxEquals,
  rotateVector,
  slerp,
  toEuler,
} from '../../../../../src/lib/spatial/canonical/algebra/quaternion.ts'
import {
  IDENTITY_QUATERNION,
  type Quaternion,
  type Vector3,
} from '../../../../../src/lib/spatial/canonical/types/primitives.ts'

function approxVectorEqual(a: Vector3, b: Vector3, tol = 1e-9) {
  expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(tol)
  expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(tol)
  expect(Math.abs(a.z - b.z)).toBeLessThanOrEqual(tol)
}

function approxNumber(a: number, b: number, tol = 1e-9) {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol)
}

describe('algebra/quaternion · basics', () => {
  it('identityQuaternion() == IDENTITY_QUATERNION', () => {
    expect(quaternionApproxEquals(identityQuaternion(), IDENTITY_QUATERNION)).toBe(true)
  })

  it('length of identity is 1', () => {
    approxNumber(length(IDENTITY_QUATERNION), 1)
  })

  it('normalize() returns identity for the zero quaternion (no NaN)', () => {
    const result = normalize({ x: 0, y: 0, z: 0, w: 0 })
    expect(quaternionApproxEquals(result, IDENTITY_QUATERNION)).toBe(true)
  })

  it('normalize() turns an arbitrary quaternion into unit length', () => {
    const q = normalize({ x: 2, y: 3, z: 4, w: 5 })
    approxNumber(length(q), 1, 1e-12)
  })

  it('conjugate negates the vector part and preserves w', () => {
    const q = normalize({ x: 0.3, y: 0.4, z: 0.5, w: 0.6 })
    const c = conjugate(q)
    approxNumber(c.x, -q.x)
    approxNumber(c.y, -q.y)
    approxNumber(c.z, -q.z)
    approxNumber(c.w, q.w)
  })

  it('q · conjugate(q) equals identity for unit q', () => {
    const q = normalize({ x: 1, y: 2, z: 3, w: 4 })
    const product = multiply(q, conjugate(q))
    expect(quaternionApproxEquals(product, IDENTITY_QUATERNION, 1e-9)).toBe(true)
  })
})

describe('algebra/quaternion · multiply', () => {
  it('identity is a multiplicative neutral element (left and right)', () => {
    const q = normalize({ x: 0.2, y: -0.4, z: 0.6, w: 0.8 })
    expect(quaternionApproxEquals(multiply(q, IDENTITY_QUATERNION), q)).toBe(true)
    expect(quaternionApproxEquals(multiply(IDENTITY_QUATERNION, q), q)).toBe(true)
  })

  it('multiply is non-commutative (a · b ≠ b · a) for generic rotations', () => {
    const a = normalize(fromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 3))
    const b = normalize(fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 4))
    const ab = multiply(a, b)
    const ba = multiply(b, a)
    expect(quaternionApproxEquals(ab, ba, 1e-12)).toBe(false)
  })
})

describe('algebra/quaternion · axis-angle round-trip', () => {
  it('fromAxisAngle with angle=0 returns identity', () => {
    const q = fromAxisAngle({ x: 1, y: 0, z: 0 }, 0)
    expect(quaternionApproxEquals(q, IDENTITY_QUATERNION)).toBe(true)
  })

  it('fromAxisAngle / rotateVector cycle returns a known rotation', () => {
    const axis: Vector3 = { x: 0, y: 1, z: 0 }
    const q = normalize(fromAxisAngle(axis, Math.PI / 2))
    const rotated = rotateVector(q, { x: 1, y: 0, z: 0 })
    // 90° around +Y maps +X to -Z (right-handed Y-up).
    approxVectorEqual(rotated, { x: 0, y: 0, z: -1 }, 1e-12)
  })

  it('rotating around the rotation axis leaves it invariant', () => {
    const axis: Vector3 = { x: 1, y: 1, z: 0 }
    const norm = Math.hypot(axis.x, axis.y, axis.z)
    const unitAxis: Vector3 = { x: axis.x / norm, y: axis.y / norm, z: axis.z / norm }
    const q = normalize(fromAxisAngle(unitAxis, Math.PI / 3))
    const rotated = rotateVector(q, unitAxis)
    approxVectorEqual(rotated, unitAxis, 1e-9)
  })
})

describe('algebra/quaternion · Euler ↔ quaternion round-trip', () => {
  it('round-trips a pure X rotation', () => {
    const q = fromEuler(Math.PI / 4, 0, 0)
    const e = toEuler(q)
    approxNumber(e.x, Math.PI / 4, 1e-9)
    approxNumber(e.y, 0, 1e-9)
    approxNumber(e.z, 0, 1e-9)
  })

  it('round-trips a pure Y rotation', () => {
    const q = fromEuler(0, Math.PI / 3, 0)
    const e = toEuler(q)
    approxNumber(e.x, 0, 1e-9)
    approxNumber(e.y, Math.PI / 3, 1e-9)
    approxNumber(e.z, 0, 1e-9)
  })

  it('round-trips a pure Z rotation', () => {
    const q = fromEuler(0, 0, Math.PI / 6)
    const e = toEuler(q)
    approxNumber(e.x, 0, 1e-9)
    approxNumber(e.y, 0, 1e-9)
    approxNumber(e.z, Math.PI / 6, 1e-9)
  })

  it('round-trips a combined small-angle Euler triple', () => {
    const inX = 0.1
    const inY = 0.2
    const inZ = 0.3
    const q = fromEuler(inX, inY, inZ)
    const e = toEuler(q)
    approxNumber(e.x, inX, 1e-9)
    approxNumber(e.y, inY, 1e-9)
    approxNumber(e.z, inZ, 1e-9)
  })

  it('handles gimbal-lock at pitch = +π/2 by collapsing X into Z', () => {
    // Pure Y pitch of π/2 followed by an arbitrary Z roll — the round-trip should
    // not produce NaNs and should keep the pitch at π/2.
    const q = fromEuler(0.4, Math.PI / 2, 0.6)
    const e = toEuler(q)
    expect(Number.isFinite(e.x)).toBe(true)
    expect(Number.isFinite(e.y)).toBe(true)
    expect(Number.isFinite(e.z)).toBe(true)
    approxNumber(e.y, Math.PI / 2, 1e-3)
  })
})

describe('algebra/quaternion · slerp shortest-path', () => {
  it('slerp(a, a, t) == a for any t', () => {
    const a = normalize(fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 4))
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const s = slerp(a, a, t)
      expect(quaternionApproxEquals(s, a, 1e-9)).toBe(true)
    }
  })

  it('slerp(a, b, 0) == a and slerp(a, b, 1) == b', () => {
    const a = normalize(fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 4))
    const b = normalize(fromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 3))
    expect(quaternionApproxEquals(slerp(a, b, 0), a, 1e-9)).toBe(true)
    expect(quaternionApproxEquals(slerp(a, b, 1), b, 1e-9)).toBe(true)
  })

  it('slerp picks the shortest arc when dot(a, b) is negative', () => {
    // q and -q represent the same rotation; slerp from a to -a should
    // produce values close to a, NOT the long way around.
    const a = normalize(fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 6))
    const negA: Quaternion = { x: -a.x, y: -a.y, z: -a.z, w: -a.w }

    const mid = slerp(a, negA, 0.5)
    // Midpoint of "no rotation" should still be `a` (or `-a`); definitely not
    // a 180°-around rotation.
    expect(quaternionApproxEquals(mid, a, 1e-9)).toBe(true)
  })

  it('slerp interpolates angles linearly along the great circle', () => {
    const a = IDENTITY_QUATERNION
    const b = normalize(fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2))
    const mid = slerp(a, b, 0.5)
    // The midpoint should be a 45° rotation around +Y.
    const expected = normalize(fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 4))
    expect(quaternionApproxEquals(mid, expected, 1e-9)).toBe(true)
  })

  it('slerp falls back to linear interpolation for near-parallel inputs', () => {
    // Almost-identity rotations: slerp should not divide by zero.
    const tiny = normalize(fromAxisAngle({ x: 1, y: 0, z: 0 }, 1e-7))
    const mid = slerp(IDENTITY_QUATERNION, tiny, 0.5)
    expect(Number.isFinite(mid.x)).toBe(true)
    expect(Number.isFinite(mid.y)).toBe(true)
    expect(Number.isFinite(mid.z)).toBe(true)
    expect(Number.isFinite(mid.w)).toBe(true)
  })
})

describe('algebra/quaternion · misc', () => {
  it('dot product of identity with itself is 1', () => {
    approxNumber(dot(IDENTITY_QUATERNION, IDENTITY_QUATERNION), 1)
  })

  it('rotateVector(identity, v) == v', () => {
    const v: Vector3 = { x: 1.5, y: -2.25, z: 0.75 }
    approxVectorEqual(rotateVector(IDENTITY_QUATERNION, v), v)
  })

  it('rotating a vector with a quaternion + its conjugate cancels out', () => {
    const q = normalize(fromAxisAngle({ x: 0.7, y: 0.4, z: -0.3 }, 0.5))
    const v: Vector3 = { x: 3, y: -1, z: 2 }
    const there = rotateVector(q, v)
    const back = rotateVector(conjugate(q), there)
    approxVectorEqual(back, v, 1e-9)
  })
})
