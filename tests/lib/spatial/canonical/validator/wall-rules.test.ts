/**
 * Tests for validator/rules/wall-rules.ts
 */
import { describe, it, expect } from 'vitest'

import {
  checkWallHeightMissing,
  checkWallHeightUnusual,
  checkWallJoins,
  checkWallNeedsMaterial,
  checkWallThicknessDefaultUsed,
  checkWallZeroLength,
  WALL_DEFAULT_THICKNESS_M,
} from '../../../../../src/lib/spatial/canonical/validator/rules/wall-rules.ts'
import { makeRoom, makeWall } from '../__helpers__/sceneFactory.ts'

describe('wall-rules · WALL_HEIGHT_MISSING', () => {
  it('emits an error when a wall has zero height', () => {
    const scene = makeRoom({
      walls: [makeWall({ id: 'w1', height_m: 0 })],
    })
    const issues = checkWallHeightMissing(scene)
    expect(issues).toHaveLength(1)
    expect(issues[0].code).toBe('WALL_HEIGHT_MISSING')
    expect(issues[0].severity).toBe('error')
  })

  it('does not flag walls with a positive height', () => {
    const scene = makeRoom({ walls: [makeWall({ id: 'w1', height_m: 2.5 })] })
    expect(checkWallHeightMissing(scene)).toEqual([])
  })
})

describe('wall-rules · WALL_ZERO_LENGTH', () => {
  it('emits an error when start == end', () => {
    const scene = makeRoom({
      walls: [makeWall({ id: 'w1', start_point: { x: 1, y: 0, z: 1 }, end_point: { x: 1, y: 0, z: 1 } })],
    })
    const issues = checkWallZeroLength(scene)
    expect(issues).toHaveLength(1)
    expect(issues[0].code).toBe('WALL_ZERO_LENGTH')
  })

  it('does not flag healthy walls', () => {
    const scene = makeRoom({
      walls: [makeWall({ id: 'w1', start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 0 } })],
    })
    expect(checkWallZeroLength(scene)).toEqual([])
  })
})

describe('wall-rules · WALL_HEIGHT_UNUSUAL', () => {
  it('flags walls shorter than 2 m as warning', () => {
    const scene = makeRoom({ walls: [makeWall({ id: 'w1', height_m: 1.5 })] })
    const issues = checkWallHeightUnusual(scene)
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
  })

  it('flags walls taller than 4 m as warning', () => {
    const scene = makeRoom({ walls: [makeWall({ id: 'w1', height_m: 5 })] })
    expect(checkWallHeightUnusual(scene)).toHaveLength(1)
  })

  it('does not flag a 2.5 m wall', () => {
    const scene = makeRoom({ walls: [makeWall({ id: 'w1', height_m: 2.5 })] })
    expect(checkWallHeightUnusual(scene)).toEqual([])
  })
})

describe('wall-rules · WALL_THICKNESS_DEFAULT_USED', () => {
  it('flags walls that fell back to the default thickness', () => {
    const scene = makeRoom({ walls: [makeWall({ id: 'w1', thickness_m: WALL_DEFAULT_THICKNESS_M })] })
    const issues = checkWallThicknessDefaultUsed(scene)
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
  })

  it('does not flag walls with a custom thickness', () => {
    const scene = makeRoom({ walls: [makeWall({ id: 'w1', thickness_m: 0.25 })] })
    expect(checkWallThicknessDefaultUsed(scene)).toEqual([])
  })
})

describe('wall-rules · WALL_NEEDS_MATERIAL', () => {
  it('hints when a wall has no material', () => {
    const scene = makeRoom({ walls: [makeWall({ id: 'w1', material_id: undefined })] })
    const issues = checkWallNeedsMaterial(scene)
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('hint')
  })

  it('does not hint when a material is assigned', () => {
    const scene = makeRoom({ walls: [makeWall({ id: 'w1', material_id: 'plaster_white' })] })
    expect(checkWallNeedsMaterial(scene)).toEqual([])
  })
})

describe('wall-rules · checkWallJoins', () => {
  it('flags suspected duplicate walls as a hint', () => {
    const scene = makeRoom({
      walls: [
        makeWall({ id: 'a', start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 0 } }),
        makeWall({ id: 'b', start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 0 } }),
      ],
    })
    const issues = checkWallJoins(scene)
    const dup = issues.find(i => i.code === 'WALL_DUPLICATE_SUSPECTED')
    expect(dup).toBeDefined()
    expect(dup?.severity).toBe('hint')
  })

  it('flags an unresolved corner gap as a warning', () => {
    const scene = makeRoom({
      walls: [
        makeWall({ id: 'a', start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 0 } }),
        makeWall({ id: 'b', start_point: { x: 4.2, y: 0, z: 0 }, end_point: { x: 8, y: 0, z: 0 } }),
      ],
    })
    const gap = checkWallJoins(scene).find(i => i.code === 'WALL_JOIN_GAP_LARGE')
    expect(gap).toBeDefined()
    expect(gap?.severity).toBe('warning')
  })

  it('a clean square room produces no join diagnostics', () => {
    const scene = makeRoom({
      walls: [
        makeWall({ id: 'w0', start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 0 } }),
        makeWall({ id: 'w1', start_point: { x: 4, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 4 } }),
        makeWall({ id: 'w2', start_point: { x: 4, y: 0, z: 4 }, end_point: { x: 0, y: 0, z: 4 } }),
        makeWall({ id: 'w3', start_point: { x: 0, y: 0, z: 4 }, end_point: { x: 0, y: 0, z: 0 } }),
      ],
    })
    expect(checkWallJoins(scene)).toEqual([])
  })
})
