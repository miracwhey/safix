/**
 * Tests for src/lib/spatial/canonical/algebra/matrix.ts
 *
 * Acceptance: identity round-trips, decompose detects negative scale, multiply
 * is associative + non-commutative, inverse round-trips, vector application
 * matches the column-major convention used by three.js / glTF / RoomPlan.
 */
import { describe, it, expect } from 'vitest'

import {
  composeMatrix,
  decomposeMatrix,
  identityMatrix,
  inverseMatrix,
  matrixApproxEquals,
  multiplyMatrix,
  multiplyVector,
} from '../../../../../src/lib/spatial/canonical/algebra/matrix.ts'
import {
  fromAxisAngle,
  multiply as multiplyQuat,
  normalize as normalizeQuat,
} from '../../../../../src/lib/spatial/canonical/algebra/quaternion.ts'
import {
  IDENTITY_MATRIX4,
  IDENTITY_QUATERNION,
  IDENTITY_VECTOR3,
  ONE_VECTOR3,
  type Matrix4,
  type Quaternion,
  type Vector3,
} from '../../../../../src/lib/spatial/canonical/types/primitives.ts'

const TOL = 1e-10

function approxVectorEqual(a: Vector3, b: Vector3, tol = 1e-9) {
  expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(tol)
  expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(tol)
  expect(Math.abs(a.z - b.z)).toBeLessThanOrEqual(tol)
}

function approxQuatEqual(a: Quaternion, b: Quaternion, tol = 1e-6) {
  const sameSign =
    Math.abs(a.x - b.x) <= tol &&
    Math.abs(a.y - b.y) <= tol &&
    Math.abs(a.z - b.z) <= tol &&
    Math.abs(a.w - b.w) <= tol
  const oppositeSign =
    Math.abs(a.x + b.x) <= tol &&
    Math.abs(a.y + b.y) <= tol &&
    Math.abs(a.z + b.z) <= tol &&
    Math.abs(a.w + b.w) <= tol
  expect(sameSign || oppositeSign).toBe(true)
}

describe('algebra/matrix · identity', () => {
  it('identityMatrix() == IDENTITY_MATRIX4', () => {
    expect(matrixApproxEquals(identityMatrix(), IDENTITY_MATRIX4, TOL)).toBe(true)
  })

  it('composing identity TRS produces the identity matrix', () => {
    const m = composeMatrix(IDENTITY_VECTOR3, IDENTITY_QUATERNION, ONE_VECTOR3)
    expect(matrixApproxEquals(m, IDENTITY_MATRIX4, TOL)).toBe(true)
  })

  it('multiplying by identity is a no-op (left and right)', () => {
    const t = composeMatrix({ x: 1, y: 2, z: 3 }, IDENTITY_QUATERNION, ONE_VECTOR3)
    expect(matrixApproxEquals(multiplyMatrix(t, IDENTITY_MATRIX4), t, TOL)).toBe(true)
    expect(matrixApproxEquals(multiplyMatrix(IDENTITY_MATRIX4, t), t, TOL)).toBe(true)
  })
})

describe('algebra/matrix · compose / decompose round-trip', () => {
  it('round-trips a pure translation', () => {
    const t: Vector3 = { x: 1.5, y: -2.25, z: 7.125 }
    const m = composeMatrix(t, IDENTITY_QUATERNION, ONE_VECTOR3)
    const r = decomposeMatrix(m)
    approxVectorEqual(r.position, t)
    approxQuatEqual(r.rotation, IDENTITY_QUATERNION)
    approxVectorEqual(r.scale, ONE_VECTOR3)
  })

  it('round-trips a pure rotation (Y axis · π/4)', () => {
    const rot = normalizeQuat(fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 4))
    const m = composeMatrix(IDENTITY_VECTOR3, rot, ONE_VECTOR3)
    const r = decomposeMatrix(m)
    approxVectorEqual(r.position, IDENTITY_VECTOR3)
    approxQuatEqual(r.rotation, rot)
    approxVectorEqual(r.scale, ONE_VECTOR3)
  })

  it('round-trips a pure non-uniform scale', () => {
    const s: Vector3 = { x: 2, y: 0.5, z: 3 }
    const m = composeMatrix(IDENTITY_VECTOR3, IDENTITY_QUATERNION, s)
    const r = decomposeMatrix(m)
    approxVectorEqual(r.position, IDENTITY_VECTOR3)
    approxQuatEqual(r.rotation, IDENTITY_QUATERNION)
    approxVectorEqual(r.scale, s)
  })

  it('round-trips combined T+R+S', () => {
    const t: Vector3 = { x: 4, y: -1, z: 2 }
    const rot = normalizeQuat(fromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 3))
    const s: Vector3 = { x: 1.5, y: 1.5, z: 1.5 }
    const m = composeMatrix(t, rot, s)
    const r = decomposeMatrix(m)
    approxVectorEqual(r.position, t, 1e-8)
    approxQuatEqual(r.rotation, rot)
    approxVectorEqual(r.scale, s, 1e-8)
  })

  it('detects mirrored / negative-scale matrices', () => {
    const negScale: Vector3 = { x: -2, y: 1, z: 1 }
    const m = composeMatrix(IDENTITY_VECTOR3, IDENTITY_QUATERNION, negScale)
    const r = decomposeMatrix(m)
    // Either sx is negative (preferred) or the rotation is mirrored.
    expect(r.scale.x).toBeLessThan(0)
  })
})

