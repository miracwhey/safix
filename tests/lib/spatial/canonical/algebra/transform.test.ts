/**
 * Tests for src/lib/spatial/canonical/algebra/transform.ts
 *
 * Acceptance: TRS round-trip, parent-relative resolve, 3-deep ancestry walk,
 * cache hit / invalidation behaviour, broken-ancestry "render-graceful"
 * fallback.
 */
import { describe, it, expect } from 'vitest'

import {
  composeMatrix,
  matrixApproxEquals,
  multiplyMatrix,
  multiplyVector,
} from '../../../../../src/lib/spatial/canonical/algebra/matrix.ts'
import {
  fromAxisAngle,
  normalize as normalizeQuat,
} from '../../../../../src/lib/spatial/canonical/algebra/quaternion.ts'
import {
  composeTransform,
  decomposeTransform,
  invalidateWorldTransformCache,
  parentRelativeResolve,
  worldTransformCompute,
  type NodeLookup,
  type TransformNode,
  type WorldTransformCache,
} from '../../../../../src/lib/spatial/canonical/algebra/transform.ts'
import {
  IDENTITY_QUATERNION,
  IDENTITY_TRANSFORM,
  IDENTITY_VECTOR3,
  ONE_VECTOR3,
  type Matrix4,
  type Transform,
  type Vector3,
} from '../../../../../src/lib/spatial/canonical/types/primitives.ts'

function approxVectorEqual(a: Vector3, b: Vector3, tol = 1e-9) {
  expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(tol)
  expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(tol)
  expect(Math.abs(a.z - b.z)).toBeLessThanOrEqual(tol)
}

function buildLookup(nodes: TransformNode[]): NodeLookup {
  const byId = new Map(nodes.map(n => [n.id, n]))
  return id => byId.get(id) ?? null
}

function buildChildrenLookup(nodes: TransformNode[]) {
  const childrenByParent = new Map<string, string[]>()
  for (const n of nodes) {
    if (n.parent_id === null) continue
    const list = childrenByParent.get(n.parent_id) ?? []
    list.push(n.id)
    childrenByParent.set(n.parent_id, list)
  }
  return (id: string): readonly string[] => childrenByParent.get(id) ?? []
}

describe('algebra/transform · compose / decompose', () => {
  it('composeTransform produces the same matrix as composeMatrix(t, r, s)', () => {
    const t: Transform = {
      position: { x: 1, y: 2, z: 3 },
      rotation: normalizeQuat(fromAxisAngle({ x: 0, y: 1, z: 0 }, 0.3)),
      scale: { x: 1.5, y: 1.5, z: 1.5 },
    }
    const viaTransform = composeTransform(t)
    const viaMatrix = composeMatrix(t.position, t.rotation, t.scale)
    expect(matrixApproxEquals(viaTransform, viaMatrix)).toBe(true)
  })

  it('decomposeTransform inverse round-trips composeTransform', () => {
    const original: Transform = {
      position: { x: -0.5, y: 1.25, z: 4 },
      rotation: normalizeQuat(fromAxisAngle({ x: 0.6, y: 0.8, z: 0 }, Math.PI / 5)),
      scale: { x: 2, y: 0.5, z: 1 },
    }
    const m = composeTransform(original)
    const round = decomposeTransform(m)
    approxVectorEqual(round.position, original.position, 1e-8)
    approxVectorEqual(round.scale, original.scale, 1e-8)
    // Quaternion sign may flip; compare via rotated vector.
    const probe = { x: 1, y: 0, z: 0 }
    approxVectorEqual(
      multiplyVector(composeTransform(round), probe),
      multiplyVector(composeTransform(original), probe),
      1e-8,
    )
  })
})

