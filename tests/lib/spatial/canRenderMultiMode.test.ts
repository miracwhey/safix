import { describe, it, expect } from 'vitest'

import { canRenderMultiMode } from '../../../src/lib/spatial/canonical/viewer/canRenderMultiMode'
import type { RoomScene } from '../../../src/lib/spatial/canonical/types/scene-graph'

/** Minimal RoomScene stub — only `walls.length` matters for the gate. */
function sceneWithWalls(n: number): RoomScene {
  return {
    walls: Array.from({ length: n }, (_, i) => ({ id: `w${i}` })),
  } as unknown as RoomScene
}

describe('canRenderMultiMode', () => {
  it('is false when there is no hydrated scene', () => {
    expect(canRenderMultiMode(null, 'ready')).toBe(false)
    expect(canRenderMultiMode(null, 'loading')).toBe(false)
  })

  it('is false for fewer than 3 walls (empty_canvas draft)', () => {
    expect(canRenderMultiMode(sceneWithWalls(0), 'ready')).toBe(false)
    expect(canRenderMultiMode(sceneWithWalls(2), 'ready')).toBe(false)
  })

  it('is false when the blob is not ready, even with real geometry', () => {
    expect(canRenderMultiMode(sceneWithWalls(4), 'loading')).toBe(false)
    expect(canRenderMultiMode(sceneWithWalls(4), 'absent')).toBe(false)
    expect(canRenderMultiMode(sceneWithWalls(4), 'error')).toBe(false)
  })

  it('is true for a hydrated scene with at least 3 walls (2×2 room / example room)', () => {
    expect(canRenderMultiMode(sceneWithWalls(3), 'ready')).toBe(true)
    expect(canRenderMultiMode(sceneWithWalls(4), 'ready')).toBe(true)
  })
})