describe('algebra/matrix · multiply', () => {
  it('matrix multiply is non-commutative for rotation × translation', () => {
    const rot = normalizeQuat(fromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 2))
    const rMat = composeMatrix(IDENTITY_VECTOR3, rot, ONE_VECTOR3)
    const tMat = composeMatrix({ x: 1, y: 0, z: 0 }, IDENTITY_QUATERNION, ONE_VECTOR3)

    const rThenT = multiplyMatrix(tMat, rMat)
    const tThenR = multiplyMatrix(rMat, tMat)

    expect(matrixApproxEquals(rThenT, tThenR, 1e-8)).toBe(false)
  })

  it('matrix multiply is associative: (a · b) · c == a · (b · c)', () => {
    const a = composeMatrix(
      { x: 1, y: 2, z: 3 },
      normalizeQuat(fromAxisAngle({ x: 0, y: 1, z: 0 }, 0.3)),
      ONE_VECTOR3,
    )
    const b = composeMatrix(
      { x: -1, y: 0.5, z: -2 },
      normalizeQuat(fromAxisAngle({ x: 1, y: 0, z: 0 }, 0.7)),
      ONE_VECTOR3,
    )
    const c = composeMatrix(
      { x: 0, y: 0, z: 5 },
      normalizeQuat(fromAxisAngle({ x: 0, y: 0, z: 1 }, 1.1)),
      ONE_VECTOR3,
    )

    const left = multiplyMatrix(multiplyMatrix(a, b), c)
    const right = multiplyMatrix(a, multiplyMatrix(b, c))
    expect(matrixApproxEquals(left, right, 1e-8)).toBe(true)
  })

  it('matrix · vector applies the column-major TRS convention', () => {
    // A point at the origin transformed by T(2, 3, 4) should land at (2, 3, 4).
    const tMat = composeMatrix({ x: 2, y: 3, z: 4 }, IDENTITY_QUATERNION, ONE_VECTOR3)
    const result = multiplyVector(tMat, IDENTITY_VECTOR3)
    approxVectorEqual(result, { x: 2, y: 3, z: 4 })
  })

  it('matrix · vector applies a 90° Y rotation correctly', () => {
    const rot = normalizeQuat(fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2))
    const rMat = composeMatrix(IDENTITY_VECTOR3, rot, ONE_VECTOR3)
    // X axis rotated 90° around Y becomes -Z.
    const result = multiplyVector(rMat, { x: 1, y: 0, z: 0 })
    approxVectorEqual(result, { x: 0, y: 0, z: -1 }, 1e-9)
  })
})