describe('algebra/transform · parentRelativeResolve', () => {
  it('returns the child world matrix as parent · child', () => {
    const parentWorld = composeMatrix({ x: 1, y: 0, z: 0 }, IDENTITY_QUATERNION, ONE_VECTOR3)
    const childLocal: Transform = {
      position: { x: 0, y: 1, z: 0 },
      rotation: IDENTITY_QUATERNION,
      scale: ONE_VECTOR3,
    }
    const childWorld = parentRelativeResolve(parentWorld, childLocal)
    const origin = multiplyVector(childWorld, IDENTITY_VECTOR3)
    // Parent at (+1, 0, 0); child offset (0, +1, 0) → world origin (1, 1, 0).
    approxVectorEqual(origin, { x: 1, y: 1, z: 0 })
  })

  it('parentRelativeResolve respects parent rotation', () => {
    // Parent rotated 90° around Y — its local +X axis points to world -Z.
    const parentWorld = composeMatrix(
      IDENTITY_VECTOR3,
      normalizeQuat(fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2)),
      ONE_VECTOR3,
    )
    const childLocal: Transform = {
      position: { x: 1, y: 0, z: 0 },
      rotation: IDENTITY_QUATERNION,
      scale: ONE_VECTOR3,
    }
    const childWorld = parentRelativeResolve(parentWorld, childLocal)
    const origin = multiplyVector(childWorld, IDENTITY_VECTOR3)
    approxVectorEqual(origin, { x: 0, y: 0, z: -1 }, 1e-9)
  })
})

describe('algebra/transform · worldTransformCompute (3-deep ancestry)', () => {
  it('returns local matrix for a root node', () => {
    const root: TransformNode = {
      id: 'root',
      parent_id: null,
      transform: { ...IDENTITY_TRANSFORM, position: { x: 5, y: 0, z: 0 } },
    }
    const lookup = buildLookup([root])
    const world = worldTransformCompute(root, lookup)
    approxVectorEqual(multiplyVector(world, IDENTITY_VECTOR3), { x: 5, y: 0, z: 0 })
  })

  it('walks a 3-deep chain and composes correctly', () => {
    // root: T(1, 0, 0)
    // child: T(0, 2, 0)
    // grandchild: T(0, 0, 3)
    const root: TransformNode = {
      id: 'root',
      parent_id: null,
      transform: { ...IDENTITY_TRANSFORM, position: { x: 1, y: 0, z: 0 } },
    }
    const child: TransformNode = {
      id: 'child',
      parent_id: 'root',
      transform: { ...IDENTITY_TRANSFORM, position: { x: 0, y: 2, z: 0 } },
    }
    const grandchild: TransformNode = {
      id: 'grandchild',
      parent_id: 'child',
      transform: { ...IDENTITY_TRANSFORM, position: { x: 0, y: 0, z: 3 } },
    }
    const lookup = buildLookup([root, child, grandchild])

    const worldGrandchild = worldTransformCompute(grandchild, lookup)
    const origin = multiplyVector(worldGrandchild, IDENTITY_VECTOR3)
    approxVectorEqual(origin, { x: 1, y: 2, z: 3 })
  })

  it('respects intermediate rotation through the chain', () => {
    // parent rotates 90° around +Y; child sits 3 units in front of its parent.
    const parent: TransformNode = {
      id: 'parent',
      parent_id: null,
      transform: {
        position: { x: 1, y: 0, z: 0 },
        rotation: normalizeQuat(fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2)),
        scale: ONE_VECTOR3,
      },
    }
    const child: TransformNode = {
      id: 'child',
      parent_id: 'parent',
      transform: { ...IDENTITY_TRANSFORM, position: { x: 0, y: 0, z: 3 } },
    }
    const lookup = buildLookup([parent, child])
    const worldChild = worldTransformCompute(child, lookup)
    const origin = multiplyVector(worldChild, IDENTITY_VECTOR3)
    // child local +Z, parent rotation maps local +Z to world +X (right-handed Y-up,
    // 90° around Y rotates +Z to +X). Plus parent translation (1, 0, 0).
    approxVectorEqual(origin, { x: 4, y: 0, z: 0 }, 1e-9)
  })

  it('falls back to local when parent_id points to an unknown node', () => {
    // Render-graceful per Decision #5: broken ancestry must not throw.
    const orphan: TransformNode = {
      id: 'orphan',
      parent_id: 'nonexistent',
      transform: { ...IDENTITY_TRANSFORM, position: { x: 7, y: 0, z: 0 } },
    }
    const lookup = buildLookup([orphan])
    const world = worldTransformCompute(orphan, lookup)
    approxVectorEqual(multiplyVector(world, IDENTITY_VECTOR3), { x: 7, y: 0, z: 0 })
  })
})