describe('algebra/matrix · inverse', () => {
  it('inverse(identity) == identity', () => {
    const inv = inverseMatrix(IDENTITY_MATRIX4)
    expect(inv).not.toBeNull()
    expect(matrixApproxEquals(inv as Matrix4, IDENTITY_MATRIX4, TOL)).toBe(true)
  })

  it('inverse round-trips a translation', () => {
    const m = composeMatrix({ x: 5, y: -3, z: 2 }, IDENTITY_QUATERNION, ONE_VECTOR3)
    const inv = inverseMatrix(m)
    expect(inv).not.toBeNull()
    const product = multiplyMatrix(m, inv as Matrix4)
    expect(matrixApproxEquals(product, IDENTITY_MATRIX4, 1e-9)).toBe(true)
  })

  it('inverse round-trips a TRS matrix', () => {
    const rot = normalizeQuat(fromAxisAngle({ x: 0.5, y: 0.5, z: 0.5 }, Math.PI / 3))
    const m = composeMatrix({ x: 2, y: 4, z: -1 }, rot, { x: 1.5, y: 1.5, z: 1.5 })
    const inv = inverseMatrix(m)
    expect(inv).not.toBeNull()
    const product = multiplyMatrix(m, inv as Matrix4)
    expect(matrixApproxEquals(product, IDENTITY_MATRIX4, 1e-7)).toBe(true)
  })

  it('returns null for a singular matrix', () => {
    // Zero scale collapses one column -> determinant is 0.
    const m = composeMatrix(IDENTITY_VECTOR3, IDENTITY_QUATERNION, { x: 0, y: 1, z: 1 })
    expect(inverseMatrix(m)).toBeNull()
  })

  it('combined rotation chain inverse equals reverse-multiplied component inverses', () => {
    // (A · B)^-1 = B^-1 · A^-1
    const a = composeMatrix(
      { x: 1, y: 0, z: 0 },
      normalizeQuat(fromAxisAngle({ x: 0, y: 1, z: 0 }, 0.4)),
      ONE_VECTOR3,
    )
    const b = composeMatrix(
      { x: 0, y: 1, z: 0 },
      normalizeQuat(fromAxisAngle({ x: 1, y: 0, z: 0 }, 0.8)),
      ONE_VECTOR3,
    )
    const ab = multiplyMatrix(a, b)
    const invAB = inverseMatrix(ab)
    const invA = inverseMatrix(a)
    const invB = inverseMatrix(b)
    expect(invAB).not.toBeNull()
    expect(invA).not.toBeNull()
    expect(invB).not.toBeNull()
    const reverseProduct = multiplyMatrix(invB as Matrix4, invA as Matrix4)
    expect(matrixApproxEquals(invAB as Matrix4, reverseProduct, 1e-7)).toBe(true)
  })
})

describe('algebra/matrix · convention check (3-deep parent chain)', () => {
  it('composed parent-child-grandchild matches the manual multiplication chain', () => {
    // Build three transforms; the composition should match the world-transform-compute
    // pattern that algebra/transform.ts implements.
    const root = composeMatrix({ x: 1, y: 0, z: 0 }, IDENTITY_QUATERNION, ONE_VECTOR3)
    const child = composeMatrix(
      { x: 0, y: 2, z: 0 },
      normalizeQuat(fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2)),
      ONE_VECTOR3,
    )
    const grandchild = composeMatrix({ x: 0, y: 0, z: 3 }, IDENTITY_QUATERNION, ONE_VECTOR3)

    const worldChild = multiplyMatrix(root, child)
    const worldGrandchild = multiplyMatrix(worldChild, grandchild)

    // The grandchild's origin in world-space:
    //   root      : translate +1 along world X
    //   child     : translate +2 along (rotated) Y; rotate 90° around +Y
    //               (right-hand rule: +Z → +X, +X → -Z)
    //   grandchild: translate +3 along local Z
    //
    // Apply right-to-left: grandchild origin (0,0,0) → +3 local Z
    //   → child rotates +Z to world +X (+3, 0, 0)
    //   → child translates +2 Y          (+3, 2, 0)
    //   → root translates +1 X           (+4, 2, 0)
    const origin = multiplyVector(worldGrandchild, IDENTITY_VECTOR3)
    expect(origin.x).toBeCloseTo(4, 6)
    expect(origin.y).toBeCloseTo(2, 6)
    expect(origin.z).toBeCloseTo(0, 6)
  })

  it('local-quaternion rotation matches matrix-only rotation for a single point', () => {
    // Sanity check that algebra/quaternion.rotateVector and algebra/matrix.multiplyVector
    // produce identical results for a non-trivial rotation.
    const q = normalizeQuat(fromAxisAngle({ x: 1, y: 1, z: 0 }, Math.PI / 5))
    const m = composeMatrix(IDENTITY_VECTOR3, q, ONE_VECTOR3)
    const p: Vector3 = { x: 1, y: 0.5, z: -0.25 }

    const viaMatrix = multiplyVector(m, p)
    // qpq*
    const qpq = (() => {
      const half = multiplyQuat(q, { x: p.x, y: p.y, z: p.z, w: 0 })
      const full = multiplyQuat(half, { x: -q.x, y: -q.y, z: -q.z, w: q.w })
      return { x: full.x, y: full.y, z: full.z }
    })()
    approxVectorEqual(viaMatrix, qpq, 1e-9)
  })
})