describe('algebra/transform · cache behaviour', () => {
  it('cache returns identical matrix references for the same node id', () => {
    const root: TransformNode = {
      id: 'root',
      parent_id: null,
      transform: { ...IDENTITY_TRANSFORM, position: { x: 2, y: 0, z: 0 } },
    }
    const lookup = buildLookup([root])
    const cache: WorldTransformCache = new Map()

    const first = worldTransformCompute(root, lookup, cache)
    const second = worldTransformCompute(root, lookup, cache)
    expect(second).toBe(first)
  })

  it('invalidate clears the chosen node and its descendants', () => {
    const root: TransformNode = {
      id: 'root',
      parent_id: null,
      transform: { ...IDENTITY_TRANSFORM, position: { x: 0, y: 0, z: 0 } },
    }
    const a: TransformNode = {
      id: 'a',
      parent_id: 'root',
      transform: { ...IDENTITY_TRANSFORM, position: { x: 1, y: 0, z: 0 } },
    }
    const b: TransformNode = {
      id: 'b',
      parent_id: 'a',
      transform: { ...IDENTITY_TRANSFORM, position: { x: 0, y: 1, z: 0 } },
    }
    const c: TransformNode = {
      id: 'c',
      parent_id: 'root',
      transform: { ...IDENTITY_TRANSFORM, position: { x: 0, y: 0, z: 5 } },
    }
    const nodes = [root, a, b, c]
    const lookup = buildLookup(nodes)
    const children = buildChildrenLookup(nodes)
    const cache: WorldTransformCache = new Map()

    // Warm up every node.
    for (const n of nodes) worldTransformCompute(n, lookup, cache)
    expect(cache.size).toBe(4)

    // Invalidate subtree rooted at 'a' → should clear 'a' and 'b' but keep 'root' and 'c'.
    invalidateWorldTransformCache(cache, 'a', children)
    expect(cache.has('root')).toBe(true)
    expect(cache.has('a')).toBe(false)
    expect(cache.has('b')).toBe(false)
    expect(cache.has('c')).toBe(true)
  })

  it('cache stays consistent when traversal happens out of order', () => {
    const root: TransformNode = {
      id: 'root',
      parent_id: null,
      transform: { ...IDENTITY_TRANSFORM, position: { x: 1, y: 0, z: 0 } },
    }
    const child: TransformNode = {
      id: 'child',
      parent_id: 'root',
      transform: { ...IDENTITY_TRANSFORM, position: { x: 0, y: 2, z: 0 } },
    }
    const lookup = buildLookup([root, child])
    const cache: WorldTransformCache = new Map()

    // Compute child first (forces recursive root resolution).
    const childWorld = worldTransformCompute(child, lookup, cache)
    expect(cache.has('root')).toBe(true)
    expect(cache.has('child')).toBe(true)

    // Subsequent compute of root must reuse the cached entry.
    const rootWorld = worldTransformCompute(root, lookup, cache)
    expect(cache.get('child')).toBe(childWorld)
    expect(cache.get('root')).toBe(rootWorld)
  })
})

describe('algebra/transform · associativity sanity', () => {
  it('worldTransformCompute matches a manual matrix multiplication chain', () => {
    const root: TransformNode = {
      id: 'root',
      parent_id: null,
      transform: {
        position: { x: 1, y: 2, z: 3 },
        rotation: normalizeQuat(fromAxisAngle({ x: 0, y: 1, z: 0 }, 0.3)),
        scale: ONE_VECTOR3,
      },
    }
    const child: TransformNode = {
      id: 'child',
      parent_id: 'root',
      transform: {
        position: { x: -1, y: 0.5, z: 1 },
        rotation: normalizeQuat(fromAxisAngle({ x: 1, y: 0, z: 0 }, 0.4)),
        scale: ONE_VECTOR3,
      },
    }
    const lookup = buildLookup([root, child])

    const direct = worldTransformCompute(child, lookup)
    const manual = multiplyMatrix(
      composeTransform(root.transform),
      composeTransform(child.transform),
    )
    expect(matrixApproxEquals(direct as Matrix4, manual, 1e-9)).toBe(true)
  })
})
